#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Predicate } from "effect";

const BASE_CONFIG_FILE = "tsconfig.base.json";
const GUARDRAILS_CONFIG_FILE = "tsconfig.guardrails.json";
const WORKSPACE_PROJECT_ROOTS = ["apps", "libs", "tools"] as const;
const WORKSPACE_TSCONFIG_FILE = "tsconfig.json";

const EXACT_OPTION = "exactOptionalPropertyTypes";
const NO_IMPLICIT_ANY_OPTION = "noImplicitAny";
const NO_UNCHECKED_INDEXED_ACCESS_OPTION = "noUncheckedIndexedAccess";
const STRICT_OPTION = "strict";

type JsonRecord = Record<string, unknown>;

type TsConfigFile = {
  readonly extends?: unknown;
  readonly compilerOptions?: unknown;
  readonly include?: unknown;
};

type ResolvedTsConfig = {
  readonly chain: readonly string[];
  readonly localConfig: TsConfigFile;
  readonly mergedCompilerOptions: JsonRecord;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRepoPath(absolutePath: string): string {
  return relative(process.cwd(), absolutePath).replace(/\\/gu, "/");
}

function toBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeGlobPattern(pattern: string): string {
  return pattern.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function resolveNoImplicitAny(compilerOptions: JsonRecord): boolean {
  const explicit = toBoolean(compilerOptions[NO_IMPLICIT_ANY_OPTION]);
  if (explicit !== undefined) {
    return explicit;
  }

  return toBoolean(compilerOptions[STRICT_OPTION]) === true;
}

function asCompilerOptions(value: unknown, configPath: string): JsonRecord {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new Error(`${toRepoPath(configPath)}#compilerOptions must be an object.`);
  }

  return value;
}

async function readTsConfig(
  configPath: string,
  cache: Map<string, TsConfigFile>,
): Promise<TsConfigFile> {
  const cached = cache.get(configPath);
  if (cached) {
    return cached;
  }

  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch {
    throw new Error(`${toRepoPath(configPath)} is missing or unreadable.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${toRepoPath(configPath)} is not valid JSON.`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${toRepoPath(configPath)} must contain a JSON object.`);
  }

  const config = parsed as TsConfigFile;
  cache.set(configPath, config);
  return config;
}

function resolveExtendsPath(configPath: string, extendsValue: string): string | undefined {
  if (extendsValue.startsWith(".") || extendsValue.startsWith("/")) {
    const normalizedExtends = extendsValue.endsWith(".json")
      ? extendsValue
      : `${extendsValue}.json`;
    return resolve(dirname(configPath), normalizedExtends);
  }

  return undefined;
}

async function resolveTsConfig(
  configPath: string,
  readCache: Map<string, TsConfigFile>,
  resolutionCache: Map<string, ResolvedTsConfig>,
  visiting: Set<string> = new Set<string>(),
): Promise<ResolvedTsConfig> {
  const cachedResolution = resolutionCache.get(configPath);
  if (cachedResolution) {
    return cachedResolution;
  }

  if (visiting.has(configPath)) {
    throw new Error(`${toRepoPath(configPath)} has a circular extends chain.`);
  }

  visiting.add(configPath);
  try {
    const localConfig = await readTsConfig(configPath, readCache);
    const localCompilerOptions = asCompilerOptions(localConfig.compilerOptions, configPath);

    let chain: readonly string[] = [configPath];
    let mergedCompilerOptions: JsonRecord = { ...localCompilerOptions };

    if (localConfig.extends !== undefined) {
      if (typeof localConfig.extends !== "string") {
        throw new Error(`${toRepoPath(configPath)}#extends must be a string when present.`);
      }

      const parentConfigPath = resolveExtendsPath(configPath, localConfig.extends);
      if (!parentConfigPath) {
        throw new Error(
          `${toRepoPath(configPath)}#extends "${localConfig.extends}" must be a relative or absolute JSON path.`,
        );
      }

      const parentResolution = await resolveTsConfig(
        parentConfigPath,
        readCache,
        resolutionCache,
        visiting,
      );
      chain = [...parentResolution.chain, configPath];
      mergedCompilerOptions = {
        ...parentResolution.mergedCompilerOptions,
        ...localCompilerOptions,
      };
    }

    const resolvedConfig: ResolvedTsConfig = {
      chain,
      localConfig,
      mergedCompilerOptions,
    };

    resolutionCache.set(configPath, resolvedConfig);
    return resolvedConfig;
  } finally {
    visiting.delete(configPath);
  }
}

