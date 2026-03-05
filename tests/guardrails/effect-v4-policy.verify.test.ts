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
  lockfile?: string;
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

const LOCKFILE_WITH_DISALLOWED_EFFECT_PACKAGE = `
{
  "packages": {
    "effect": ["effect@4.1.2", "", {}],
    "@effect/data": ["@effect/data@0.18.0", "", {}]
  }
}
`;

const UNSUPPORTED_EFFECT_SPECIFIERS = [
  "",
  "*",
  "file:../effect",
  "link:../effect",
  "git+https://github.com/Effect-TS/effect.git",
  "github:Effect-TS/effect",
  "http://example.com/effect.tgz",
  "https://example.com/effect.tgz",
] as const;

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
    if (fixture.lockfile !== undefined) {
      await writeFile(join(workspaceDir, "bun.lock"), `${fixture.lockfile.trim()}\n`, "utf8");
    }
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

  it("accepts bounded v4 effect ranges", async () => {
    await withFixture(
      {
        manifests: [
          {
            path: "package.json",
            content: {
              name: "fixture-root",
              private: true,
              dependencies: {
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

  it("rejects non-v4 effect dependency ranges in manifests", async () => {
    await withFixture(
      {
        manifests: [
          {
            path: "package.json",
            content: {
              name: "fixture-root",
              private: true,
              dependencies: {
                effect: "^3.16.0",
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
          'package.json#dependencies: effect must use a v4-only semver range (found "^3.16.0").',
        );
      },
    );
  });

  it("rejects non-v4 effect dependency ranges in devDependencies", async () => {
    await withFixture(
      {
        manifests: [
          {
            path: "package.json",
            content: {
              name: "fixture-root",
              private: true,
              devDependencies: {
                effect: "^3.16.0",
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
          'package.json#devDependencies: effect must use a v4-only semver range (found "^3.16.0").',
        );
      },
    );
  });

  for (const section of ["peerDependencies", "optionalDependencies"] as const) {
    it(`rejects non-v4 effect dependency ranges in ${section}`, async () => {
      const manifestContent: ManifestContent = {
        name: "fixture-root",
        private: true,
        [section]: {
          effect: "^3.16.0",
        },
      };

      await withFixture(
        {
          manifests: [
            {
              path: "package.json",
              content: manifestContent,
            },
          ],
          lockfile: PASSING_LOCKFILE,
        },
        async (workspaceDir) => {
          const result = runPolicyCheck(workspaceDir);
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain("Effect v4 dependency policy violations detected:");
          expect(result.stderr).toContain(
            `package.json#${section}: effect must use a v4-only semver range (found "^3.16.0").`,
          );
        },
      );
    });
  }

  it("rejects aliases that resolve to non-v4 effect ranges", async () => {
    await withFixture(
      {
        manifests: [
          {
            path: "package.json",
            content: {
              name: "fixture-root",
              private: true,
              dependencies: {
                "@app/effect-alias": "npm:effect@^3.16.0",
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
          'package.json#dependencies: alias "@app/effect-alias" resolves to non-v4 effect range "npm:effect@^3.16.0".',
        );
      },
    );
  });

  it("rejects unsupported effect specifier formats", async () => {
    await withFixture(
      {
        manifests: [
          {
            path: "package.json",
            content: {
              name: "fixture-root",
              private: true,
              dependencies: {
                effect: "latest",
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
          'package.json#dependencies: effect must use a v4-only semver range (found "latest").',
        );
      },
    );
  });

  it("rejects workspace-prefixed effect specifiers", async () => {
    await withFixture(
      {
        manifests: [
          {
            path: "package.json",
            content: {
              name: "fixture-root",
              private: true,
              dependencies: {
                effect: "workspace:^4.1.0",
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
          'package.json#dependencies: effect must use a v4-only semver range (found "workspace:^4.1.0").',
        );
      },
    );
  });

  for (const unsupportedSpecifier of UNSUPPORTED_EFFECT_SPECIFIERS) {
    const testLabel = unsupportedSpecifier.length > 0 ? unsupportedSpecifier : "<empty>";
    it(`rejects unsupported effect specifier "${testLabel}"`, async () => {
      await withFixture(
        {
          manifests: [
            {
              path: "package.json",
              content: {
                name: "fixture-root",
                private: true,
                dependencies: {
                  effect: unsupportedSpecifier,
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
            `package.json#dependencies: effect must use a v4-only semver range (found "${unsupportedSpecifier}").`,
          );
        },
      );
    });
  }

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

  it("rejects disallowed Effect package entries from bun.lock", async () => {
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
        lockfile: LOCKFILE_WITH_DISALLOWED_EFFECT_PACKAGE,
      },
      async (workspaceDir) => {
        const result = runPolicyCheck(workspaceDir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Effect v4 dependency policy violations detected:");
        expect(result.stderr).toContain(
          'bun.lock: disallowed Effect dependency "@effect/data" detected.',
        );
      },
    );
  });

  it("rejects missing bun.lock", async () => {
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
      },
      async (workspaceDir) => {
        const result = runPolicyCheck(workspaceDir);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Effect v4 dependency policy violations detected:");
        expect(result.stderr).toContain(
          "bun.lock: bun.lock is required for deterministic dependency checks.",
        );
      },
    );
  });

  it("rejects unreadable package.json content", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "effect-v4-policy-"));
    try {
      await writeFile(join(workspaceDir, "package.json"), '{"name": "fixture",}', "utf8");
      await writeFile(join(workspaceDir, "bun.lock"), `${PASSING_LOCKFILE.trim()}\n`, "utf8");

      const result = runPolicyCheck(workspaceDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Effect v4 dependency policy violations detected:");
      expect(result.stderr).toContain("package.json: package.json is unreadable or invalid JSON.");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
