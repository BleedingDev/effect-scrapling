import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect } from "effect";
import {
  importSurfsharkWireGuardAssets,
  parseOptions,
} from "../../scripts/benchmarks/e9-import-surfshark-wireguard-assets.ts";
import {
  loadSurfsharkGeneratedManifest,
  loadSurfsharkWireproxyManifest,
} from "../../src/sdk/surfshark-wireguard-runtime.ts";

describe("e9 import surfshark wireguard assets", () => {
  it("parses CLI options with explicit overrides", () => {
    expect(
      parseOptions([
        "--source-config-root",
        "/tmp/source-config",
        "--target-root",
        "/tmp/target-config",
        "--no-clean-target",
      ]),
    ).toEqual({
      sourceConfigRoot: "/tmp/source-config",
      targetRoot: "/tmp/target-config",
      cleanTarget: false,
    });
  });

  it("imports trading-agent style manifests into the bundled repo layout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effect-scrapling-wireguard-import-"));
    const sourceConfigRoot = join(directory, "source-config");
    const sourceWgDir = join(sourceConfigRoot, "surfshark_wg");
    const sourceWireproxyDir = join(sourceConfigRoot, "wireproxy_pool");
    const targetRoot = join(directory, "target-config");

    try {
      await mkdir(sourceWgDir, { recursive: true });
      await mkdir(sourceWireproxyDir, { recursive: true });
      await Bun.write(
        join(sourceWgDir, "cz_prague_fixture.conf"),
        "[Interface]\nPrivateKey = test\n",
      );
      await Bun.write(
        join(sourceWireproxyDir, "cz_prague_fixture_wireproxy.conf"),
        "[Interface]\nPrivateKey = test\n\n[Socks5]\nBindAddress = 127.0.0.1:19080\n\n[http]\nBindAddress = 127.0.0.1:29080\n",
      );
      await writeFile(
        join(sourceWgDir, "surfshark_generated_manifest.json"),
        `${JSON.stringify(
          {
            generated_at_utc: "2026-03-14T00:00:00Z",
            output_dir: sourceWgDir,
            manifest_out: join(sourceWgDir, "surfshark_generated_manifest.json"),
            count_written: 1,
            entries: [
              {
                file: join(sourceWgDir, "cz_prague_fixture.conf"),
                cluster_id: "fixture-cluster",
                cluster_type: "generic",
                country_code: "CZ",
                location: "Prague",
                connection_name: "cz-prg.prod.surfshark.com",
                load: 17,
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        join(sourceWireproxyDir, "wireproxy_pool_manifest.json"),
        `${JSON.stringify(
          {
            generated_at_utc: "2026-03-14T00:00:00Z",
            wireproxy_bin: "wireproxy",
            wireguard_config_dir: sourceWgDir,
            output_dir: sourceWireproxyDir,
            pool_size: 1,
            proxy_list_socks_file: join(sourceConfigRoot, "proxy_pool_wireproxy_socks.txt"),
            proxy_list_http_file: join(sourceConfigRoot, "proxy_pool_wireproxy_http.txt"),
            start_script: join(sourceWireproxyDir, "start_wireproxy_pool.sh"),
            stop_script: join(sourceWireproxyDir, "stop_wireproxy_pool.sh"),
            entries: [
              {
                name: "cz_prague_fixture",
                wireguard_config: join(sourceWgDir, "cz_prague_fixture.conf"),
                wireproxy_config: join(sourceWireproxyDir, "cz_prague_fixture_wireproxy.conf"),
                socks_proxy: "socks5h://127.0.0.1:19080",
                http_proxy: "http://127.0.0.1:29080",
                log_file: join(sourceWireproxyDir, "logs", "cz_prague_fixture.log"),
                pid_file: join(sourceWireproxyDir, "pids", "cz_prague_fixture.pid"),
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await Bun.write(
        join(sourceConfigRoot, "proxy_pool_wireproxy_socks_healthy_20260311_refresh.txt"),
        "socks5h://127.0.0.1:19080\n",
      );

      const summary = await importSurfsharkWireGuardAssets({
        sourceConfigRoot,
        targetRoot,
      });

      expect(summary.wireguardConfigCount).toBe(1);
      expect(summary.wireproxyConfigCount).toBe(1);

      const generatedManifest = await loadSurfsharkGeneratedManifest(
        summary.generatedManifestPath,
      ).pipe(Effect.runPromise);
      const wireproxyManifest = await loadSurfsharkWireproxyManifest(
        summary.wireproxyManifestPath,
      ).pipe(Effect.runPromise);

      expect(generatedManifest.entries[0]?.file).toBe(
        join(targetRoot, "surfshark_wg", "cz_prague_fixture.conf"),
      );
      expect(wireproxyManifest.entries[0]).toMatchObject({
        name: "cz_prague_fixture",
        wireguardConfig: join(targetRoot, "surfshark_wg", "cz_prague_fixture.conf"),
        wireproxyConfig: join(targetRoot, "wireproxy_pool", "cz_prague_fixture_wireproxy.conf"),
        logFile: join(targetRoot, "wireproxy_pool", "logs", "cz_prague_fixture.log"),
        pidFile: join(targetRoot, "wireproxy_pool", "pids", "cz_prague_fixture.pid"),
      });

      expect(await readFile(summary.proxyListSocksPath, "utf8")).toBe(
        "socks5h://127.0.0.1:19080\n",
      );
      expect(await readFile(summary.proxyListHttpPath, "utf8")).toBe("http://127.0.0.1:29080\n");
      const rawGeneratedManifest = JSON.parse(
        await readFile(summary.generatedManifestPath, "utf8"),
      ) as Record<string, unknown>;
      const rawWireproxyManifest = JSON.parse(
        await readFile(summary.wireproxyManifestPath, "utf8"),
      ) as Record<string, unknown>;
      const startScript = await readFile(
        join(targetRoot, "wireproxy_pool", "start_wireproxy_pool.sh"),
        "utf8",
      );
      const stopScript = await readFile(
        join(targetRoot, "wireproxy_pool", "stop_wireproxy_pool.sh"),
        "utf8",
      );

      expect(rawGeneratedManifest.output_dir).toBe(".");
      expect(rawGeneratedManifest.manifest_out).toBe("./surfshark_generated_manifest.json");
      expect(
        (rawGeneratedManifest.entries as ReadonlyArray<Record<string, unknown>>)[0]?.file,
      ).toBe("./cz_prague_fixture.conf");
      expect(rawWireproxyManifest.wireguard_config_dir).toBe("../surfshark_wg");
      expect(rawWireproxyManifest.output_dir).toBe(".");
      expect(rawWireproxyManifest.proxy_list_socks_file).toBe("../proxy_pool_wireproxy_socks.txt");
      expect(rawWireproxyManifest.proxy_list_http_file).toBe("../proxy_pool_wireproxy_http.txt");
      expect(rawWireproxyManifest.start_script).toBe("./start_wireproxy_pool.sh");
      expect(rawWireproxyManifest.stop_script).toBe("./stop_wireproxy_pool.sh");
      expect(
        (rawWireproxyManifest.entries as ReadonlyArray<Record<string, unknown>>)[0],
      ).toMatchObject({
        wireguard_config: "../surfshark_wg/cz_prague_fixture.conf",
        wireproxy_config: "./cz_prague_fixture_wireproxy.conf",
        log_file: "./logs/cz_prague_fixture.log",
        pid_file: "./pids/cz_prague_fixture.pid",
      });
      expect(startScript).toContain('SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"');
      expect(startScript).toContain('WIREPROXY_BIN="${WIREPROXY_BIN:-wireproxy}"');
      expect(startScript).not.toContain(targetRoot);
      expect(stopScript).toContain('SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"');
      expect(stopScript).not.toContain(targetRoot);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not delete the target bundle before source manifests validate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effect-scrapling-wireguard-import-safety-"));
    const sourceConfigRoot = join(directory, "source-config");
    const sourceWireproxyDir = join(sourceConfigRoot, "wireproxy_pool");
    const targetRoot = join(directory, "target-config");
    const sentinelPath = join(targetRoot, "sentinel.txt");

    try {
      await mkdir(sourceWireproxyDir, { recursive: true });
      await mkdir(targetRoot, { recursive: true });
      await writeFile(sentinelPath, "keep me\n", "utf8");
      await writeFile(
        join(sourceWireproxyDir, "wireproxy_pool_manifest.json"),
        JSON.stringify({ entries: [] }),
        "utf8",
      );

      await expect(
        importSurfsharkWireGuardAssets({
          sourceConfigRoot,
          targetRoot,
        }),
      ).rejects.toMatchObject({
        message: "Failed to read Surfshark generated manifest",
      });

      await access(sentinelPath);
      expect(await readFile(sentinelPath, "utf8")).toBe("keep me\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not delete the target bundle before referenced source files exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effect-scrapling-wireguard-import-files-"));
    const sourceConfigRoot = join(directory, "source-config");
    const sourceWgDir = join(sourceConfigRoot, "surfshark_wg");
    const sourceWireproxyDir = join(sourceConfigRoot, "wireproxy_pool");
    const targetRoot = join(directory, "target-config");
    const sentinelPath = join(targetRoot, "sentinel.txt");

    try {
      await mkdir(sourceWgDir, { recursive: true });
      await mkdir(sourceWireproxyDir, { recursive: true });
      await mkdir(targetRoot, { recursive: true });
      await writeFile(sentinelPath, "keep me\n", "utf8");
      await Bun.write(
        join(sourceWireproxyDir, "cz_prague_fixture_wireproxy.conf"),
        "[Interface]\nPrivateKey = test\n",
      );
      await writeFile(
        join(sourceWgDir, "surfshark_generated_manifest.json"),
        `${JSON.stringify(
          {
            generated_at_utc: "2026-03-14T00:00:00Z",
            output_dir: sourceWgDir,
            manifest_out: join(sourceWgDir, "surfshark_generated_manifest.json"),
            count_written: 1,
            entries: [
              {
                file: join(sourceWgDir, "missing.conf"),
                cluster_id: "fixture-cluster",
                cluster_type: "generic",
                country_code: "CZ",
                location: "Prague",
                connection_name: "cz-prg.prod.surfshark.com",
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        join(sourceWireproxyDir, "wireproxy_pool_manifest.json"),
        `${JSON.stringify(
          {
            generated_at_utc: "2026-03-14T00:00:00Z",
            wireproxy_bin: "wireproxy",
            wireguard_config_dir: sourceWgDir,
            output_dir: sourceWireproxyDir,
            pool_size: 1,
            entries: [
              {
                name: "cz_prague_fixture",
                wireguard_config: join(sourceWgDir, "missing.conf"),
                wireproxy_config: join(sourceWireproxyDir, "cz_prague_fixture_wireproxy.conf"),
                socks_proxy: "socks5h://127.0.0.1:19080",
                http_proxy: "http://127.0.0.1:29080",
                log_file: join(sourceWireproxyDir, "logs", "cz_prague_fixture.log"),
                pid_file: join(sourceWireproxyDir, "pids", "cz_prague_fixture.pid"),
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await expect(
        importSurfsharkWireGuardAssets({
          sourceConfigRoot,
          targetRoot,
        }),
      ).rejects.toThrow(
        `Referenced WireGuard config does not exist: ${join(sourceWgDir, "missing.conf")}`,
      );

      await access(sentinelPath);
      expect(await readFile(sentinelPath, "utf8")).toBe("keep me\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("copies the union of referenced WireGuard configs from both manifests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effect-scrapling-wireguard-import-union-"));
    const sourceConfigRoot = join(directory, "source-config");
    const sourceWgDir = join(sourceConfigRoot, "surfshark_wg");
    const sourceWireproxyDir = join(sourceConfigRoot, "wireproxy_pool");
    const targetRoot = join(directory, "target-config");

    try {
      await mkdir(sourceWgDir, { recursive: true });
      await mkdir(sourceWireproxyDir, { recursive: true });
      await Bun.write(join(sourceWgDir, "cz_prague_fixture.conf"), "[Interface]\nPrivateKey = a\n");
      await Bun.write(join(sourceWgDir, "de_berlin_fixture.conf"), "[Interface]\nPrivateKey = b\n");
      await Bun.write(
        join(sourceWireproxyDir, "de_berlin_fixture_wireproxy.conf"),
        "[Interface]\nPrivateKey = test\n\n[Socks5]\nBindAddress = 127.0.0.1:19081\n\n[http]\nBindAddress = 127.0.0.1:29081\n",
      );
      await writeFile(
        join(sourceWgDir, "surfshark_generated_manifest.json"),
        `${JSON.stringify(
          {
            generated_at_utc: "2026-03-14T00:00:00Z",
            output_dir: sourceWgDir,
            manifest_out: join(sourceWgDir, "surfshark_generated_manifest.json"),
            count_written: 1,
            entries: [
              {
                file: join(sourceWgDir, "cz_prague_fixture.conf"),
                cluster_id: "fixture-cluster",
                cluster_type: "generic",
                country_code: "CZ",
                location: "Prague",
                connection_name: "cz-prg.prod.surfshark.com",
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        join(sourceWireproxyDir, "wireproxy_pool_manifest.json"),
        `${JSON.stringify(
          {
            generated_at_utc: "2026-03-14T00:00:00Z",
            wireproxy_bin: "wireproxy",
            wireguard_config_dir: sourceWgDir,
            output_dir: sourceWireproxyDir,
            pool_size: 1,
            entries: [
              {
                name: "de_berlin_fixture",
                wireguard_config: join(sourceWgDir, "de_berlin_fixture.conf"),
                wireproxy_config: join(sourceWireproxyDir, "de_berlin_fixture_wireproxy.conf"),
                socks_proxy: "socks5h://127.0.0.1:19081",
                http_proxy: "http://127.0.0.1:29081",
                log_file: join(sourceWireproxyDir, "logs", "de_berlin_fixture.log"),
                pid_file: join(sourceWireproxyDir, "pids", "de_berlin_fixture.pid"),
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const summary = await importSurfsharkWireGuardAssets({
        sourceConfigRoot,
        targetRoot,
      });

      expect(summary.wireguardConfigCount).toBe(2);
      await access(join(targetRoot, "surfshark_wg", "cz_prague_fixture.conf"));
      await access(join(targetRoot, "surfshark_wg", "de_berlin_fixture.conf"));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects overlapping source and target roots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "effect-scrapling-wireguard-import-overlap-"));
    const targetRoot = join(directory, "nested-target");

    try {
      await expect(
        importSurfsharkWireGuardAssets({
          sourceConfigRoot: directory,
          targetRoot,
        }),
      ).rejects.toThrow(`Source and target roots must not overlap: ${directory} <-> ${targetRoot}`);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
