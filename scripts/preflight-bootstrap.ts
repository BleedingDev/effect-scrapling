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

function parseMinimumBunVersion(constraint: string): Semver | undefined {
  const match = /^\s*>=\s*(\d+\.\d+\.\d+)\s*$/u.exec(constraint);
  if (!match) {
    return undefined;
  }

  const minimumVersion = match[1];
  if (!minimumVersion) {
    return undefined;
  }
  return parseSemver(minimumVersion);
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

  const minimum = parseMinimumBunVersion(engineConstraint);
  if (!minimum) {
    return {
      id: "bun-version",
      ok: false,
      summary: "Unsupported Bun engine constraint format in package.json.",
      details: `engines.bun = "${engineConstraint}"`,
      action: "Use a >=x.y.z Bun engine constraint so bootstrap tooling can validate it.",
    };
  }

  if (compareSemver(installed, minimum) < 0) {
    return {
      id: "bun-version",
      ok: false,
      summary: "Installed Bun version does not satisfy workspace minimum.",
      details: `Detected Bun ${formatSemver(installed)}, required >= ${formatSemver(minimum)}`,
      action: `Upgrade Bun to >= ${formatSemver(minimum)} and re-run preflight.`,
    };
  }

  return {
    id: "bun-version",
    ok: true,
    summary: "Bun runtime version satisfies workspace requirement.",
    details: `Detected Bun ${formatSemver(installed)}, required >= ${formatSemver(minimum)}`,
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
