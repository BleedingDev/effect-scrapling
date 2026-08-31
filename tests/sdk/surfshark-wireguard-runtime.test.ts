import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect } from "effect";
import { createEngine } from "../../src/sdk/engine.ts";
import {
  buildSurfsharkWireGuardModule,
  ensureSurfsharkWireproxyPoolReady,
  loadBundledSurfsharkWireGuardModule,
  loadSurfsharkGeneratedManifest,
  loadSurfsharkWireGuardModule,
  loadSurfsharkWireproxyManifest,
  resolveBundledSurfsharkWireGuardAssetPaths,
  surfsharkWireGuardProfileId,
} from "../../src/sdk/surfshark-wireguard-runtime.ts";

const wireproxyManifestFixture = {
  generated_at_utc: "2026-03-13T00:00:00Z",
  wireguard_config_dir: "/tmp/wg",
  output_dir: "/tmp/wireproxy",
  pool_size: 3,
  entries: [
    {
      name: "cz_prague_fixture",
      wireguard_config: "/tmp/wg/cz_prague_fixture.conf",
      wireproxy_config: "/tmp/wireproxy/cz_prague_fixture_wireproxy.conf",
      socks_proxy: "socks5h://127.0.0.1:19080",
      http_proxy: "http://127.0.0.1:29080",
      log_file: "/tmp/wireproxy/logs/cz_prague_fixture.log",
      pid_file: "/tmp/wireproxy/pids/cz_prague_fixture.pid",
    },
    {
      name: "de_berlin_fixture",
      wireguard_config: "/tmp/wg/de_berlin_fixture.conf",
      wireproxy_config: "/tmp/wireproxy/de_berlin_fixture_wireproxy.conf",
      socks_proxy: "socks5h://127.0.0.1:19081",
      http_proxy: "http://127.0.0.1:29081",
      log_file: "/tmp/wireproxy/logs/de_berlin_fixture.log",
      pid_file: "/tmp/wireproxy/pids/de_berlin_fixture.pid",
    },
    {
      name: "us_new-york_fixture",
      wireguard_config: "/tmp/wg/us_new-york_fixture.conf",
      wireproxy_config: "/tmp/wireproxy/us_new-york_fixture_wireproxy.conf",
      socks_proxy: "socks5h://127.0.0.1:19082",
      http_proxy: "http://127.0.0.1:29082",
      log_file: "/tmp/wireproxy/logs/us_new-york_fixture.log",
      pid_file: "/tmp/wireproxy/pids/us_new-york_fixture.pid",
    },
  ],
} as const;

const generatedManifestFixture = {
  generated_at_utc: "2026-03-13T00:00:00Z",
  output_dir: "/tmp/wg",
  count_written: 3,
  entries: [
    {
      file: "/tmp/wg/cz_prague_fixture.conf",
      cluster_id: "cz-fixture-cluster",
      cluster_type: "generic",
      country_code: "CZ",
      location: "Prague",
      connection_name: "cz-prg.prod.surfshark.com",
      load: 17,
    },
    {
      file: "/tmp/wg/de_berlin_fixture.conf",
      cluster_id: "de-fixture-cluster",
      cluster_type: "generic",
      country_code: "DE",
      location: "Berlin",
      connection_name: "de-ber.prod.surfshark.com",
      load: 12,
    },
    {
      file: "/tmp/wg/us_new-york_fixture.conf",
      cluster_id: "us-fixture-cluster",
      cluster_type: "static",
      country_code: "US",
      location: "New York",
      connection_name: "us-nyc.prod.surfshark.com",
      load: 24,
    },
  ],
} as const;

const mockFetch = async (input: RequestInfo | URL) => {
  const response = new Response("<html><body><h1>WireGuard Probe</h1></body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  Object.defineProperty(response, "url", {
    value: new Request(input).url,
    configurable: true,
  });
  return response;
};

async function allocateLoopbackPort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Failed to allocate a loopback port."));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

const allocatePort = allocateLoopbackPort;

function isLoopbackListenPermissionError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EPERM"
  );
}

