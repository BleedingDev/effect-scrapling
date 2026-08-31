import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { BUILTIN_WIREGUARD_EGRESS_PLUGIN_ID } from "./access-allocation-plugin-ids.ts";
import { type AccessRuntimeModule } from "./access-module-runtime.ts";
import { AccessResourceError, InvalidInputError } from "./errors.ts";

export type SurfsharkWireproxyTransport = "socks5" | "http";

export type SurfsharkWireproxyManifestEntry = {
  readonly name: string;
  readonly wireguardConfig: string;
  readonly wireproxyConfig: string;
  readonly socksProxy: string;
  readonly httpProxy: string;
  readonly logFile: string;
  readonly pidFile: string;
};

export type SurfsharkWireproxyManifest = {
  readonly generatedAtUtc?: string | undefined;
  readonly wireproxyBin?: string | undefined;
  readonly wireguardConfigDir: string;
  readonly poolSize: number;
  readonly outputDir: string;
  readonly proxyListSocksFile?: string | undefined;
  readonly proxyListHttpFile?: string | undefined;
  readonly startScript?: string | undefined;
  readonly stopScript?: string | undefined;
  readonly entries: ReadonlyArray<SurfsharkWireproxyManifestEntry>;
};

export type SurfsharkGeneratedManifestEntry = {
  readonly file: string;
  readonly clusterId: string;
  readonly clusterType: string;
  readonly countryCode: string;
  readonly location: string;
  readonly connectionName: string;
  readonly load?: number | undefined;
};

export type SurfsharkGeneratedManifest = {
  readonly generatedAtUtc?: string | undefined;
  readonly outputDir?: string | undefined;
  readonly manifestOut?: string | undefined;
  readonly countWritten?: number | undefined;
  readonly entries: ReadonlyArray<SurfsharkGeneratedManifestEntry>;
};

export type SurfsharkWireGuardCatalogEntry = SurfsharkWireproxyManifestEntry & {
  readonly countryCode?: string | undefined;
  readonly location?: string | undefined;
  readonly load?: number | undefined;
  readonly clusterId?: string | undefined;
  readonly clusterType?: string | undefined;
  readonly connectionName?: string | undefined;
};

export type SurfsharkWireproxyEndpointProbe = {
  readonly entryName: string;
  readonly transport: SurfsharkWireproxyTransport;
  readonly proxyUrl: string;
  readonly reachable: boolean;
  readonly failureReason?: string | undefined;
};

export type SurfsharkWireproxyPoolReadiness = {
  readonly selectedEntryNames: ReadonlyArray<string>;
  readonly transport: SurfsharkWireproxyTransport;
  readonly attemptedStart: boolean;
  readonly startedPool: boolean;
  readonly wireproxyBinPath?: string | undefined;
  readonly endpointProbes: ReadonlyArray<SurfsharkWireproxyEndpointProbe>;
};

export type EnsureSurfsharkWireproxyPoolReadyOptions = {
  readonly wireproxyManifest: SurfsharkWireproxyManifest;
  readonly transport?: SurfsharkWireproxyTransport | undefined;
  readonly entryNames?: ReadonlyArray<string> | undefined;
  readonly minimumReachableEntryCount?: number | undefined;
  readonly startTimeoutMs?: number | undefined;
  readonly probeTimeoutMs?: number | undefined;
};

export type BuildSurfsharkWireGuardModuleOptions = {
  readonly moduleId?: string | undefined;
  readonly profileIdPrefix?: string | undefined;
  readonly poolId?: string | undefined;
  readonly poolIdPrefix?: string | undefined;
  readonly routePolicyId?: string | undefined;
  readonly routePolicyIdPrefix?: string | undefined;
  readonly transport?: SurfsharkWireproxyTransport | undefined;
  readonly includeEntryNames?: ReadonlyArray<string> | undefined;
  readonly includeCountryCodes?: ReadonlyArray<string> | undefined;
  readonly wireproxyManifest: SurfsharkWireproxyManifest;
  readonly generatedManifest?: SurfsharkGeneratedManifest | undefined;
};

export type LoadSurfsharkWireGuardModuleOptions = Omit<
  BuildSurfsharkWireGuardModuleOptions,
  "wireproxyManifest" | "generatedManifest"
> & {
  readonly wireproxyManifestPath: string;
  readonly generatedManifestPath?: string | undefined;
};

export type SelectSurfsharkWireGuardCatalogEntriesOptions = {
  readonly includeEntryNames?: ReadonlyArray<string> | undefined;
  readonly includeCountryCodes?: ReadonlyArray<string> | undefined;
};

const DEFAULT_MODULE_ID = "surfshark-wireguard-module";
const DEFAULT_PROFILE_ID_PREFIX = "surfshark-wireguard";
const DEFAULT_POOL_ID = "surfshark-wireguard-pool";
const DEFAULT_ROUTE_POLICY_ID = "surfshark-wireguard-route";
export const DEFAULT_EUROPEAN_SURFSHARK_COUNTRY_CODES = [
  "AD",
  "AL",
  "AT",
  "BA",
  "BE",
  "BG",
  "CH",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GB",
  "GI",
  "GR",
  "HR",
  "HU",
  "IE",
  "IM",
  "IS",
  "IT",
  "LI",
  "LT",
  "LU",
  "LV",
  "MC",
  "MD",
  "ME",
  "MK",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "RS",
  "SE",
  "SI",
  "SK",
  "SM",
  "UA",
] as const;
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_BUNDLED_SURFSHARK_ASSET_ROOT = resolve(
  REPO_ROOT,
  "vendor/surfshark-wireguard-assets",
);
const DEFAULT_BUNDLED_SURFSHARK_WG_DIR = resolve(
  DEFAULT_BUNDLED_SURFSHARK_ASSET_ROOT,
  "surfshark_wg",
);
const DEFAULT_BUNDLED_SURFSHARK_WIREPROXY_DIR = resolve(
  DEFAULT_BUNDLED_SURFSHARK_ASSET_ROOT,
  "wireproxy_pool",
);

