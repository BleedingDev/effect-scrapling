import { existsSync, readdirSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, setDefaultTimeout } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  E8ArtifactExportEnvelopeSchema,
  E8BenchmarkRunEnvelopeSchema,
  TargetImportEnvelopeSchema,
  TargetListEnvelopeSchema,
  WorkspaceConfigShowEnvelopeSchema,
  WorkspaceDoctorEnvelopeSchema,
} from "effect-scrapling/e8";
import { runE8SdkConsumerExample } from "../../examples/e8-sdk-consumer.ts";

const REPO_ROOT = import.meta.dir ? join(import.meta.dir, "..", "..") : process.cwd();
const EXAMPLE_PATH = join(REPO_ROOT, "examples", "e8-sdk-consumer.ts");
const FOUNDATION_CORE_ROOT = join(REPO_ROOT, "libs", "foundation", "core");
const BUN_BINARY = process.execPath;
const workspaceRequire = createRequire(import.meta.url);

setDefaultTimeout(120000);

async function runBun(cwd: string, args: readonly string[]) {
  const writableTempDirectory = join(cwd, ".bun-temp");
  const writableHomeDirectory = join(cwd, ".bun-home");
  const writableCacheDirectory = join(cwd, ".bun-cache");
  await mkdir(writableTempDirectory, { recursive: true });
  await mkdir(writableHomeDirectory, { recursive: true });
  await mkdir(writableCacheDirectory, { recursive: true });
  const effectiveArgs =
    args[0] === "install"
      ? ["install", "--backend=copyfile", "--cache-dir", writableCacheDirectory]
      : [...args];
  const processHandle = Bun.spawn({
    cmd: [BUN_BINARY, ...effectiveArgs],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      BUN_TMPDIR: writableTempDirectory,
      TEMP: writableTempDirectory,
      TMP: writableTempDirectory,
      TMPDIR: writableTempDirectory,
      HOME: writableHomeDirectory,
      XDG_CACHE_HOME: writableCacheDirectory,
      BUN_INSTALL_CACHE_DIR: join(writableCacheDirectory, "install"),
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `Command failed (${args.join(" ")}): ${stderr.trim() === "" ? stdout.trim() : stderr.trim()}`,
    );
  }

  return stdout.trim();
}

function readPackedTarballPath(output: string): string {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.endsWith(".tgz")) {
      return line;
    }
  }

  throw new Error(`Unable to locate packed tarball path in output:\n${output}`);
}

