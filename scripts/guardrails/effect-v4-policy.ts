#!/usr/bin/env bun

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const IGNORED_DIRS = new Set(["node_modules", "dist", ".git", ".nx", ".beads", "tmp", "Scrapling"]);

// Legacy / compatibility-era Effect package split that must not be introduced.
const DISALLOWED_EFFECT_PACKAGES = [
  "@effect-ts/core",
  "@effect-ts/system",
  "@effect/data",
  "@effect/io",
  "@effect/match",
  "@effect/schema",
  "@effect/stream",
] as const;
const DISALLOWED_EFFECT_PACKAGE_SET = new Set<string>(DISALLOWED_EFFECT_PACKAGES);

type ManifestDependencySection = (typeof DEPENDENCY_SECTIONS)[number];

type PolicyViolation = {
  location: string;
  message: string;
};

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isResolvedEffectVersionV4(version: string): boolean {
  return /^4(?:\.|$)/u.test(version.trim());
}

function normalizeEffectSpecifier(specifier: string): string {
  const trimmed = specifier.trim();
  if (trimmed.startsWith("npm:effect@")) {
    return trimmed.slice("npm:effect@".length).trim();
  }
  return trimmed;
}

function isUnsupportedSpecifierFormat(specifier: string): boolean {
  return (
    specifier === "" ||
    specifier === "*" ||
    specifier === "latest" ||
    specifier.startsWith("workspace:") ||
    specifier.startsWith("file:") ||
    specifier.startsWith("link:") ||
    specifier.startsWith("git+") ||
    specifier.startsWith("github:") ||
    specifier.startsWith("http:") ||
    specifier.startsWith("https:")
  );
}

function isCanonicalV4Range(rangeClause: string): boolean {
  return /^(?:\^|~)?4(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?(?:-[0-9A-Za-z-.]+)?$/u.test(
    rangeClause,
  );
}

function isBoundedV4Range(rangeClause: string): boolean {
  return /^>=\s*4(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?(?:-[0-9A-Za-z-.]+)?\s*<\s*5(?:\.(?:0|[xX*]))?(?:\.(?:0|[xX*]))?(?:-[0-9A-Za-z-.]+)?$/u.test(
    rangeClause,
  );
}

function isEffectSpecifierV4(specifier: string): boolean {
  const normalized = normalizeEffectSpecifier(specifier);
  if (isUnsupportedSpecifierFormat(normalized)) {
    return false;
  }

  const disjunctions = normalized
    .replaceAll(",", " ")
    .split("||")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (disjunctions.length === 0) {
    return false;
  }

  return disjunctions.every((clause) => isCanonicalV4Range(clause) || isBoundedV4Range(clause));
}

function asDependencyEntries(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([name, specifier]) => {
    if (typeof specifier !== "string") {
      return [];
    }
    return [[name, specifier] as const];
  });
}

function findDeniedDependencies(
  dependencyName: string,
  specifier: string,
  relativeManifestPath: string,
  section: ManifestDependencySection,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  if (dependencyName === "effect" && !isEffectSpecifierV4(specifier)) {
    violations.push({
      location: `${relativeManifestPath}#${section}`,
      message: `effect must use a v4-only semver range (found "${specifier}").`,
    });
  }

  if (specifier.startsWith("npm:effect@")) {
    const aliasSpecifier = normalizeEffectSpecifier(specifier);
    if (!isEffectSpecifierV4(aliasSpecifier)) {
      violations.push({
        location: `${relativeManifestPath}#${section}`,
        message: `alias "${dependencyName}" resolves to non-v4 effect range "${specifier}".`,
      });
    }
  }

  if (DISALLOWED_EFFECT_PACKAGE_SET.has(dependencyName)) {
    violations.push({
      location: `${relativeManifestPath}#${section}`,
      message: `disallowed Effect dependency "${dependencyName}" detected.`,
    });
  }

  return violations;
}

async function discoverPackageJsonFiles(rootDir: string): Promise<string[]> {
  const discovered: string[] = [];
  const pending: string[] = [rootDir];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((left, right) => String(left.name).localeCompare(String(right.name)));

    for (const entry of entries) {
      const entryName = String(entry.name);
      const fullPath = join(current, entryName);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entryName)) {
          pending.push(fullPath);
        }
        continue;
      }

      if (entry.isFile() && entryName === "package.json") {
        discovered.push(fullPath);
      }
    }
  }

  discovered.sort((left, right) => left.localeCompare(right));
  return discovered;
}