export type BundledSurfsharkWireGuardAssetPaths = {
  readonly rootDir: string;
  readonly wireguardConfigDir: string;
  readonly wireproxyConfigDir: string;
  readonly generatedManifestPath: string;
  readonly wireproxyManifestPath: string;
};

function invalidManifest(message: string, details?: string) {
  return new InvalidInputError({
    message,
    ...(details === undefined ? {} : { details }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  subject: string,
): Effect.Effect<string, InvalidInputError> {
  const value = record[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return Effect.succeed(value.trim());
  }

  return Effect.fail(
    invalidManifest(
      `Invalid ${subject}`,
      `Expected non-empty string field "${key}" in ${subject}.`,
    ),
  );
}

function readOptionalString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveManifestRelativePath(manifestPath: string, rawPath: string) {
  return rawPath.startsWith("/") ? rawPath : resolve(dirname(manifestPath), rawPath);
}

function resolveManifestOptionalPath(manifestPath: string, rawPath: string | undefined) {
  return rawPath === undefined ? undefined : resolveManifestRelativePath(manifestPath, rawPath);
}

function resolveManifestExecutablePath(manifestPath: string, rawPath: string | undefined) {
  if (rawPath === undefined) {
    return undefined;
  }

  return rawPath.includes("/") ? resolveManifestRelativePath(manifestPath, rawPath) : rawPath;
}

function readOptionalNonNegativeInt(
  record: Record<string, unknown>,
  key: string,
  subject: string,
): Effect.Effect<number | undefined, InvalidInputError> {
  const value = record[key];
  if (value === undefined) {
    return Effect.succeed(undefined);
  }

  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  ) {
    return Effect.succeed(value);
  }

  return Effect.fail(
    invalidManifest(
      `Invalid ${subject}`,
      `Expected optional non-negative integer field "${key}" in ${subject}.`,
    ),
  );
}

function readValidatedPoolSize(
  record: Record<string, unknown>,
): Effect.Effect<number, InvalidInputError> {
  return readOptionalNonNegativeInt(record, "pool_size", "Surfshark wireproxy manifest").pipe(
    Effect.map((value) => value ?? (Array.isArray(record.entries) ? record.entries.length : 0)),
  );
}

function readRequiredArray(
  record: Record<string, unknown>,
  key: string,
  subject: string,
): Effect.Effect<ReadonlyArray<unknown>, InvalidInputError> {
  const value = record[key];
  if (Array.isArray(value)) {
    return Effect.succeed(value);
  }

  return Effect.fail(
    invalidManifest(`Invalid ${subject}`, `Expected array field "${key}" in ${subject}.`),
  );
}

function parseWireproxyManifestEntry(
  value: unknown,
): Effect.Effect<SurfsharkWireproxyManifestEntry, InvalidInputError> {
  if (!isRecord(value)) {
    return Effect.fail(
      invalidManifest("Invalid Surfshark wireproxy manifest", "Manifest entry must be an object."),
    );
  }

  return Effect.all({
    name: readRequiredString(value, "name", "Surfshark wireproxy manifest entry"),
    wireguardConfig: readRequiredString(
      value,
      "wireguard_config",
      "Surfshark wireproxy manifest entry",
    ),
    wireproxyConfig: readRequiredString(
      value,
      "wireproxy_config",
      "Surfshark wireproxy manifest entry",
    ),
    socksProxy: readRequiredString(value, "socks_proxy", "Surfshark wireproxy manifest entry"),
    httpProxy: readRequiredString(value, "http_proxy", "Surfshark wireproxy manifest entry"),
    logFile: readRequiredString(value, "log_file", "Surfshark wireproxy manifest entry"),
    pidFile: readRequiredString(value, "pid_file", "Surfshark wireproxy manifest entry"),
  });
}

function parseGeneratedManifestEntry(
  value: unknown,
): Effect.Effect<SurfsharkGeneratedManifestEntry, InvalidInputError> {
  if (!isRecord(value)) {
    return Effect.fail(
      invalidManifest("Invalid Surfshark generated manifest", "Manifest entry must be an object."),
    );
  }

  return Effect.all({
    file: readRequiredString(value, "file", "Surfshark generated manifest entry"),
    clusterId: readRequiredString(value, "cluster_id", "Surfshark generated manifest entry"),
    clusterType: readRequiredString(value, "cluster_type", "Surfshark generated manifest entry"),
    countryCode: readRequiredString(value, "country_code", "Surfshark generated manifest entry"),
    location: readRequiredString(value, "location", "Surfshark generated manifest entry"),
    connectionName: readRequiredString(
      value,
      "connection_name",
      "Surfshark generated manifest entry",
    ),
    load: readOptionalNonNegativeInt(value, "load", "Surfshark generated manifest entry"),
  });
}

function decodeJsonFile(
  path: string,
  subject: "Surfshark wireproxy manifest" | "Surfshark generated manifest",
) {
  return Effect.tryPromise({
    try: async () => JSON.parse(await readFile(path, "utf8")),
    catch: (error) => invalidManifest(`Failed to read ${subject}`, `${path}: ${String(error)}`),
  });
}

function crossPlatformBasename(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  return segments.at(-1) ?? normalized;
}

function normalizeManifestKey(path: string) {
  const file = crossPlatformBasename(path).trim().toLowerCase();
  return file.endsWith(".conf") ? file.slice(0, -".conf".length) : file;
}

function generatedManifestKey(entry: SurfsharkGeneratedManifestEntry) {
  return normalizeManifestKey(entry.file);
}

function wireproxyManifestKey(entry: SurfsharkWireproxyManifestEntry) {
  return normalizeManifestKey(entry.wireguardConfig);
}

function findDuplicateKeys<T>(
  values: ReadonlyArray<T>,
  keyOf: (value: T) => string,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) {
      duplicates.add(key);
      continue;
    }
    seen.add(key);
  }

  return [...duplicates].sort();
}

