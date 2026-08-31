import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "@effect-native/bun-test";
import {
  buildCatalog,
  parseOptions,
  readProbeSuccessAccessWallAnalysis,
  readProbeSuccessFinalUrl,
  runE9WireproxyDomainProbeCli,
  selectCatalogEntries,
} from "../../scripts/benchmarks/e9-wireproxy-domain-probe.ts";

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

const wireproxyManifestFixture = {
  generatedAtUtc: "2026-03-13T00:00:00Z",
  wireguardConfigDir: "/tmp/wg",
  outputDir: "/tmp/wireproxy",
  poolSize: 5,
  entries: [
    {
      name: "cz_prague_5368a311",
      wireguardConfig: "/tmp/wg/cz_prague_5368a311.conf",
      wireproxyConfig: "/tmp/wireproxy/cz_prague_5368a311_wireproxy.conf",
      socksProxy: "socks5h://127.0.0.1:19111",
      httpProxy: "http://127.0.0.1:29111",
      logFile: "/tmp/wireproxy/logs/cz_prague_5368a311.log",
      pidFile: "/tmp/wireproxy/pids/cz_prague_5368a311.pid",
    },
    {
      name: "de_berlin_32bf891c",
      wireguardConfig: "/tmp/wg/de_berlin_32bf891c.conf",
      wireproxyConfig: "/tmp/wireproxy/de_berlin_32bf891c_wireproxy.conf",
      socksProxy: "socks5h://127.0.0.1:19112",
      httpProxy: "http://127.0.0.1:29112",
      logFile: "/tmp/wireproxy/logs/de_berlin_32bf891c.log",
      pidFile: "/tmp/wireproxy/pids/de_berlin_32bf891c.pid",
    },
    {
      name: "de_frankfurt-am-main_cd2a0e6c",
      wireguardConfig: "/tmp/wg/de_frankfurt-am-main_cd2a0e6c.conf",
      wireproxyConfig: "/tmp/wireproxy/de_frankfurt-am-main_cd2a0e6c_wireproxy.conf",
      socksProxy: "socks5h://127.0.0.1:19119",
      httpProxy: "http://127.0.0.1:29119",
      logFile: "/tmp/wireproxy/logs/de_frankfurt-am-main_cd2a0e6c.log",
      pidFile: "/tmp/wireproxy/pids/de_frankfurt-am-main_cd2a0e6c.pid",
    },
    {
      name: "nl_amsterdam_2b8c48bf",
      wireguardConfig: "/tmp/wg/nl_amsterdam_2b8c48bf.conf",
      wireproxyConfig: "/tmp/wireproxy/nl_amsterdam_2b8c48bf_wireproxy.conf",
      socksProxy: "socks5h://127.0.0.1:19192",
      httpProxy: "http://127.0.0.1:29192",
      logFile: "/tmp/wireproxy/logs/nl_amsterdam_2b8c48bf.log",
      pidFile: "/tmp/wireproxy/pids/nl_amsterdam_2b8c48bf.pid",
    },
    {
      name: "us_new-york_23dca51e",
      wireguardConfig: "/tmp/wg/us_new-york_23dca51e.conf",
      wireproxyConfig: "/tmp/wireproxy/us_new-york_23dca51e_wireproxy.conf",
      socksProxy: "socks5h://127.0.0.1:19241",
      httpProxy: "http://127.0.0.1:29241",
      logFile: "/tmp/wireproxy/logs/us_new-york_23dca51e.log",
      pidFile: "/tmp/wireproxy/pids/us_new-york_23dca51e.pid",
    },
  ],
} as const;

