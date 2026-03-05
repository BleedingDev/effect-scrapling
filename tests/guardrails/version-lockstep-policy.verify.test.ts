import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import process from "node:process";
import { describe, expect, it } from "@effect-native/bun-test";

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type CommandOptions = {
  env?: NodeJS.ProcessEnv;
};

const REPO_ROOT = join(import.meta.dir, "..", "..");
const LOCKSTEP_POLICY_SCRIPT = join(REPO_ROOT, "scripts/guardrails/version-lockstep-policy.ts");
const VALIDATE_VERSION_SCRIPT = join(REPO_ROOT, "scripts/validate-version.ts");

async function withTempWorkspace(
  name: string,
  run: (workspaceRoot: string) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), `effect-scrapling-${name}-`));
  try {
    await run(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function writeJsonFile(filePath: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildDeterministicEnv(envOverrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...envOverrides,
  };

  if (envOverrides.ALLOW_V1_RELEASE === undefined) {
    delete env.ALLOW_V1_RELEASE;
  }

  return env;
}

function runTypeScriptScript(
  scriptPath: string,
  workspaceRoot: string,
  options: CommandOptions = {},
): CommandResult {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: workspaceRoot,
    env: buildDeterministicEnv(options.env),
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("version policy guardrails", () => {
  it("passes lockstep check when workspace package versions are aligned", async () => {
    await withTempWorkspace("lockstep-pass", async (workspaceRoot) => {
      await writeJsonFile(join(workspaceRoot, "package.json"), {
        name: "root",
        private: true,
        version: "0.2.0",
      });
      await writeJsonFile(join(workspaceRoot, "apps/api/package.json"), {
        name: "api",
        private: true,
        version: "0.2.0",
      });
      await writeJsonFile(join(workspaceRoot, "libs/core/package.json"), {
        name: "core",
        private: true,
      });

      const result = runTypeScriptScript(LOCKSTEP_POLICY_SCRIPT, workspaceRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Workspace version lockstep policy OK:");
      expect(result.stderr).toBe("");
    });
  });

  it("fails lockstep check when one workspace package drifts", async () => {
    await withTempWorkspace("lockstep-fail", async (workspaceRoot) => {
      await writeJsonFile(join(workspaceRoot, "package.json"), {
        name: "root",
        private: true,
        version: "0.2.0",
      });
      await writeJsonFile(join(workspaceRoot, "apps/api/package.json"), {
        name: "api",
        private: true,
        version: "0.3.0",
      });

      const result = runTypeScriptScript(LOCKSTEP_POLICY_SCRIPT, workspaceRoot);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Workspace version lockstep policy failed: expected "0.2.0"');
      expect(result.stderr).toContain(`apps${sep}api${sep}package.json`);
      expect(result.stderr).toContain('found "0.3.0"');
    });
  });

  it("passes semver policy for pre-1.0 versions", async () => {
    await withTempWorkspace("validate-pass", async (workspaceRoot) => {
      await writeJsonFile(join(workspaceRoot, "package.json"), {
        name: "root",
        private: true,
        version: "0.7.4",
      });

      const result = runTypeScriptScript(VALIDATE_VERSION_SCRIPT, workspaceRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Version policy OK: 0.7.4 (pre-1.0 policy)");
      expect(result.stderr).toBe("");
    });
  });

  it("fails semver policy for major versions before v1 release", async () => {
    await withTempWorkspace("validate-fail", async (workspaceRoot) => {
      await writeJsonFile(join(workspaceRoot, "package.json"), {
        name: "root",
        private: true,
        version: "1.2.3",
      });

      const result = runTypeScriptScript(VALIDATE_VERSION_SCRIPT, workspaceRoot);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Version 1.2.3 is not allowed by pre-1.0 policy.");
      expect(result.stderr).toContain("ALLOW_V1_RELEASE=1");
    });
  });
});