function validateUniqueWireproxyEntryNames(
  entries: ReadonlyArray<SurfsharkWireproxyManifestEntry>,
  subject: string,
) {
  const duplicates = findDuplicateKeys(entries, (entry) => entry.name);
  return duplicates.length === 0
    ? Effect.void
    : Effect.fail(
        invalidManifest(
          `Invalid ${subject}`,
          `Duplicate wireproxy entry names are not allowed: ${duplicates.join(", ")}.`,
        ),
      );
}

function validateUniqueWireproxyManifestKeys(
  entries: ReadonlyArray<SurfsharkWireproxyManifestEntry>,
  subject: string,
) {
  const duplicates = findDuplicateKeys(entries, wireproxyManifestKey);
  return duplicates.length === 0
    ? Effect.void
    : Effect.fail(
        invalidManifest(
          `Invalid ${subject}`,
          `Duplicate wireguard config basenames are not allowed: ${duplicates.join(", ")}.`,
        ),
      );
}

function validateUniqueGeneratedManifestKeys(
  entries: ReadonlyArray<SurfsharkGeneratedManifestEntry>,
  subject: string,
) {
  const duplicates = findDuplicateKeys(entries, generatedManifestKey);
  return duplicates.length === 0
    ? Effect.void
    : Effect.fail(
        invalidManifest(
          `Invalid ${subject}`,
          `Duplicate generated manifest basenames are not allowed: ${duplicates.join(", ")}.`,
        ),
      );
}

export function loadSurfsharkWireproxyManifest(
  path: string,
): Effect.Effect<SurfsharkWireproxyManifest, InvalidInputError> {
  return decodeJsonFile(path, "Surfshark wireproxy manifest").pipe(
    Effect.flatMap((raw) => {
      if (!isRecord(raw)) {
        return Effect.fail(
          invalidManifest(
            "Invalid Surfshark wireproxy manifest",
            `Expected object payload in ${path}.`,
          ),
        );
      }

      return Effect.all({
        generatedAtUtc: Effect.succeed(readOptionalString(raw, "generated_at_utc")),
        wireproxyBin: Effect.succeed(
          resolveManifestExecutablePath(path, readOptionalString(raw, "wireproxy_bin")),
        ),
        wireguardConfigDir: readRequiredString(
          raw,
          "wireguard_config_dir",
          "Surfshark wireproxy manifest",
        ).pipe(Effect.map((value) => resolveManifestRelativePath(path, value))),
        poolSize: readValidatedPoolSize(raw),
        outputDir: readRequiredString(raw, "output_dir", "Surfshark wireproxy manifest").pipe(
          Effect.map((value) => resolveManifestRelativePath(path, value)),
        ),
        proxyListSocksFile: Effect.succeed(
          resolveManifestOptionalPath(path, readOptionalString(raw, "proxy_list_socks_file")),
        ),
        proxyListHttpFile: Effect.succeed(
          resolveManifestOptionalPath(path, readOptionalString(raw, "proxy_list_http_file")),
        ),
        startScript: Effect.succeed(
          resolveManifestOptionalPath(path, readOptionalString(raw, "start_script")),
        ),
        stopScript: Effect.succeed(
          resolveManifestOptionalPath(path, readOptionalString(raw, "stop_script")),
        ),
        entries: readRequiredArray(raw, "entries", "Surfshark wireproxy manifest").pipe(
          Effect.flatMap((entries) => Effect.forEach(entries, parseWireproxyManifestEntry)),
          Effect.map((entries) =>
            entries.map((entry) => ({
              ...entry,
              wireguardConfig: resolveManifestRelativePath(path, entry.wireguardConfig),
              wireproxyConfig: resolveManifestRelativePath(path, entry.wireproxyConfig),
              logFile: resolveManifestRelativePath(path, entry.logFile),
              pidFile: resolveManifestRelativePath(path, entry.pidFile),
            })),
          ),
          Effect.flatMap((entries) =>
            entries.length === 0
              ? Effect.fail(
                  invalidManifest(
                    "Invalid Surfshark wireproxy manifest",
                    `Expected at least one entry in ${path}.`,
                  ),
                )
              : Effect.gen(function* () {
                  yield* validateUniqueWireproxyEntryNames(entries, "Surfshark wireproxy manifest");
                  yield* validateUniqueWireproxyManifestKeys(
                    entries,
                    "Surfshark wireproxy manifest",
                  );
                  return entries;
                }),
          ),
        ),
      });
    }),
  );
}