const generatedManifestFixture = {
  generatedAtUtc: "2026-03-13T00:00:00Z",
  outputDir: "/tmp/wg",
  entries: [
    {
      file: "/tmp/wg/cz_prague_5368a311.conf",
      clusterId: "cz-cluster",
      clusterType: "generic",
      countryCode: "CZ",
      location: "Prague",
      connectionName: "cz-prg.prod.surfshark.com",
      load: 17,
    },
    {
      file: "/tmp/wg/de_berlin_32bf891c.conf",
      clusterId: "de-berlin-cluster",
      clusterType: "generic",
      countryCode: "DE",
      location: "Berlin",
      connectionName: "de-ber.prod.surfshark.com",
      load: 12,
    },
    {
      file: "/tmp/wg/de_frankfurt-am-main_cd2a0e6c.conf",
      clusterId: "de-frankfurt-cluster",
      clusterType: "generic",
      countryCode: "DE",
      location: "Frankfurt am Main",
      connectionName: "de-fra.prod.surfshark.com",
      load: 16,
    },
    {
      file: "/tmp/wg/nl_amsterdam_2b8c48bf.conf",
      clusterId: "nl-cluster",
      clusterType: "generic",
      countryCode: "NL",
      location: "Amsterdam",
      connectionName: "nl-ams.prod.surfshark.com",
      load: 14,
    },
    {
      file: "/tmp/wg/us_new-york_23dca51e.conf",
      clusterId: "us-nyc-cluster",
      clusterType: "static",
      countryCode: "US",
      location: "New York",
      connectionName: "us-nyc.prod.surfshark.com",
      load: 49,
    },
  ],
} as const;

