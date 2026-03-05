#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const REQUIRED_REPO_FILES = [
  "AGENTS.md",
  "package.json",
  "bun.lock",
  "tsconfig.base.json",
  "tsconfig.guardrails.json",
] as const;

const REQUIRED_PACKAGE_SCRIPTS = [
  "ultracite",
  "oxlint",
  "oxfmt",
  "lint:typesafety",
  "check:governance",
  "check:lockstep-version",
  "check:effect-v4-policy",
  "check:strict-ts-posture",
  "typecheck",
  "test",
  "build",
] as const;

type Semver = readonly [major: number, minor: number, patch: number];
type ComparisonOperator = "<" | "<=" | "=" | ">" | ">=";

type SemverConstraint = {
  readonly operator: ComparisonOperator;
  readonly version: Semver;
};

type ParsedConstraintVersion = {
  readonly version: Semver;
  readonly segments: 1 | 2 | 3;
};

type PackageJson = {
  readonly engines?: {
    readonly bun?: string;
  };
  readonly scripts?: Record<string, string>;
};

type CommandResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorMessage?: string;
};

export type PreflightCheck = {
  readonly id: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly details?: string;
  readonly action?: string;
};

export type PreflightReport = {
  readonly ok: boolean;
  readonly checks: readonly PreflightCheck[];
};

function runCommand(command: string, args: readonly string[]): CommandResult {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  const baseResult = {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  const errorMessage = result.error?.message;
  return errorMessage ? { ...baseResult, errorMessage } : baseResult;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseSemver(value: string): Semver | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const majorText = match[1];
  const minorText = match[2];
  const patchText = match[3];
  if (!majorText || !minorText || !patchText) {
    return undefined;
  }

  return [
    Number.parseInt(majorText, 10),
    Number.parseInt(minorText, 10),
    Number.parseInt(patchText, 10),
  ];
}

function compareSemver(left: Semver, right: Semver): number {
  if (left[0] !== right[0]) {
    return left[0] - right[0];
  }
  if (left[1] !== right[1]) {
    return left[1] - right[1];
  }
  return left[2] - right[2];
}

function formatSemver(version: Semver): string {
  return `${version[0]}.${version[1]}.${version[2]}`;
}

function parseConstraintVersionDetailed(value: string): ParsedConstraintVersion | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const majorText = match[1];
  if (!majorText) {
    return undefined;
  }

  const minorText = match[2];
  const patchText = match[3];

  const segments = patchText ? 3 : minorText ? 2 : 1;

  return {
    version: [
      Number.parseInt(majorText, 10),
      Number.parseInt(minorText ?? "0", 10),
      Number.parseInt(patchText ?? "0", 10),
    ],
    segments,
  };
}

function parseConstraintVersion(value: string): Semver | undefined {
  return parseConstraintVersionDetailed(value)?.version;
}

function nextCaretUpperBound(version: Semver, segments: 1 | 2 | 3): Semver {
  if (segments === 1) {
    return [version[0] + 1, 0, 0];
  }
  if (version[0] > 0) {
    return [version[0] + 1, 0, 0];
  }
  if (version[1] > 0) {
    return [0, version[1] + 1, 0];
  }
  return [0, 0, version[2] + 1];
}

function nextTildeUpperBound(version: Semver, segments: 1 | 2 | 3): Semver {
  if (segments === 1) {
    return [version[0] + 1, 0, 0];
  }
  return [version[0], version[1] + 1, 0];
}

function parseConstraintToken(token: string): readonly SemverConstraint[] | undefined {
  const trimmed = token.trim();
  if (trimmed.length === 0 || trimmed === "*" || /^x$/iu.test(trimmed)) {
    return [];
  }

  if (trimmed.startsWith("^")) {
    const parsedBase = parseConstraintVersionDetailed(trimmed.slice(1));
    if (!parsedBase) {
      return undefined;
    }
    return [
      { operator: ">=", version: parsedBase.version },
      { operator: "<", version: nextCaretUpperBound(parsedBase.version, parsedBase.segments) },
    ];
  }

  if (trimmed.startsWith("~")) {
    const parsedBase = parseConstraintVersionDetailed(trimmed.slice(1));
    if (!parsedBase) {
      return undefined;
    }
    return [
      { operator: ">=", version: parsedBase.version },
      { operator: "<", version: nextTildeUpperBound(parsedBase.version, parsedBase.segments) },
    ];
  }

  const comparatorMatch = /^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2})$/u.exec(trimmed);
  if (!comparatorMatch) {
    return undefined;
  }

  const comparator = comparatorMatch[1] as ComparisonOperator | undefined;
  const versionText = comparatorMatch[2];
  if (!versionText) {
    return undefined;
  }

  const parsedVersion = parseConstraintVersion(versionText);
  if (!parsedVersion) {
    return undefined;
  }

  return [{ operator: comparator ?? "=", version: parsedVersion }];
}

