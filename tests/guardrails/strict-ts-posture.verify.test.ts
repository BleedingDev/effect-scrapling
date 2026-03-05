import { afterEach, describe, expect, it } from "@effect-native/bun-test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const STRICT_TS_POSTURE_SCRIPT = join(REPO_ROOT, "scripts/guardrails/strict-ts-posture.ts");
const TEMP_FIXTURES: string[] = [];

const TEXT_DECODER = new TextDecoder();

type StrictTsPostureRun = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

type FixtureOptions = {
  readonly baseTsConfig?: string;
  readonly guardrailsOverrides?: string;
  readonly projectTsConfig?: string;
  readonly libsProjectTsConfig?: string;
  readonly toolsProjectTsConfig?: string;
};

type PackageScripts = Record<string, string>;

const BASE_TSCONFIG = `{
  "compilerOptions": {
    "strict": true
  }
}
`;

const DEFAULT_GUARDRAILS_TSCONFIG = `{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true
  },
  "include": [
    "apps/**/*.ts",
    "libs/**/*.ts",
    "tools/**/*.ts"
  ]
}
`;

const DEFAULT_PROJECT_TSCONFIG = `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler"
  },
  "include": ["src/**/*.ts"]
}
`;

async function createFixture(files: Record<string, string>): Promise<string> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "strict-ts-posture-verify-"));
  TEMP_FIXTURES.push(fixtureRoot);

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(fixtureRoot, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }

  return fixtureRoot;
}

async function createStrictTsFixture(options: FixtureOptions = {}): Promise<string> {
  return createFixture({
    "tsconfig.base.json": options.baseTsConfig ?? BASE_TSCONFIG,
    "tsconfig.guardrails.json": options.guardrailsOverrides ?? DEFAULT_GUARDRAILS_TSCONFIG,
    "apps/api/tsconfig.json": options.projectTsConfig ?? DEFAULT_PROJECT_TSCONFIG,
    "libs/core/tsconfig.json":
      options.libsProjectTsConfig ??
      `{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
`,
    "tools/ci/tsconfig.json":
      options.toolsProjectTsConfig ??
      `{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
`,
  });
}