export function loadSurfsharkGeneratedManifest(
  path: string,
): Effect.Effect<SurfsharkGeneratedManifest, InvalidInputError> {
  return decodeJsonFile(path, "Surfshark generated manifest").pipe(
    Effect.flatMap((raw) => {
      if (!isRecord(raw)) {
        return Effect.fail(
          invalidManifest(
            "Invalid Surfshark generated manifest",
            `Expected object payload in ${path}.`,
          ),
        );
      }

      return Effect.all({
        generatedAtUtc: Effect.succeed(readOptionalString(raw, "generated_at_utc")),
        outputDir: Effect.succeed(
          resolveManifestOptionalPath(path, readOptionalString(raw, "output_dir")),
        ),
        manifestOut: Effect.succeed(
          resolveManifestOptionalPath(path, readOptionalString(raw, "manifest_out")),
        ),
        countWritten: readOptionalNonNegativeInt(
          raw,
          "count_written",
          "Surfshark generated manifest",
        ),
        entries: readRequiredArray(raw, "entries", "Surfshark generated manifest").pipe(
          Effect.flatMap((entries) => Effect.forEach(entries, parseGeneratedManifestEntry)),
          Effect.map((entries) =>
            entries.map((entry) => ({
              ...entry,
              file: resolveManifestRelativePath(path, entry.file),
            })),
          ),
          Effect.flatMap((entries) =>
            entries.length === 0
              ? Effect.fail(
                  invalidManifest(
                    "Invalid Surfshark generated manifest",
                    `Expected at least one entry in ${path}.`,
                  ),
                )
              : validateUniqueGeneratedManifestKeys(entries, "Surfshark generated manifest").pipe(
                  Effect.as(entries),
                ),
          ),
        ),
      });
    }),
  );
}

export function resolveBundledSurfsharkWireGuardAssetPaths(): BundledSurfsharkWireGuardAssetPaths {
  return {
    rootDir: DEFAULT_BUNDLED_SURFSHARK_ASSET_ROOT,
    wireguardConfigDir: DEFAULT_BUNDLED_SURFSHARK_WG_DIR,
    wireproxyConfigDir: DEFAULT_BUNDLED_SURFSHARK_WIREPROXY_DIR,
    generatedManifestPath: resolve(
      DEFAULT_BUNDLED_SURFSHARK_WG_DIR,
      "surfshark_generated_manifest.json",
    ),
    wireproxyManifestPath: resolve(
      DEFAULT_BUNDLED_SURFSHARK_WIREPROXY_DIR,
      "wireproxy_pool_manifest.json",
    ),
  };
}

export function surfsharkWireGuardProfileId(name: string, prefix = DEFAULT_PROFILE_ID_PREFIX) {
  return `${prefix}-${name}`;
}

function surfsharkWireGuardPoolId(name: string, prefix = DEFAULT_POOL_ID) {
  return `${prefix}-${name}`;
}

function surfsharkWireGuardRoutePolicyId(name: string, prefix = DEFAULT_ROUTE_POLICY_ID) {
  return `${prefix}-${name}`;
}

function normalizeCountryCode(value: string) {
  return value.trim().toUpperCase();
}

function sortCatalogEntries(
  left: SurfsharkWireGuardCatalogEntry,
  right: SurfsharkWireGuardCatalogEntry,
) {
  const leftLoad = left.load ?? Number.POSITIVE_INFINITY;
  const rightLoad = right.load ?? Number.POSITIVE_INFINITY;
  if (leftLoad !== rightLoad) {
    return leftLoad - rightLoad;
  }

  return left.name.localeCompare(right.name);
}

export function buildSurfsharkWireGuardCatalog(input: {
  readonly wireproxyManifest: SurfsharkWireproxyManifest;
  readonly generatedManifest?: SurfsharkGeneratedManifest | undefined;
}): Effect.Effect<ReadonlyArray<SurfsharkWireGuardCatalogEntry>, InvalidInputError> {
  return Effect.gen(function* () {
    yield* validateUniqueWireproxyEntryNames(
      input.wireproxyManifest.entries,
      "Surfshark wireproxy manifest",
    );
    yield* validateUniqueWireproxyManifestKeys(
      input.wireproxyManifest.entries,
      "Surfshark wireproxy manifest",
    );
    yield* validateUniqueGeneratedManifestKeys(
      input.generatedManifest?.entries ?? [],
      "Surfshark generated manifest",
    );
    const generatedEntriesByName = Object.fromEntries(
      (input.generatedManifest?.entries ?? []).map((entry) => [generatedManifestKey(entry), entry]),
    ) as Readonly<Record<string, SurfsharkGeneratedManifestEntry>>;

    return input.wireproxyManifest.entries
      .map(
        (entry) =>
          ({
            ...entry,
            countryCode: generatedEntriesByName[wireproxyManifestKey(entry)]?.countryCode,
            location: generatedEntriesByName[wireproxyManifestKey(entry)]?.location,
            load: generatedEntriesByName[wireproxyManifestKey(entry)]?.load,
            clusterId: generatedEntriesByName[wireproxyManifestKey(entry)]?.clusterId,
            clusterType: generatedEntriesByName[wireproxyManifestKey(entry)]?.clusterType,
            connectionName: generatedEntriesByName[wireproxyManifestKey(entry)]?.connectionName,
          }) satisfies SurfsharkWireGuardCatalogEntry,
      )
      .sort(sortCatalogEntries);
  });
}

