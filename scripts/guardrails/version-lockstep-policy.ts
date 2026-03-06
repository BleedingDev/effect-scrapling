#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Predicate } from "effect";

const EXCLUDED_DIRECTORIES = new Set([".git", "vendor", "node_modules", "tmp", ".beads", "dist"]);
const PACKAGE_FILE_NAME = "package.json";

type PackageRecord = Record<string, unknown>;

type VersionViolation = {
  file: string;
  version: unknown;
};

function isRecord(value: unknown): value is PackageRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPackageJson(filePath: string): Promise<PackageRecord> {
  const raw = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);

  if (!isRecord(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }

  return parsed;
}

async function findWorkspacePackageJsonFiles(rootDir: string): Promise<string[]> {
  const discovered: string[] = [];
  const pending: string[] = [rootDir];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);

      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
          pending.push(fullPath);
        }
        continue;
      }

      if (entry.isFile() && entry.name === PACKAGE_FILE_NAME) {
        discovered.push(fullPath);
      }
    }
  }

  return discovered.sort((left, right) => left.localeCompare(right));
}

function formatVersion(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  const serialized = JSON.stringify(value);
  return serialized ?? String(value);
}

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const rootPackagePath = join(workspaceRoot, PACKAGE_FILE_NAME);

  let rootPackage: PackageRecord;
  try {
    rootPackage = await readPackageJson(rootPackagePath);
  } catch (error) {
    const message = Predicate.isError(error) ? error.message : String(error);
    console.error(`Failed to read root package.json: ${message}`);
    process.exit(1);
  }

  const rootVersion = rootPackage.version;
  if (typeof rootVersion !== "string" || rootVersion.length === 0) {
    console.error("Missing or invalid string version in root package.json");
    process.exit(1);
  }

  let packageFiles: string[];
  try {
    packageFiles = await findWorkspacePackageJsonFiles(workspaceRoot);
  } catch (error) {
    const message = Predicate.isError(error) ? error.message : String(error);
    console.error(`Failed to enumerate workspace package.json files: ${message}`);
    process.exit(1);
  }

  const violations: VersionViolation[] = [];
  for (const packagePath of packageFiles) {
    let packageJson: PackageRecord;

    try {
      packageJson = await readPackageJson(packagePath);
    } catch (error) {
      const message = Predicate.isError(error) ? error.message : String(error);
      console.error(`Failed to read ${relative(workspaceRoot, packagePath)}: ${message}`);
      process.exit(1);
    }

    if (!("version" in packageJson)) {
      continue;
    }

    if (packageJson.version !== rootVersion) {
      violations.push({
        file: relative(workspaceRoot, packagePath),
        version: packageJson.version,
      });
    }
  }

  if (violations.length > 0) {
    console.error(
      `Workspace version lockstep policy failed: expected "${rootVersion}" in all package.json files with a version field.`,
    );
    for (const violation of violations) {
      console.error(`- ${violation.file}: found "${formatVersion(violation.version)}"`);
    }
    process.exit(1);
  }

  console.log(
    `Workspace version lockstep policy OK: ${packageFiles.length} package.json files scanned, all version fields match "${rootVersion}".`,
  );
}

await main();