function parseConstraintClause(clause: string): readonly SemverConstraint[] | undefined {
  const normalizedClause = clause.trim().replace(/,/gu, " ");
  if (normalizedClause.length === 0) {
    return [];
  }

  const hyphenMatch = /^(\d+(?:\.\d+){0,2})\s*-\s*(\d+(?:\.\d+){0,2})$/u.exec(normalizedClause);
  if (hyphenMatch) {
    const lower = hyphenMatch[1];
    const upper = hyphenMatch[2];
    if (!lower || !upper) {
      return undefined;
    }
    const lowerVersion = parseConstraintVersion(lower);
    const upperVersion = parseConstraintVersion(upper);
    if (!lowerVersion || !upperVersion) {
      return undefined;
    }
    return [
      { operator: ">=", version: lowerVersion },
      { operator: "<=", version: upperVersion },
    ];
  }

  const tokenPattern =
    /(?:[~^]\s*\d+(?:\.\d+){0,2})|(?:(?:>=|<=|>|<|=)\s*\d+(?:\.\d+){0,2})|(?:\d+(?:\.\d+){0,2})|(?:\*)|(?:x)/giu;
  const tokens = [...normalizedClause.matchAll(tokenPattern)].map((match) =>
    match[0].replace(/\s+/gu, ""),
  );
  const leftover = normalizedClause.replace(tokenPattern, " ").replace(/\s+/gu, "");
  if (leftover.length > 0) {
    return undefined;
  }

  const constraints: SemverConstraint[] = [];
  for (const token of tokens) {
    if (token.length === 0) {
      return undefined;
    }
    const parsed = parseConstraintToken(token);
    if (!parsed) {
      return undefined;
    }
    constraints.push(...parsed);
  }
  return constraints;
}

function parseBunConstraint(
  constraint: string,
): readonly (readonly SemverConstraint[])[] | undefined {
  const clauses = constraint
    .split("||")
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  if (clauses.length === 0) {
    return undefined;
  }

  const parsedClauses: SemverConstraint[][] = [];
  for (const clause of clauses) {
    const parsedClause = parseConstraintClause(clause);
    if (!parsedClause) {
      return undefined;
    }
    parsedClauses.push([...parsedClause]);
  }
  return parsedClauses;
}

function satisfiesConstraint(version: Semver, constraint: SemverConstraint): boolean {
  const comparison = compareSemver(version, constraint.version);
  switch (constraint.operator) {
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
    case "=":
      return comparison === 0;
    case ">":
      return comparison > 0;
    case ">=":
      return comparison >= 0;
  }
}

function formatConstraint(constraint: string): string {
  return constraint.replace(/\s+/gu, " ").trim();
}

async function readPackageJson(): Promise<PackageJson | undefined> {
  try {
    const source = await readFile(resolve(process.cwd(), "package.json"), "utf8");
    const parsed = JSON.parse(source) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as PackageJson;
  } catch {
    return undefined;
  }
}

async function checkRequiredRepoFiles(): Promise<PreflightCheck> {
  const missing: string[] = [];
  for (const requiredFile of REQUIRED_REPO_FILES) {
    if (!(await pathExists(resolve(process.cwd(), requiredFile)))) {
      missing.push(requiredFile);
    }
  }

  if (missing.length === 0) {
    return {
      id: "repo-files",
      ok: true,
      summary: "Repository baseline files are present.",
    };
  }

  return {
    id: "repo-files",
    ok: false,
    summary: "Required repository files are missing.",
    details: `Missing: ${missing.join(", ")}`,
    action: "Restore the missing files or reclone the repository before bootstrapping.",
  };
}

function checkGitAvailable(): PreflightCheck {
  const run = runCommand("git", ["--version"]);
  if (run.status !== 0) {
    const detail = run.errorMessage ?? `${run.stdout}\n${run.stderr}`.trim();
    return {
      id: "git-cli",
      ok: false,
      summary: "Git CLI is not available.",
      details: detail.length > 0 ? detail : "git --version exited with a non-zero status.",
      action: "Install Git and ensure `git` is in PATH.",
    };
  }

  return {
    id: "git-cli",
    ok: true,
    summary: "Git CLI is available.",
    details: run.stdout.trim(),
  };
}

function checkGitWorktreeRoot(): PreflightCheck {
  const run = runCommand("git", ["rev-parse", "--show-toplevel"]);
  if (run.status !== 0) {
    const detail = run.errorMessage ?? `${run.stdout}\n${run.stderr}`.trim();
    return {
      id: "git-root",
      ok: false,
      summary: "Current directory is not a Git worktree root.",
      details: detail.length > 0 ? detail : "git rev-parse failed.",
      action: "Run the command from the repository root checkout directory.",
    };
  }

  const reportedRoot = resolve(run.stdout.trim());
  const cwd = resolve(process.cwd());
  if (reportedRoot !== cwd) {
    return {
      id: "git-root",
      ok: false,
      summary: "Commands must run from repository root.",
      details: `Current directory: ${cwd}\nGit root: ${reportedRoot}`,
      action: `Change directory to ${reportedRoot} before running bootstrap tooling.`,
    };
  }

  return {
    id: "git-root",
    ok: true,
    summary: "Command is running from repository root.",
    details: reportedRoot,
  };
}

