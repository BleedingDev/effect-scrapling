#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { createEngine } from "../../src/sdk/engine.ts";
import {
  detectAccessWall,
  classifyAccessWallKind,
  readAccessWallSignalsFromText,
  readAccessWallSignalsFromWarnings,
} from "../../src/sdk/access-wall-detection.ts";
import {
  ensureSurfsharkWireproxyPoolReady,
  loadSurfsharkGeneratedManifest,
  loadSurfsharkWireGuardModule,
  loadSurfsharkWireproxyManifest,
  resolveBundledSurfsharkWireGuardAssetPaths,
  surfsharkWireGuardProfileId,
  type SurfsharkGeneratedManifest,
  type SurfsharkGeneratedManifestEntry,
  type SurfsharkWireproxyManifest,
  type SurfsharkWireproxyManifestEntry,
  type SurfsharkWireproxyTransport,
} from "../../src/sdk/surfshark-wireguard-runtime.ts";
import type { AccessPreviewResponse, RenderPreviewResponse } from "../../src/sdk/schemas.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const ProbeLaneSchema = Schema.Literals(["http", "browser"] as const);
const WireproxyTransportSchema = Schema.Literals(["socks5", "http"] as const);

const E9WireproxyDomainProbeCliOptionsSchema = Schema.Struct({
  wireproxyManifestPath: Schema.optional(NonEmptyStringSchema),
  generatedManifestPath: Schema.optional(NonEmptyStringSchema),
  urls: Schema.Array(NonEmptyStringSchema),
  lanes: Schema.Array(ProbeLaneSchema),
  entryNames: Schema.Array(NonEmptyStringSchema),
  countryCodes: Schema.Array(NonEmptyStringSchema),
  maxEntriesPerCountry: PositiveIntSchema,
  timeoutMs: PositiveIntSchema,
  transport: WireproxyTransportSchema,
  includeDirect: Schema.Boolean,
  wireproxyBundled: Schema.Boolean,
  artifactPath: Schema.optional(NonEmptyStringSchema),
});

export type E9WireproxyDomainProbeCliOptions = Schema.Schema.Type<
  typeof E9WireproxyDomainProbeCliOptionsSchema
>;

export type ProbeLane = Schema.Schema.Type<typeof ProbeLaneSchema>;

export type SurfsharkWireproxyCatalogEntry = SurfsharkWireproxyManifestEntry & {
  readonly countryCode?: string | undefined;
  readonly location?: string | undefined;
  readonly load?: number | undefined;
  readonly clusterId?: string | undefined;
  readonly clusterType?: string | undefined;
  readonly connectionName?: string | undefined;
};

export type E9WireproxyDomainProbeAttempt = {
  readonly url: string;
  readonly lane: ProbeLane;
  readonly profileKind: "direct" | "wireproxy";
  readonly profileId: string;
  readonly profileName: string;
  readonly countryCode?: string | undefined;
  readonly location?: string | undefined;
  readonly outcome: "success" | "error";
  readonly httpStatus?: number | undefined;
  readonly finalUrl?: string | undefined;
  readonly accessWallSignals: ReadonlyArray<string>;
  readonly accessWallKind?:
    | "challenge"
    | "consent"
    | "forbidden"
    | "rate-limit"
    | "trap"
    | undefined;
  readonly warnings: ReadonlyArray<string>;
  readonly errorTag?: string | undefined;
  readonly errorMessage?: string | undefined;
  readonly errorDetails?: string | undefined;
};

