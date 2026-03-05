import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "@effect-native/bun-test";

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type TrackedDifference = {
  upstreamPattern: string;
  status: string;
  rationale: string;
};

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const PARITY_CHECK_SCRIPT = join(REPO_ROOT, "scripts/guardrails/guardrail-parity-check.ts");
const tempFixtures: string[] = [];

const REQUIRED_IMPLEMENTED_GUARDRAILS = [
  "Nx workspace graph",
  "Module boundary enforcement",
  "Oxlint policy",
  "Oxfmt policy",
  "Ultracite checks",
  "Type-safety bypass ban",
  "Effect v4 dependency policy",
  "Strict TS posture",
  "CI guardrail enforcement",
  "Semver release policy",
] as const;

const VALID_TRACKED_DIFFERENCES: readonly TrackedDifference[] = [
  {
    upstreamPattern: "pnpm wrappers",
    status: "Intentionally not mirrored",
    rationale: "This fixture validates deterministic parity checks for Bun-native workflows.",
  },
] as const;

function runParityChecker(argumentsList: readonly string[] = []): CommandResult {
  const result = spawnSync("bun", [PARITY_CHECK_SCRIPT, ...argumentsList], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function toImplementationReference(guardrailName: string): string {
  return guardrailName
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function buildParityMarkdown(options: {
  implementedGuardrails: readonly string[];
  trackedDifferences: readonly TrackedDifference[];
  trackedHeader?: string;
}): string {
  const implementedRows = options.implementedGuardrails
    .map(
      (guardrail) =>
        `| ${guardrail} | Implemented | \`evidence/${toImplementationReference(guardrail)}\` |`,
    )
    .join("\n");

  const trackedRows = options.trackedDifferences
    .map(
      (difference) =>
        `| ${difference.upstreamPattern} | ${difference.status} | ${difference.rationale} |`,
    )
    .join("\n");

  return [
    "# Guardrail Parity Report",
    "",
    "## Implemented in this repository",
    "",
    "| Guardrail | Status | Implementation |",
    "| --- | --- | --- |",
    implementedRows,
    "",
    "## Tracked differences with rationale",
    "",
    options.trackedHeader ?? "| Upstream pattern | Status | Rationale |",
    "| --- | --- | --- |",
    trackedRows,
    "",
  ].join("\n");
}

async function createFixtureReport(markdown: string): Promise<string> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "guardrail-parity-verify-"));
  tempFixtures.push(fixtureRoot);

  const reportPath = join(fixtureRoot, "docs", "guardrail-parity.md");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, markdown, "utf8");
  return reportPath;
}

afterEach(async () => {
  await Promise.all(
    tempFixtures.splice(0).map((fixturePath) => rm(fixturePath, { recursive: true, force: true })),
  );
});

describe("guardrail parity verification", () => {
  it("passes for the committed parity report", () => {
    const run = runParityChecker();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Guardrail parity verification passed");
    expect(run.stdout).toContain("docs/guardrail-parity.md");
    expect(run.stderr.trim()).toBe("");
  });

  it("fails when a required implemented guardrail row is missing", async () => {
    const missingGuardrailRows = REQUIRED_IMPLEMENTED_GUARDRAILS.filter(
      (guardrail) => guardrail !== "Semver release policy",
    );

    const fixtureReport = await createFixtureReport(
      buildParityMarkdown({
        implementedGuardrails: missingGuardrailRows,
        trackedDifferences: VALID_TRACKED_DIFFERENCES,
      }),
    );

    const run = runParityChecker([fixtureReport]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'Missing required implemented guardrail row: "Semver release policy".',
    );
    expect(run.stdout.trim()).toBe("");
  });

  it("fails when tracked-difference rationale content is incomplete", async () => {
    const fixtureReport = await createFixtureReport(
      buildParityMarkdown({
        implementedGuardrails: REQUIRED_IMPLEMENTED_GUARDRAILS,
        trackedDifferences: [
          {
            upstreamPattern: "pnpm wrappers",
            status: "Deferred",
            rationale: "",
          },
        ],
      }),
    );

    const run = runParityChecker([fixtureReport]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "Tracked differences with rationale row 1 is missing rationale text.",
    );
    expect(run.stdout.trim()).toBe("");
  });

  it("fails when tracked-differences table headers are malformed", async () => {
    const fixtureReport = await createFixtureReport(
      buildParityMarkdown({
        implementedGuardrails: REQUIRED_IMPLEMENTED_GUARDRAILS,
        trackedDifferences: VALID_TRACKED_DIFFERENCES,
        trackedHeader: "| Upstream pattern | Status | Notes |",
      }),
    );

    const run = runParityChecker([fixtureReport]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'Section "Tracked differences with rationale" table header must be "Upstream pattern | Status | Rationale".',
    );
    expect(run.stdout.trim()).toBe("");
  });
});