export function selectSurfsharkWireGuardCatalogEntries(
  catalog: ReadonlyArray<SurfsharkWireGuardCatalogEntry>,
  input: SelectSurfsharkWireGuardCatalogEntriesOptions = {},
): Effect.Effect<ReadonlyArray<SurfsharkWireGuardCatalogEntry>, InvalidInputError> {
  return Effect.gen(function* () {
    const includeEntryNames = [
      ...new Set((input.includeEntryNames ?? []).map((value) => value.trim()).filter(Boolean)),
    ];
    const includeCountryCodes = [
      ...new Set((input.includeCountryCodes ?? []).map(normalizeCountryCode).filter(Boolean)),
    ];

    const selected = new Map<string, SurfsharkWireGuardCatalogEntry>();
    if (includeEntryNames.length > 0) {
      const catalogByName = new Map(catalog.map((entry) => [entry.name, entry] as const));
      const missingNames = includeEntryNames.filter((name) => !catalogByName.has(name));
      if (missingNames.length > 0) {
        return yield* Effect.fail(
          invalidManifest(
            "Unknown Surfshark WireGuard entry",
            `No wireproxy manifest entry matched: ${missingNames.sort().join(", ")}.`,
          ),
        );
      }

      for (const name of includeEntryNames) {
        const entry = catalogByName.get(name);
        if (entry !== undefined) {
          selected.set(entry.name, entry);
        }
      }
    }

    if (includeCountryCodes.length > 0) {
      const matchedCountryCodes = new Set(
        catalog
          .map((entry) => entry.countryCode)
          .filter((countryCode): countryCode is string => countryCode !== undefined)
          .map(normalizeCountryCode),
      );
      const missingCountryCodes = includeCountryCodes.filter(
        (countryCode) => !matchedCountryCodes.has(countryCode),
      );
      if (missingCountryCodes.length > 0) {
        return yield* Effect.fail(
          invalidManifest(
            "Unknown Surfshark WireGuard country code",
            `No generated Surfshark metadata matched country code: ${missingCountryCodes.sort().join(", ")}.`,
          ),
        );
      }

      for (const entry of catalog) {
        if (
          entry.countryCode !== undefined &&
          includeCountryCodes.includes(normalizeCountryCode(entry.countryCode))
        ) {
          selected.set(entry.name, entry);
        }
      }
    }

    return selected.size === 0 ? catalog : [...selected.values()].sort(sortCatalogEntries);
  });
}

function parseProxyUrl(
  proxyUrl: string,
): Effect.Effect<{ readonly host: string; readonly port: number }, InvalidInputError> {
  return Effect.try({
    try: () => {
      const parsed = new URL(proxyUrl);
      const host = parsed.hostname.trim();
      const port = Number(parsed.port);
      if (host.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new Error("invalid");
      }

      return { host, port } as const;
    },
    catch: () =>
      invalidManifest(
        "Invalid Surfshark wireproxy proxy URL",
        `Expected a proxy URL with an explicit host and port, received: ${proxyUrl}.`,
      ),
  });
}

function selectWireproxyManifestEntries(
  manifest: SurfsharkWireproxyManifest,
  entryNames: ReadonlyArray<string> | undefined,
): Effect.Effect<ReadonlyArray<SurfsharkWireproxyManifestEntry>, InvalidInputError> {
  const selectedNames = [
    ...new Set((entryNames ?? []).map((value) => value.trim()).filter(Boolean)),
  ];
  if (selectedNames.length === 0) {
    return Effect.succeed(manifest.entries);
  }

  const entriesByName = new Map(manifest.entries.map((entry) => [entry.name, entry] as const));
  const missingNames = selectedNames.filter((name) => !entriesByName.has(name));
  if (missingNames.length > 0) {
    return Effect.fail(
      invalidManifest(
        "Unknown Surfshark WireGuard entry",
        `No wireproxy manifest entry matched: ${missingNames.sort().join(", ")}.`,
      ),
    );
  }

  return Effect.succeed(
    selectedNames
      .map((name) => entriesByName.get(name))
      .filter((entry): entry is SurfsharkWireproxyManifestEntry => entry !== undefined),
  );
}

function resolveWireproxyBinaryPath(
  manifest: SurfsharkWireproxyManifest,
): Effect.Effect<string, AccessResourceError> {
  const envOverride = process.env.WIREPROXY_BIN?.trim();
  const configured = manifest.wireproxyBin?.trim();
  const candidate =
    envOverride && envOverride.length > 0
      ? envOverride
      : configured && configured.length > 0
        ? configured
        : "wireproxy";

  return Effect.gen(function* () {
    if (candidate.includes("/")) {
      yield* Effect.tryPromise({
        try: () => access(candidate, fsConstants.X_OK),
        catch: () =>
          new AccessResourceError({
            message: "Surfshark wireproxy binary is not executable",
            details: `Expected an executable wireproxy binary at: ${candidate}.`,
          }),
      });

      return candidate;
    }

    const resolved = Bun.which(candidate);
    if (resolved === null) {
      return yield* Effect.fail(
        new AccessResourceError({
          message: "Surfshark wireproxy binary is not available",
          details: `Resolved manifest requires "${candidate}" on PATH before bundled WireGuard exits can start. Set WIREPROXY_BIN to an absolute executable path to override the manifest binary.`,
        }),
      );
    }

    return resolved;
  });
}