export type E9WireproxyDomainProbeArtifact = {
  readonly benchmark: "e9-wireproxy-domain-probe";
  readonly generatedAt: string;
  readonly wireproxyManifestPath: string;
  readonly generatedManifestPath?: string | undefined;
  readonly urls: ReadonlyArray<string>;
  readonly lanes: ReadonlyArray<ProbeLane>;
  readonly transport: SurfsharkWireproxyTransport;
  readonly includeDirect: boolean;
  readonly selectedEntries: ReadonlyArray<{
    readonly name: string;
    readonly profileId: string;
    readonly countryCode?: string | undefined;
    readonly location?: string | undefined;
    readonly load?: number | undefined;
    readonly proxyUrl: string;
  }>;
  readonly attempts: ReadonlyArray<E9WireproxyDomainProbeAttempt>;
  readonly summary: {
    readonly attemptCount: number;
    readonly successCount: number;
    readonly failureCount: number;
    readonly laneBreakdown: ReadonlyArray<{
      readonly lane: ProbeLane;
      readonly successCount: number;
      readonly failureCount: number;
    }>;
    readonly profileBreakdown: ReadonlyArray<{
      readonly profileId: string;
      readonly successCount: number;
      readonly failureCount: number;
    }>;
    readonly accessWallKindBreakdown: ReadonlyArray<{
      readonly key: string;
      readonly count: number;
    }>;
  };
};

type ProbeSuccessResponse = AccessPreviewResponse | RenderPreviewResponse;

