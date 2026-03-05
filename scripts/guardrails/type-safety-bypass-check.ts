#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const INCLUDED_ROOTS = ["src", "tests", "apps", "libs", "tools", "scripts"] as const;
const EXCLUDED_FILES = new Set([
  "scripts/guardrails/type-safety-bypass-check.ts",
  "scripts/guardrails/governance-audit.ts",
]);
const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const IGNORED_DIRS = new Set(["node_modules", "dist", ".git", ".nx", ".beads", "tmp", "Scrapling"]);

const CHECKS = [
  { id: "@ts-ignore", pattern: /@ts-ignore\b/u },
  { id: "@ts-nocheck", pattern: /@ts-nocheck\b/u },
  { id: "@ts-expect-error", pattern: /@ts-expect-error\b/u },
  { id: "eslint-disable", pattern: /eslint-disable\b/u },
  { id: "as any", pattern: /\bas\s+any\b/u },
  { id: "generic<any>", pattern: /\b[A-Za-z_$][\w$]*\s*<[^>\n]*\bany\b[^>\n]*>/u },
  { id: "standalone-any", pattern: /^\s*any(?:\[\])?\s*(?:[>,|&)]|$)/u },
  { id: "union-or-intersection-any", pattern: /(?:\||&)\s*any\b/u },
  { id: "as unknown as", pattern: /\bas\s+unknown\b[\s)\]>]*\bas\b/u },
  { id: ": any", pattern: /:\s*any\b/u },
  { id: "identifier<any>", pattern: /\b[A-Za-z_$][\w$]*\s*<\s*any\s*>/u },
] as const;

type Violation = {
  check: string;
  file: string;
  line: number;
  content: string;
};

async function walkFiles(rootDir: string): Promise<string[]> {
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

    for (const entry of entries) {
      const fullPath = join(current, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          pending.push(fullPath);
        }
        continue;
      }

      if (entry.isFile() && EXTENSIONS.has(extname(entry.name))) {
        discovered.push(fullPath);
      }
    }
  }

  return discovered;
}

async function main(): Promise<void> {
  const violations: Violation[] = [];

  for (const root of INCLUDED_ROOTS) {
    for (const filePath of await walkFiles(root)) {
      const relativePath = relative(process.cwd(), filePath).replace(/\\/gu, "/");
      if (EXCLUDED_FILES.has(relativePath)) {
        continue;
      }

      const contents = await readFile(filePath, "utf8");
      const lines = contents.split(/\r?\n/u);

      for (const [index, line] of lines.entries()) {
        for (const check of CHECKS) {
          if (check.pattern.test(line)) {
            violations.push({
              check: check.id,
              file: relativePath,
              line: index + 1,
              content: line.trim(),
            });
          }
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error("Type-safety bypass patterns are forbidden:");
    for (const violation of violations) {
      console.error(
        `- ${violation.file}:${violation.line} [${violation.check}] ${violation.content || "<empty line>"}`,
      );
    }
    process.exit(1);
  }

  console.log(`Type-safety bypass check passed (${INCLUDED_ROOTS.join(", ")}).`);
}

await main();
