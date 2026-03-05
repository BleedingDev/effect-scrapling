import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "@effect-native/bun-test";

type CommandResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type GeneratedFixture = {
  readonly moduleName: string;
  readonly moduleDirectory: string;
  readonly generatedFilePaths: readonly [
    schemaFilePath: string,
    errorsFilePath: string,
    tagFilePath: string,
    layerFilePath: string,
    effectFilePath: string,
  ];
  readonly testFilePath: string;
};

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const TEMP_PATHS = new Set<string>();
const MODULE_DIRECTORY_NAME = "generated-modules";
const SOURCE_ROOT = join(REPO_ROOT, "libs", "foundation", "core", "src", MODULE_DIRECTORY_NAME);
const TEST_ROOT = join(
  REPO_ROOT,
  "tests",
  "generated-modules",
  "foundation-core",
  MODULE_DIRECTORY_NAME,
);
const TMP_ROOT = join(REPO_ROOT, "tmp");

function trackPath(path: string): string {
  TEMP_PATHS.add(path);
  return path;
}

function runCommand(command: readonly [string, ...string[]], cwd = REPO_ROOT): CommandResult {
  const run = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: "utf8",
  });

  return {
    status: run.status,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
  };
}

function getOutput(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function modulePaths(moduleName: string): GeneratedFixture {
  const moduleDirectory = trackPath(join(SOURCE_ROOT, moduleName));
  const testDirectory = TEST_ROOT;
  const generatedFilePaths = [
    join(moduleDirectory, `${moduleName}.schema.ts`),
    join(moduleDirectory, `${moduleName}.errors.ts`),
    join(moduleDirectory, `${moduleName}.tag.ts`),
    join(moduleDirectory, `${moduleName}.layer.ts`),
    join(moduleDirectory, `${moduleName}.effect.ts`),
  ] as const;
  const testFilePath = join(testDirectory, `${moduleName}.test.ts`);
  trackPath(testFilePath);

  return {
    moduleName,
    moduleDirectory,
    generatedFilePaths,
    testFilePath,
  };
}

function runGenerator(moduleName: string): CommandResult {
  return runCommand([
    "bunx",
    "--bun",
    "nx",
    "g",
    "./tools/ci/generators.json:compliant-module",
    `--project=foundation-core`,
    `--name=${moduleName}`,
    `--directory=${MODULE_DIRECTORY_NAME}`,
    "--no-interactive",
  ]);
}

async function readGeneratedContents(paths: readonly string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(
    paths.map(async (path) => [relative(REPO_ROOT, path), await readFile(path, "utf8")] as const),
  );
  return Object.fromEntries(entries);
}

function assertGeneratorSucceeded(result: CommandResult): void {
  if (result.status !== 0) {
    throw new Error(`Generator failed:\n${getOutput(result)}`);
  }
}

async function createTypecheckConfig(moduleName: string): Promise<string> {
  await mkdir(TMP_ROOT, { recursive: true });
  const tsconfigPath = trackPath(
    join(TMP_ROOT, `tsconfig-generated-module-${moduleName}-${randomUUID()}.json`),
  );
  const tsconfigRelative = relative(REPO_ROOT, tsconfigPath);

  const content = `{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "types": ["bun-types"],
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  },
  "include": [
    "../libs/foundation/core/src/${MODULE_DIRECTORY_NAME}/${moduleName}/**/*.ts"
  ]
}
`;

  await writeFile(tsconfigPath, content, "utf8");
  return tsconfigRelative;
}

afterEach(async () => {
  const paths = [...TEMP_PATHS].sort((left, right) => right.length - left.length);
  TEMP_PATHS.clear();
  await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
});

describe("nx compliant-module generator verification", () => {
  it("generates lintable, typecheckable, and runnable module scaffolding", async () => {
    const moduleName = `scaffold-${randomUUID().slice(0, 8)}`;
    const fixture = modulePaths(moduleName);

    assertGeneratorSucceeded(runGenerator(moduleName));

    for (const filePath of [...fixture.generatedFilePaths, fixture.testFilePath]) {
      const content = await readFile(filePath, "utf8");
      expect(content.length).toBeGreaterThan(0);
    }

    const schemaContent = await readFile(fixture.generatedFilePaths[0], "utf8");
    const tagContent = await readFile(fixture.generatedFilePaths[2], "utf8");
    const layerContent = await readFile(fixture.generatedFilePaths[3], "utf8");
    const effectContent = await readFile(fixture.generatedFilePaths[4], "utf8");
    const testContent = await readFile(fixture.testFilePath, "utf8");

    expect(schemaContent).toContain("Schema.Struct");
    expect(tagContent).toContain("ServiceMap.Service");
    expect(layerContent).toContain("Layer.succeed");
    expect(effectContent).toContain("Effect.try");
    expect(testContent).toContain("@effect-native/bun-test");

    const fileArgs = [...fixture.generatedFilePaths, fixture.testFilePath].map((filePath) =>
      relative(REPO_ROOT, filePath),
    );

    const lintRun = runCommand(["bunx", "--bun", "oxlint", ...fileArgs]);
    expect(lintRun.status).toBe(0);

    const typecheckConfigPath = await createTypecheckConfig(moduleName);
    const typecheckRun = runCommand([
      "bunx",
      "--bun",
      "tsc",
      "--noEmit",
      "-p",
      typecheckConfigPath,
    ]);
    expect(typecheckRun.status).toBe(0);

    const generatedTestRun = runCommand(["bun", "test", relative(REPO_ROOT, fixture.testFilePath)]);
    expect(generatedTestRun.status).toBe(0);
  });

  it("is deterministic when re-run with the same options", async () => {
    const moduleName = `deterministic-${randomUUID().slice(0, 8)}`;
    const fixture = modulePaths(moduleName);

    assertGeneratorSucceeded(runGenerator(moduleName));
    const firstRunContents = await readGeneratedContents([
      ...fixture.generatedFilePaths,
      fixture.testFilePath,
    ]);

    assertGeneratorSucceeded(runGenerator(moduleName));
    const secondRunContents = await readGeneratedContents([
      ...fixture.generatedFilePaths,
      fixture.testFilePath,
    ]);

    expect(secondRunContents).toEqual(firstRunContents);
  });
});