function parseStringList(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseBooleanFlag(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error(`Expected boolean value "true" or "false", received ${JSON.stringify(value)}.`);
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

function dedupeStrings(values: ReadonlyArray<string>) {
  return [...new Set(values)];
}

export function parseOptions(args: readonly string[]): E9WireproxyDomainProbeCliOptions {
  let wireproxyManifestPath: string | undefined;
  let generatedManifestPath: string | undefined;
  const urls: string[] = [];
  const lanes: ProbeLane[] = [];
  const entryNames: string[] = [];
  const countryCodes: string[] = [];
  let maxEntriesPerCountry = 1;
  let timeoutMs = 15_000;
  let transport: SurfsharkWireproxyTransport = "http";
  let includeDirect = true;
  let wireproxyBundled = false;
  let artifactPath: string | undefined;

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
      case "--wireproxy-manifest":
        wireproxyManifestPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(expectValue());
        index += 1;
        break;
      case "--wireproxy-generated-manifest":
        generatedManifestPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(expectValue());
        index += 1;
        break;
      case "--url":
        urls.push(...parseStringList(expectValue()));
        index += 1;
        break;
      case "--lane":
        lanes.push(
          ...Schema.decodeUnknownSync(Schema.Array(ProbeLaneSchema))(
            parseStringList(expectValue()),
          ),
        );
        index += 1;
        break;
      case "--wireproxy-entry":
        entryNames.push(...parseStringList(expectValue()));
        index += 1;
        break;
      case "--country":
        countryCodes.push(...parseStringList(expectValue()).map((value) => value.toUpperCase()));
        index += 1;
        break;
      case "--max-entries-per-country":
        maxEntriesPerCountry = Schema.decodeUnknownSync(PositiveIntSchema)(Number(expectValue()));
        index += 1;
        break;
      case "--timeout":
        timeoutMs = Schema.decodeUnknownSync(PositiveIntSchema)(Number(expectValue()));
        index += 1;
        break;
      case "--transport":
        transport = Schema.decodeUnknownSync(WireproxyTransportSchema)(expectValue());
        index += 1;
        break;
      case "--include-direct":
        includeDirect = parseBooleanFlag(expectValue());
        index += 1;
        break;
      case "--artifact":
        artifactPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(expectValue());
        index += 1;
        break;
      case "--wireproxy-bundled":
        wireproxyBundled = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (urls.length === 0) {
    throw new Error("Pass at least one --url to probe.");
  }
  if (wireproxyManifestPath === undefined && !wireproxyBundled) {
    throw new Error("Pass --wireproxy-manifest or enable --wireproxy-bundled.");
  }

  return Schema.decodeUnknownSync(E9WireproxyDomainProbeCliOptionsSchema)({
    wireproxyManifestPath,
    generatedManifestPath,
    urls,
    lanes: lanes.length === 0 ? ["http", "browser"] : lanes,
    entryNames: dedupeStrings(entryNames),
    countryCodes: dedupeStrings(countryCodes),
    maxEntriesPerCountry,
    timeoutMs,
    transport,
    includeDirect,
    wireproxyBundled,
    artifactPath,
  });
}

export function buildCatalog(input: {
  readonly wireproxyManifest: SurfsharkWireproxyManifest;
  readonly generatedManifest?: SurfsharkGeneratedManifest | undefined;
}) {
  const duplicateEntryNames = findDuplicateKeys(
    input.wireproxyManifest.entries,
    (entry) => entry.name,
  );
  if (duplicateEntryNames.length > 0) {
    throw new Error(
      `Duplicate wireproxy entry names are not allowed: ${duplicateEntryNames.join(", ")}`,
    );
  }
  const duplicateGeneratedKeys = findDuplicateKeys(
    input.generatedManifest?.entries ?? [],
    generatedManifestKey,
  );
  if (duplicateGeneratedKeys.length > 0) {
    throw new Error(
      `Duplicate generated manifest basenames are not allowed: ${duplicateGeneratedKeys.join(", ")}`,
    );
  }
  const duplicateWireproxyKeys = findDuplicateKeys(
    input.wireproxyManifest.entries,
    wireproxyManifestKey,
  );
  if (duplicateWireproxyKeys.length > 0) {
    throw new Error(
      `Duplicate wireguard config basenames are not allowed: ${duplicateWireproxyKeys.join(", ")}`,
    );
  }
  const invalidLoadKeys = (input.generatedManifest?.entries ?? [])
    .filter(
      (entry) =>
        entry.load !== undefined &&
        (!Number.isInteger(entry.load) || !Number.isFinite(entry.load) || entry.load < 0),
    )
    .map(generatedManifestKey)
    .sort();
  if (invalidLoadKeys.length > 0) {
    throw new Error(
      `Generated manifest load values must be non-negative integers: ${invalidLoadKeys.join(", ")}`,
    );
  }
  const metadataByName = Object.fromEntries(
    (input.generatedManifest?.entries ?? []).map((entry) => [generatedManifestKey(entry), entry]),
  ) as Readonly<Record<string, SurfsharkGeneratedManifestEntry>>;

  return input.wireproxyManifest.entries.map(
    (entry) =>
      ({
        ...entry,
        countryCode: metadataByName[wireproxyManifestKey(entry)]?.countryCode,
        location: metadataByName[wireproxyManifestKey(entry)]?.location,
        load: metadataByName[wireproxyManifestKey(entry)]?.load,
        clusterId: metadataByName[wireproxyManifestKey(entry)]?.clusterId,
        clusterType: metadataByName[wireproxyManifestKey(entry)]?.clusterType,
        connectionName: metadataByName[wireproxyManifestKey(entry)]?.connectionName,
      }) satisfies SurfsharkWireproxyCatalogEntry,
  );
}

function sortCatalogEntries(
  left: SurfsharkWireproxyCatalogEntry,
  right: SurfsharkWireproxyCatalogEntry,
) {
  const leftLoad = left.load ?? Number.POSITIVE_INFINITY;
  const rightLoad = right.load ?? Number.POSITIVE_INFINITY;
  if (leftLoad !== rightLoad) {
    return leftLoad - rightLoad;
  }
  return left.name.localeCompare(right.name);
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

function selectEntriesByCountry(
  catalog: ReadonlyArray<SurfsharkWireproxyCatalogEntry>,
  countryCodes: ReadonlyArray<string>,
  maxEntriesPerCountry: number,
) {
  const normalizedCountryCodes = dedupeStrings(countryCodes.map((value) => value.toUpperCase()));
  if (normalizedCountryCodes.length === 0) {
    return [...catalog];
  }

  if (!catalog.some((entry) => entry.countryCode !== undefined)) {
    throw new Error(
      "Country-based Surfshark selection requires generated metadata. Pass --wireproxy-generated-manifest.",
    );
  }

  const selected: SurfsharkWireproxyCatalogEntry[] = [];
  for (const countryCode of normalizedCountryCodes) {
    const matching = catalog
      .filter((entry) => entry.countryCode?.toUpperCase() === countryCode)
      .sort(sortCatalogEntries)
      .slice(0, maxEntriesPerCountry);
    if (matching.length === 0) {
      throw new Error(`No Surfshark wireproxy entries matched country code ${countryCode}.`);
    }
    selected.push(...matching);
  }
  return selected;
}

export function selectCatalogEntries(
  catalog: ReadonlyArray<SurfsharkWireproxyCatalogEntry>,
  input: {
    readonly entryNames: ReadonlyArray<string>;
    readonly countryCodes: ReadonlyArray<string>;
    readonly maxEntriesPerCountry: number;
  },
) {
  const entryNames = dedupeStrings(input.entryNames);
  if (entryNames.length > 0) {
    const catalogByName = new Map(catalog.map((entry) => [entry.name, entry] as const));
    const selectedByName: SurfsharkWireproxyCatalogEntry[] = [];
    const missingNames: string[] = [];
    for (const name of entryNames) {
      const entry = catalogByName.get(name);
      if (entry === undefined) {
        missingNames.push(name);
        continue;
      }
      selectedByName.push(entry);
    }
    if (missingNames.length > 0) {
      throw new Error(`Unknown Surfshark wireproxy entries: ${missingNames.join(", ")}`);
    }
    return selectEntriesByCountry(selectedByName, input.countryCodes, input.maxEntriesPerCountry);
  }

  const countryCodes = dedupeStrings(input.countryCodes.map((value) => value.toUpperCase()));
  if (countryCodes.length === 0) {
    return [];
  }
  return selectEntriesByCountry(catalog, countryCodes, input.maxEntriesPerCountry);
}

export function readProbeSuccessAccessWallAnalysis(input: {
  readonly requestedUrl: string;
  readonly result: ProbeSuccessResponse;
}) {
  const warningSignals = readAccessWallSignalsFromWarnings(input.result.warnings);

  if (input.result.command === "access preview") {
    const accessAnalysis = detectAccessWall({
      statusCode: input.result.data.status,
      requestedUrl: input.requestedUrl,
      finalUrl: input.result.data.finalUrl,
    });
    const accessWallSignals = dedupeStrings([...warningSignals, ...accessAnalysis.signals]).sort();
    return {
      accessWallSignals,
      accessWallKind: classifyAccessWallKind(accessWallSignals),
    };
  }

  const navigationArtifact = input.result.data.artifacts.find(
    (artifact) => artifact.kind === "navigation",
  );
  const renderedDomArtifact = input.result.data.artifacts.find(
    (artifact) => artifact.kind === "renderedDom",
  );
  const renderedAnalysis = detectAccessWall({
    statusCode: input.result.data.status.code,
    requestedUrl: input.requestedUrl,
    finalUrl: navigationArtifact?.finalUrl,
    title: renderedDomArtifact?.title ?? undefined,
    text: renderedDomArtifact?.textPreview,
  });
  const accessWallSignals = dedupeStrings([...warningSignals, ...renderedAnalysis.signals]).sort();

  return {
    accessWallSignals,
    accessWallKind: classifyAccessWallKind(accessWallSignals),
  };
}

export function readProbeSuccessFinalUrl(result: ProbeSuccessResponse) {
  if (result.command === "access preview") {
    return result.data.finalUrl;
  }

  return result.data.artifacts.find((artifact) => artifact.kind === "navigation")?.finalUrl;
}

function readStringProperty(record: object | undefined, key: string) {
  if (record === undefined) {
    return undefined;
  }
  const value = Reflect.get(record, key);
  return typeof value === "string" ? value : undefined;
}

function extractSignalsFromError(error: unknown) {
  const errorRecord =
    (typeof error === "object" && error !== null) || typeof error === "function"
      ? error
      : undefined;
  const warningsCandidate =
    errorRecord === undefined ? undefined : Reflect.get(errorRecord, "warnings");
  const warnings = Array.isArray(warningsCandidate)
    ? warningsCandidate.filter((warning): warning is string => typeof warning === "string")
    : [];
  const details = readStringProperty(errorRecord, "details");

  return {
    warnings,
    details,
    accessWallSignals: dedupeStrings([
      ...readAccessWallSignalsFromWarnings(warnings),
      ...(details === undefined ? [] : readAccessWallSignalsFromText(details)),
    ]).sort(),
  };
}

function summarizeAttempts(attempts: ReadonlyArray<E9WireproxyDomainProbeAttempt>) {
  const laneMap = new Map<ProbeLane, { successCount: number; failureCount: number }>();
  const profileMap = new Map<string, { successCount: number; failureCount: number }>();
  const accessWallMap = new Map<string, number>();

  for (const attempt of attempts) {
    const laneBucket = laneMap.get(attempt.lane) ?? { successCount: 0, failureCount: 0 };
    if (attempt.outcome === "success") {
      laneBucket.successCount += 1;
    } else {
      laneBucket.failureCount += 1;
    }
    laneMap.set(attempt.lane, laneBucket);

    const profileBucket = profileMap.get(attempt.profileId) ?? {
      successCount: 0,
      failureCount: 0,
    };
    if (attempt.outcome === "success") {
      profileBucket.successCount += 1;
    } else {
      profileBucket.failureCount += 1;
    }
    profileMap.set(attempt.profileId, profileBucket);

    const accessWallKey = attempt.accessWallKind ?? "none";
    accessWallMap.set(accessWallKey, (accessWallMap.get(accessWallKey) ?? 0) + 1);
  }

  return {
    attemptCount: attempts.length,
    successCount: attempts.filter((attempt) => attempt.outcome === "success").length,
    failureCount: attempts.filter((attempt) => attempt.outcome === "error").length,
    laneBreakdown: [...laneMap.entries()].map(([lane, counts]) => ({
      lane,
      ...counts,
    })),
    profileBreakdown: [...profileMap.entries()].map(([profileId, counts]) => ({
      profileId,
      ...counts,
    })),
    accessWallKindBreakdown: [...accessWallMap.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key)),
  };
}

async function runAttempt(input: {
  readonly url: string;
  readonly lane: ProbeLane;
  readonly timeoutMs: number;
  readonly wireproxyModulePath?:
    | {
        readonly manifestPath: string;
        readonly generatedManifestPath?: string | undefined;
        readonly profileName: string;
        readonly transport: SurfsharkWireproxyTransport;
      }
    | undefined;
  readonly selectedEntry?: SurfsharkWireproxyCatalogEntry | undefined;
}): Promise<E9WireproxyDomainProbeAttempt> {
  const profileId =
    input.selectedEntry === undefined
      ? "direct"
      : surfsharkWireGuardProfileId(input.selectedEntry.name);
  const profileName = input.selectedEntry?.name ?? "direct";
  const profileKind = input.selectedEntry === undefined ? "direct" : "wireproxy";

  const use = async (): Promise<ProbeSuccessResponse> => {
    const module =
      input.wireproxyModulePath === undefined
        ? undefined
        : await loadSurfsharkWireGuardModule({
            wireproxyManifestPath: input.wireproxyModulePath.manifestPath,
            ...(input.wireproxyModulePath.generatedManifestPath === undefined
              ? {}
              : { generatedManifestPath: input.wireproxyModulePath.generatedManifestPath }),
            includeEntryNames: [input.wireproxyModulePath.profileName],
            transport: input.wireproxyModulePath.transport,
          }).pipe(Effect.runPromise);
    const engineOptions = module === undefined ? {} : { modules: [module] };
    if (input.lane === "http") {
      return await Effect.runPromise(
        Effect.acquireUseRelease(
          createEngine(engineOptions),
          (engine) =>
            engine.accessPreview({
              url: input.url,
              timeoutMs: input.timeoutMs,
              execution:
                input.selectedEntry === undefined
                  ? {
                      mode: "http",
                    }
                  : {
                      mode: "http",
                      egress: {
                        profileId,
                      },
                    },
            }),
          (engine) => engine.close,
        ),
      );
    }

    return await Effect.runPromise(
      Effect.acquireUseRelease(
        createEngine(engineOptions),
        (engine) =>
          engine.renderPreview({
            url: input.url,
            timeoutMs: input.timeoutMs,
            execution:
              input.selectedEntry === undefined
                ? {
                    mode: "browser",
                    browser: {
                      timeoutMs: input.timeoutMs,
                    },
                  }
                : {
                    mode: "browser",
                    egress: {
                      profileId,
                    },
                    browser: {
                      timeoutMs: input.timeoutMs,
                    },
                  },
          }),
        (engine) => engine.close,
      ),
    );
  };

  try {
    const result = await use();
    const warnings = [...result.warnings];
    const successAnalysis = readProbeSuccessAccessWallAnalysis({
      requestedUrl: input.url,
      result,
    });

    if (result.command === "access preview") {
      return {
        url: input.url,
        lane: input.lane,
        profileKind,
        profileId,
        profileName,
        countryCode: input.selectedEntry?.countryCode,
        location: input.selectedEntry?.location,
        outcome: "success",
        httpStatus: result.data.status,
        finalUrl: result.data.finalUrl,
        accessWallSignals: successAnalysis.accessWallSignals,
        accessWallKind: successAnalysis.accessWallKind,
        warnings,
      };
    }

    return {
      url: input.url,
      lane: input.lane,
      profileKind,
      profileId,
      profileName,
      countryCode: input.selectedEntry?.countryCode,
      location: input.selectedEntry?.location,
      outcome: "success",
      httpStatus: result.data.status.code,
      finalUrl: readProbeSuccessFinalUrl(result),
      accessWallSignals: successAnalysis.accessWallSignals,
      accessWallKind: successAnalysis.accessWallKind,
      warnings,
    };
  } catch (error) {
    const warningData = extractSignalsFromError(error);
    const errorRecord =
      (typeof error === "object" && error !== null) || typeof error === "function"
        ? error
        : undefined;
    return {
      url: input.url,
      lane: input.lane,
      profileKind,
      profileId,
      profileName,
      countryCode: input.selectedEntry?.countryCode,
      location: input.selectedEntry?.location,
      outcome: "error",
      accessWallSignals: warningData.accessWallSignals,
      accessWallKind: classifyAccessWallKind(warningData.accessWallSignals),
      warnings: warningData.warnings,
      errorTag: readStringProperty(errorRecord, "_tag") ?? "UnknownError",
      errorMessage: readStringProperty(errorRecord, "message") ?? String(error),
      errorDetails: warningData.details,
    };
  }
}

export async function runE9WireproxyDomainProbeCli(args: readonly string[]) {
  const options = parseOptions(args);
  if (options.wireproxyBundled && options.wireproxyManifestPath !== undefined) {
    throw new Error(
      "Bundled Surfshark assets are incompatible with an explicit --wireproxy-manifest override.",
    );
  }
  if (options.wireproxyBundled && options.generatedManifestPath !== undefined) {
    throw new Error(
      "Bundled Surfshark assets are incompatible with an explicit --wireproxy-generated-manifest override.",
    );
  }
  const bundledAssets =
    options.wireproxyBundled === true ? resolveBundledSurfsharkWireGuardAssetPaths() : undefined;
  const effectiveWireproxyManifestPath =
    options.wireproxyManifestPath ?? bundledAssets?.wireproxyManifestPath;
  const effectiveGeneratedManifestPath =
    options.generatedManifestPath ?? bundledAssets?.generatedManifestPath;
  const wireproxyManifest = await loadSurfsharkWireproxyManifest(
    effectiveWireproxyManifestPath,
  ).pipe(Effect.runPromise);
  const generatedManifest =
    effectiveGeneratedManifestPath === undefined
      ? undefined
      : await loadSurfsharkGeneratedManifest(effectiveGeneratedManifestPath).pipe(
          Effect.runPromise,
        );
  if (options.countryCodes.length > 0 && generatedManifest === undefined) {
    throw new Error("Country-based Surfshark selection requires --wireproxy-generated-manifest.");
  }
  const catalog = buildCatalog({
    wireproxyManifest,
    generatedManifest,
  });
  const selectedEntries = selectCatalogEntries(catalog, {
    entryNames: options.entryNames,
    countryCodes: options.countryCodes,
    maxEntriesPerCountry: options.maxEntriesPerCountry,
  });
  if (!options.includeDirect && selectedEntries.length === 0) {
    throw new Error(
      "No probe profiles selected. Pass --wireproxy-entry or --country, or leave --include-direct enabled.",
    );
  }
  if (selectedEntries.length > 0) {
    await ensureSurfsharkWireproxyPoolReady({
      wireproxyManifest,
      transport: options.transport,
      entryNames: selectedEntries.map((entry) => entry.name),
    }).pipe(Effect.runPromise);
  }
  const attempts: E9WireproxyDomainProbeAttempt[] = [];

  for (const url of options.urls) {
    for (const lane of options.lanes) {
      if (options.includeDirect) {
        attempts.push(
          await runAttempt({
            url,
            lane,
            timeoutMs: options.timeoutMs,
          }),
        );
      }

      for (const entry of selectedEntries) {
        attempts.push(
          await runAttempt({
            url,
            lane,
            timeoutMs: options.timeoutMs,
            selectedEntry: entry,
            wireproxyModulePath: {
              manifestPath: effectiveWireproxyManifestPath,
              generatedManifestPath: effectiveGeneratedManifestPath,
              profileName: entry.name,
              transport: options.transport,
            },
          }),
        );
      }
    }
  }

  const artifact: E9WireproxyDomainProbeArtifact = {
    benchmark: "e9-wireproxy-domain-probe",
    generatedAt: new Date().toISOString(),
    wireproxyManifestPath: effectiveWireproxyManifestPath,
    ...(effectiveGeneratedManifestPath === undefined
      ? {}
      : { generatedManifestPath: effectiveGeneratedManifestPath }),
    urls: options.urls,
    lanes: options.lanes,
    transport: options.transport,
    includeDirect: options.includeDirect,
    selectedEntries: selectedEntries.map((entry) => ({
      name: entry.name,
      profileId: surfsharkWireGuardProfileId(entry.name),
      countryCode: entry.countryCode,
      location: entry.location,
      load: entry.load,
      proxyUrl: options.transport === "http" ? entry.httpProxy : entry.socksProxy,
    })),
    attempts,
    summary: summarizeAttempts(attempts),
  };

  if (options.artifactPath !== undefined) {
    const outputPath = resolve(options.artifactPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  }

  return artifact;
}

if (import.meta.main) {
  runE9WireproxyDomainProbeCli(process.argv.slice(2)).then(
    (artifact) => {
      console.log(JSON.stringify(artifact, null, 2));
      process.exitCode = 0;
    },
    (error) => {
      const message =
        error instanceof Error ? error.message : `Wireproxy domain probe failed: ${String(error)}`;
      console.error(message);
      process.exitCode = 1;
    },
  );
}