function runStrictTsPosture(fixtureRoot: string): StrictTsPostureRun {
  const result = Bun.spawnSync({
    cmd: ["bun", STRICT_TS_POSTURE_SCRIPT],
    cwd: fixtureRoot,
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stderr: TEXT_DECODER.decode(result.stderr),
    stdout: TEXT_DECODER.decode(result.stdout),
  };
}

function readViolationLines(stderr: string): readonly string[] {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

async function readPackageScripts(): Promise<PackageScripts> {
  const packageJsonPath = join(REPO_ROOT, "package.json");
  const packageJsonContent = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(packageJsonContent) as { scripts?: PackageScripts };
  return parsed.scripts ?? {};
}

afterEach(async () => {
  await Promise.all(
    TEMP_FIXTURES.splice(0).map((fixtureRoot) => rm(fixtureRoot, { force: true, recursive: true })),
  );
});

describe("strict TypeScript posture guardrail verification", () => {
  it("wires strict posture guardrail into package scripts and full check pipeline", async () => {
    const scripts = await readPackageScripts();
    expect(scripts["check:strict-ts-posture"]).toBe(
      "bun run scripts/guardrails/strict-ts-posture.ts",
    );
    expect(scripts.check).toContain("bun run check:strict-ts-posture");
  });

  it("passes on a compliant workspace fixture", async () => {
    const fixtureRoot = await createStrictTsFixture();
    const run = runStrictTsPosture(fixtureRoot);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("Strict TypeScript posture check passed");
    expect(run.stderr.trim()).toBe("");
  });

  it("fails when guardrail strict flags are missing", async () => {
    const fixtureRoot = await createStrictTsFixture({
      guardrailsOverrides: `{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "exactOptionalPropertyTypes": false,
    "noUncheckedIndexedAccess": false
  },
  "include": [
    "apps/**/*.ts",
    "libs/**/*.ts",
    "tools/**/*.ts"
  ]
}
`,
    });
    const run = runStrictTsPosture(fixtureRoot);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("Strict TypeScript posture check failed:");
    expect(run.stderr).toContain(
      "tsconfig.guardrails.json#compilerOptions.exactOptionalPropertyTypes must be true.",
    );
    expect(run.stderr).toContain(
      "tsconfig.guardrails.json#compilerOptions.noUncheckedIndexedAccess must be true.",
    );
    expect(run.stdout.trim()).toBe("");
  });

  it("fails when workspace project config does not inherit tsconfig.base.json", async () => {
    const fixtureRoot = await createStrictTsFixture({
      projectTsConfig: `{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler"
  },
  "include": ["src/**/*.ts"]
}
`,
    });
    const run = runStrictTsPosture(fixtureRoot);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("Strict TypeScript posture check failed:");
    expect(run.stderr).toContain("apps/api/tsconfig.json must extend tsconfig.base.json.");
    expect(run.stdout.trim()).toBe("");
  });

  it("fails when a workspace project disables noImplicitAny", async () => {
    const fixtureRoot = await createStrictTsFixture({
      projectTsConfig: `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noImplicitAny": false
  },
  "include": ["src/**/*.ts"]
}
`,
    });
    const run = runStrictTsPosture(fixtureRoot);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("Strict TypeScript posture check failed:");
    expect(run.stderr).toContain(
      "apps/api/tsconfig.json#compilerOptions.noImplicitAny must resolve to true.",
    );
    expect(run.stdout.trim()).toBe("");
  });

  it("fails when tsconfig.base.json does not enforce strict noImplicitAny posture", async () => {
    const fixtureRoot = await createStrictTsFixture({
      baseTsConfig: `{
  "compilerOptions": {
    "strict": false
  }
}
`,
    });
    const run = runStrictTsPosture(fixtureRoot);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("Strict TypeScript posture check failed:");
    expect(run.stderr).toContain("tsconfig.base.json#compilerOptions.strict must be true.");
    expect(run.stderr).toContain(
      "tsconfig.base.json must enforce compilerOptions.noImplicitAny via compilerOptions.strict=true or noImplicitAny=true.",
    );
    expect(run.stdout.trim()).toBe("");
  });

  it("fails when guardrails config stops inheriting base strict posture and misses include coverage", async () => {
    const fixtureRoot = await createStrictTsFixture({
      guardrailsOverrides: `{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true
  },
  "include": [
    "apps/**/*.ts",
    "libs/**/*.ts"
  ]
}
`,
    });
    const run = runStrictTsPosture(fixtureRoot);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("Strict TypeScript posture check failed:");
    expect(run.stderr).toContain(
      "tsconfig.guardrails.json must extend tsconfig.base.json to inherit strict compiler posture.",
    );
    expect(run.stderr).toContain('tsconfig.guardrails.json#include must contain "tools/**/*.ts".');
    expect(run.stdout.trim()).toBe("");
  });

  it("fails when a workspace project disables exactOptionalPropertyTypes", async () => {
    const fixtureRoot = await createStrictTsFixture({
      projectTsConfig: `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "exactOptionalPropertyTypes": false
  },
  "include": ["src/**/*.ts"]
}
`,
    });
    const run = runStrictTsPosture(fixtureRoot);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("Strict TypeScript posture check failed:");
    expect(run.stderr).toContain(
      "apps/api/tsconfig.json must not disable compilerOptions.exactOptionalPropertyTypes.",
    );
    expect(run.stdout.trim()).toBe("");
  });

  it("sorts fail-path violations deterministically", async () => {
    const fixtureRoot = await createStrictTsFixture({
      baseTsConfig: `{
  "compilerOptions": {
    "strict": false
  }
}
`,
      guardrailsOverrides: `{
  "compilerOptions": {
    "exactOptionalPropertyTypes": false,
    "noUncheckedIndexedAccess": true
  },
  "include": ["apps/**/*.ts"]
}
`,
      projectTsConfig: `{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler"
  },
  "include": ["src/**/*.ts"]
}
`,
      libsProjectTsConfig: `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noUncheckedIndexedAccess": false
  },
  "include": ["src/**/*.ts"]
}
`,
      toolsProjectTsConfig: `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "exactOptionalPropertyTypes": false
  },
  "include": ["src/**/*.ts"]
}
`,
    });
    const run = runStrictTsPosture(fixtureRoot);
    const violationLines = readViolationLines(run.stderr);
    const sortedViolations = [...violationLines].sort((left, right) => left.localeCompare(right));

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("Strict TypeScript posture check failed:");
    expect(violationLines.length).toBeGreaterThan(3);
    expect(violationLines).toEqual(sortedViolations);
    expect(run.stdout.trim()).toBe("");
  });
});
