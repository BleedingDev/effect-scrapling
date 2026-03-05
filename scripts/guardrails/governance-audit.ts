#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const DEFAULT_SOURCE_ROOTS = ["src", "tests", "apps", "libs", "tools", "scripts"] as const;
const ROOT_AGENTS_FILE = "AGENTS.md";

const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "tmp",
  ".beads",
  "vendor",
  ".git",
  ".nx",
  ".idea",
  ".vscode",
]);

const AGENTS_SCAN_IGNORED_DIRS = new Set([".git", "node_modules", "dist"]);

const EXCLUDED_PATTERN_FILES = new Set([
  "scripts/guardrails/type-safety-bypass-check.ts",
  "scripts/guardrails/governance-audit.ts",
]);

const FORBIDDEN_LINE_PATTERNS = [
  { id: "@ts-ignore", pattern: /@ts-ignore\b/u },
  { id: "@ts-nocheck", pattern: /@ts-nocheck\b/u },
  { id: "@ts-expect-error", pattern: /@ts-expect-error\b/u },
  { id: "as unknown as", pattern: /\bas\s+unknown\b[\s)\]]*\bas\b/u },
  { id: "governance-audit-ignore", pattern: /\bgovernance-audit-ignore\b/iu },
  { id: "governance-bypass", pattern: /\bgovernance-bypass\b/iu },
  { id: "guardrail-bypass", pattern: /\bguardrail-bypass\b/iu },
  { id: "skip-governance-check", pattern: /\bskip-governance-check\b/iu },
] as const;

const BLANKET_DISABLE_COMMENT_PATTERN =
  /(?:\/\/|\/\*+|\*)\s*(?:eslint|oxlint)-disable\b(?!-(?:next-line|line))/iu;

type Violation = {
  check: string;
  file: string;
  line?: number;
  content?: string;
};

type EntryFilter = (entryName: string) => boolean;

function toRepoPath(absolutePath: string): string {
  return relative(process.cwd(), absolutePath).replace(/\\/gu, "/");
}

async function walkFiles(
  rootDir: string,
  fileFilter: EntryFilter,
  ignoredDirs = IGNORED_DIRS,
): Promise<string[]> {
  const discovered: string[] = [];
  const pending: string[] = [rootDir];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = join(current, entry.name);

      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          pending.push(fullPath);
        }
        continue;
      }

      if (entry.isFile() && fileFilter(entry.name)) {
        discovered.push(fullPath);
      }
    }
  }

  discovered.sort((left, right) => left.localeCompare(right));
  return discovered;
}

async function resolveSourceRoots(): Promise<string[]> {
  const roots = new Set<string>();

  for (const root of DEFAULT_SOURCE_ROOTS) {
    try {
      const [entry] = await readdir(root, { withFileTypes: true });
      if (entry !== undefined || root.length > 0) {
        roots.add(root);
      }
    } catch {
      // Ignore missing default roots.
    }
  }

  const topLevelEntries = await readdir(".", { withFileTypes: true });
  topLevelEntries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of topLevelEntries) {
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
      roots.add(entry.name);
    }
  }

  return [...roots].sort((left, right) => left.localeCompare(right));
}

async function collectSourceFiles(roots: readonly string[]): Promise<string[]> {
  const files: string[] = [];

  for (const root of roots) {
    for (const absolutePath of await walkFiles(root, (entryName) =>
      TEXT_EXTENSIONS.has(extname(entryName)),
    )) {
      const repoPath = toRepoPath(absolutePath);
      if (!EXCLUDED_PATTERN_FILES.has(repoPath)) {
        files.push(absolutePath);
      }
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

async function findNonRootAgentsFiles(): Promise<string[]> {
  const allAgents = await walkFiles(
    ".",
    (entryName) => entryName.toLowerCase() === ROOT_AGENTS_FILE.toLowerCase(),
    AGENTS_SCAN_IGNORED_DIRS,
  );
  const nonRootAgents: string[] = [];

  for (const absolutePath of allAgents) {
    const repoPath = toRepoPath(absolutePath);
    if (repoPath.toLowerCase() !== ROOT_AGENTS_FILE.toLowerCase()) {
      nonRootAgents.push(repoPath);
    }
  }

  nonRootAgents.sort((left, right) => left.localeCompare(right));
  return nonRootAgents;
}

function detectLineViolations(filePath: string, source: string): Violation[] {
  const violations: Violation[] = [];
  const lines = source.split(/\r?\n/u);

  for (const [index, line] of lines.entries()) {
    for (const check of FORBIDDEN_LINE_PATTERNS) {
      if (check.pattern.test(line)) {
        violations.push({
          check: check.id,
          file: filePath,
          line: index + 1,
          content: line.trim(),
        });
      }
    }

    if (BLANKET_DISABLE_COMMENT_PATTERN.test(line)) {
      violations.push({
        check: "blanket-disable",
        file: filePath,
        line: index + 1,
        content: line.trim(),
      });
    }
  }

  return violations;
}

async function main(): Promise<void> {
  const violations: Violation[] = [];
  const sourceRoots = await resolveSourceRoots();

  for (const sourceFile of await collectSourceFiles(sourceRoots)) {
    const repoPath = toRepoPath(sourceFile);
    const contents = await readFile(sourceFile, "utf8");
    violations.push(...detectLineViolations(repoPath, contents));
  }

  for (const file of await findNonRootAgentsFiles()) {
    violations.push({
      check: "non-root-AGENTS.md",
      file,
    });
  }

  violations.sort((left, right) => {
    const byFile = left.file.localeCompare(right.file);
    if (byFile !== 0) {
      return byFile;
    }

    const leftLine = left.line ?? Number.MAX_SAFE_INTEGER;
    const rightLine = right.line ?? Number.MAX_SAFE_INTEGER;
    if (leftLine !== rightLine) {
      return leftLine - rightLine;
    }

    return left.check.localeCompare(right.check);
  });

  if (violations.length > 0) {
    console.error("Governance audit failed. Forbidden patterns found:");
    for (const violation of violations) {
      const location =
        violation.line === undefined ? `${violation.file}` : `${violation.file}:${violation.line}`;
      const content =
        violation.content && violation.content.length > 0 ? ` ${violation.content}` : "";
      console.error(`- ${location} [${violation.check}]${content}`);
    }
    process.exit(1);
  }

  console.log(
    `Governance audit passed (${sourceRoots.join(", ")}); no forbidden patterns or non-root AGENTS.md files found.`,
  );
}

await main();
