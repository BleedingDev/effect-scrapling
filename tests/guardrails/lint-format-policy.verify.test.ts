import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type PackageScripts = Record<string, string>;

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const API_SOURCE_ROOT = join(REPO_ROOT, "apps", "api", "src");
const GUARDRAILS_TEST_ROOT = join(REPO_ROOT, "tests", "guardrails");

function runCommand(command: readonly [string, ...string[]], cwd = REPO_ROOT): CommandResult {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function getCombinedOutput(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

async function readPackageScripts(): Promise<PackageScripts> {
  const packageJsonPath = join(REPO_ROOT, "package.json");
  const packageJsonContent = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(packageJsonContent) as { scripts?: PackageScripts };
  return parsed.scripts ?? {};
}

async function withTemporaryFixtureFile(
  parentDirectory: string,
  fileNamePrefix: string,
  content: string,
  run: (relativePathToRoot: string) => Promise<void> | void,
): Promise<void> {
  await mkdir(parentDirectory, { recursive: true });
  const fixturePath = join(parentDirectory, `${fileNamePrefix}${randomUUID()}.ts`);
  const fixturePathRelative = relative(REPO_ROOT, fixturePath);

  await writeFile(fixturePath, content, "utf8");
  try {
    await run(fixturePathRelative);
  } finally {
    await rm(fixturePath, { force: true });
  }
}

describe("lint and format policy verification", () => {
  it("wires lint and format guardrails into package scripts and full check pipeline", async () => {
    const scripts = await readPackageScripts();
    expect(scripts.ultracite).toContain("bunx --bun ultracite check");
    expect(scripts.oxlint).toContain("bunx --bun oxlint");
    expect(scripts.oxfmt).toBe("bun run format:check");
    expect(scripts.check).toContain("bun run ultracite");
    expect(scripts.check).toContain("bun run oxlint");
    expect(scripts.check).toContain("bun run oxfmt");
    expect(scripts["check:strict-ts-posture"]).toBe(
      "bun run scripts/guardrails/strict-ts-posture.ts",
    );
    expect(scripts.check).toContain("bun run check:strict-ts-posture");
  });

  it("passes lint and format policy commands on a clean fixture", async () => {
    await withTemporaryFixtureFile(
      GUARDRAILS_TEST_ROOT,
      "__lint-policy-clean-",
      "export const lintFormatPolicyCleanFixture = { value: 1 };\n",
      (fixturePathRelative) => {
        const commands: readonly (readonly [string, ...string[]])[] = [
          ["bunx", "--bun", "ultracite", "check", fixturePathRelative],
          ["bunx", "--bun", "oxlint", fixturePathRelative],
          ["bunx", "--bun", "oxfmt", "--check", fixturePathRelative],
        ];

        for (const command of commands) {
          const result = runCommand(command);
          expect(result.status).toBe(0);
        }
      },
    );
  });

  it("fails ultracite policy on an unformatted fixture", async () => {
    await withTemporaryFixtureFile(
      GUARDRAILS_TEST_ROOT,
      "__lint-policy-ultracite-",
      "export   const ultraciteFixture={value:1}\n",
      (fixturePathRelative) => {
        const result = runCommand(["bunx", "--bun", "ultracite", "check", fixturePathRelative]);
        expect(result.status).toBe(1);
        expect(getCombinedOutput(result)).toContain("Format issues found");
        expect(getCombinedOutput(result)).toContain(fixturePathRelative);
      },
    );
  });

  it("fails oxfmt policy on an unformatted fixture", async () => {
    await withTemporaryFixtureFile(
      GUARDRAILS_TEST_ROOT,
      "__lint-policy-oxfmt-",
      "export   const oxfmtFixture={value:1}\n",
      (fixturePathRelative) => {
        const result = runCommand(["bunx", "--bun", "oxfmt", "--check", fixturePathRelative]);
        expect(result.status).toBe(1);
        expect(getCombinedOutput(result)).toContain("Format issues found");
        expect(getCombinedOutput(result)).toContain(fixturePathRelative);
      },
    );
  });

  it("fails oxlint policy on module-boundary violations", async () => {
    await withTemporaryFixtureFile(
      API_SOURCE_ROOT,
      "__lint-policy-oxlint-",
      'import { reportProjectHealth } from "@effect-scrapling/ci-tooling";\n\nexport const lintPolicyViolationFixture = reportProjectHealth;\n',
      (fixturePathRelative) => {
        const result = runCommand(["bunx", "--bun", "oxlint", fixturePathRelative]);
        expect(result.status).toBe(1);
        expect(getCombinedOutput(result)).toContain("@nx(enforce-module-boundaries)");
        expect(getCombinedOutput(result)).toContain(
          'A project tagged with "type:app" can only depend on libs tagged with "type:lib"',
        );
        expect(getCombinedOutput(result)).toContain(fixturePathRelative);
      },
    );
  });
});
