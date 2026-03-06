import { afterEach, describe, expect, it } from "@effect-native/bun-test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const BOOTSTRAP_DOCTOR_SCRIPT = join(REPO_ROOT, "scripts", "bootstrap-doctor.ts");
const PREFLIGHT_SCRIPT = join(REPO_ROOT, "scripts", "preflight-bootstrap.ts");
const TEMP_FIXTURES: string[] = [];

const REQUIRED_SCRIPT_NAMES = [
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

const DOCTOR_GATE_IDS = [
  "dependencies:frozen-lockfile",
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

const DOCTOR_GATE_COMMANDS = [
  "RUN  dependencies:frozen-lockfile: bun install --frozen-lockfile",
  "RUN  ultracite: bun run ultracite",
  "RUN  oxlint: bun run oxlint",
  "RUN  oxfmt: bun run oxfmt",
  "RUN  lint:typesafety: bun run lint:typesafety",
  "RUN  check:governance: bun run check:governance",
  "RUN  check:lockstep-version: bun run check:lockstep-version",
  "RUN  check:effect-v4-policy: bun run check:effect-v4-policy",
  "RUN  check:strict-ts-posture: bun run check:strict-ts-posture",
  "RUN  typecheck: bun run typecheck",
  "RUN  test: bun run test",
  "RUN  build: bun run build",
] as const;

type DoctorGateId = (typeof DOCTOR_GATE_IDS)[number];

type CommandRun = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type FixtureOptions = {
  readonly failGate?: DoctorGateId;
};

const textDecoder = new TextDecoder();

function createPackageJsonSource(): string {
  const scripts = Object.fromEntries(
    REQUIRED_SCRIPT_NAMES.map((scriptName) => [scriptName, `echo ${scriptName}`]),
  );

  return `${JSON.stringify(
    {
      name: "bootstrap-doctor-fixture",
      private: true,
      version: "0.0.1",
      engines: {
        bun: ">=1.3.10",
      },
      scripts,
    },
    null,
    2,
  )}\n`;
}

async function writeFixtureFile(filePath: string, contents: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

async function writeExecutable(filePath: string, contents: string): Promise<void> {
  await writeFixtureFile(filePath, contents);
  await chmod(filePath, 0o755);
}

async function createWorkspaceFixture(): Promise<string> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bootstrap-doctor-verify-"));
  TEMP_FIXTURES.push(fixtureRoot);

  await writeFixtureFile(join(fixtureRoot, "AGENTS.md"), "# Fixture governance\n");
  await writeFixtureFile(join(fixtureRoot, "package.json"), createPackageJsonSource());
  await writeFixtureFile(join(fixtureRoot, "bun.lock"), '{\n  "packages": {}\n}\n');
  await writeFixtureFile(
    join(fixtureRoot, "tsconfig.base.json"),
    '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n',
  );
  await writeFixtureFile(
    join(fixtureRoot, "tsconfig.guardrails.json"),
    '{\n  "extends": "./tsconfig.base.json",\n  "compilerOptions": {\n    "noEmit": true,\n    "exactOptionalPropertyTypes": true,\n    "noUncheckedIndexedAccess": true\n  },\n  "include": []\n}\n',
  );

  const binDir = join(fixtureRoot, "bin");
  await mkdir(binDir, { recursive: true });

  await writeExecutable(
    join(binDir, "git"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'git version 2.43.0'
  exit 0
fi

if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then
  pwd
  exit 0
fi

printf 'unexpected git invocation: %s\\n' "$*" >&2
exit 97
`,
  );

  await writeExecutable(
    join(binDir, "bun"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' "\${FAKE_BUN_VERSION:-1.3.10}"
  exit 0
fi

gate=""
if [ "$1" = "install" ] && [ "$2" = "--frozen-lockfile" ]; then
  gate="dependencies:frozen-lockfile"
elif [ "$1" = "run" ] && [ -n "$2" ]; then
  gate="$2"
else
  printf 'unexpected bun invocation: %s\\n' "$*" >&2
  exit 97
fi

if [ "$gate" = "\${FAKE_BUN_FAIL_GATE:-}" ]; then
  printf 'simulated failure for %s\\n' "$gate" >&2
  exit 1
fi

printf 'simulated pass for %s\\n' "$gate"
exit 0
`,
  );

  return fixtureRoot;
}

function createFixtureEnv(binDir: string, options: FixtureOptions = {}): NodeJS.ProcessEnv {
  const pathValue = process.env.PATH;
  const prefixedPath = pathValue ? `${binDir}:${pathValue}` : binDir;

  return {
    ...process.env,
    PATH: prefixedPath,
    ...(options.failGate ? { FAKE_BUN_FAIL_GATE: options.failGate } : {}),
  };
}

function runScript(scriptPath: string, cwd: string, env: NodeJS.ProcessEnv): CommandRun {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd,
    env,
  });

  return {
    exitCode: result.status,
    stderr: textDecoder.decode(result.stderr),
    stdout: textDecoder.decode(result.stdout),
  };
}

afterEach(async () => {
  await Promise.all(
    TEMP_FIXTURES.splice(0).map((fixtureRoot) => rm(fixtureRoot, { force: true, recursive: true })),
  );
});

describe("bootstrap doctor integration evidence", () => {
  it("executes the documented preflight and doctor path on a compliant workspace fixture", async () => {
    const fixtureRoot = await createWorkspaceFixture();
    const env = createFixtureEnv(join(fixtureRoot, "bin"));

    const preflightRun = runScript(PREFLIGHT_SCRIPT, fixtureRoot, env);
    expect(preflightRun.exitCode).toBe(0);
    expect(preflightRun.stderr.trim()).toBe("");
    expect(preflightRun.stdout).toContain("Bootstrap preflight report");
    expect(preflightRun.stdout).toContain("PASS repo-files");
    expect(preflightRun.stdout).toContain("PASS git-cli");
    expect(preflightRun.stdout).toContain("PASS git-root");
    expect(preflightRun.stdout).toContain("PASS bun-version");
    expect(preflightRun.stdout).toContain("PASS package-scripts");
    expect(preflightRun.stdout).toContain("Preflight passed (5/5 checks).");

    const doctorRun = runScript(BOOTSTRAP_DOCTOR_SCRIPT, fixtureRoot, env);
    expect(doctorRun.exitCode).toBe(0);
    expect(doctorRun.stderr.trim()).toBe("");
    expect(doctorRun.stdout).toContain("Bootstrap doctor report");
    expect(doctorRun.stdout).toContain("Bootstrap preflight report");
    expect(doctorRun.stdout).toContain("Preflight passed (5/5 checks).");

    for (const gateId of DOCTOR_GATE_IDS) {
      expect(doctorRun.stdout).toContain(`RUN  ${gateId}:`);
      expect(doctorRun.stdout).toContain(`PASS ${gateId}`);
    }

    for (const gateCommand of DOCTOR_GATE_COMMANDS) {
      expect(doctorRun.stdout).toContain(gateCommand);
    }

    expect(doctorRun.stdout).toContain("Bootstrap doctor passed (12 readiness gates).");
  });

  it("aborts before readiness gates when preflight fails inside bootstrap doctor", async () => {
    const fixtureRoot = await createWorkspaceFixture();
    await rm(join(fixtureRoot, "AGENTS.md"));
    const env = createFixtureEnv(join(fixtureRoot, "bin"));

    const doctorRun = runScript(BOOTSTRAP_DOCTOR_SCRIPT, fixtureRoot, env);
    expect(doctorRun.exitCode).toBe(1);
    expect(doctorRun.stdout).toContain("Bootstrap doctor report");
    expect(doctorRun.stdout).toContain("Bootstrap preflight report");
    expect(doctorRun.stdout).toContain("FAIL repo-files");
    expect(doctorRun.stdout).not.toContain("RUN  dependencies:frozen-lockfile:");
    expect(doctorRun.stderr).toContain(
      "Bootstrap doctor failed because preflight checks did not pass.",
    );
  });

  it("stops at the first failing readiness gate and prints actionable failure evidence", async () => {
    const fixtureRoot = await createWorkspaceFixture();
    const failGate: DoctorGateId = "check:effect-v4-policy";
    const env = createFixtureEnv(join(fixtureRoot, "bin"), { failGate });

    const doctorRun = runScript(BOOTSTRAP_DOCTOR_SCRIPT, fixtureRoot, env);
    expect(doctorRun.exitCode).toBe(1);
    expect(doctorRun.stdout).toContain("Bootstrap doctor report");
    expect(doctorRun.stdout).toContain("PASS check:lockstep-version");
    expect(doctorRun.stdout).toContain(`RUN  ${failGate}:`);
    expect(doctorRun.stdout).not.toContain("RUN  check:strict-ts-posture:");
    expect(doctorRun.stdout).not.toContain("RUN  build:");

    expect(doctorRun.stderr).toContain(`FAIL ${failGate}`);
    expect(doctorRun.stderr).toContain("Command: bun run check:effect-v4-policy");
    expect(doctorRun.stderr).toContain(
      "Action: Resolve Effect dependency/version policy violations and rerun `bun run check:effect-v4-policy`.",
    );
    expect(doctorRun.stderr).toContain(`simulated failure for ${failGate}`);
    expect(doctorRun.stderr).toContain(`Bootstrap doctor failed at gate "${failGate}".`);
  });
});