async function scanManifestPolicyViolations(
  packageJsonPaths: string[],
): Promise<PolicyViolation[]> {
  const violations: PolicyViolation[] = [];

  for (const manifestPath of packageJsonPaths) {
    const relativeManifestPath = relative(process.cwd(), manifestPath);
    let parsedManifest: unknown;
    try {
      const rawManifest = await readFile(manifestPath, "utf8");
      parsedManifest = JSON.parse(rawManifest) as unknown;
    } catch {
      violations.push({
        location: relativeManifestPath,
        message: "package.json is unreadable or invalid JSON.",
      });
      continue;
    }

    if (!parsedManifest || typeof parsedManifest !== "object" || Array.isArray(parsedManifest)) {
      violations.push({
        location: relativeManifestPath,
        message: "package.json must be a JSON object.",
      });
      continue;
    }

    for (const section of DEPENDENCY_SECTIONS) {
      const sectionEntries = asDependencyEntries(
        (parsedManifest as Record<string, unknown>)[section],
      );
      for (const [dependencyName, specifier] of sectionEntries) {
        violations.push(
          ...findDeniedDependencies(dependencyName, specifier, relativeManifestPath, section),
        );
      }
    }
  }

  return violations;
}

function scanLockfilePolicyViolations(lockfileContents: string): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  const resolvedEffectEntries = lockfileContents.matchAll(/"effect"\s*:\s*\[\s*"effect@([^"]+)"/gu);

  for (const entry of resolvedEffectEntries) {
    const resolvedVersion = entry[1]?.trim();
    if (!resolvedVersion) {
      continue;
    }

    if (!isResolvedEffectVersionV4(resolvedVersion)) {
      violations.push({
        location: "bun.lock#packages",
        message: `resolved effect version must be v4 (found "${resolvedVersion}").`,
      });
    }
  }

  for (const dependencyName of DISALLOWED_EFFECT_PACKAGES) {
    const lockfilePattern = new RegExp(`"${escapeForRegExp(dependencyName)}"\\s*:`, "u");
    if (lockfilePattern.test(lockfileContents)) {
      violations.push({
        location: "bun.lock",
        message: `disallowed Effect dependency "${dependencyName}" detected.`,
      });
    }
  }

  return violations;
}

async function main(): Promise<void> {
  const packageJsonPaths = await discoverPackageJsonFiles(process.cwd());
  const policyViolations = await scanManifestPolicyViolations(packageJsonPaths);

  const lockfilePath = join(process.cwd(), "bun.lock");
  try {
    const lockfileContents = await readFile(lockfilePath, "utf8");
    policyViolations.push(...scanLockfilePolicyViolations(lockfileContents));
  } catch {
    policyViolations.push({
      location: "bun.lock",
      message: "bun.lock is required for deterministic dependency checks.",
    });
  }

  if (policyViolations.length > 0) {
    policyViolations.sort((left, right) => {
      const locationComparison = left.location.localeCompare(right.location);
      if (locationComparison !== 0) {
        return locationComparison;
      }
      return left.message.localeCompare(right.message);
    });

    console.error("Effect v4 dependency policy violations detected:");
    for (const violation of policyViolations) {
      console.error(`- ${violation.location}: ${violation.message}`);
    }
    process.exit(1);
  }

  console.log(
    `Effect v4 dependency policy check passed (${packageJsonPaths.length} package.json file(s) + bun.lock).`,
  );
}

await main();