async function startLoopbackServer(port: number) {
  const server = createServer((socket) => {
    socket.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return server;
}

describe("sdk surfshark wireguard runtime", () => {
  it("loads the bundled Surfshark asset manifests from the repo vendor bundle", async () => {
    const bundled = resolveBundledSurfsharkWireGuardAssetPaths();

    const wireproxyManifest = await Effect.runPromise(
      loadSurfsharkWireproxyManifest(bundled.wireproxyManifestPath),
    );
    const generatedManifest = await Effect.runPromise(
      loadSurfsharkGeneratedManifest(bundled.generatedManifestPath),
    );
    const module = await Effect.runPromise(
      loadBundledSurfsharkWireGuardModule({
        includeEntryNames: ["cz_prague_5368a311"],
        transport: "http",
      }),
    );

    expect(wireproxyManifest.entries.length).toBeGreaterThan(0);
    expect(wireproxyManifest.wireproxyBin).toBe(join(bundled.rootDir, "bin/wireproxy"));
    expect(generatedManifest.entries.length).toBeGreaterThanOrEqual(
      wireproxyManifest.entries.length,
    );
    expect(
      module.egressProfiles?.[surfsharkWireGuardProfileId("cz_prague_5368a311")],
    ).toMatchObject({
      routeConfig: {
        kind: "wireguard",
      },
    });
  });

  it("verifies already-live selected wireproxy endpoints without attempting startup", async () => {
    const port = await allocateLoopbackPort().catch((error) => {
      if (isLoopbackListenPermissionError(error)) {
        return undefined;
      }
      throw error;
    });
    if (port === undefined) {
      return;
    }
    const server = await startLoopbackServer(port);

    try {
      const readiness = await Effect.runPromise(
        ensureSurfsharkWireproxyPoolReady({
          wireproxyManifest: {
            wireguardConfigDir: "/tmp/wg",
            outputDir: "/tmp/wireproxy",
            poolSize: 1,
            entries: [
              {
                name: "ready_fixture",
                wireguardConfig: "/tmp/wg/ready_fixture.conf",
                wireproxyConfig: "/tmp/wireproxy/ready_fixture_wireproxy.conf",
                socksProxy: "socks5h://127.0.0.1:19099",
                httpProxy: `http://127.0.0.1:${port}`,
                logFile: "/tmp/wireproxy/logs/ready_fixture.log",
                pidFile: "/tmp/wireproxy/pids/ready_fixture.pid",
              },
            ],
          },
          entryNames: ["ready_fixture"],
          transport: "http",
          probeTimeoutMs: 100,
        }),
      );

      expect(readiness).toMatchObject({
        selectedEntryNames: ["ready_fixture"],
        transport: "http",
        attemptedStart: false,
        startedPool: false,
      });
      expect(readiness.endpointProbes).toEqual([
        expect.objectContaining({
          entryName: "ready_fixture",
          reachable: true,
        }),
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("fails fast with an actionable error when the configured wireproxy binary is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "surfshark-wireproxy-missing-bin-"));

    try {
      const startScript = join(directory, "start_wireproxy_pool.sh");
      await writeFile(startScript, "#!/usr/bin/env bash\nexit 0\n", "utf8");
      await chmod(startScript, 0o755);

      await expect(
        Effect.runPromise(
          ensureSurfsharkWireproxyPoolReady({
            wireproxyManifest: {
              wireproxyBin: join(directory, "missing-wireproxy"),
              wireguardConfigDir: "/tmp/wg",
              outputDir: directory,
              poolSize: 1,
              startScript,
              entries: [
                {
                  name: "missing_bin_fixture",
                  wireguardConfig: "/tmp/wg/missing_bin_fixture.conf",
                  wireproxyConfig: join(directory, "missing_bin_fixture_wireproxy.conf"),
                  socksProxy: "socks5h://127.0.0.1:19150",
                  httpProxy: "http://127.0.0.1:29150",
                  logFile: join(directory, "logs/missing_bin_fixture.log"),
                  pidFile: join(directory, "pids/missing_bin_fixture.pid"),
                },
              ],
            },
            entryNames: ["missing_bin_fixture"],
            transport: "http",
            probeTimeoutMs: 50,
          }),
        ),
      ).rejects.toMatchObject({
        message: "Surfshark wireproxy binary is not executable",
        details: `Expected an executable wireproxy binary at: ${join(directory, "missing-wireproxy")}.`,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("can start a selected wireproxy entry through the manifest lifecycle hooks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "surfshark-wireproxy-autostart-"));
    const pidFile = join(directory, "pids/autostart_fixture.pid");

    try {
      const httpPort = await allocateLoopbackPort().catch((error) => {
        if (isLoopbackListenPermissionError(error)) {
          return undefined;
        }
        throw error;
      });
      if (httpPort === undefined) {
        return;
      }
      const socksPort = await allocateLoopbackPort().catch((error) => {
        if (isLoopbackListenPermissionError(error)) {
          return undefined;
        }
        throw error;
      });
      if (socksPort === undefined) {
        return;
      }
      const fakeWireproxyBin = join(directory, "fake-wireproxy.mjs");
      const startScript = join(directory, "start_wireproxy_pool.sh");
      const stopScript = join(directory, "stop_wireproxy_pool.sh");
      const configPath = join(directory, "autostart_fixture_wireproxy.conf");
      const logFile = join(directory, "logs/autostart_fixture.log");

      await mkdir(join(directory, "logs"), { recursive: true });
      await mkdir(join(directory, "pids"), { recursive: true });
      await writeFile(
        configPath,
        [
          "[Interface]",
          "PrivateKey = test-key",
          "Address = 10.14.0.2/16",
          "",
          "[Socks5]",
          `BindAddress = 127.0.0.1:${socksPort}`,
          "",
          "[http]",
          `BindAddress = 127.0.0.1:${httpPort}`,
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        fakeWireproxyBin,
        [
          "#!/usr/bin/env bun",
          "import { createServer } from 'node:net';",
          "import { readFileSync } from 'node:fs';",
          "const configPath = process.argv[process.argv.indexOf('-c') + 1];",
          "const config = readFileSync(configPath, 'utf8');",
          "const ports = [...config.matchAll(/BindAddress\\s*=\\s*127\\.0\\.0\\.1:(\\d+)/g)].map((match) => Number(match[1]));",
          "const servers = ports.map((port) => {",
          "  const server = createServer((socket) => socket.end());",
          "  server.listen(port, '127.0.0.1');",
          "  return server;",
          "});",
          "const shutdown = () => {",
          "  for (const server of servers) { server.close(); }",
          "  process.exit(0);",
          "};",
          "process.on('SIGTERM', shutdown);",
          "process.on('SIGINT', shutdown);",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(fakeWireproxyBin, 0o755);
      await writeFile(
        startScript,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `ROOT=${JSON.stringify(directory)}`,
          'mkdir -p "$ROOT/logs" "$ROOT/pids"',
          `nohup "$WIREPROXY_BIN" -c ${JSON.stringify(configPath)} > ${JSON.stringify(logFile)} 2>&1 &`,
          `echo $! > ${JSON.stringify(pidFile)}`,
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(startScript, 0o755);
      await writeFile(
        stopScript,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `if [ -f ${JSON.stringify(pidFile)} ]; then`,
          `  pid=$(cat ${JSON.stringify(pidFile)})`,
          '  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then',
          '    kill "$pid" || true',
          "  fi",
          `  rm -f ${JSON.stringify(pidFile)}`,
          "fi",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(stopScript, 0o755);

      const readiness = await Effect.runPromise(
        ensureSurfsharkWireproxyPoolReady({
          wireproxyManifest: {
            wireproxyBin: fakeWireproxyBin,
            wireguardConfigDir: "/tmp/wg",
            outputDir: directory,
            poolSize: 1,
            startScript,
            stopScript,
            entries: [
              {
                name: "autostart_fixture",
                wireguardConfig: "/tmp/wg/autostart_fixture.conf",
                wireproxyConfig: configPath,
                socksProxy: `socks5h://127.0.0.1:${socksPort}`,
                httpProxy: `http://127.0.0.1:${httpPort}`,
                logFile,
                pidFile,
              },
            ],
          },
          entryNames: ["autostart_fixture"],
          transport: "http",
          probeTimeoutMs: 50,
          startTimeoutMs: 2_000,
        }),
      );

      expect(readiness).toMatchObject({
        selectedEntryNames: ["autostart_fixture"],
        transport: "http",
        attemptedStart: true,
        startedPool: true,
        wireproxyBinPath: fakeWireproxyBin,
      });
      expect(readiness.endpointProbes).toEqual([
        expect.objectContaining({
          entryName: "autostart_fixture",
          reachable: true,
        }),
      ]);
    } finally {
      const pid = await readFile(pidFile, "utf8").catch(() => undefined);
      const numericPid = Number(pid?.trim());
      if (Number.isInteger(numericPid) && numericPid > 0) {
        try {
          process.kill(numericPid, "SIGTERM");
        } catch {}
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("loads and validates the wireproxy manifest shape", async () => {
    const directory = await mkdtemp(join(tmpdir(), "surfshark-wireproxy-manifest-"));

    try {
      const manifestPath = join(directory, "wireproxy_pool_manifest.json");
      await writeFile(manifestPath, JSON.stringify(wireproxyManifestFixture));

      const manifest = await Effect.runPromise(loadSurfsharkWireproxyManifest(manifestPath));

      expect(manifest.poolSize).toBe(3);
      expect(manifest.entries).toHaveLength(3);
      expect(manifest.entries[0]?.name).toBe("cz_prague_fixture");
      expect(manifest.entries[0]?.socksProxy).toBe("socks5h://127.0.0.1:19080");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("resolves relative manifest paths against the manifest location", async () => {
    const directory = await mkdtemp(join(tmpdir(), "surfshark-wireproxy-relative-"));

    try {
      const wireproxyDir = join(directory, "wireproxy_pool");
      const wireguardDir = join(directory, "surfshark_wg");
      await mkdir(wireproxyDir, { recursive: true });
      await mkdir(wireguardDir, { recursive: true });
      await Bun.write(
        join(wireproxyDir, "wireproxy_pool_manifest.json"),
        JSON.stringify({
          ...wireproxyManifestFixture,
          wireguard_config_dir: "../surfshark_wg",
          output_dir: ".",
          wireproxy_bin: "../bin/fake-wireproxy",
          proxy_list_socks_file: "../proxy_pool_wireproxy_socks.txt",
          proxy_list_http_file: "../proxy_pool_wireproxy_http.txt",
          start_script: "./start_wireproxy_pool.sh",
          stop_script: "./stop_wireproxy_pool.sh",
          entries: wireproxyManifestFixture.entries.map((entry) => ({
            ...entry,
            wireguard_config: `../surfshark_wg/${basename(entry.wireguard_config)}`,
            wireproxy_config: `./${basename(entry.wireproxy_config)}`,
            log_file: `./logs/${basename(entry.log_file)}`,
            pid_file: `./pids/${basename(entry.pid_file)}`,
          })),
        }),
      );
      await Bun.write(
        join(wireguardDir, "surfshark_generated_manifest.json"),
        JSON.stringify({
          ...generatedManifestFixture,
          output_dir: ".",
          manifest_out: "./surfshark_generated_manifest.json",
          entries: generatedManifestFixture.entries.map((entry) => ({
            ...entry,
            file: `./${basename(entry.file)}`,
          })),
        }),
      );

      const wireproxyManifest = await Effect.runPromise(
        loadSurfsharkWireproxyManifest(join(wireproxyDir, "wireproxy_pool_manifest.json")),
      );
      const generatedManifest = await Effect.runPromise(
        loadSurfsharkGeneratedManifest(join(wireguardDir, "surfshark_generated_manifest.json")),
      );

      expect(wireproxyManifest.wireguardConfigDir).toBe(wireguardDir);
      expect(wireproxyManifest.wireproxyBin).toBe(join(directory, "bin/fake-wireproxy"));
      expect(wireproxyManifest.entries[0]?.wireguardConfig).toBe(
        join(wireguardDir, "cz_prague_fixture.conf"),
      );
      expect(generatedManifest.outputDir).toBe(wireguardDir);
      expect(generatedManifest.entries[0]?.file).toBe(join(wireguardDir, "cz_prague_fixture.conf"));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects malformed wireproxy pool_size values instead of silently falling back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "surfshark-wireproxy-invalid-pool-size-"));

    try {
      const manifestPath = join(directory, "wireproxy_pool_manifest.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          ...wireproxyManifestFixture,
          pool_size: "three",
        }),
      );

      await expect(
        Effect.runPromise(loadSurfsharkWireproxyManifest(manifestPath)),
      ).rejects.toMatchObject({
        message: "Invalid Surfshark wireproxy manifest",
        details:
          'Expected optional non-negative integer field "pool_size" in Surfshark wireproxy manifest.',
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("loads the generated Surfshark manifest and preserves country metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "surfshark-generated-manifest-"));

    try {
      const manifestPath = join(directory, "surfshark_generated_manifest.json");
      await writeFile(manifestPath, JSON.stringify(generatedManifestFixture));

      const manifest = await Effect.runPromise(loadSurfsharkGeneratedManifest(manifestPath));

      expect(manifest.countWritten).toBe(3);
      expect(manifest.entries[0]?.countryCode).toBe("CZ");
      expect(manifest.entries[1]?.connectionName).toBe("de-ber.prod.surfshark.com");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects malformed generated load values at parse time", async () => {
    const directory = await mkdtemp(join(tmpdir(), "surfshark-generated-invalid-load-"));

    try {
      const manifestPath = join(directory, "surfshark_generated_manifest.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          ...generatedManifestFixture,
          entries: [
            {
              ...generatedManifestFixture.entries[0],
              load: -1,
            },
          ],
        }),
      );

      await expect(
        Effect.runPromise(loadSurfsharkGeneratedManifest(manifestPath)),
      ).rejects.toMatchObject({
        message: "Invalid Surfshark generated manifest entry",
        details:
          'Expected optional non-negative integer field "load" in Surfshark generated manifest entry.',
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects malformed generated count_written values at parse time", async () => {
    const directory = await mkdtemp(join(tmpdir(), "surfshark-generated-invalid-count-written-"));

    try {
      const manifestPath = join(directory, "surfshark_generated_manifest.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          ...generatedManifestFixture,
          count_written: -1,
        }),
      );

      await expect(
        Effect.runPromise(loadSurfsharkGeneratedManifest(manifestPath)),
      ).rejects.toMatchObject({
        message: "Invalid Surfshark generated manifest",
        details:
          'Expected optional non-negative integer field "count_written" in Surfshark generated manifest.',
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("builds wireguard profiles from the manifests and filters by country", async () => {
    const module = await Effect.runPromise(
      buildSurfsharkWireGuardModule({
        wireproxyManifest: {
          generatedAtUtc: wireproxyManifestFixture.generated_at_utc,
          wireguardConfigDir: wireproxyManifestFixture.wireguard_config_dir,
          outputDir: wireproxyManifestFixture.output_dir,
          poolSize: wireproxyManifestFixture.pool_size,
          entries: wireproxyManifestFixture.entries.map((entry) => ({
            name: entry.name,
            wireguardConfig: entry.wireguard_config,
            wireproxyConfig: entry.wireproxy_config,
            socksProxy: entry.socks_proxy,
            httpProxy: entry.http_proxy,
            logFile: entry.log_file,
            pidFile: entry.pid_file,
          })),
        },
        generatedManifest: {
          generatedAtUtc: generatedManifestFixture.generated_at_utc,
          outputDir: generatedManifestFixture.output_dir,
          countWritten: generatedManifestFixture.count_written,
          entries: generatedManifestFixture.entries.map((entry) => ({
            file: entry.file,
            clusterId: entry.cluster_id,
            clusterType: entry.cluster_type,
            countryCode: entry.country_code,
            location: entry.location,
            connectionName: entry.connection_name,
            load: entry.load,
          })),
        },
        includeCountryCodes: ["CZ", "DE"],
      }),
    );

    expect(module.id).toBe("surfshark-wireguard-module");
    expect(Object.keys(module.egressProfiles ?? {})).toEqual([
      surfsharkWireGuardProfileId("cz_prague_fixture"),
      surfsharkWireGuardProfileId("de_berlin_fixture"),
    ]);
    expect(module.egressProfiles?.[surfsharkWireGuardProfileId("cz_prague_fixture")]).toMatchObject(
      {
        pluginId: "builtin-wireguard-egress",
        poolId: "surfshark-wireguard-pool-cz_prague_fixture",
        routePolicyId: "surfshark-wireguard-route-cz_prague_fixture",
        routeKind: "wireguard",
        routeConfig: {
          kind: "wireguard",
          proxyUrl: "socks5h://127.0.0.1:19080",
          endpoint: "cz-prg.prod.surfshark.com",
          exitNodeId: "cz-fixture-cluster",
        },
      },
    );
    expect(module.egressProfiles?.[surfsharkWireGuardProfileId("de_berlin_fixture")]).toMatchObject(
      {
        poolId: "surfshark-wireguard-pool-de_berlin_fixture",
        routePolicyId: "surfshark-wireguard-route-de_berlin_fixture",
      },
    );
  });

  it("fails fast when country filters are requested without generated metadata", async () => {
    await expect(
      Effect.runPromise(
        buildSurfsharkWireGuardModule({
          wireproxyManifest: {
            generatedAtUtc: wireproxyManifestFixture.generated_at_utc,
            wireguardConfigDir: wireproxyManifestFixture.wireguard_config_dir,
            outputDir: wireproxyManifestFixture.output_dir,
            poolSize: wireproxyManifestFixture.pool_size,
            entries: wireproxyManifestFixture.entries.map((entry) => ({
              name: entry.name,
              wireguardConfig: entry.wireguard_config,
              wireproxyConfig: entry.wireproxy_config,
              socksProxy: entry.socks_proxy,
              httpProxy: entry.http_proxy,
              logFile: entry.log_file,
              pidFile: entry.pid_file,
            })),
          },
          includeCountryCodes: ["CZ"],
        }),
      ),
    ).rejects.toMatchObject({
      message: "Surfshark country filters require generated metadata",
      details:
        "Pass a Surfshark generated manifest before filtering WireGuard entries by country code.",
    });
  });

  it("joins generated metadata through wireguard config basename instead of manifest label", async () => {
    const module = await Effect.runPromise(
      buildSurfsharkWireGuardModule({
        wireproxyManifest: {
          generatedAtUtc: wireproxyManifestFixture.generated_at_utc,
          wireguardConfigDir: wireproxyManifestFixture.wireguard_config_dir,
          outputDir: wireproxyManifestFixture.output_dir,
          poolSize: 1,
          entries: [
            {
              name: "cz_prague_alias",
              wireguardConfig: "/tmp/wg/cz_prague_fixture.conf",
              wireproxyConfig: "/tmp/wireproxy/cz_prague_alias_wireproxy.conf",
              socksProxy: "socks5h://127.0.0.1:19080",
              httpProxy: "http://127.0.0.1:29080",
              logFile: "/tmp/wireproxy/logs/cz_prague_alias.log",
              pidFile: "/tmp/wireproxy/pids/cz_prague_alias.pid",
            },
          ],
        },
        generatedManifest: {
          generatedAtUtc: generatedManifestFixture.generated_at_utc,
          outputDir: generatedManifestFixture.output_dir,
          countWritten: generatedManifestFixture.count_written,
          entries: generatedManifestFixture.entries.map((entry) => ({
            file: entry.file,
            clusterId: entry.cluster_id,
            clusterType: entry.cluster_type,
            countryCode: entry.country_code,
            location: entry.location,
            connectionName: entry.connection_name,
            load: entry.load,
          })),
        },
        includeCountryCodes: ["CZ"],
      }),
    );

    expect(Object.keys(module.egressProfiles ?? {})).toEqual([
      surfsharkWireGuardProfileId("cz_prague_alias"),
    ]);
    expect(module.egressProfiles?.[surfsharkWireGuardProfileId("cz_prague_alias")]).toMatchObject({
      routeConfig: {
        endpoint: "cz-prg.prod.surfshark.com",
        exitNodeId: "cz-fixture-cluster",
      },
    });
  });

  it("treats Windows and POSIX config paths as the same basename when validating generated metadata", async () => {
    await expect(
      Effect.runPromise(
        buildSurfsharkWireGuardModule({
          wireproxyManifest: {
            generatedAtUtc: wireproxyManifestFixture.generated_at_utc,
            wireguardConfigDir: wireproxyManifestFixture.wireguard_config_dir,
            outputDir: wireproxyManifestFixture.output_dir,
            poolSize: 1,
            entries: [
              {
                name: "cz_prague_fixture",
                wireguardConfig: "C:\\WG\\CZ_PRAGUE_FIXTURE.CONF",
                wireproxyConfig: "/tmp/wireproxy/cz_prague_fixture_wireproxy.conf",
                socksProxy: "socks5h://127.0.0.1:19080",
                httpProxy: "http://127.0.0.1:29080",
                logFile: "/tmp/wireproxy/logs/cz_prague_fixture.log",
                pidFile: "/tmp/wireproxy/pids/cz_prague_fixture.pid",
              },
            ],
          },
          generatedManifest: {
            generatedAtUtc: generatedManifestFixture.generated_at_utc,
            outputDir: generatedManifestFixture.output_dir,
            countWritten: 2,
            entries: [
              {
                file: "/tmp/wg/cz_prague_fixture.conf",
                clusterId: "cz-fixture-cluster",
                clusterType: "generic",
                countryCode: "CZ",
                location: "Prague",
                connectionName: "cz-prg.prod.surfshark.com",
                load: 17,
              },
              {
                file: "C:\\wg\\cz_prague_fixture.conf",
                clusterId: "cz-fixture-cluster-duplicate",
                clusterType: "generic",
                countryCode: "CZ",
                location: "Prague",
                connectionName: "cz-prg-dup.prod.surfshark.com",
                load: 18,
              },
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({
      message: "Invalid Surfshark generated manifest",
      details: "Duplicate generated manifest basenames are not allowed: cz_prague_fixture.",
    });
  });

  it("fails closed when different wireproxy entry names share the same config basename", async () => {
    await expect(
      Effect.runPromise(
        buildSurfsharkWireGuardModule({
          wireproxyManifest: {
            generatedAtUtc: wireproxyManifestFixture.generated_at_utc,
            wireguardConfigDir: wireproxyManifestFixture.wireguard_config_dir,
            outputDir: wireproxyManifestFixture.output_dir,
            poolSize: 2,
            entries: [
              {
                name: "cz_prague_fixture_a",
                wireguardConfig: "/tmp/wg/cz_prague_fixture.conf",
                wireproxyConfig: "/tmp/wireproxy/cz_prague_fixture_a_wireproxy.conf",
                socksProxy: "socks5h://127.0.0.1:19080",
                httpProxy: "http://127.0.0.1:29080",
                logFile: "/tmp/wireproxy/logs/cz_prague_fixture_a.log",
                pidFile: "/tmp/wireproxy/pids/cz_prague_fixture_a.pid",
              },
              {
                name: "cz_prague_fixture_b",
                wireguardConfig: "C:\\WG\\CZ_PRAGUE_FIXTURE.CONF",
                wireproxyConfig: "/tmp/wireproxy/cz_prague_fixture_b_wireproxy.conf",
                socksProxy: "socks5h://127.0.0.1:19081",
                httpProxy: "http://127.0.0.1:29081",
                logFile: "/tmp/wireproxy/logs/cz_prague_fixture_b.log",
                pidFile: "/tmp/wireproxy/pids/cz_prague_fixture_b.pid",
              },
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({
      message: "Invalid Surfshark wireproxy manifest",
      details: "Duplicate wireguard config basenames are not allowed: cz_prague_fixture.",
    });
  });

  it("fails closed on duplicate manifest keys and missing country codes", async () => {
    await expect(
      Effect.runPromise(
        buildSurfsharkWireGuardModule({
          wireproxyManifest: {
            generatedAtUtc: wireproxyManifestFixture.generated_at_utc,
            wireguardConfigDir: wireproxyManifestFixture.wireguard_config_dir,
            outputDir: wireproxyManifestFixture.output_dir,
            poolSize: 4,
            entries: [
              ...wireproxyManifestFixture.entries.map((entry) => ({
                name: entry.name,
                wireguardConfig: entry.wireguard_config,
                wireproxyConfig: entry.wireproxy_config,
                socksProxy: entry.socks_proxy,
                httpProxy: entry.http_proxy,
                logFile: entry.log_file,
                pidFile: entry.pid_file,
              })),
              {
                name: "cz_prague_fixture",
                wireguardConfig: "/tmp/wg/cz_prague_fixture_duplicate.conf",
                wireproxyConfig: "/tmp/wireproxy/cz_prague_fixture_duplicate_wireproxy.conf",
                socksProxy: "socks5h://127.0.0.1:19090",
                httpProxy: "http://127.0.0.1:29090",
                logFile: "/tmp/wireproxy/logs/cz_prague_fixture_duplicate.log",
                pidFile: "/tmp/wireproxy/pids/cz_prague_fixture_duplicate.pid",
              },
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({
      message: "Invalid Surfshark wireproxy manifest",
      details: "Duplicate wireproxy entry names are not allowed: cz_prague_fixture.",
    });

    await expect(
      Effect.runPromise(
        buildSurfsharkWireGuardModule({
          wireproxyManifest: {
            generatedAtUtc: wireproxyManifestFixture.generated_at_utc,
            wireguardConfigDir: wireproxyManifestFixture.wireguard_config_dir,
            outputDir: wireproxyManifestFixture.output_dir,
            poolSize: wireproxyManifestFixture.pool_size,
            entries: wireproxyManifestFixture.entries.map((entry) => ({
              name: entry.name,
              wireguardConfig: entry.wireguard_config,
              wireproxyConfig: entry.wireproxy_config,
              socksProxy: entry.socks_proxy,
              httpProxy: entry.http_proxy,
              logFile: entry.log_file,
              pidFile: entry.pid_file,
            })),
          },
          generatedManifest: {
            generatedAtUtc: generatedManifestFixture.generated_at_utc,
            outputDir: generatedManifestFixture.output_dir,
            countWritten: generatedManifestFixture.count_written,
            entries: [
              ...generatedManifestFixture.entries.map((entry) => ({
                file: entry.file,
                clusterId: entry.cluster_id,
                clusterType: entry.cluster_type,
                countryCode: entry.country_code,
                location: entry.location,
                connectionName: entry.connection_name,
                load: entry.load,
              })),
              {
                file: "/tmp/wg/cz_prague_fixture.conf",
                clusterId: "duplicate-fixture-cluster",
                clusterType: "generic",
                countryCode: "CZ",
                location: "Prague Duplicate",
                connectionName: "cz-dup.prod.surfshark.com",
                load: 1,
              },
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({
      message: "Invalid Surfshark generated manifest",
      details: "Duplicate generated manifest basenames are not allowed: cz_prague_fixture.",
    });

    await expect(
      Effect.runPromise(
        buildSurfsharkWireGuardModule({
          wireproxyManifest: {
            generatedAtUtc: wireproxyManifestFixture.generated_at_utc,
            wireguardConfigDir: wireproxyManifestFixture.wireguard_config_dir,
            outputDir: wireproxyManifestFixture.output_dir,
            poolSize: wireproxyManifestFixture.pool_size,
            entries: wireproxyManifestFixture.entries.map((entry) => ({
              name: entry.name,
              wireguardConfig: entry.wireguard_config,
              wireproxyConfig: entry.wireproxy_config,
              socksProxy: entry.socks_proxy,
              httpProxy: entry.http_proxy,
              logFile: entry.log_file,
              pidFile: entry.pid_file,
            })),
          },
          generatedManifest: {
            generatedAtUtc: generatedManifestFixture.generated_at_utc,
            outputDir: generatedManifestFixture.output_dir,
            countWritten: generatedManifestFixture.count_written,
            entries: generatedManifestFixture.entries.map((entry) => ({
              file: entry.file,
              clusterId: entry.cluster_id,
              clusterType: entry.cluster_type,
              countryCode: entry.country_code,
              location: entry.location,
              connectionName: entry.connection_name,
              load: entry.load,
            })),
          },
          includeCountryCodes: ["CZ", "ZZ"],
        }),
      ),
    ).rejects.toMatchObject({
      message: "Unknown Surfshark WireGuard country code",
      details: "No generated Surfshark metadata matched country code: ZZ.",
    });
  });

  it("surfaces specific unknown entry and unknown country errors even when no entries are selected", async () => {
    await expect(
      Effect.runPromise(
        buildSurfsharkWireGuardModule({
          wireproxyManifest: {
            generatedAtUtc: wireproxyManifestFixture.generated_at_utc,
            wireguardConfigDir: wireproxyManifestFixture.wireguard_config_dir,
            outputDir: wireproxyManifestFixture.output_dir,
            poolSize: wireproxyManifestFixture.pool_size,
            entries: wireproxyManifestFixture.entries.map((entry) => ({
              name: entry.name,
              wireguardConfig: entry.wireguard_config,
              wireproxyConfig: entry.wireproxy_config,
              socksProxy: entry.socks_proxy,
              httpProxy: entry.http_proxy,
              logFile: entry.log_file,
              pidFile: entry.pid_file,
            })),
          },
          includeEntryNames: ["missing-entry"],
        }),
      ),
    ).rejects.toMatchObject({
      message: "Unknown Surfshark WireGuard entry",
      details: "No wireproxy manifest entry matched: missing-entry.",
    });

    await expect(
      Effect.runPromise(
        buildSurfsharkWireGuardModule({
          wireproxyManifest: {
            generatedAtUtc: wireproxyManifestFixture.generated_at_utc,
            wireguardConfigDir: wireproxyManifestFixture.wireguard_config_dir,
            outputDir: wireproxyManifestFixture.output_dir,
            poolSize: wireproxyManifestFixture.pool_size,
            entries: wireproxyManifestFixture.entries.map((entry) => ({
              name: entry.name,
              wireguardConfig: entry.wireguard_config,
              wireproxyConfig: entry.wireproxy_config,
              socksProxy: entry.socks_proxy,
              httpProxy: entry.http_proxy,
              logFile: entry.log_file,
              pidFile: entry.pid_file,
            })),
          },
          generatedManifest: {
            generatedAtUtc: generatedManifestFixture.generated_at_utc,
            outputDir: generatedManifestFixture.output_dir,
            countWritten: generatedManifestFixture.count_written,
            entries: generatedManifestFixture.entries.map((entry) => ({
              file: entry.file,
              clusterId: entry.cluster_id,
              clusterType: entry.cluster_type,
              countryCode: entry.country_code,
              location: entry.location,
              connectionName: entry.connection_name,
              load: entry.load,
            })),
          },
          includeCountryCodes: ["ZZ"],
        }),
      ),
    ).rejects.toMatchObject({
      message: "Unknown Surfshark WireGuard country code",
      details: "No generated Surfshark metadata matched country code: ZZ.",
    });
  });

  it.effect(
    "loads a module from manifest paths and links generated profiles through the engine",
    () =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const directory = yield* Effect.tryPromise({
            try: () => mkdtemp(join(tmpdir(), "surfshark-wireguard-module-")),
            catch: (error) => new Error(String(error)),
          });
          const wireproxyManifestPath = join(directory, "wireproxy_pool_manifest.json");
          const generatedManifestPath = join(directory, "surfshark_generated_manifest.json");
          yield* Effect.tryPromise({
            try: async () => {
              await writeFile(wireproxyManifestPath, JSON.stringify(wireproxyManifestFixture));
              await writeFile(generatedManifestPath, JSON.stringify(generatedManifestFixture));
            },
            catch: (error) => new Error(String(error)),
          });

          const module = yield* loadSurfsharkWireGuardModule({
            wireproxyManifestPath,
            generatedManifestPath,
            includeEntryNames: ["cz_prague_fixture"],
            transport: "http",
          });
          const engine = yield* createEngine({
            fetchClient: mockFetch,
            modules: [module],
          });

          return {
            directory,
            engine,
          };
        }),
        ({ engine }) =>
          Effect.gen(function* () {
            const profileId = surfsharkWireGuardProfileId("cz_prague_fixture");
            const linking = yield* engine.inspectLinkSnapshot();
            const trace = yield* engine.explainAccessPreview({
              url: "https://example.com/wireguard",
              execution: {
                egress: {
                  profileId,
                },
              },
            });

            expect(linking.egressProfileIds).toContain(profileId);
            expect(trace.resolved.egress.profileId).toBe(profileId);
            expect(trace.resolved.egress.routeKind).toBe("wireguard");
          }),
        ({ directory, engine }) =>
          engine.close.pipe(
            Effect.andThen(
              Effect.tryPromise({
                try: () => rm(directory, { force: true, recursive: true }),
                catch: () => undefined,
              }),
            ),
          ),
      ),
  );

  it("prefers the WIREPROXY_BIN override when starting the wireproxy pool", async () => {
    const directory = await mkdtemp(join(tmpdir(), "surfshark-wireproxy-env-override-"));

    try {
      const port = await allocatePort().catch((error) => {
        if (isLoopbackListenPermissionError(error)) {
          return undefined;
        }
        throw error;
      });
      if (port === undefined) {
        return;
      }
      const poolDir = join(directory, "wireproxy_pool");
      const wireguardDir = join(directory, "surfshark_wg");
      const pidDir = join(poolDir, "pids");
      const logDir = join(poolDir, "logs");
      await mkdir(poolDir, { recursive: true });
      await mkdir(wireguardDir, { recursive: true });
      await mkdir(pidDir, { recursive: true });
      await mkdir(logDir, { recursive: true });

      const entryName = "cz_prague_fixture";
      const pidFile = join(pidDir, `${entryName}.pid`);
      const logFile = join(logDir, `${entryName}.log`);
      const fakeBinary = join(directory, "fake-wireproxy.sh");
      const startScript = join(poolDir, "start_wireproxy_pool.sh");
      const stopScript = join(poolDir, "stop_wireproxy_pool.sh");
      const manifestPath = join(poolDir, "wireproxy_pool_manifest.json");

      await writeFile(
        fakeBinary,
        `#!/usr/bin/env bash
set -euo pipefail
port="$1"
exec python3 -m http.server "$port" --bind 127.0.0.1
`,
      );
      await writeFile(
        startScript,
        `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/pids/${entryName}.pid"
LOG_FILE="$SCRIPT_DIR/logs/${entryName}.log"
nohup "$WIREPROXY_BIN" ${port} > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
`,
      );
      await writeFile(
        stopScript,
        `#!/usr/bin/env bash
set -euo pipefail
PID_FILE="$(cd "$(dirname "$0")" && pwd)/pids/${entryName}.pid"
if [ -f "$PID_FILE" ]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" || true
  fi
  rm -f "$PID_FILE"
fi
`,
      );
      await chmod(fakeBinary, 0o755);
      await chmod(startScript, 0o755);
      await chmod(stopScript, 0o755);
      await writeFile(
        manifestPath,
        JSON.stringify({
          generated_at_utc: "2026-03-13T00:00:00Z",
          wireproxy_bin: "/definitely/missing/wireproxy",
          wireguard_config_dir: wireguardDir,
          output_dir: poolDir,
          start_script: startScript,
          stop_script: stopScript,
          pool_size: 1,
          entries: [
            {
              name: entryName,
              wireguard_config: join(wireguardDir, `${entryName}.conf`),
              wireproxy_config: join(poolDir, `${entryName}_wireproxy.conf`),
              socks_proxy: `socks5h://127.0.0.1:${port}`,
              http_proxy: `http://127.0.0.1:${port}`,
              log_file: logFile,
              pid_file: pidFile,
            },
          ],
        }),
      );

      const manifest = await Effect.runPromise(loadSurfsharkWireproxyManifest(manifestPath));
      const previousOverride = process.env.WIREPROXY_BIN;
      process.env.WIREPROXY_BIN = fakeBinary;

      try {
        const readiness = await Effect.runPromise(
          ensureSurfsharkWireproxyPoolReady({
            wireproxyManifest: manifest,
            transport: "http",
            entryNames: [entryName],
            probeTimeoutMs: 50,
            startTimeoutMs: 3_000,
          }),
        );

        expect(readiness.attemptedStart).toBe(true);
        expect(readiness.startedPool).toBe(true);
        expect(readiness.wireproxyBinPath).toBe(fakeBinary);
        expect(readiness.endpointProbes).toEqual([
          {
            entryName,
            transport: "http",
            proxyUrl: `http://127.0.0.1:${port}`,
            reachable: true,
          },
        ]);
      } finally {
        if (previousOverride === undefined) {
          delete process.env.WIREPROXY_BIN;
        } else {
          process.env.WIREPROXY_BIN = previousOverride;
        }
        Bun.spawnSync({
          cmd: [stopScript],
          cwd: dirname(stopScript),
          stderr: "ignore",
          stdout: "ignore",
        });
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