function probeWireproxyEntryEndpoint(input: {
  readonly entry: SurfsharkWireproxyManifestEntry;
  readonly transport: SurfsharkWireproxyTransport;
  readonly timeoutMs: number;
}): Effect.Effect<SurfsharkWireproxyEndpointProbe, InvalidInputError> {
  return Effect.gen(function* () {
    const proxyUrl = input.transport === "http" ? input.entry.httpProxy : input.entry.socksProxy;
    const { host, port } = yield* parseProxyUrl(proxyUrl);
    return yield* Effect.tryPromise({
      try: () =>
        new Promise<SurfsharkWireproxyEndpointProbe>((resolve) => {
          const socket = new Socket();
          let settled = false;
          const finish = (result: SurfsharkWireproxyEndpointProbe) => {
            if (settled) {
              return;
            }

            settled = true;
            socket.destroy();
            resolve(result);
          };

          socket.setTimeout(input.timeoutMs);
          socket.once("connect", () =>
            finish({
              entryName: input.entry.name,
              transport: input.transport,
              proxyUrl,
              reachable: true,
            }),
          );
          socket.once("timeout", () =>
            finish({
              entryName: input.entry.name,
              transport: input.transport,
              proxyUrl,
              reachable: false,
              failureReason: "Timed out while connecting to the local wireproxy endpoint.",
            }),
          );
          socket.once("error", (error: Error) =>
            finish({
              entryName: input.entry.name,
              transport: input.transport,
              proxyUrl,
              reachable: false,
              failureReason: error.message,
            }),
          );
          socket.connect({ host, port });
        }),
      catch: (error) =>
        invalidManifest(
          "Failed to probe Surfshark wireproxy endpoint",
          error instanceof Error ? error.message : String(error),
        ),
    });
  });
}

function probeWireproxyEntries(input: {
  readonly entries: ReadonlyArray<SurfsharkWireproxyManifestEntry>;
  readonly transport: SurfsharkWireproxyTransport;
  readonly timeoutMs: number;
}) {
  return Effect.forEach(input.entries, (entry) =>
    probeWireproxyEntryEndpoint({
      entry,
      transport: input.transport,
      timeoutMs: input.timeoutMs,
    }),
  );
}

function formatEndpointFailureSummary(
  probes: ReadonlyArray<SurfsharkWireproxyEndpointProbe>,
  wireproxyBinPath?: string | undefined,
  diagnostics?: string | undefined,
) {
  const failed = probes.filter((probe) => !probe.reachable);
  const summary = failed
    .map(
      (probe) => `${probe.entryName} (${probe.proxyUrl}): ${probe.failureReason ?? "unreachable"}`,
    )
    .join("; ");

  return [
    wireproxyBinPath === undefined ? undefined : `wireproxyBin=${wireproxyBinPath}`,
    summary.length === 0 ? undefined : `deadEntries=${summary}`,
    diagnostics,
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" | ");
}

function readTail(path: string, maxChars = 400): Effect.Effect<string | undefined, never> {
  return Effect.tryPromise({
    try: async () => {
      const content = await readFile(path, "utf8");
      return content.length <= maxChars ? content : content.slice(-maxChars);
    },
    catch: () => undefined,
  });
}

function collectWireproxyEntryDiagnostics(
  entries: ReadonlyArray<SurfsharkWireproxyManifestEntry>,
): Effect.Effect<string | undefined, never> {
  return Effect.gen(function* () {
    const lines = yield* Effect.forEach(entries, (entry) =>
      Effect.gen(function* () {
        const pid = yield* Effect.tryPromise({
          try: () => readFile(entry.pidFile, "utf8"),
          catch: () => undefined,
        });
        const logTail = yield* readTail(entry.logFile);
        const pidLine = pid === undefined ? "pid=missing" : `pid=${pid.trim() || "empty"}`;
        const logLine =
          logTail === undefined ? "log=missing" : `logTail=${JSON.stringify(logTail)}`;
        return `${entry.name}[${pidLine}; ${logLine}]`;
      }),
    );

    return lines.length === 0 ? undefined : lines.join(" | ");
  });
}

