#!/usr/bin/env bun

import { chmod, cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { Effect, Schema } from "effect";
import {
  loadSurfsharkGeneratedManifest,
  loadSurfsharkWireproxyManifest,
  resolveBundledSurfsharkWireGuardAssetPaths,
  type SurfsharkGeneratedManifest,
  type SurfsharkWireproxyManifest,
} from "../../src/sdk/surfshark-wireguard-runtime.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const SOURCE_CONFIG_ROOT_DEFAULT =
  "/Users/satan/code/trading-agent/trading_workspace/us_equities_watchlist/config";

const ImportCliOptionsSchema = Schema.Struct({
  sourceConfigRoot: NonEmptyStringSchema,
  targetRoot: NonEmptyStringSchema,
  cleanTarget: Schema.Boolean,
});

export type E9ImportSurfsharkWireGuardAssetsCliOptions = Schema.Schema.Type<
  typeof ImportCliOptionsSchema
>;

export type ImportedSurfsharkWireGuardAssetSummary = {
  readonly sourceConfigRoot: string;
  readonly targetRoot: string;
  readonly generatedManifestPath: string;
  readonly wireproxyManifestPath: string;
  readonly wireguardConfigCount: number;
  readonly wireproxyConfigCount: number;
  readonly proxyListSocksPath: string;
  readonly proxyListHttpPath: string;
};

function sourceWireguardManifestPath(sourceConfigRoot: string) {
  return resolve(sourceConfigRoot, "surfshark_wg", "surfshark_generated_manifest.json");
}

function sourceWireproxyManifestPath(sourceConfigRoot: string) {
  return resolve(sourceConfigRoot, "wireproxy_pool", "wireproxy_pool_manifest.json");
}

function sourceHealthySocksPath(sourceConfigRoot: string) {
  return resolve(sourceConfigRoot, "proxy_pool_wireproxy_socks_healthy_20260311_refresh.txt");
}

function targetPaths(targetRoot: string) {
  return {
    rootDir: resolve(targetRoot),
    wireguardConfigDir: resolve(targetRoot, "surfshark_wg"),
    wireproxyConfigDir: resolve(targetRoot, "wireproxy_pool"),
    generatedManifestPath: resolve(targetRoot, "surfshark_wg", "surfshark_generated_manifest.json"),
    wireproxyManifestPath: resolve(targetRoot, "wireproxy_pool", "wireproxy_pool_manifest.json"),
    proxyListSocksPath: resolve(targetRoot, "proxy_pool_wireproxy_socks.txt"),
    proxyListHttpPath: resolve(targetRoot, "proxy_pool_wireproxy_http.txt"),
    healthyProxyListSocksPath: resolve(
      targetRoot,
      "proxy_pool_wireproxy_socks_healthy_20260311_refresh.txt",
    ),
    startScriptPath: resolve(targetRoot, "wireproxy_pool", "start_wireproxy_pool.sh"),
    stopScriptPath: resolve(targetRoot, "wireproxy_pool", "stop_wireproxy_pool.sh"),
    logDir: resolve(targetRoot, "wireproxy_pool", "logs"),
    pidDir: resolve(targetRoot, "wireproxy_pool", "pids"),
  };
}

export function parseOptions(args: readonly string[]): E9ImportSurfsharkWireGuardAssetsCliOptions {
  const bundled = resolveBundledSurfsharkWireGuardAssetPaths();
  let sourceConfigRoot = SOURCE_CONFIG_ROOT_DEFAULT;
  let targetRoot = bundled.rootDir;
  let cleanTarget = true;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const rawValue = args[index + 1];

    const expectValue = () => {
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error(`Missing value for argument: ${argument}`);
      }
      return rawValue;
    };

    switch (argument) {
      case "--source-config-root":
        sourceConfigRoot = Schema.decodeUnknownSync(NonEmptyStringSchema)(expectValue());
        index += 1;
        break;
      case "--target-root":
        targetRoot = Schema.decodeUnknownSync(NonEmptyStringSchema)(expectValue());
        index += 1;
        break;
      case "--no-clean-target":
        cleanTarget = false;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return Schema.decodeUnknownSync(ImportCliOptionsSchema)({
    sourceConfigRoot,
    targetRoot,
    cleanTarget,
  });
}

function createStartScript(input: { readonly entries: SurfsharkWireproxyManifest["entries"] }) {
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
    'WIREPROXY_BIN="${WIREPROXY_BIN:-wireproxy}"',
    'POOL_DIR="$SCRIPT_DIR"',
    'LOG_DIR="$POOL_DIR/logs"',
    'PID_DIR="$POOL_DIR/pids"',
    'mkdir -p "$LOG_DIR" "$PID_DIR"',
    'if ! command -v "$WIREPROXY_BIN" >/dev/null 2>&1; then',
    '  echo "wireproxy binary not found: $WIREPROXY_BIN" >&2',
    "  exit 1",
    "fi",
    "",
  ];

  for (const entry of input.entries) {
    const wireproxyConfigBasename = basename(entry.wireproxyConfig);
    const logBasename = basename(entry.logFile);
    const pidBasename = basename(entry.pidFile);
    lines.push(`echo "starting ${entry.name} -> $POOL_DIR/${wireproxyConfigBasename}"`);
    lines.push(
      `nohup "$WIREPROXY_BIN" -c "$POOL_DIR/${wireproxyConfigBasename}" > "$LOG_DIR/${logBasename}" 2>&1 &`,
    );
    lines.push(`echo $! > "$PID_DIR/${pidBasename}"`);
    lines.push("");
  }

  lines.push('echo "wireproxy pool started."');
  return `${lines.join("\n")}\n`;
}

function createStopScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_DIR="$SCRIPT_DIR/pids"
if [ ! -d "$PID_DIR" ]; then
  echo "PID directory not found: $PID_DIR" >&2
  exit 0
fi
for f in "$PID_DIR"/*.pid; do
  [ -e "$f" ] || continue
  pid=$(cat "$f" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" || true
  fi
  rm -f "$f"
done
echo "wireproxy pool stopped."
`;
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyReferencedFiles(
  references: ReadonlyArray<{ readonly sourcePath: string; readonly targetPath: string }>,
) {
  for (const reference of references) {
    await mkdir(dirname(reference.targetPath), { recursive: true });
    await cp(reference.sourcePath, reference.targetPath, { force: true });
  }
}

async function assertFileExists(path: string, subject: string) {
  if (await pathExists(path)) {
    return;
  }

  throw new Error(`${subject} does not exist: ${path}`);
}

function pathsOverlap(left: string, right: string) {
  if (left === right) {
    return true;
  }

  const leftRelative = relative(left, right);
  if (leftRelative !== "" && !leftRelative.startsWith(`..${sep}`) && leftRelative !== "..") {
    return true;
  }

  const rightRelative = relative(right, left);
  return rightRelative !== "" && !rightRelative.startsWith(`..${sep}`) && rightRelative !== "..";
}

export async function importSurfsharkWireGuardAssets(input: {
  readonly sourceConfigRoot: string;
  readonly targetRoot: string;
  readonly cleanTarget?: boolean | undefined;
}): Promise<ImportedSurfsharkWireGuardAssetSummary> {
  const sourceConfigRoot = resolve(input.sourceConfigRoot);
  const targetRoot = resolve(input.targetRoot);
  if (pathsOverlap(sourceConfigRoot, targetRoot)) {
    throw new Error(
      `Source and target roots must not overlap: ${sourceConfigRoot} <-> ${targetRoot}`,
    );
  }
  const nextPaths = targetPaths(targetRoot);
  const generatedManifest = await loadSurfsharkGeneratedManifest(
    sourceWireguardManifestPath(sourceConfigRoot),
  ).pipe(Effect.runPromise);
  const wireproxyManifest = await loadSurfsharkWireproxyManifest(
    sourceWireproxyManifestPath(sourceConfigRoot),
  ).pipe(Effect.runPromise);
  const copiedWireguardFiles = new Map<string, string>();

  for (const entry of generatedManifest.entries) {
    copiedWireguardFiles.set(
      entry.file,
      resolve(nextPaths.wireguardConfigDir, basename(entry.file)),
    );
  }
  for (const entry of wireproxyManifest.entries) {
    copiedWireguardFiles.set(
      entry.wireguardConfig,
      resolve(nextPaths.wireguardConfigDir, basename(entry.wireguardConfig)),
    );
  }
  const requiredSourceFiles = [
    ...[...copiedWireguardFiles.keys()].map((path) => ({
      path,
      subject: "Referenced WireGuard config",
    })),
    ...wireproxyManifest.entries.map((entry) => ({
      path: entry.wireproxyConfig,
      subject: `Referenced wireproxy config for ${entry.name}`,
    })),
  ];
  for (const reference of requiredSourceFiles) {
    await assertFileExists(reference.path, reference.subject);
  }

  if (input.cleanTarget ?? true) {
    await rm(nextPaths.rootDir, { force: true, recursive: true });
  }

  await mkdir(nextPaths.wireguardConfigDir, { recursive: true });
  await mkdir(nextPaths.wireproxyConfigDir, { recursive: true });
  await mkdir(nextPaths.logDir, { recursive: true });
  await mkdir(nextPaths.pidDir, { recursive: true });

  const rewrittenGeneratedManifest: SurfsharkGeneratedManifest = {
    generatedAtUtc: new Date().toISOString(),
    outputDir: nextPaths.wireguardConfigDir,
    manifestOut: nextPaths.generatedManifestPath,
    countWritten: generatedManifest.entries.length,
    entries: generatedManifest.entries.map((entry) => ({
      ...entry,
      file: copiedWireguardFiles.get(entry.file)!,
    })),
  };

  const rewrittenWireproxyEntries: SurfsharkWireproxyManifest["entries"] =
    wireproxyManifest.entries.map((entry) => ({
      ...entry,
      wireguardConfig: copiedWireguardFiles.get(entry.wireguardConfig)!,
      wireproxyConfig: resolve(nextPaths.wireproxyConfigDir, basename(entry.wireproxyConfig)),
      logFile: resolve(nextPaths.logDir, basename(entry.logFile)),
      pidFile: resolve(nextPaths.pidDir, basename(entry.pidFile)),
    }));

  const rewrittenWireproxyManifest: SurfsharkWireproxyManifest = {
    generatedAtUtc: new Date().toISOString(),
    wireproxyBin: "wireproxy",
    wireguardConfigDir: nextPaths.wireguardConfigDir,
    poolSize: rewrittenWireproxyEntries.length,
    outputDir: nextPaths.wireproxyConfigDir,
    proxyListSocksFile: nextPaths.proxyListSocksPath,
    proxyListHttpFile: nextPaths.proxyListHttpPath,
    startScript: nextPaths.startScriptPath,
    stopScript: nextPaths.stopScriptPath,
    entries: rewrittenWireproxyEntries,
  };

  await copyReferencedFiles(
    [...copiedWireguardFiles.entries()].map(([sourcePath, targetPath]) => ({
      sourcePath,
      targetPath,
    })),
  );
  await copyReferencedFiles(
    wireproxyManifest.entries.map((entry, index) => ({
      sourcePath: entry.wireproxyConfig,
      targetPath: rewrittenWireproxyEntries[index]!.wireproxyConfig,
    })),
  );

  await writeFile(
    nextPaths.proxyListSocksPath,
    `${rewrittenWireproxyEntries.map((entry) => entry.socksProxy).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    nextPaths.proxyListHttpPath,
    `${rewrittenWireproxyEntries.map((entry) => entry.httpProxy).join("\n")}\n`,
    "utf8",
  );

  const healthySocksSource = sourceHealthySocksPath(sourceConfigRoot);
  if (await pathExists(healthySocksSource)) {
    await cp(healthySocksSource, nextPaths.healthyProxyListSocksPath, { force: true });
  }

  await writeFile(
    nextPaths.generatedManifestPath,
    `${JSON.stringify(
      {
        generated_at_utc: rewrittenGeneratedManifest.generatedAtUtc,
        output_dir: ".",
        manifest_out: "./surfshark_generated_manifest.json",
        count_written: rewrittenGeneratedManifest.countWritten,
        entries: rewrittenGeneratedManifest.entries.map((entry) => ({
          file: `./${basename(entry.file)}`,
          cluster_id: entry.clusterId,
          cluster_type: entry.clusterType,
          country_code: entry.countryCode,
          location: entry.location,
          connection_name: entry.connectionName,
          ...(entry.load === undefined ? {} : { load: entry.load }),
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(
    nextPaths.wireproxyManifestPath,
    `${JSON.stringify(
      {
        generated_at_utc: rewrittenWireproxyManifest.generatedAtUtc,
        wireproxy_bin: rewrittenWireproxyManifest.wireproxyBin,
        wireguard_config_dir: "../surfshark_wg",
        pool_size: rewrittenWireproxyManifest.poolSize,
        output_dir: ".",
        proxy_list_socks_file: "../proxy_pool_wireproxy_socks.txt",
        proxy_list_http_file: "../proxy_pool_wireproxy_http.txt",
        start_script: "./start_wireproxy_pool.sh",
        stop_script: "./stop_wireproxy_pool.sh",
        entries: rewrittenWireproxyManifest.entries.map((entry) => ({
          name: entry.name,
          wireguard_config: `../surfshark_wg/${basename(entry.wireguardConfig)}`,
          wireproxy_config: `./${basename(entry.wireproxyConfig)}`,
          socks_proxy: entry.socksProxy,
          http_proxy: entry.httpProxy,
          log_file: `./logs/${basename(entry.logFile)}`,
          pid_file: `./pids/${basename(entry.pidFile)}`,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(
    nextPaths.startScriptPath,
    createStartScript({
      entries: rewrittenWireproxyEntries,
    }),
    "utf8",
  );
  await writeFile(nextPaths.stopScriptPath, createStopScript(), "utf8");
  await chmod(nextPaths.startScriptPath, 0o755);
  await chmod(nextPaths.stopScriptPath, 0o755);

  return {
    sourceConfigRoot,
    targetRoot,
    generatedManifestPath: nextPaths.generatedManifestPath,
    wireproxyManifestPath: nextPaths.wireproxyManifestPath,
    wireguardConfigCount: copiedWireguardFiles.size,
    wireproxyConfigCount: rewrittenWireproxyEntries.length,
    proxyListSocksPath: nextPaths.proxyListSocksPath,
    proxyListHttpPath: nextPaths.proxyListHttpPath,
  };
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  console.log(
    JSON.stringify(
      await importSurfsharkWireGuardAssets({
        sourceConfigRoot: options.sourceConfigRoot,
        targetRoot: options.targetRoot,
        cleanTarget: options.cleanTarget,
      }),
      null,
      2,
    ),
  );
}