async function runCommand(cwd: string, command: string, args: readonly string[]) {
  const processHandle = Bun.spawn({
    cmd: [command, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `Command failed (${command} ${args.join(" ")}): ${
        stderr.trim() === "" ? stdout.trim() : stderr.trim()
      }`,
    );
  }
}

async function unpackTarball(cwd: string, tarballPath: string, destinationDirectory: string) {
  await mkdir(destinationDirectory, { recursive: true });
  await runCommand(cwd, "tar", [
    "-xzf",
    tarballPath,
    "-C",
    destinationDirectory,
    "--strip-components=1",
  ]);
}

async function linkWorkspaceDependency(consumerDirectory: string, packageName: string) {
  const resolvePackageRoot = () => {
    try {
      let currentDirectory = dirname(workspaceRequire.resolve(packageName));

      while (true) {
        if (existsSync(join(currentDirectory, "package.json"))) {
          return currentDirectory;
        }

        const parentDirectory = dirname(currentDirectory);
        if (parentDirectory === currentDirectory) {
          throw new Error(`Unable to resolve package root for ${packageName}.`);
        }
        currentDirectory = parentDirectory;
      }
    } catch {
      const bunStoreDirectory = join(REPO_ROOT, "node_modules", ".bun");
      const bunStoreEntry = readdirSync(bunStoreDirectory).find((entry) =>
        entry.startsWith(`${packageName}@`),
      );

      if (bunStoreEntry === undefined) {
        throw new Error(`Unable to resolve package root for ${packageName}.`);
      }

      return join(bunStoreDirectory, bunStoreEntry, "node_modules", packageName);
    }
  };
  const packageSegments = packageName.split("/");
  const sourceDirectory = resolvePackageRoot();
  const targetDirectory = join(consumerDirectory, "node_modules", ...packageSegments);

  await mkdir(join(targetDirectory, ".."), { recursive: true });
  await rm(targetDirectory, { recursive: true, force: true });
  await symlink(sourceDirectory, targetDirectory, "junction");
}

describe("E8 SDK consumer example", () => {
  it.effect("runs the public E8 consumer contract without private import leakage", () =>
    Effect.gen(function* () {
      const result = yield* runE8SdkConsumerExample();
      const doctor = Schema.decodeUnknownSync(WorkspaceDoctorEnvelopeSchema)(result.payload.doctor);
      const config = Schema.decodeUnknownSync(WorkspaceConfigShowEnvelopeSchema)(
        result.payload.config,
      );
      const targetImport = Schema.decodeUnknownSync(TargetImportEnvelopeSchema)(
        result.payload.targetImport,
      );
      const targetList = Schema.decodeUnknownSync(TargetListEnvelopeSchema)(
        result.payload.targetList,
      );
      const benchmarkRun = Schema.decodeUnknownSync(E8BenchmarkRunEnvelopeSchema)(
        result.payload.benchmarkRun,
      );
      const artifactExport = Schema.decodeUnknownSync(E8ArtifactExportEnvelopeSchema)(
        result.payload.artifactExport,
      );

      expect(result.importPath).toBe("effect-scrapling/e8");
      expect(
        result.prerequisites.some((entry: string) => entry.includes("effect-scrapling/e8")),
      ).toBe(true);
      expect(result.pitfalls.some((entry: string) => entry.includes("repository-private"))).toBe(
        true,
      );
      expect(doctor.command).toBe("doctor");
      expect(config.command).toBe("config show");
      expect(targetImport.command).toBe("target import");
      expect(targetImport.data.importedCount).toBe(2);
      expect(targetList.command).toBe("target list");
      expect(targetList.data.targets.map(({ id }) => id)).toEqual([
        "target-sdk-consumer-listing-001",
        "target-sdk-consumer-product-001",
      ]);
      expect(benchmarkRun.command).toBe("benchmark run");
      expect(artifactExport.command).toBe("artifact export");
      expect(artifactExport.data.artifact.metadata.sanitizedPathCount).toBeGreaterThanOrEqual(0);
    }),
  );

  it("keeps the example on the public E8 package import path only", async () => {
    const source = await Bun.file(EXAMPLE_PATH).text();
    const e8PublicModule = await import("effect-scrapling/e8");
    const importSpecifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].flatMap((match) => {
      const specifier = match[1];
      return specifier === undefined ? [] : [specifier];
    });

    expect(importSpecifiers).toEqual(["effect", "effect-scrapling/e8"]);
    expect("provideSdkRuntime" in e8PublicModule).toBe(false);
    expect("provideSdkEnvironment" in e8PublicModule).toBe(false);
    expect(source.includes("../src/")).toBeFalse();
    expect(source.includes("../scripts/")).toBeFalse();
    expect(source.includes("../libs/")).toBeFalse();
  });

  it("installs the packed public SDK surface into a downstream consumer", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "e8-sdk-pack-"));
    const packsDirectory = join(tempRoot, "packs");
    const consumerDirectory = join(tempRoot, "consumer");

    try {
      await mkdir(packsDirectory, { recursive: true });
      await mkdir(consumerDirectory, { recursive: true });

      const effectScraplingPackOutput = await runBun(REPO_ROOT, [
        "pm",
        "pack",
        "--destination",
        packsDirectory,
      ]);
      const foundationCorePackOutput = await runBun(FOUNDATION_CORE_ROOT, [
        "pm",
        "pack",
        "--destination",
        packsDirectory,
      ]);
      const effectScraplingTarball = readPackedTarballPath(effectScraplingPackOutput);
      const foundationCoreTarball = readPackedTarballPath(foundationCorePackOutput);
      await writeFile(
        join(consumerDirectory, "package.json"),
        `${JSON.stringify(
          {
            name: "e8-sdk-consumer-smoke",
            type: "module",
            dependencies: {
              "@effect-scrapling/foundation-core": foundationCoreTarball,
              "effect-scrapling": effectScraplingTarball,
            },
            overrides: {
              "@effect-scrapling/foundation-core": foundationCoreTarball,
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await mkdir(join(consumerDirectory, "node_modules"), { recursive: true });
      await unpackTarball(
        REPO_ROOT,
        effectScraplingTarball,
        join(consumerDirectory, "node_modules", "effect-scrapling"),
      );
      await unpackTarball(
        REPO_ROOT,
        foundationCoreTarball,
        join(consumerDirectory, "node_modules", "@effect-scrapling", "foundation-core"),
      );
      for (const dependency of ["effect", "cheerio", "domhandler", "patchright"]) {
        await linkWorkspaceDependency(consumerDirectory, dependency);
      }
      await writeFile(
        join(consumerDirectory, "consumer.ts"),
        [
          'import { Effect } from "effect";',
          'import { runTargetListOperation, runWorkspaceDoctor } from "effect-scrapling/e8";',
          "",
          "const result = await Effect.runPromise(runWorkspaceDoctor());",
          "const targets = await Effect.runPromise(",
          "  runTargetListOperation({",
          "    targets: [",
          "      {",
          '        id: "target-smoke-001",',
          '        tenantId: "tenant-main",',
          '        domain: "shop.example.com",',
          '        kind: "productPage",',
          '        canonicalKey: "productPage/target-smoke-001",',
          '        seedUrls: ["https://shop.example.com/target-smoke-001"],',
          '        accessPolicyId: "policy-default",',
          '        packId: "pack-shop-example-com",',
          "        priority: 10,",
          "      },",
          "    ],",
          "  }),",
          ");",
          "console.log(JSON.stringify({ ok: result.ok, command: result.command, targetCount: targets.data.count }));",
          "",
        ].join("\n"),
        "utf8",
      );

      await runBun(consumerDirectory, ["run", "consumer.ts"]);

      const installedManifest = JSON.parse(
        await readFile(
          join(consumerDirectory, "node_modules", "effect-scrapling", "package.json"),
          "utf8",
        ),
      ) as { readonly private?: boolean; readonly dependencies?: Record<string, string> };
      await access(
        join(
          consumerDirectory,
          "node_modules",
          "@effect-scrapling",
          "foundation-core",
          "package.json",
        ),
      );

      expect(installedManifest.private).toBe(false);
      expect(installedManifest.dependencies?.["@effect-scrapling/foundation-core"]).toBe("0.0.1");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