async function findWorkspaceTsConfigFiles(workspaceRoot: string): Promise<readonly string[]> {
  const discovered = new Set<string>();
  const ignoredDirectories = new Set(["node_modules", "dist", "tmp", ".git", ".nx", ".beads"]);

  for (const workspaceRootDir of WORKSPACE_PROJECT_ROOTS) {
    const absoluteRoot = join(workspaceRoot, workspaceRootDir);
    const pending: string[] = [absoluteRoot];

    while (pending.length > 0) {
      const currentDir = pending.pop();
      if (!currentDir) {
        continue;
      }

      let entries;
      try {
        entries = await readdir(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const entryPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name)) {
            pending.push(entryPath);
          }
          continue;
        }

        if (entry.isFile() && entry.name === WORKSPACE_TSCONFIG_FILE) {
          discovered.add(entryPath);
        }
      }
    }
  }

  return [...discovered].sort((left, right) => left.localeCompare(right));
}

function readStringArray(
  value: unknown,
  configPath: string,
  propertyName: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${toRepoPath(configPath)}#${propertyName} must be a string array.`);
  }

  const normalized: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      throw new Error(`${toRepoPath(configPath)}#${propertyName}[${index}] must be a string.`);
    }
    normalized.push(normalizeGlobPattern(entry));
  }
  return normalized;
}