describe("e9 wireproxy domain probe", () => {
  it("parses repeated and comma-separated CLI options", () => {
    expect(
      parseOptions([
        "--wireproxy-manifest",
        "/tmp/wireproxy_pool_manifest.json",
        "--wireproxy-generated-manifest",
        "/tmp/surfshark_generated_manifest.json",
        "--url",
        "https://www.zbozi.cz/,https://www.boozt.com/",
        "--url",
        "https://www.ebay.com/",
        "--lane",
        "http,browser",
        "--country",
        "cz,de",
        "--wireproxy-entry",
        "us_new-york_23dca51e",
        "--max-entries-per-country",
        "2",
        "--timeout",
        "12000",
        "--transport",
        "socks5",
        "--include-direct",
        "false",
        "--artifact",
        "tmp/e9-wireproxy-domain-probe.json",
      ]),
    ).toEqual({
      wireproxyManifestPath: "/tmp/wireproxy_pool_manifest.json",
      generatedManifestPath: "/tmp/surfshark_generated_manifest.json",
      urls: ["https://www.zbozi.cz/", "https://www.boozt.com/", "https://www.ebay.com/"],
      lanes: ["http", "browser"],
      entryNames: ["us_new-york_23dca51e"],
      countryCodes: ["CZ", "DE"],
      maxEntriesPerCountry: 2,
      timeoutMs: 12_000,
      transport: "socks5",
      includeDirect: false,
      wireproxyBundled: false,
      artifactPath: "tmp/e9-wireproxy-domain-probe.json",
    });
  });

  it("fails fast when no probe URLs are provided", () => {
    expect(() =>
      parseOptions([
        "--wireproxy-manifest",
        "/tmp/wireproxy_pool_manifest.json",
        "--wireproxy-entry",
        "us_new-york_23dca51e",
      ]),
    ).toThrow("Pass at least one --url to probe.");
  });

  it("deduplicates repeated entry and country selectors during CLI parsing", () => {
    expect(
      parseOptions([
        "--wireproxy-manifest",
        "/tmp/wireproxy_pool_manifest.json",
        "--url",
        "https://www.zbozi.cz/",
        "--wireproxy-entry",
        "cz_prague_5368a311,cz_prague_5368a311",
        "--wireproxy-entry",
        "de_berlin_32bf891c",
        "--country",
        "cz,de,cz",
        "--country",
        "de",
      ]),
    ).toEqual({
      wireproxyManifestPath: "/tmp/wireproxy_pool_manifest.json",
      generatedManifestPath: undefined,
      urls: ["https://www.zbozi.cz/"],
      lanes: ["http", "browser"],
      entryNames: ["cz_prague_5368a311", "de_berlin_32bf891c"],
      countryCodes: ["CZ", "DE"],
      maxEntriesPerCountry: 1,
      timeoutMs: 15_000,
      transport: "http",
      includeDirect: true,
      wireproxyBundled: false,
      artifactPath: undefined,
    });
  });

  it("accepts bundled wireproxy assets without an explicit manifest path", () => {
    expect(
      parseOptions([
        "--wireproxy-bundled",
        "--url",
        "https://www.zbozi.cz/",
        "--wireproxy-entry",
        "cz_prague_5368a311",
      ]),
    ).toEqual({
      wireproxyManifestPath: undefined,
      generatedManifestPath: undefined,
      urls: ["https://www.zbozi.cz/"],
      lanes: ["http", "browser"],
      entryNames: ["cz_prague_5368a311"],
      countryCodes: [],
      maxEntriesPerCountry: 1,
      timeoutMs: 15_000,
      transport: "http",
      includeDirect: true,
      wireproxyBundled: true,
      artifactPath: undefined,
    });
  });

  it("rejects conflicting bundled and explicit manifest overrides before probing", async () => {
    await expect(
      runE9WireproxyDomainProbeCli([
        "--wireproxy-bundled",
        "--wireproxy-manifest",
        "/tmp/wireproxy_pool_manifest.json",
        "--url",
        "https://www.zbozi.cz/",
      ]),
    ).rejects.toThrow(
      "Bundled Surfshark assets are incompatible with an explicit --wireproxy-manifest override.",
    );
    await expect(
      runE9WireproxyDomainProbeCli([
        "--wireproxy-bundled",
        "--wireproxy-generated-manifest",
        "/tmp/surfshark_generated_manifest.json",
        "--url",
        "https://www.zbozi.cz/",
      ]),
    ).rejects.toThrow(
      "Bundled Surfshark assets are incompatible with an explicit --wireproxy-generated-manifest override.",
    );
  });

  it("rejects conflicting bundled and explicit wireproxy probe manifests", async () => {
    await expect(
      runE9WireproxyDomainProbeCli([
        "--wireproxy-bundled",
        "--wireproxy-manifest",
        "/tmp/wireproxy_pool_manifest.json",
        "--url",
        "https://www.zbozi.cz/",
      ]),
    ).rejects.toThrow(
      "Bundled Surfshark assets are incompatible with an explicit --wireproxy-manifest override.",
    );
  });

  it("fails fast before probing when the selected wireproxy pool cannot be started", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e9-wireproxy-probe-preflight-"));
    const wireproxyManifestPath = join(directory, "wireproxy_pool_manifest.json");
    const deadSocksPort = await allocateLoopbackPort();
    const deadHttpPort = await allocateLoopbackPort();

    try {
      await writeFile(
        wireproxyManifestPath,
        JSON.stringify({
          wireguard_config_dir: "/tmp/wg",
          output_dir: "/tmp/wireproxy",
          wireproxy_bin: "/definitely/missing/wireproxy",
          start_script: "/tmp/start_wireproxy_pool.sh",
          pool_size: 1,
          entries: [
            {
              name: "cz_prague_fixture",
              wireguard_config: "/tmp/wg/cz_prague_fixture.conf",
              wireproxy_config: "/tmp/wireproxy/cz_prague_fixture_wireproxy.conf",
              socks_proxy: `socks5h://127.0.0.1:${deadSocksPort}`,
              http_proxy: `http://127.0.0.1:${deadHttpPort}`,
              log_file: "/tmp/wireproxy/logs/cz_prague_fixture.log",
              pid_file: "/tmp/wireproxy/pids/cz_prague_fixture.pid",
            },
          ],
        }),
      );

      await expect(
        runE9WireproxyDomainProbeCli([
          "--wireproxy-manifest",
          wireproxyManifestPath,
          "--url",
          "https://example.com/",
          "--wireproxy-entry",
          "cz_prague_fixture",
          "--include-direct",
          "false",
        ]),
      ).rejects.toThrow("Surfshark wireproxy binary is not executable");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("builds a catalog with Surfshark metadata attached", () => {
    const catalog = buildCatalog({
      wireproxyManifest: wireproxyManifestFixture,
      generatedManifest: generatedManifestFixture,
    });

    expect(catalog[0]).toMatchObject({
      name: "cz_prague_5368a311",
      countryCode: "CZ",
      location: "Prague",
      load: 17,
      connectionName: "cz-prg.prod.surfshark.com",
    });
    expect(catalog[4]).toMatchObject({
      name: "us_new-york_23dca51e",
      countryCode: "US",
      location: "New York",
      load: 49,
    });
  });

  it("joins generated metadata by wireguard config basename and rejects malformed loads", () => {
    const aliasedCatalog = buildCatalog({
      wireproxyManifest: {
        ...wireproxyManifestFixture,
        entries: [
          {
            ...wireproxyManifestFixture.entries[0],
            name: "cz_prague_alias",
            wireguardConfig: "/tmp/wg/cz_prague_5368a311.conf",
          },
        ],
      },
      generatedManifest: generatedManifestFixture,
    });

    expect(aliasedCatalog[0]).toMatchObject({
      name: "cz_prague_alias",
      countryCode: "CZ",
      location: "Prague",
      connectionName: "cz-prg.prod.surfshark.com",
    });

    expect(() =>
      buildCatalog({
        wireproxyManifest: wireproxyManifestFixture,
        generatedManifest: {
          ...generatedManifestFixture,
          entries: [
            {
              ...generatedManifestFixture.entries[0],
              load: -1,
            },
          ],
        },
      }),
    ).toThrow("Generated manifest load values must be non-negative integers: cz_prague_5368a311");
  });

  it("joins generated metadata correctly for Windows-style wireguard config paths", () => {
    const catalog = buildCatalog({
      wireproxyManifest: {
        ...wireproxyManifestFixture,
        entries: [
          {
            ...wireproxyManifestFixture.entries[0],
            wireguardConfig: "C:\\WG\\CZ_PRAGUE_5368A311.CONF",
          },
        ],
      },
      generatedManifest: {
        ...generatedManifestFixture,
        entries: [
          {
            ...generatedManifestFixture.entries[0],
            file: "/tmp/wg/cz_prague_5368a311.conf",
          },
        ],
      },
    });

    expect(catalog[0]).toMatchObject({
      name: "cz_prague_5368a311",
      countryCode: "CZ",
      location: "Prague",
      connectionName: "cz-prg.prod.surfshark.com",
    });
  });

  it("rejects duplicate generated basenames across Windows and POSIX path forms", () => {
    expect(() =>
      buildCatalog({
        wireproxyManifest: wireproxyManifestFixture,
        generatedManifest: {
          ...generatedManifestFixture,
          entries: [
            {
              ...generatedManifestFixture.entries[0],
              file: "/tmp/wg/cz_prague_5368a311.conf",
            },
            {
              ...generatedManifestFixture.entries[0],
              file: "C:\\wg\\cz_prague_5368a311.conf",
            },
          ],
        },
      }),
    ).toThrow("Duplicate generated manifest basenames are not allowed: cz_prague_5368a311");
  });

  it("rejects duplicate wireguard config basenames across Windows and POSIX path forms", () => {
    expect(() =>
      buildCatalog({
        wireproxyManifest: {
          ...wireproxyManifestFixture,
          entries: [
            {
              ...wireproxyManifestFixture.entries[0],
              name: "cz_prague_5368a311_a",
              wireguardConfig: "/tmp/wg/cz_prague_5368a311.conf",
            },
            {
              ...wireproxyManifestFixture.entries[0],
              name: "cz_prague_5368a311_b",
              wireguardConfig: "C:\\WG\\CZ_PRAGUE_5368A311.CONF",
            },
          ],
        },
        generatedManifest: generatedManifestFixture,
      }),
    ).toThrow("Duplicate wireguard config basenames are not allowed: cz_prague_5368a311");
  });

  it("rejects duplicate manifest keys when building the catalog", () => {
    expect(() =>
      buildCatalog({
        wireproxyManifest: {
          ...wireproxyManifestFixture,
          entries: [
            ...wireproxyManifestFixture.entries,
            {
              ...wireproxyManifestFixture.entries[0],
            },
          ],
        },
        generatedManifest: generatedManifestFixture,
      }),
    ).toThrow("Duplicate wireproxy entry names are not allowed: cz_prague_5368a311");

    expect(() =>
      buildCatalog({
        wireproxyManifest: wireproxyManifestFixture,
        generatedManifest: {
          ...generatedManifestFixture,
          entries: [
            ...generatedManifestFixture.entries,
            {
              ...generatedManifestFixture.entries[0],
              file: "/tmp/other/cz_prague_5368a311.conf",
            },
          ],
        },
      }),
    ).toThrow("Duplicate generated manifest basenames are not allowed: cz_prague_5368a311");
  });

  it("selects the lowest-load exits per country", () => {
    const catalog = buildCatalog({
      wireproxyManifest: wireproxyManifestFixture,
      generatedManifest: generatedManifestFixture,
    });

    expect(
      selectCatalogEntries(catalog, {
        entryNames: [],
        countryCodes: ["DE", "US"],
        maxEntriesPerCountry: 1,
      }),
    ).toEqual([
      expect.objectContaining({
        name: "de_berlin_32bf891c",
        countryCode: "DE",
        load: 12,
      }),
      expect.objectContaining({
        name: "us_new-york_23dca51e",
        countryCode: "US",
        load: 49,
      }),
    ]);
  });

  it("returns no Surfshark exits when selectors are omitted so direct-only runs stay possible", () => {
    const catalog = buildCatalog({
      wireproxyManifest: wireproxyManifestFixture,
      generatedManifest: generatedManifestFixture,
    });

    expect(
      selectCatalogEntries(catalog, {
        entryNames: [],
        countryCodes: [],
        maxEntriesPerCountry: 1,
      }),
    ).toEqual([]);
  });

  it("fails fast when country selection is requested without generated metadata", () => {
    const catalog = buildCatalog({
      wireproxyManifest: wireproxyManifestFixture,
    });

    expect(() =>
      selectCatalogEntries(catalog, {
        entryNames: [],
        countryCodes: ["CZ"],
        maxEntriesPerCountry: 1,
      }),
    ).toThrow(
      "Country-based Surfshark selection requires generated metadata. Pass --wireproxy-generated-manifest.",
    );
  });

  it("combines explicit entry names with country filters and validates unknown exits", () => {
    const catalog = buildCatalog({
      wireproxyManifest: wireproxyManifestFixture,
      generatedManifest: generatedManifestFixture,
    });

    expect(
      selectCatalogEntries(catalog, {
        entryNames: ["nl_amsterdam_2b8c48bf", "cz_prague_5368a311"],
        countryCodes: ["NL"],
        maxEntriesPerCountry: 1,
      }).map((entry) => entry.name),
    ).toEqual(["nl_amsterdam_2b8c48bf"]);
    expect(() =>
      selectCatalogEntries(catalog, {
        entryNames: ["missing-exit"],
        countryCodes: [],
        maxEntriesPerCountry: 1,
      }),
    ).toThrow("Unknown Surfshark wireproxy entries: missing-exit");
    expect(() =>
      selectCatalogEntries(catalog, {
        entryNames: ["us_new-york_23dca51e"],
        countryCodes: ["DE"],
        maxEntriesPerCountry: 1,
      }),
    ).toThrow("No Surfshark wireproxy entries matched country code DE.");
  });

  it("allows direct-only CLI runs when no Surfshark selector is provided", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e9-wireproxy-direct-only-"));
    const originalFetch = globalThis.fetch;
    const mockedFetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
        const response = new Response("<html><body><h1>direct-only</h1></body></html>", {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        });
        Object.defineProperty(response, "url", {
          value: new Request(input).url,
          configurable: true,
        });
        return response;
      },
      originalFetch,
    ) as typeof fetch;
    globalThis.fetch = mockedFetch;

    try {
      const manifestPath = join(directory, "wireproxy_pool_manifest.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          generated_at_utc: "2026-03-13T00:00:00Z",
          wireguard_config_dir: "/tmp/wg",
          output_dir: "/tmp/wireproxy",
          pool_size: 1,
          entries: [
            {
              name: "cz_prague_5368a311",
              wireguard_config: "/tmp/wg/cz_prague_5368a311.conf",
              wireproxy_config: "/tmp/wireproxy/cz_prague_5368a311_wireproxy.conf",
              socks_proxy: "socks5h://127.0.0.1:19111",
              http_proxy: "http://127.0.0.1:29111",
              log_file: "/tmp/wireproxy/logs/cz_prague_5368a311.log",
              pid_file: "/tmp/wireproxy/pids/cz_prague_5368a311.pid",
            },
          ],
        }),
      );

      const artifact = await runE9WireproxyDomainProbeCli([
        "--wireproxy-manifest",
        manifestPath,
        "--url",
        "https://www.example.com/direct-only-probe",
        "--lane",
        "http",
      ]);

      expect(artifact.selectedEntries).toEqual([]);
      expect(artifact.summary.attemptCount).toBe(1);
      expect(artifact.attempts[0]).toMatchObject({
        profileKind: "direct",
        profileId: "direct",
      });
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("fails fast when country filtering is requested without a generated manifest path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e9-wireproxy-country-manifest-"));

    try {
      const manifestPath = join(directory, "wireproxy_pool_manifest.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          generated_at_utc: "2026-03-13T00:00:00Z",
          wireguard_config_dir: "/tmp/wg",
          output_dir: "/tmp/wireproxy",
          pool_size: 1,
          entries: [
            {
              name: "cz_prague_5368a311",
              wireguard_config: "/tmp/wg/cz_prague_5368a311.conf",
              wireproxy_config: "/tmp/wireproxy/cz_prague_5368a311_wireproxy.conf",
              socks_proxy: "socks5h://127.0.0.1:19111",
              http_proxy: "http://127.0.0.1:29111",
              log_file: "/tmp/wireproxy/logs/cz_prague_5368a311.log",
              pid_file: "/tmp/wireproxy/pids/cz_prague_5368a311.pid",
            },
          ],
        }),
      );

      await expect(
        runE9WireproxyDomainProbeCli([
          "--wireproxy-manifest",
          manifestPath,
          "--url",
          "https://www.zbozi.cz/",
          "--country",
          "CZ",
        ]),
      ).rejects.toThrow(
        "Country-based Surfshark selection requires --wireproxy-generated-manifest.",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("detects access walls from successful browser render artifacts even without warning strings", () => {
    const analysis = readProbeSuccessAccessWallAnalysis({
      requestedUrl: "https://www.zbozi.cz/product",
      result: {
        ok: true,
        command: "render preview",
        warnings: [],
        data: {
          url: "https://www.zbozi.cz/product",
          execution: {
            providerId: "browser-basic",
            mode: "browser",
            egressProfileId: "direct",
            egressPluginId: "builtin-direct-egress",
            egressRouteKind: "direct",
            egressRouteKey: "direct",
            egressPoolId: "direct-pool",
            egressRoutePolicyId: "direct-route",
            egressKey: "direct",
            identityProfileId: "default",
            identityPluginId: "builtin-default-identity",
            identityTenantId: "public",
            identityKey: "default",
            browserRuntimeProfileId: "patchright-browser",
            browserPoolKey: "browser-basic::direct::default",
          },
          status: {
            code: 200,
            ok: true,
            redirected: true,
            family: "success",
          },
          artifacts: [
            {
              kind: "navigation",
              mediaType: "application/json",
              finalUrl: "https://cmp.seznam.cz/consent",
              contentType: "text/html",
              contentLength: 1024,
            },
            {
              kind: "renderedDom",
              mediaType: "application/json",
              title: "Nastaveni souhlasu",
              textPreview: "Sprava souhlasu a souhlas s cookies pred pokracovanim",
              linkTargets: [],
              hiddenFieldCount: 0,
            },
            {
              kind: "timings",
              mediaType: "application/json",
              durationMs: 321,
              requestCount: 1,
              redirectCount: 1,
            },
          ],
        },
      },
    });

    expect(analysis.accessWallKind).toBe("consent");
    expect(analysis.accessWallSignals).toEqual(
      expect.arrayContaining(["text-consent", "text-cookies", "url-consent"]),
    );
  });

  it("detects access walls from successful access-preview responses even without warning strings", () => {
    const analysis = readProbeSuccessAccessWallAnalysis({
      requestedUrl: "https://www.ebay.com/product",
      result: {
        ok: true,
        command: "access preview",
        warnings: [],
        data: {
          status: 403,
          finalUrl: "https://www.ebay.com/splashui/challenge",
        },
      } as never,
    });

    expect(analysis.accessWallKind).toBe("challenge");
    expect(analysis.accessWallSignals).toEqual(
      expect.arrayContaining(["status-403", "url-challenge"]),
    );
  });

  it("finds browser artifacts by kind instead of assuming a fixed artifact order", () => {
    const analysis = readProbeSuccessAccessWallAnalysis({
      requestedUrl: "https://www.zbozi.cz/product",
      result: {
        ok: true,
        command: "render preview",
        warnings: [],
        data: {
          url: "https://www.zbozi.cz/product",
          execution: {
            providerId: "browser-basic",
            mode: "browser",
            egressProfileId: "direct",
            egressPluginId: "builtin-direct-egress",
            egressRouteKind: "direct",
            egressRouteKey: "direct",
            egressPoolId: "direct-pool",
            egressRoutePolicyId: "direct-route",
            egressKey: "direct",
            identityProfileId: "default",
            identityPluginId: "builtin-default-identity",
            identityTenantId: "public",
            identityKey: "default",
            browserRuntimeProfileId: "patchright-browser",
            browserPoolKey: "browser-basic::direct::default",
          },
          status: {
            code: 200,
            ok: true,
            redirected: true,
            family: "success",
          },
          artifacts: [
            {
              kind: "timings",
              mediaType: "application/json",
              durationMs: 321,
              requestCount: 1,
              redirectCount: 1,
            },
            {
              kind: "renderedDom",
              mediaType: "application/json",
              title: "Nastaveni souhlasu",
              textPreview: "Sprava souhlasu a souhlas s cookies pred pokracovanim",
              linkTargets: [],
              hiddenFieldCount: 0,
            },
            {
              kind: "navigation",
              mediaType: "application/json",
              finalUrl: "https://cmp.seznam.cz/consent",
              contentType: "text/html",
              contentLength: 1024,
            },
          ],
        },
      } as never,
    });

    expect(analysis.accessWallKind).toBe("consent");
    expect(analysis.accessWallSignals).toEqual(
      expect.arrayContaining(["text-consent", "text-cookies", "url-consent"]),
    );
  });

  it("reads browser finalUrl by artifact kind instead of assuming navigation is first", () => {
    expect(
      readProbeSuccessFinalUrl({
        ok: true,
        command: "render preview",
        warnings: [],
        data: {
          url: "https://www.zbozi.cz/product",
          execution: {
            providerId: "browser-basic",
            mode: "browser",
            egressProfileId: "direct",
            egressPluginId: "builtin-direct-egress",
            egressRouteKind: "direct",
            egressRouteKey: "direct",
            egressPoolId: "direct-pool",
            egressRoutePolicyId: "direct-route",
            egressKey: "direct",
            identityProfileId: "default",
            identityPluginId: "builtin-default-identity",
            identityTenantId: "public",
            identityKey: "default",
            browserRuntimeProfileId: "patchright-browser",
            browserPoolKey: "browser-basic::direct::default",
          },
          status: {
            code: 200,
            ok: true,
            redirected: true,
            family: "success",
          },
          artifacts: [
            {
              kind: "timings",
              mediaType: "application/json",
              durationMs: 321,
              requestCount: 1,
              redirectCount: 1,
            },
            {
              kind: "renderedDom",
              mediaType: "application/json",
              title: "Nastaveni souhlasu",
              textPreview: "Sprava souhlasu a souhlas s cookies pred pokracovanim",
              linkTargets: [],
              hiddenFieldCount: 0,
            },
            {
              kind: "navigation",
              mediaType: "application/json",
              finalUrl: "https://cmp.seznam.cz/consent",
              contentType: "text/html",
              contentLength: 1024,
            },
          ],
        },
      } as never),
    ).toBe("https://cmp.seznam.cz/consent");
  });
});