function checkBunVersion(pkg: PackageJson | undefined): PreflightCheck {
  const bunRun = runCommand("bun", ["--version"]);
  if (bunRun.status !== 0) {
    const detail = bunRun.errorMessage ?? `${bunRun.stdout}\n${bunRun.stderr}`.trim();
    return {
      id: "bun-version",
      ok: false,
      summary: "Bun runtime is not available.",
      details: detail.length > 0 ? detail : "bun --version exited with a non-zero status.",
      action: "Install Bun and ensure `bun` is in PATH.",
    };
  }

  const installed = parseSemver(bunRun.stdout);
  if (!installed) {
    return {
      id: "bun-version",
      ok: false,
      summary: "Unable to parse Bun version output.",
      details: bunRun.stdout.trim(),
      action: "Run `bun --version` manually and verify it prints a semantic version.",
    };
  }

  const engineConstraint = pkg?.engines?.bun;
  if (typeof engineConstraint !== "string") {
    return {
      id: "bun-version",
      ok: true,
      summary: "Bun runtime is available (no engine constraint declared).",
      details: `Detected Bun ${formatSemver(installed)}`,
    };
  }

  const parsedConstraint = parseBunConstraint(engineConstraint);
  if (!parsedConstraint) {
    return {
      id: "bun-version",
      ok: false,
      summary: "Unsupported Bun engine constraint format in package.json.",
      details: `engines.bun = "${engineConstraint}"`,
      action:
        "Use semver comparators supported by npm-style ranges (for example: >=1.3.10, >=1.3.10 <2.0.0, ^1.3.10, ~1.3.10).",
    };
  }

  const constraintSatisfied = parsedConstraint.some((clause) =>
    clause.every((comparator) => satisfiesConstraint(installed, comparator)),
  );
  if (!constraintSatisfied) {
    return {
      id: "bun-version",
      ok: false,
      summary: "Installed Bun version does not satisfy workspace engine constraint.",
      details: `Detected Bun ${formatSemver(installed)}, required ${formatConstraint(engineConstraint)}`,
      action: "Install a Bun version matching package.json#engines.bun and re-run preflight.",
    };
  }

  return {
    id: "bun-version",
    ok: true,
    summary: "Bun runtime version satisfies workspace engine constraint.",
    details: `Detected Bun ${formatSemver(installed)}, required ${formatConstraint(engineConstraint)}`,
  };
}

function checkRequiredScripts(pkg: PackageJson | undefined): PreflightCheck {
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== "object") {
    return {
      id: "package-scripts",
      ok: false,
      summary: "package.json scripts are missing or invalid.",
      action: "Restore package.json scripts and retry preflight.",
    };
  }

  const missingScripts = REQUIRED_PACKAGE_SCRIPTS.filter(
    (scriptName) => scripts[scriptName] == null,
  );
  if (missingScripts.length > 0) {
    return {
      id: "package-scripts",
      ok: false,
      summary: "Required readiness scripts are missing from package.json.",
      details: `Missing scripts: ${missingScripts.join(", ")}`,
      action: "Restore the missing scripts before running bootstrap doctor.",
    };
  }

  return {
    id: "package-scripts",
    ok: true,
    summary: "Required readiness scripts are present.",
  };
}

export function printPreflightReport(report: PreflightReport): void {
  console.log("Bootstrap preflight report");
  for (const check of report.checks) {
    const statusLabel = check.ok ? "PASS" : "FAIL";
    console.log(`${statusLabel} ${check.id}: ${check.summary}`);
    if (check.details) {
      console.log(`  Details: ${check.details}`);
    }
    if (!check.ok && check.action) {
      console.log(`  Action: ${check.action}`);
    }
  }

  if (report.ok) {
    console.log(`Preflight passed (${report.checks.length}/${report.checks.length} checks).`);
    return;
  }

  const failedChecks = report.checks.filter((check) => !check.ok);
  console.error(`Preflight failed (${failedChecks.length}/${report.checks.length} checks failed).`);
}

export async function runPreflightBootstrap(): Promise<PreflightReport> {
  const packageJson = await readPackageJson();
  const checks: PreflightCheck[] = [
    await checkRequiredRepoFiles(),
    checkGitAvailable(),
    checkGitWorktreeRoot(),
    checkBunVersion(packageJson),
    checkRequiredScripts(packageJson),
  ];

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

if (import.meta.main) {
  const report = await runPreflightBootstrap();
  printPreflightReport(report);
  process.exit(report.ok ? 0 : 1);
}
