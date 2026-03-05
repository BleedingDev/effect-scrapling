#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import process from "node:process";
import { printPreflightReport, runPreflightBootstrap } from "./preflight-bootstrap";

type CommandResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorMessage?: string;
};

type GateStep = {
  readonly id: string;
  readonly command: readonly [string, ...string[]];
  readonly action: string;
};

type GateResult = {
  readonly step: GateStep;
  readonly ok: boolean;
  readonly output: string;
};

const READINESS_GATES: readonly GateStep[] = [
  {
    id: "dependencies:frozen-lockfile",
    command: ["bun", "install", "--frozen-lockfile"],
    action:
      "Resolve dependency or lockfile drift, then rerun `bun install --frozen-lockfile` before doctor.",
  },
  {
    id: "ultracite",
    command: ["bun", "run", "ultracite"],
    action: "Fix lint and format diagnostics, then rerun `bun run ultracite`.",
  },
  {
    id: "oxlint",
    command: ["bun", "run", "oxlint"],
    action: "Fix Oxlint diagnostics, then rerun `bun run oxlint`.",
  },
  {
    id: "oxfmt",
    command: ["bun", "run", "oxfmt"],
    action: "Format files and rerun `bun run oxfmt`.",
  },
  {
    id: "lint:typesafety",
    command: ["bun", "run", "lint:typesafety"],
    action: "Resolve type-safety bypass diagnostics and rerun `bun run lint:typesafety`.",
  },
  {
    id: "check:governance",
    command: ["bun", "run", "check:governance"],
    action: "Remove governance-forbidden patterns and rerun `bun run check:governance`.",
  },
  {
    id: "check:lockstep-version",
    command: ["bun", "run", "check:lockstep-version"],
    action: "Align lockstep policy requirements and rerun `bun run check:lockstep-version`.",
  },
  {
    id: "check:effect-v4-policy",
    command: ["bun", "run", "check:effect-v4-policy"],
    action:
      "Resolve Effect dependency/version policy violations and rerun `bun run check:effect-v4-policy`.",
  },
  {
    id: "check:strict-ts-posture",
    command: ["bun", "run", "check:strict-ts-posture"],
    action: "Restore strict TypeScript posture and rerun `bun run check:strict-ts-posture`.",
  },
  {
    id: "typecheck",
    command: ["bun", "run", "typecheck"],
    action: "Fix TypeScript errors and rerun `bun run typecheck`.",
  },
  {
    id: "test",
    command: ["bun", "run", "test"],
    action: "Fix failing tests and rerun `bun run test`.",
  },
  {
    id: "build",
    command: ["bun", "run", "build"],
    action: "Fix build failures and rerun `bun run build`.",
  },
];

function runCommand(command: readonly [string, ...string[]]): CommandResult {
  const result = spawnSync(command[0], command.slice(1), {
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

function formatCommand(command: readonly [string, ...string[]]): string {
  return command.join(" ");
}

function toCombinedOutput(result: CommandResult): string {
  if (result.errorMessage) {
    return result.errorMessage;
  }

  return `${result.stdout}\n${result.stderr}`.trim();
}

function limitOutput(output: string, maxLines = 120): string {
  if (output.length === 0) {
    return "<no output>";
  }

  const lines = output.split(/\r?\n/u);
  if (lines.length <= maxLines) {
    return output;
  }

  const visible = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  return `${visible.join("\n")}\n... (${remaining} additional lines omitted)`;
}

function printGateStart(step: GateStep): void {
  console.log(`RUN  ${step.id}: ${formatCommand(step.command)}`);
}

function printGateResult(result: GateResult): void {
  if (result.ok) {
    console.log(`PASS ${result.step.id}`);
    return;
  }

  console.error(`FAIL ${result.step.id}`);
  console.error(`  Command: ${formatCommand(result.step.command)}`);
  console.error(`  Action: ${result.step.action}`);
  console.error("  Output:");
  for (const line of limitOutput(result.output).split(/\r?\n/u)) {
    console.error(`    ${line}`);
  }
}

export async function runBootstrapDoctor(): Promise<boolean> {
  console.log("Bootstrap doctor report");

  const preflightReport = await runPreflightBootstrap();
  printPreflightReport(preflightReport);
  if (!preflightReport.ok) {
    console.error("Bootstrap doctor failed because preflight checks did not pass.");
    return false;
  }

  for (const step of READINESS_GATES) {
    printGateStart(step);
    const run = runCommand(step.command);
    const gateResult: GateResult = {
      step,
      ok: run.status === 0,
      output: toCombinedOutput(run),
    };

    printGateResult(gateResult);
    if (!gateResult.ok) {
      console.error(`Bootstrap doctor failed at gate "${step.id}".`);
      return false;
    }
  }

  console.log(`Bootstrap doctor passed (${READINESS_GATES.length} readiness gates).`);
  return true;
}

if (import.meta.main) {
  const ok = await runBootstrapDoctor();
  process.exit(ok ? 0 : 1);
}
