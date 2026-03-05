import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";

type ManifestContent = Record<string, unknown>;

type ManifestFixture = {
  path: string;
  content: ManifestContent;
};

type PolicyFixture = {
  manifests: readonly ManifestFixture[];
  lockfile: string;
};

type PolicyResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

const EFFECT_POLICY_SCRIPT = resolve(
  import.meta.dir,
  "../../scripts/guardrails/effect-v4-policy.ts",
);

const PASSING_LOCKFILE = `
{
  "packages": {
    "effect": ["effect@4.1.2", "", {}]
  }
}
`;

async function writeJson(filePath: string, value: ManifestContent): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function withFixture(
  fixture: PolicyFixture,
  run: (workspaceDir: string) => Promise<void>,
): Promise<void> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "effect-v4-policy-"));
  try {
    for (const manifest of fixture.manifests) {
      await writeJson(join(workspaceDir, manifest.path), manifest.content);
    }
    await writeFile(join(workspaceDir, "bun.lock"), `${fixture.lockfile.trim()}\n`, "utf8");
    await run(workspaceDir);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

function runPolicyCheck(workspaceDir: string): PolicyResult {
  const result = spawnSync("bun", ["run", EFFECT_POLICY_SCRIPT], {
    cwd: workspaceDir,
    encoding: "utf8",
  });

  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("effect-v4 dependency policy guardrail", () => {
  it("accepts compliant manifests and lockfile", async () => {
    await withFixture(
      {
        manifests: [
          {
            path: "package.json",
            content: {
              name: "fixture-root",
              private: true,
              dependencies: {
                effect: "^4.1.0",
              },
            },
          },
          {
            path: "apps/api/package.json",
            content: {
              name: "fixture-api",
              private: true,
              peerDependencies: {
                effect: ">=4 <5",
              },
            },
          },
        ],
        lockfile: PASSING_LOCKFILE,
      },
      async (workspaceDir) => {
        const result = runPolicyCheck(workspaceDir);
        expect(result.exitCode).toBe(0);
        expect(result.stderr.trim()).toBe("");
        expect(result.stdout).toContain("Effect v4 dependency policy check passed");
      },
    );
  });

  it("rejects disallowed legacy Effect package dependencies", async () => {
    await withFixture(
      {
        manifests: [
          {
            path: "package.json",
            content: {
              name: "fixture-root",
              private: true,
              dependencies: {
                effect: "^4.1.0",
                "@effect/data": "^0.18.0",
              },
            },
          },
        ],
        lockfile: PASSING_LOCKFILE,
      },
      async (workspaceDir) => {
        const result = runPolicyCheck(workspaceDir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Effect v4 dependency policy violations detected:");
        expect(result.stderr).toContain(
          'package.json#dependencies: disallowed Effect dependency "@effect/data" detected.',
        );
      },
    );
  });

  it("rejects non-v4 resolved effect versions in bun.lock", async () => {
    await withFixture(
      {
        manifests: [
          {
            path: "package.json",
            content: {
              name: "fixture-root",
              private: true,
              dependencies: {
                effect: "^4.1.0",
              },
            },
          },
        ],
        lockfile: `
{
  "packages": {
    "effect": ["effect@3.16.0", "", {}]
  }
}
`,
      },
      async (workspaceDir) => {
        const result = runPolicyCheck(workspaceDir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Effect v4 dependency policy violations detected:");
        expect(result.stderr).toContain(
          'bun.lock#packages: resolved effect version must be v4 (found "3.16.0").',
        );
      },
    );
  });
});