function readLocalCompilerOptionBoolean(
  config: TsConfigFile,
  optionName: string,
): boolean | undefined {
  if (!isRecord(config.compilerOptions)) {
    return undefined;
  }

  return toBoolean(config.compilerOptions[optionName]);
}

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const baseConfigPath = resolve(workspaceRoot, BASE_CONFIG_FILE);
  const guardrailsConfigPath = resolve(workspaceRoot, GUARDRAILS_CONFIG_FILE);
  const violations: string[] = [];

  const readCache = new Map<string, TsConfigFile>();
  const resolutionCache = new Map<string, ResolvedTsConfig>();

  let baseConfigResolution: ResolvedTsConfig | undefined;
  try {
    baseConfigResolution = await resolveTsConfig(baseConfigPath, readCache, resolutionCache);
  } catch (error) {
    const message = Predicate.isError(error) ? error.message : String(error);
    violations.push(message);
  }

  if (baseConfigResolution) {
    const baseCompilerOptions = baseConfigResolution.mergedCompilerOptions;
    if (toBoolean(baseCompilerOptions[STRICT_OPTION]) !== true) {
      violations.push(`${BASE_CONFIG_FILE}#compilerOptions.strict must be true.`);
    }
    if (!resolveNoImplicitAny(baseCompilerOptions)) {
      violations.push(
        `${BASE_CONFIG_FILE} must enforce compilerOptions.noImplicitAny via compilerOptions.strict=true or noImplicitAny=true.`,
      );
    }
  }

  let guardrailsConfigResolution: ResolvedTsConfig | undefined;
  try {
    guardrailsConfigResolution = await resolveTsConfig(
      guardrailsConfigPath,
      readCache,
      resolutionCache,
    );
  } catch (error) {
    const message = Predicate.isError(error) ? error.message : String(error);
    violations.push(message);
  }

  let guardrailsIncludePatterns: readonly string[] = [];
  if (guardrailsConfigResolution) {
    const guardrailsChain = new Set(guardrailsConfigResolution.chain);
    if (!guardrailsChain.has(baseConfigPath)) {
      violations.push(
        `${GUARDRAILS_CONFIG_FILE} must extend ${BASE_CONFIG_FILE} to inherit strict compiler posture.`,
      );
    }

    const guardrailsCompilerOptions = guardrailsConfigResolution.mergedCompilerOptions;
    if (!resolveNoImplicitAny(guardrailsCompilerOptions)) {
      violations.push(
        `${GUARDRAILS_CONFIG_FILE}#compilerOptions.noImplicitAny must resolve to true.`,
      );
    }

    if (toBoolean(guardrailsCompilerOptions[EXACT_OPTION]) !== true) {
      violations.push(`${GUARDRAILS_CONFIG_FILE}#compilerOptions.${EXACT_OPTION} must be true.`);
    }

    if (toBoolean(guardrailsCompilerOptions[NO_UNCHECKED_INDEXED_ACCESS_OPTION]) !== true) {
      violations.push(
        `${GUARDRAILS_CONFIG_FILE}#compilerOptions.${NO_UNCHECKED_INDEXED_ACCESS_OPTION} must be true.`,
      );
    }

    try {
      guardrailsIncludePatterns = readStringArray(
        guardrailsConfigResolution.localConfig.include,
        guardrailsConfigPath,
        "include",
      );
    } catch (error) {
      const message = Predicate.isError(error) ? error.message : String(error);
      violations.push(message);
    }
  }

  const workspaceTsConfigFiles = await findWorkspaceTsConfigFiles(workspaceRoot);
  if (workspaceTsConfigFiles.length === 0) {
    violations.push("No workspace tsconfig.json files were found under apps/, libs/, or tools/.");
  }

  const workspaceRoots = new Set<string>();
  for (const workspaceTsConfigPath of workspaceTsConfigFiles) {
    const repoPath = toRepoPath(workspaceTsConfigPath);
    const [workspaceRootDir] = repoPath.split("/");
    if (workspaceRootDir) {
      workspaceRoots.add(workspaceRootDir);
    }

    let workspaceResolution: ResolvedTsConfig;
    try {
      workspaceResolution = await resolveTsConfig(
        workspaceTsConfigPath,
        readCache,
        resolutionCache,
      );
    } catch (error) {
      const message = Predicate.isError(error) ? error.message : String(error);
      violations.push(message);
      continue;
    }

    const workspaceChain = new Set(workspaceResolution.chain);
    if (!workspaceChain.has(baseConfigPath)) {
      violations.push(`${repoPath} must extend ${BASE_CONFIG_FILE}.`);
    }

    const workspaceCompilerOptions = workspaceResolution.mergedCompilerOptions;
    if (toBoolean(workspaceCompilerOptions[STRICT_OPTION]) !== true) {
      violations.push(`${repoPath}#compilerOptions.strict must resolve to true.`);
    }

    if (!resolveNoImplicitAny(workspaceCompilerOptions)) {
      violations.push(`${repoPath}#compilerOptions.noImplicitAny must resolve to true.`);
    }

    if (readLocalCompilerOptionBoolean(workspaceResolution.localConfig, EXACT_OPTION) === false) {
      violations.push(`${repoPath} must not disable compilerOptions.${EXACT_OPTION}.`);
    }

    if (
      readLocalCompilerOptionBoolean(
        workspaceResolution.localConfig,
        NO_UNCHECKED_INDEXED_ACCESS_OPTION,
      ) === false
    ) {
      violations.push(
        `${repoPath} must not disable compilerOptions.${NO_UNCHECKED_INDEXED_ACCESS_OPTION}.`,
      );
    }
  }

  for (const workspaceRootDir of [...workspaceRoots].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const expectedPattern = `${workspaceRootDir}/**/*.ts`;
    if (!guardrailsIncludePatterns.includes(expectedPattern)) {
      violations.push(`${GUARDRAILS_CONFIG_FILE}#include must contain "${expectedPattern}".`);
    }
  }

  violations.sort((left, right) => left.localeCompare(right));
  if (violations.length > 0) {
    console.error("Strict TypeScript posture check failed:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log(
    `Strict TypeScript posture check passed: ${workspaceTsConfigFiles.length} workspace tsconfig files inherit strict posture and guardrail coverage.`,
  );
}

await main();
