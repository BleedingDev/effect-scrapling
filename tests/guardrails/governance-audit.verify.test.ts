import { afterEach, describe, expect, it } from "@effect-native/bun-test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(__dirname, "..", "..");
const governanceAuditScript = join(repositoryRoot, "scripts/guardrails/governance-audit.ts");
const tempFixtures: string[] = [];

const textDecoder = new TextDecoder();

type AuditRun = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

async function createFixture(files: Record<string, string>): Promise<string> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "governance-audit-verify-"));
  tempFixtures.push(fixtureRoot);

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(fixtureRoot, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }

  return fixtureRoot;
}

function runGovernanceAudit(cwd: string): AuditRun {
  const result = Bun.spawnSync({
    cmd: ["bun", governanceAuditScript],
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stderr: textDecoder.decode(result.stderr),
    stdout: textDecoder.decode(result.stdout),
  };
}

afterEach(async () => {
  await Promise.all(
    tempFixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })),
  );
});

describe("governance-audit forbidden patterns verification", () => {
  it("passes on a clean fixture", async () => {
    const fixture = await createFixture({
      "AGENTS.md": "# Governance\n",
      "src/clean.ts": "export const cleanValue = 1;\n",
    });

    const run = runGovernanceAudit(fixture);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("Governance audit passed");
    expect(run.stderr.trim()).toBe("");
  });

  it("fails on forbidden bypass patterns", async () => {
    const fixture = await createFixture({
      "src/bypass.ts": "// @ts-ignore\n/* eslint-disable */\nexport const bypass = true;\n",
    });

    const run = runGovernanceAudit(fixture);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("Governance audit failed. Forbidden patterns found:");
    expect(run.stderr).toContain("src/bypass.ts:1 [@ts-ignore]");
    expect(run.stderr).toContain("src/bypass.ts:2 [blanket-disable]");
    expect(run.stdout.trim()).toBe("");
  });

  it("fails when non-root AGENTS.md exists", async () => {
    const fixture = await createFixture({
      "AGENTS.md": "# Root policy\n",
      "docs/AGENTS.md": "# Nested policy\n",
      "src/clean.ts": "export const stillClean = true;\n",
    });

    const run = runGovernanceAudit(fixture);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("Governance audit failed. Forbidden patterns found:");
    expect(run.stderr).toContain("docs/AGENTS.md [non-root-AGENTS.md]");
    expect(run.stdout.trim()).toBe("");
  });
});