function startWireproxyPool(
  manifest: SurfsharkWireproxyManifest,
  wireproxyBinPath: string,
): Effect.Effect<string | undefined, AccessResourceError> {
  const startScript = manifest.startScript;
  if (startScript === undefined) {
    return Effect.fail(
      new AccessResourceError({
        message: "Surfshark wireproxy pool is not running",
        details:
          "Selected wireproxy endpoints are unreachable and the manifest does not declare a start_script to recover the pool.",
      }),
    );
  }

  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => access(startScript, fsConstants.X_OK),
      catch: () =>
        new AccessResourceError({
          message: "Surfshark wireproxy start script is not executable",
          details: `Expected an executable start_script at: ${startScript}.`,
        }),
    });
    yield* Effect.tryPromise({
      try: () => mkdir(manifest.outputDir, { recursive: true }),
      catch: (error) =>
        new AccessResourceError({
          message: "Failed to prepare Surfshark wireproxy output directory",
          details: error instanceof Error ? error.message : String(error),
        }),
    });
    yield* Effect.tryPromise({
      try: () =>
        Promise.all(
          manifest.entries.flatMap((entry) => [
            mkdir(dirname(entry.logFile), { recursive: true }),
            mkdir(dirname(entry.pidFile), { recursive: true }),
          ]),
        ),
      catch: (error) =>
        new AccessResourceError({
          message: "Failed to prepare Surfshark wireproxy log directories",
          details: error instanceof Error ? error.message : String(error),
        }),
    });

    const result = spawnSync(startScript, {
      cwd: dirname(startScript),
      env: {
        ...process.env,
        WIREPROXY_BIN: wireproxyBinPath,
      },
      encoding: "utf8",
    });
    if (result.error !== undefined) {
      return yield* Effect.fail(
        new AccessResourceError({
          message: "Failed to start the Surfshark wireproxy pool",
          details: result.error.message,
        }),
      );
    }

    if (result.status !== 0) {
      return yield* Effect.fail(
        new AccessResourceError({
          message: "Surfshark wireproxy pool start script failed",
          details: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
        }),
      );
    }

    return [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || undefined;
  });
}

export function ensureSurfsharkWireproxyPoolReady(
  input: EnsureSurfsharkWireproxyPoolReadyOptions,
): Effect.Effect<SurfsharkWireproxyPoolReadiness, InvalidInputError | AccessResourceError> {
  const transport = input.transport ?? "http";
  const probeTimeoutMs = input.probeTimeoutMs ?? 750;
  const startTimeoutMs = input.startTimeoutMs ?? 10_000;

  return Effect.gen(function* () {
    const entries = yield* selectWireproxyManifestEntries(
      input.wireproxyManifest,
      input.entryNames,
    );
    const minimumReachableEntryCount = Math.max(
      1,
      Math.min(entries.length, input.minimumReachableEntryCount ?? entries.length),
    );
    const initialProbes = yield* probeWireproxyEntries({
      entries,
      transport,
      timeoutMs: probeTimeoutMs,
    });
    if (initialProbes.filter((probe) => probe.reachable).length >= minimumReachableEntryCount) {
      return {
        selectedEntryNames: entries.map((entry) => entry.name),
        transport,
        attemptedStart: false,
        startedPool: false,
        endpointProbes: initialProbes,
      } satisfies SurfsharkWireproxyPoolReadiness;
    }

    const wireproxyBinPath = yield* resolveWireproxyBinaryPath(input.wireproxyManifest);
    const startOutput = yield* startWireproxyPool(input.wireproxyManifest, wireproxyBinPath);
    const deadline = Date.now() + startTimeoutMs;
    let latestProbes = initialProbes;
    while (Date.now() <= deadline) {
      latestProbes = yield* probeWireproxyEntries({
        entries,
        transport,
        timeoutMs: probeTimeoutMs,
      });
      if (latestProbes.filter((probe) => probe.reachable).length >= minimumReachableEntryCount) {
        return {
          selectedEntryNames: entries.map((entry) => entry.name),
          transport,
          attemptedStart: true,
          startedPool: true,
          wireproxyBinPath,
          endpointProbes: latestProbes,
        } satisfies SurfsharkWireproxyPoolReadiness;
      }

      yield* Effect.sleep("150 millis");
    }

    const diagnostics = yield* collectWireproxyEntryDiagnostics(
      entries.filter((entry) =>
        latestProbes.some((probe) => probe.entryName === entry.name && !probe.reachable),
      ),
    );
    return yield* Effect.fail(
      new AccessResourceError({
        message: "Surfshark wireproxy pool did not become ready",
        details: [
          `minimumReachableEntryCount=${minimumReachableEntryCount}`,
          formatEndpointFailureSummary(
            latestProbes,
            wireproxyBinPath,
            [startOutput, diagnostics]
              .filter((value): value is string => value !== undefined && value.length > 0)
              .join(" | "),
          ),
        ]
          .filter((value) => value.length > 0)
          .join(" | "),
      }),
    );
  });
}

export function buildSurfsharkWireGuardModule(
  input: BuildSurfsharkWireGuardModuleOptions,
): Effect.Effect<AccessRuntimeModule, InvalidInputError> {
  return Effect.gen(function* () {
    yield* validateUniqueWireproxyEntryNames(
      input.wireproxyManifest.entries,
      "Surfshark wireproxy manifest",
    );
    yield* validateUniqueWireproxyManifestKeys(
      input.wireproxyManifest.entries,
      "Surfshark wireproxy manifest",
    );
    yield* validateUniqueGeneratedManifestKeys(
      input.generatedManifest?.entries ?? [],
      "Surfshark generated manifest",
    );
    const transport = input.transport ?? "socks5";
    const includeNames = new Set((input.includeEntryNames ?? []).map((value) => value.trim()));
    const includeCountryCodes = new Set(
      (input.includeCountryCodes ?? []).map((value) => normalizeCountryCode(value)),
    );
    if (includeCountryCodes.size > 0 && input.generatedManifest === undefined) {
      return yield* Effect.fail(
        invalidManifest(
          "Surfshark country filters require generated metadata",
          "Pass a Surfshark generated manifest before filtering WireGuard entries by country code.",
        ),
      );
    }
    const generatedEntriesByName = Object.fromEntries(
      (input.generatedManifest?.entries ?? []).map((entry) => [generatedManifestKey(entry), entry]),
    ) as Readonly<Record<string, SurfsharkGeneratedManifestEntry>>;
    if (includeNames.size > 0) {
      const knownNames = new Set(input.wireproxyManifest.entries.map((entry) => entry.name));
      const missingNames = [...includeNames].filter((name) => !knownNames.has(name));
      if (missingNames.length > 0) {
        return yield* Effect.fail(
          invalidManifest(
            "Unknown Surfshark WireGuard entry",
            `No wireproxy manifest entry matched: ${missingNames.sort().join(", ")}.`,
          ),
        );
      }
    }

    if (includeCountryCodes.size > 0) {
      const matchedCountryCodes = new Set(
        input.wireproxyManifest.entries
          .map((entry) => generatedEntriesByName[wireproxyManifestKey(entry)]?.countryCode)
          .filter((countryCode): countryCode is string => countryCode !== undefined)
          .map(normalizeCountryCode),
      );
      const missingCountryCodes = [...includeCountryCodes].filter(
        (countryCode) => !matchedCountryCodes.has(countryCode),
      );
      if (missingCountryCodes.length > 0) {
        return yield* Effect.fail(
          invalidManifest(
            "Unknown Surfshark WireGuard country code",
            `No generated Surfshark metadata matched country code: ${missingCountryCodes.sort().join(", ")}.`,
          ),
        );
      }
    }
    const selectedEntries = input.wireproxyManifest.entries.filter((entry) => {
      if (includeNames.size > 0 && !includeNames.has(entry.name)) {
        return false;
      }

      if (includeCountryCodes.size === 0) {
        return true;
      }

      const metadata = generatedEntriesByName[wireproxyManifestKey(entry)];
      return (
        metadata !== undefined &&
        includeCountryCodes.has(normalizeCountryCode(metadata.countryCode))
      );
    });

    if (selectedEntries.length === 0) {
      return yield* Effect.fail(
        invalidManifest(
          "No Surfshark WireGuard entries selected",
          "The provided filters did not match any wireproxy manifest entry.",
        ),
      );
    }

    const profileIdPrefix = input.profileIdPrefix ?? DEFAULT_PROFILE_ID_PREFIX;
    const poolIdPrefix = input.poolIdPrefix ?? DEFAULT_POOL_ID;
    const routePolicyIdPrefix = input.routePolicyIdPrefix ?? DEFAULT_ROUTE_POLICY_ID;
    const egressProfiles = Object.fromEntries(
      selectedEntries.map((entry) => {
        const metadata = generatedEntriesByName[wireproxyManifestKey(entry)];
        const proxyUrl = transport === "http" ? entry.httpProxy : entry.socksProxy;
        const exitNodeId = metadata?.clusterId ?? entry.name;
        const endpoint = metadata?.connectionName;
        const profileId = surfsharkWireGuardProfileId(entry.name, profileIdPrefix);
        const poolId = input.poolId ?? surfsharkWireGuardPoolId(entry.name, poolIdPrefix);
        const routePolicyId =
          input.routePolicyId ?? surfsharkWireGuardRoutePolicyId(entry.name, routePolicyIdPrefix);

        return [
          profileId,
          {
            allocationMode: "static",
            pluginId: BUILTIN_WIREGUARD_EGRESS_PLUGIN_ID,
            profileId,
            poolId,
            routePolicyId,
            routeKind: "wireguard",
            routeKey: `wireguard:${entry.name}`,
            routeConfig: {
              kind: "wireguard",
              proxyUrl,
              ...(endpoint === undefined ? {} : { endpoint }),
              ...(exitNodeId.length === 0 ? {} : { exitNodeId }),
            },
            requestHeaders: {},
            warnings: [],
          },
        ] as const;
      }),
    );

    return {
      id: input.moduleId ?? DEFAULT_MODULE_ID,
      egressProfiles,
    } satisfies AccessRuntimeModule;
  });
}

export function loadSurfsharkWireGuardModule(
  input: LoadSurfsharkWireGuardModuleOptions,
): Effect.Effect<AccessRuntimeModule, InvalidInputError> {
  return Effect.gen(function* () {
    const wireproxyManifest = yield* loadSurfsharkWireproxyManifest(input.wireproxyManifestPath);
    const generatedManifest =
      input.generatedManifestPath === undefined
        ? undefined
        : yield* loadSurfsharkGeneratedManifest(input.generatedManifestPath);

    return yield* buildSurfsharkWireGuardModule({
      ...input,
      wireproxyManifest,
      generatedManifest,
    });
  });
}

export function loadBundledSurfsharkWireGuardModule(
  input: Omit<
    LoadSurfsharkWireGuardModuleOptions,
    "wireproxyManifestPath" | "generatedManifestPath"
  > = {},
): Effect.Effect<AccessRuntimeModule, InvalidInputError> {
  const bundled = resolveBundledSurfsharkWireGuardAssetPaths();
  return loadSurfsharkWireGuardModule({
    ...input,
    wireproxyManifestPath: bundled.wireproxyManifestPath,
    generatedManifestPath: bundled.generatedManifestPath,
  });
}
