import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Effect, Exit, Schema, Scope } from "effect";
import { chromium } from "patchright";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "@effect-scrapling/foundation-core";
import {
  E9CommerceCorpusFreezeArtifactSchema,
  type E9FrozenCorpusPageSchema,
} from "./e9-corpus-freeze.ts";
import {
  E9HighFrictionCanaryArtifactSchema,
  runE9HighFrictionCanary,
} from "./e9-high-friction-canary.ts";
import { E9ScraplingParityArtifactSchema, runE9ScraplingParity } from "./e9-scrapling-parity.ts";
import {
  classifyAccessWallKind,
  detectAccessWall,
  extractHtmlTitle,
  readAccessWallSignalsFromWarnings,
} from "./sdk/access-wall-detection.ts";
import {
  AccessExecutionRuntime,
  DEFAULT_BROWSER_PROVIDER_ID,
  DEFAULT_HTTP_PROVIDER_ID,
  type ResolvedExecutionPlan,
} from "./sdk/access-runtime.ts";
import { RECOVERED_BROWSER_ALLOCATION_WARNING_PREFIX } from "./sdk/browser-pool.ts";
import { makeSdkRuntimeHandle, type SdkRuntimeHandle } from "./sdk/runtime-layer.ts";
import { accessPreview, renderPreview } from "./sdk/scraper.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeNumberSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const UnitIntervalSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);
const PageTypeSchema = Schema.Literals([
  "product",
  "listing",
  "search",
  "offer",
  "unknown",
] as const);
const FrictionClassSchema = Schema.Literals(["low", "medium", "high"] as const);
const BenchmarkPhaseSchema = Schema.Literals([
  "live-http-corpus",
  "live-browser-corpus",
  "extraction-parity",
  "high-friction-canary",
] as const);
const BenchmarkProfileSchema = Schema.Literals([
  "effect-http",
  "native-fetch",
  "effect-browser",
  "patchright-browser",
  "scrapling-parser",
] as const);
const BenchmarkCliPhaseSchema = Schema.Literals([
  "http",
  "browser",
  "scrapling",
  "canary",
] as const);
const BenchmarkPresetSchema = Schema.Literals([
  "fast-regression",
  "scale-study",
  "full-corpus",
  "competitor-calibration",
] as const);
const HttpBenchmarkProfileSchema = Schema.Literals(["effect-http", "native-fetch"] as const);
const BrowserBenchmarkProfileSchema = Schema.Literals([
  "effect-browser",
  "patchright-browser",
] as const);

const DistributionSummarySchema = Schema.Struct({
  count: NonNegativeIntSchema,
  min: NonNegativeNumberSchema,
  mean: NonNegativeNumberSchema,
  p50: NonNegativeNumberSchema,
  p90: NonNegativeNumberSchema,
  p95: NonNegativeNumberSchema,
  p99: NonNegativeNumberSchema,
  max: NonNegativeNumberSchema,
});

const BreakdownSummarySchema = Schema.Struct({
  key: NonEmptyStringSchema,
  attemptCount: NonNegativeIntSchema,
  successRate: UnitIntervalSchema,
  challengeRate: UnitIntervalSchema,
  redirectedRate: UnitIntervalSchema,
  titlePresentRate: UnitIntervalSchema,
  blockedRate: UnitIntervalSchema,
  averageContentBytes: NonNegativeNumberSchema,
  durationMs: DistributionSummarySchema,
});

const BenchmarkAttemptTimingSchema = Schema.Struct({
  totalWallMs: NonNegativeNumberSchema,
  runnerReportedMs: Schema.optional(NonNegativeNumberSchema),
  overheadMs: NonNegativeNumberSchema,
  requestCount: Schema.optional(NonNegativeIntSchema),
  redirectCount: Schema.optional(NonNegativeIntSchema),
  blockedRequestCount: Schema.optional(NonNegativeIntSchema),
  responseHeadersMs: Schema.optional(NonNegativeNumberSchema),
  bodyReadMs: Schema.optional(NonNegativeNumberSchema),
  contextCreateMs: Schema.optional(NonNegativeNumberSchema),
  pageCreateMs: Schema.optional(NonNegativeNumberSchema),
  routeRegistrationMs: Schema.optional(NonNegativeNumberSchema),
  gotoMs: Schema.optional(NonNegativeNumberSchema),
  loadStateMs: Schema.optional(NonNegativeNumberSchema),
  domReadMs: Schema.optional(NonNegativeNumberSchema),
  headerReadMs: Schema.optional(NonNegativeNumberSchema),
  titleReadMs: Schema.optional(NonNegativeNumberSchema),
  cleanupMs: Schema.optional(NonNegativeNumberSchema),
});

const BenchmarkExecutionMetadataSchema = Schema.Struct({
  source: Schema.Literals(["planned", "executed"] as const),
  providerId: NonEmptyStringSchema,
  mode: Schema.Literals(["http", "browser"] as const),
  egressProfileId: NonEmptyStringSchema,
  egressPluginId: NonEmptyStringSchema,
  egressRouteKind: NonEmptyStringSchema,
  egressRouteKey: NonEmptyStringSchema,
  egressPoolId: NonEmptyStringSchema,
  egressRoutePolicyId: NonEmptyStringSchema,
  identityProfileId: NonEmptyStringSchema,
  identityPluginId: NonEmptyStringSchema,
  identityTenantId: NonEmptyStringSchema,
  browserRuntimeProfileId: Schema.optional(NonEmptyStringSchema),
  egressKey: Schema.optional(NonEmptyStringSchema),
  identityKey: Schema.optional(NonEmptyStringSchema),
  browserPoolKey: Schema.optional(NonEmptyStringSchema),
});

const BenchmarkTimingSummarySchema = Schema.Struct({
  totalWallMs: DistributionSummarySchema,
  runnerReportedMs: DistributionSummarySchema,
  overheadMs: DistributionSummarySchema,
  requestCount: DistributionSummarySchema,
  redirectCount: DistributionSummarySchema,
  blockedRequestCount: DistributionSummarySchema,
  responseHeadersMs: DistributionSummarySchema,
  bodyReadMs: DistributionSummarySchema,
  contextCreateMs: DistributionSummarySchema,
  pageCreateMs: DistributionSummarySchema,
  routeRegistrationMs: DistributionSummarySchema,
  gotoMs: DistributionSummarySchema,
  loadStateMs: DistributionSummarySchema,
  domReadMs: DistributionSummarySchema,
  headerReadMs: DistributionSummarySchema,
  titleReadMs: DistributionSummarySchema,
  cleanupMs: DistributionSummarySchema,
});

const BenchmarkAttemptSchema = Schema.Struct({
  phase: BenchmarkPhaseSchema,
  profile: BenchmarkProfileSchema,
  concurrency: PositiveIntSchema,
  siteId: CanonicalIdentifierSchema,
  domain: NonEmptyStringSchema,
  url: NonEmptyStringSchema,
  pageType: PageTypeSchema,
  frictionClass: FrictionClassSchema,
  expectedChallengeSignals: Schema.Array(NonEmptyStringSchema),
  statusCode: Schema.optional(PositiveIntSchema),
  success: Schema.Boolean,
  blocked: Schema.Boolean,
  redirected: Schema.Boolean,
  challengeDetected: Schema.Boolean,
  observedChallengeSignals: Schema.Array(NonEmptyStringSchema),
  durationMs: NonNegativeNumberSchema,
  contentBytes: NonNegativeIntSchema,
  titlePresent: Schema.Boolean,
  timings: BenchmarkAttemptTimingSchema,
  finalUrl: Schema.optional(NonEmptyStringSchema),
  error: Schema.optional(NonEmptyStringSchema),
  failureCategory: Schema.optional(
    Schema.Literals([
      "access-wall",
      "access-wall-challenge",
      "access-wall-consent",
      "access-wall-rate-limit",
      "access-wall-trap",
      "http-error",
      "timeout",
      "browser-launch",
      "browser-context-allocation",
      "browser-page-allocation",
      "browser-route-registration",
      "browser-navigation-timeout",
      "browser-navigation-response-missing",
      "browser-navigation-connection",
      "browser-navigation-aborted",
      "browser-navigation-http-error",
      "browser-navigation-failed",
      "browser-dom-read-timeout",
      "browser-dom-read-failed",
      "browser-header-read-failed",
      "browser-title-read-timeout",
      "browser-title-read-failed",
      "browser-closed",
      "browser-crash",
      "local-selection",
      "local-egress-config",
      "local-identity-config",
      "network-error",
      "empty-content",
      "unknown-error",
    ] as const),
  ),
  executionMetadata: Schema.optional(BenchmarkExecutionMetadataSchema),
  warnings: Schema.optional(Schema.Array(NonEmptyStringSchema)),
});

const SweepSummarySchema = Schema.Struct({
  phase: BenchmarkPhaseSchema,
  profile: BenchmarkProfileSchema,
  concurrency: PositiveIntSchema,
  attemptCount: NonNegativeIntSchema,
  successCount: NonNegativeIntSchema,
  successRate: UnitIntervalSchema,
  blockedCount: NonNegativeIntSchema,
  blockedRate: UnitIntervalSchema,
  challengeRate: UnitIntervalSchema,
  redirectedRate: UnitIntervalSchema,
  titlePresentRate: UnitIntervalSchema,
  localFailureCount: NonNegativeIntSchema,
  recoveredBrowserAllocationCount: NonNegativeIntSchema,
  effectiveAttemptCount: NonNegativeIntSchema,
  effectiveSuccessRate: UnitIntervalSchema,
  totalWallMs: NonNegativeNumberSchema,
  throughputPagesPerMinute: NonNegativeNumberSchema,
  effectiveThroughputPagesPerMinute: NonNegativeNumberSchema,
  parallelEfficiency: UnitIntervalSchema,
  contentBytes: DistributionSummarySchema,
  durationMs: DistributionSummarySchema,
  timings: BenchmarkTimingSummarySchema,
  rssPeakMb: NonNegativeNumberSchema,
  cpuUserMs: NonNegativeNumberSchema,
  cpuSystemMs: NonNegativeNumberSchema,
  bySite: Schema.Array(BreakdownSummarySchema),
  byPageType: Schema.Array(BreakdownSummarySchema),
  byFriction: Schema.Array(BreakdownSummarySchema),
});

const PageTypeCountsSchema = Schema.Struct({
  product: NonNegativeIntSchema,
  listing: NonNegativeIntSchema,
  search: NonNegativeIntSchema,
  offer: NonNegativeIntSchema,
  unknown: NonNegativeIntSchema,
});

const BenchmarkPhaseArtifactSchema = Schema.Struct({
  phase: BenchmarkPhaseSchema,
  pageCount: NonNegativeIntSchema,
  attempts: Schema.Array(BenchmarkAttemptSchema),
  sweeps: Schema.Array(SweepSummarySchema),
});

const CompetitorAvailabilitySchema = Schema.Struct({
  profile: NonEmptyStringSchema,
  available: Schema.Boolean,
  reason: Schema.optional(NonEmptyStringSchema),
});

const BenchmarkReportItemSchema = Schema.Struct({
  key: NonEmptyStringSchema,
  count: NonNegativeIntSchema,
});

const E9BenchmarkSuiteSummarySchema = Schema.Struct({
  executedPhases: Schema.Array(BenchmarkCliPhaseSchema),
  skippedPhases: Schema.Array(BenchmarkCliPhaseSchema),
  sampled: Schema.Boolean,
  totalAttemptCount: NonNegativeIntSchema,
  totalSweepCount: NonNegativeIntSchema,
  httpAttemptCount: NonNegativeIntSchema,
  browserAttemptCount: NonNegativeIntSchema,
  httpLocalFailureCount: NonNegativeIntSchema,
  browserLocalFailureCount: NonNegativeIntSchema,
  browserRecoveredBrowserAllocationCount: NonNegativeIntSchema,
  httpSuccessRate: UnitIntervalSchema,
  browserSuccessRate: UnitIntervalSchema,
  httpEffectiveSuccessRate: UnitIntervalSchema,
  browserEffectiveSuccessRate: UnitIntervalSchema,
  httpBestThroughputPagesPerMinute: NonNegativeNumberSchema,
  browserBestThroughputPagesPerMinute: NonNegativeNumberSchema,
  httpBestEffectiveThroughputPagesPerMinute: NonNegativeNumberSchema,
  browserBestEffectiveThroughputPagesPerMinute: NonNegativeNumberSchema,
  topHttpFailureDomains: Schema.Array(BenchmarkReportItemSchema),
  topBrowserFailureDomains: Schema.Array(BenchmarkReportItemSchema),
  topRemoteFailureDomains: Schema.optional(Schema.Array(BenchmarkReportItemSchema)),
  topRemoteFailureCategories: Schema.optional(Schema.Array(BenchmarkReportItemSchema)),
  topBrowserFailureCategories: Schema.Array(BenchmarkReportItemSchema),
  topLocalFailureCategories: Schema.Array(BenchmarkReportItemSchema),
});

export const E9BenchmarkSuiteArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e9-benchmark-suite"),
  benchmarkId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  corpus: Schema.Struct({
    sourceArtifactPath: NonEmptyStringSchema,
    sourcePageCount: Schema.optional(NonNegativeIntSchema),
    sourceSiteCount: Schema.optional(NonNegativeIntSchema),
    selectedPageCount: NonNegativeIntSchema,
    selectedSiteCount: NonNegativeIntSchema,
    highFrictionPageCount: NonNegativeIntSchema,
    pageTypeCounts: PageTypeCountsSchema,
    preset: Schema.optional(NonEmptyStringSchema),
    samplingStrategy: Schema.optional(NonEmptyStringSchema),
    samplePageCount: Schema.optional(NonNegativeIntSchema),
    sampleSeed: Schema.optional(NonEmptyStringSchema),
    shardCount: Schema.optional(PositiveIntSchema),
    shardIndex: Schema.optional(PositiveIntSchema),
    shardPageCount: Schema.optional(NonNegativeIntSchema),
  }),
  profiles: Schema.Struct({
    available: Schema.Array(CompetitorAvailabilitySchema),
    unavailable: Schema.Array(CompetitorAvailabilitySchema),
  }),
  httpCorpus: BenchmarkPhaseArtifactSchema,
  browserCorpus: BenchmarkPhaseArtifactSchema,
  scraplingParity: Schema.Struct({
    totalWallMs: NonNegativeNumberSchema,
    skipped: Schema.optional(Schema.Boolean),
    artifact: Schema.optional(E9ScraplingParityArtifactSchema),
  }),
  highFrictionCanary: Schema.Struct({
    totalWallMs: NonNegativeNumberSchema,
    skipped: Schema.optional(Schema.Boolean),
    artifact: Schema.optional(E9HighFrictionCanaryArtifactSchema),
  }),
  summary: Schema.optional(E9BenchmarkSuiteSummarySchema),
  warnings: Schema.optional(Schema.Array(NonEmptyStringSchema)),
  recommendations: Schema.optional(Schema.Array(NonEmptyStringSchema)),
  status: Schema.Literals(["pass", "warn", "fail"] as const),
});

type FrozenPage = Schema.Schema.Type<typeof E9FrozenCorpusPageSchema>;
type BenchmarkAttempt = Schema.Schema.Type<typeof BenchmarkAttemptSchema>;
type BenchmarkAttemptTiming = Schema.Schema.Type<typeof BenchmarkAttemptTimingSchema>;
type SweepSummary = Schema.Schema.Type<typeof SweepSummarySchema>;
type BenchmarkPhase = Schema.Schema.Type<typeof BenchmarkPhaseSchema>;
type BenchmarkProfile = Schema.Schema.Type<typeof BenchmarkProfileSchema>;
type BenchmarkCliPhase = Schema.Schema.Type<typeof BenchmarkCliPhaseSchema>;
type BenchmarkPreset = Schema.Schema.Type<typeof BenchmarkPresetSchema>;
type HttpBenchmarkProfile = Schema.Schema.Type<typeof HttpBenchmarkProfileSchema>;
type BrowserBenchmarkProfile = Schema.Schema.Type<typeof BrowserBenchmarkProfileSchema>;
type BenchmarkFailureCategory = NonNullable<
  Schema.Schema.Type<typeof BenchmarkAttemptSchema>["failureCategory"]
>;
type BenchmarkExecutionMetadata = Schema.Schema.Type<typeof BenchmarkExecutionMetadataSchema>;
export type E9BenchmarkSuiteArtifact = Schema.Schema.Type<typeof E9BenchmarkSuiteArtifactSchema>;
export type E9BenchmarkSuiteProgressEvent =
  | {
      readonly kind: "suite-start";
      readonly benchmarkId: string;
      readonly generatedAt: string;
      readonly selectedPhases: ReadonlyArray<BenchmarkCliPhase>;
      readonly corpusPath: string;
      readonly pageCount: number;
      readonly siteCount: number;
      readonly httpProfiles: ReadonlyArray<HttpBenchmarkProfile>;
      readonly browserProfiles: ReadonlyArray<BrowserBenchmarkProfile>;
      readonly httpConcurrency: ReadonlyArray<number>;
      readonly browserConcurrency: ReadonlyArray<number>;
      readonly expectedSweepCount: number;
    }
  | {
      readonly kind: "phase-start";
      readonly benchmarkId: string;
      readonly generatedAt: string;
      readonly phase: BenchmarkPhase;
      readonly pageCount: number;
      readonly profileCount: number;
      readonly concurrencyLevels: ReadonlyArray<number>;
      readonly expectedSweepCount: number;
    }
  | {
      readonly kind: "profile-start";
      readonly benchmarkId: string;
      readonly generatedAt: string;
      readonly phase: BenchmarkPhase;
      readonly profile: BenchmarkProfile;
      readonly pageCount: number;
      readonly sweepCount: number;
      readonly concurrencyLevels: ReadonlyArray<number>;
    }
  | {
      readonly kind: "sweep-start";
      readonly benchmarkId: string;
      readonly generatedAt: string;
      readonly phase: BenchmarkPhase;
      readonly profile: BenchmarkProfile;
      readonly concurrency: number;
      readonly pageCount: number;
      readonly sweepOrdinal: number;
      readonly sweepCount: number;
    }
  | {
      readonly kind: "attempt-complete";
      readonly benchmarkId: string;
      readonly generatedAt: string;
      readonly phase: BenchmarkPhase;
      readonly profile: BenchmarkProfile;
      readonly concurrency: number;
      readonly pageOrdinal: number;
      readonly completedCount: number;
      readonly totalCount: number;
      readonly siteId: string;
      readonly domain: string;
      readonly url: string;
      readonly pageType: Schema.Schema.Type<typeof PageTypeSchema>;
      readonly frictionClass: Schema.Schema.Type<typeof FrictionClassSchema>;
      readonly success: boolean;
      readonly blocked: boolean;
      readonly challengeDetected: boolean;
      readonly redirected: boolean;
      readonly statusCode?: number | undefined;
      readonly durationMs: number;
      readonly reportedDurationMs?: number | undefined;
      readonly overheadDurationMs: number;
      readonly requestCount?: number | undefined;
      readonly redirectCount?: number | undefined;
      readonly blockedRequestCount?: number | undefined;
      readonly contentBytes: number;
      readonly elapsedMs: number;
      readonly etaMs: number;
      readonly finalUrl?: string | undefined;
      readonly error?: string | undefined;
      readonly failureCategory?: BenchmarkFailureCategory | undefined;
      readonly executionMetadata?: BenchmarkExecutionMetadata | undefined;
      readonly warnings?: ReadonlyArray<string> | undefined;
    }
  | {
      readonly kind: "sweep-complete";
      readonly benchmarkId: string;
      readonly generatedAt: string;
      readonly phase: BenchmarkPhase;
      readonly profile: BenchmarkProfile;
      readonly concurrency: number;
      readonly pageCount: number;
      readonly sweepOrdinal: number;
      readonly sweepCount: number;
      readonly totalWallMs: number;
      readonly throughputPagesPerMinute: number;
      readonly parallelEfficiency: number;
      readonly successCount: number;
      readonly blockedCount: number;
      readonly challengeCount: number;
      readonly recoveredBrowserAllocationCount: number;
      readonly rssPeakMb: number;
      readonly cpuUserMs: number;
      readonly cpuSystemMs: number;
    }
  | {
      readonly kind: "profile-complete";
      readonly benchmarkId: string;
      readonly generatedAt: string;
      readonly phase: BenchmarkPhase;
      readonly profile: BenchmarkProfile;
      readonly attemptCount: number;
      readonly sweepCount: number;
      readonly totalWallMs: number;
    }
  | {
      readonly kind: "phase-complete";
      readonly benchmarkId: string;
      readonly generatedAt: string;
      readonly phase: BenchmarkPhase;
      readonly attemptCount: number;
      readonly sweepCount: number;
      readonly totalWallMs: number;
    }
  | {
      readonly kind: "subbenchmark-start";
      readonly benchmarkId: string;
      readonly generatedAt: string;
      readonly task: "scrapling-parity" | "high-friction-canary";
    }
  | {
      readonly kind: "subbenchmark-complete";
      readonly benchmarkId: string;
      readonly generatedAt: string;
      readonly task: "scrapling-parity" | "high-friction-canary";
      readonly totalWallMs: number;
      readonly status: "pass" | "fail";
    }
  | {
      readonly kind: "suite-complete";
      readonly benchmarkId: string;
      readonly generatedAt: string;
      readonly status: "pass" | "warn" | "fail";
      readonly totalWallMs: number;
      readonly totalAttemptCount: number;
      readonly totalSweepCount: number;
    };

type E9BenchmarkSuiteProgressListener = (event: E9BenchmarkSuiteProgressEvent) => void;

function emitProgress(
  listener: E9BenchmarkSuiteProgressListener | undefined,
  event: E9BenchmarkSuiteProgressEvent,
) {
  if (listener === undefined) {
    return;
  }

  try {
    listener(event);
  } catch {
    // Progress logging must never abort a long-running benchmark sweep.
  }
}

type AttemptResult = {
  readonly statusCode?: number | undefined;
  readonly redirected: boolean;
  readonly challengeDetected: boolean;
  readonly observedChallengeSignals: ReadonlyArray<string>;
  readonly durationMs: number;
  readonly reportedDurationMs?: number | undefined;
  readonly requestCount?: number | undefined;
  readonly redirectCount?: number | undefined;
  readonly blockedRequestCount?: number | undefined;
  readonly responseHeadersDurationMs?: number | undefined;
  readonly bodyReadDurationMs?: number | undefined;
  readonly contextCreateDurationMs?: number | undefined;
  readonly pageCreateDurationMs?: number | undefined;
  readonly routeRegistrationDurationMs?: number | undefined;
  readonly gotoDurationMs?: number | undefined;
  readonly loadStateDurationMs?: number | undefined;
  readonly domReadDurationMs?: number | undefined;
  readonly headerReadDurationMs?: number | undefined;
  readonly titleReadDurationMs?: number | undefined;
  readonly cleanupDurationMs?: number | undefined;
  readonly contentBytes: number;
  readonly titlePresent: boolean;
  readonly finalUrl?: string | undefined;
  readonly error?: string | undefined;
  readonly executionMetadata?: BenchmarkExecutionMetadata | undefined;
  readonly warnings?: ReadonlyArray<string> | undefined;
};

type SweepRunner = {
  readonly runPage: (page: FrozenPage) => Promise<AttemptResult>;
  readonly close: () => Promise<void>;
};

type SweepRunnerFactory = (input: { readonly timeoutMs: number }) => Promise<SweepRunner>;

type SuiteOverrides = {
  readonly pages?: ReadonlyArray<FrozenPage>;
  readonly httpLevels?: ReadonlyArray<number>;
  readonly browserLevels?: ReadonlyArray<number>;
  readonly httpProfileFactories?: ReadonlyArray<{
    readonly profile: BenchmarkProfile;
    readonly createRunner: SweepRunnerFactory;
  }>;
  readonly browserProfileFactories?: ReadonlyArray<{
    readonly profile: BenchmarkProfile;
    readonly createRunner: SweepRunnerFactory;
  }>;
  readonly scraplingParityRunner?: () => Promise<
    Schema.Schema.Type<typeof E9ScraplingParityArtifactSchema>
  >;
  readonly highFrictionCanaryRunner?: () => Promise<
    Schema.Schema.Type<typeof E9HighFrictionCanaryArtifactSchema>
  >;
  readonly onProgress?: E9BenchmarkSuiteProgressListener;
};

const DEFAULT_BENCHMARK_ID = "e9-benchmark-suite";
const DEFAULT_CORPUS_PATH = "docs/artifacts/e9-commerce-corpus-freeze-corpus-artifact.json";
const DEFAULT_HTTP_CONCURRENCY = [1, 2, 4, 8, 16, 32] as const;
const DEFAULT_BROWSER_CONCURRENCY = [1, 2, 4, 8] as const;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_BROWSER_TIMEOUT_MS = 20_000;
const DEFAULT_SAMPLE_SEED = "e9-benchmark-suite-v1";
const ADAPTIVE_STOP_MIN_GAIN = 1.12;
const ADAPTIVE_STOP_MIN_PARALLEL_EFFICIENCY = 0.6;
const ADAPTIVE_STOP_MAX_SUCCESS_DELTA = 0.01;
const ADAPTIVE_STOP_MAX_BLOCKED_DELTA = 0.01;
const ADAPTIVE_STOP_MAX_CHALLENGE_DELTA = 0.01;
const DEFAULT_HTTP_USER_AGENT = "effect-scrapling-benchmark/1.0";
const DEFAULT_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
function compareStrings(left: string, right: string) {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function hashString(value: string) {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

function toFinite(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function roundToThree(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function safeRate(numerator: number, denominator: number) {
  if (denominator === 0) {
    return 0;
  }

  return numerator / denominator;
}

function pickPercentile(values: ReadonlyArray<number>, percentile: number) {
  if (values.length === 0) {
    return 0;
  }

  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * values.length) - 1),
  );
  return values[index] ?? 0;
}

function summarizeDistribution(values: ReadonlyArray<number>) {
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const count = sorted.length;

  return Schema.decodeUnknownSync(DistributionSummarySchema)({
    count,
    min: count === 0 ? 0 : roundToThree(sorted[0] ?? 0),
    mean: count === 0 ? 0 : roundToThree(total / count),
    p50: roundToThree(pickPercentile(sorted, 50)),
    p90: roundToThree(pickPercentile(sorted, 90)),
    p95: roundToThree(pickPercentile(sorted, 95)),
    p99: roundToThree(pickPercentile(sorted, 99)),
    max: count === 0 ? 0 : roundToThree(sorted.at(-1) ?? 0),
  });
}

type BenchmarkPresetDefinition = {
  readonly phases: ReadonlyArray<BenchmarkCliPhase>;
  readonly httpProfiles: ReadonlyArray<HttpBenchmarkProfile>;
  readonly browserProfiles: ReadonlyArray<BrowserBenchmarkProfile>;
  readonly httpConcurrency: ReadonlyArray<number>;
  readonly browserConcurrency: ReadonlyArray<number>;
  readonly samplePageCount?: number | undefined;
  readonly adaptiveStop: boolean;
};

function resolveBenchmarkPreset(preset: BenchmarkPreset): BenchmarkPresetDefinition {
  switch (preset) {
    case "fast-regression":
      return {
        phases: ["http", "browser"],
        httpProfiles: ["effect-http"],
        browserProfiles: ["effect-browser"],
        httpConcurrency: [1, 8, 32],
        browserConcurrency: [1, 4],
        samplePageCount: 128,
        adaptiveStop: true,
      };
    case "scale-study":
      return {
        phases: ["http", "browser"],
        httpProfiles: ["effect-http"],
        browserProfiles: ["effect-browser"],
        httpConcurrency: [1, 4, 8, 16, 32],
        browserConcurrency: [1, 4, 8],
        samplePageCount: 96,
        adaptiveStop: true,
      };
    case "full-corpus":
      return {
        phases: ["http", "browser", "scrapling", "canary"],
        httpProfiles: ["effect-http"],
        browserProfiles: ["effect-browser"],
        httpConcurrency: [1, 8, 32],
        browserConcurrency: [1, 4],
        adaptiveStop: true,
      };
    case "competitor-calibration":
      return {
        phases: ["http", "browser"],
        httpProfiles: ["effect-http", "native-fetch"],
        browserProfiles: ["effect-browser", "patchright-browser"],
        httpConcurrency: [1, 8, 32],
        browserConcurrency: [1, 4, 8],
        samplePageCount: 96,
        adaptiveStop: false,
      };
  }
}

type SelectedCorpus = {
  readonly path: string;
  readonly sourcePageCount: number;
  readonly sourceSiteCount: number;
  readonly selectedPageCount: number;
  readonly selectedSiteCount: number;
  readonly selectedHighFrictionPageCount: number;
  readonly selectedPageTypeCounts: Schema.Schema.Type<typeof PageTypeCountsSchema>;
  readonly pages: ReadonlyArray<FrozenPage>;
  readonly preset?: BenchmarkPreset | undefined;
  readonly samplingStrategy?: string | undefined;
  readonly samplePageCount?: number | undefined;
  readonly sampleSeed?: string | undefined;
  readonly shardCount?: number | undefined;
  readonly shardIndex?: number | undefined;
  readonly shardPageCount?: number | undefined;
};

function summarizeOptionalDistribution(values: ReadonlyArray<number | undefined>) {
  return summarizeDistribution(
    values.filter((value): value is number => value !== undefined && Number.isFinite(value)),
  );
}

function buildAttemptTimings(input: AttemptResult): BenchmarkAttemptTiming {
  const totalWallMs = roundToThree(toFinite(input.durationMs));
  const runnerReportedMs =
    input.reportedDurationMs === undefined
      ? undefined
      : roundToThree(toFinite(input.reportedDurationMs));
  const overheadMs =
    runnerReportedMs === undefined ? 0 : roundToThree(Math.max(0, totalWallMs - runnerReportedMs));

  return Schema.decodeUnknownSync(BenchmarkAttemptTimingSchema)({
    totalWallMs,
    runnerReportedMs,
    overheadMs,
    requestCount: input.requestCount,
    redirectCount: input.redirectCount,
    blockedRequestCount: input.blockedRequestCount,
    responseHeadersMs:
      input.responseHeadersDurationMs === undefined
        ? undefined
        : roundToThree(toFinite(input.responseHeadersDurationMs)),
    bodyReadMs:
      input.bodyReadDurationMs === undefined
        ? undefined
        : roundToThree(toFinite(input.bodyReadDurationMs)),
    contextCreateMs:
      input.contextCreateDurationMs === undefined
        ? undefined
        : roundToThree(toFinite(input.contextCreateDurationMs)),
    pageCreateMs:
      input.pageCreateDurationMs === undefined
        ? undefined
        : roundToThree(toFinite(input.pageCreateDurationMs)),
    routeRegistrationMs:
      input.routeRegistrationDurationMs === undefined
        ? undefined
        : roundToThree(toFinite(input.routeRegistrationDurationMs)),
    gotoMs:
      input.gotoDurationMs === undefined ? undefined : roundToThree(toFinite(input.gotoDurationMs)),
    loadStateMs:
      input.loadStateDurationMs === undefined
        ? undefined
        : roundToThree(toFinite(input.loadStateDurationMs)),
    domReadMs:
      input.domReadDurationMs === undefined
        ? undefined
        : roundToThree(toFinite(input.domReadDurationMs)),
    headerReadMs:
      input.headerReadDurationMs === undefined
        ? undefined
        : roundToThree(toFinite(input.headerReadDurationMs)),
    titleReadMs:
      input.titleReadDurationMs === undefined
        ? undefined
        : roundToThree(toFinite(input.titleReadDurationMs)),
    cleanupMs:
      input.cleanupDurationMs === undefined
        ? undefined
        : roundToThree(toFinite(input.cleanupDurationMs)),
  });
}

function summarizeAttemptTimings(attempts: ReadonlyArray<BenchmarkAttempt>) {
  return Schema.decodeUnknownSync(BenchmarkTimingSummarySchema)({
    totalWallMs: summarizeDistribution(attempts.map(({ timings }) => timings.totalWallMs)),
    runnerReportedMs: summarizeOptionalDistribution(
      attempts.map(({ timings }) => timings.runnerReportedMs),
    ),
    overheadMs: summarizeDistribution(attempts.map(({ timings }) => timings.overheadMs)),
    requestCount: summarizeOptionalDistribution(
      attempts.map(({ timings }) => timings.requestCount),
    ),
    redirectCount: summarizeOptionalDistribution(
      attempts.map(({ timings }) => timings.redirectCount),
    ),
    blockedRequestCount: summarizeOptionalDistribution(
      attempts.map(({ timings }) => timings.blockedRequestCount),
    ),
    responseHeadersMs: summarizeOptionalDistribution(
      attempts.map(({ timings }) => timings.responseHeadersMs),
    ),
    bodyReadMs: summarizeOptionalDistribution(attempts.map(({ timings }) => timings.bodyReadMs)),
    contextCreateMs: summarizeOptionalDistribution(
      attempts.map(({ timings }) => timings.contextCreateMs),
    ),
    pageCreateMs: summarizeOptionalDistribution(
      attempts.map(({ timings }) => timings.pageCreateMs),
    ),
    routeRegistrationMs: summarizeOptionalDistribution(
      attempts.map(({ timings }) => timings.routeRegistrationMs),
    ),
    gotoMs: summarizeOptionalDistribution(attempts.map(({ timings }) => timings.gotoMs)),
    loadStateMs: summarizeOptionalDistribution(attempts.map(({ timings }) => timings.loadStateMs)),
    domReadMs: summarizeOptionalDistribution(attempts.map(({ timings }) => timings.domReadMs)),
    headerReadMs: summarizeOptionalDistribution(
      attempts.map(({ timings }) => timings.headerReadMs),
    ),
    titleReadMs: summarizeOptionalDistribution(attempts.map(({ timings }) => timings.titleReadMs)),
    cleanupMs: summarizeOptionalDistribution(attempts.map(({ timings }) => timings.cleanupMs)),
  });
}

function buildBreakdown(key: string, attempts: ReadonlyArray<BenchmarkAttempt>) {
  return Schema.decodeUnknownSync(BreakdownSummarySchema)({
    key,
    attemptCount: attempts.length,
    successRate: roundToThree(
      safeRate(attempts.filter(({ success }) => success).length, attempts.length),
    ),
    challengeRate: roundToThree(
      safeRate(
        attempts.filter(({ challengeDetected }) => challengeDetected).length,
        attempts.length,
      ),
    ),
    redirectedRate: roundToThree(
      safeRate(attempts.filter(({ redirected }) => redirected).length, attempts.length),
    ),
    titlePresentRate: roundToThree(
      safeRate(attempts.filter(({ titlePresent }) => titlePresent).length, attempts.length),
    ),
    blockedRate: roundToThree(
      safeRate(attempts.filter(({ blocked }) => blocked).length, attempts.length),
    ),
    averageContentBytes: roundToThree(
      safeRate(
        attempts.reduce((sum, attempt) => sum + attempt.contentBytes, 0),
        Math.max(1, attempts.length),
      ),
    ),
    durationMs: summarizeDistribution(attempts.map(({ durationMs }) => durationMs)),
  });
}

function groupBreakdowns(
  attempts: ReadonlyArray<BenchmarkAttempt>,
  keyOf: (attempt: BenchmarkAttempt) => string,
) {
  const grouped = new Map<string, BenchmarkAttempt[]>();

  for (const attempt of attempts) {
    const key = keyOf(attempt);
    const current = grouped.get(key);
    if (current === undefined) {
      grouped.set(key, [attempt]);
      continue;
    }

    current.push(attempt);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([key, values]) => buildBreakdown(key, values));
}

function toFrictionClass(page: FrozenPage) {
  if (page.challengeSignals.length > 0) {
    return "high" as const;
  }

  if (page.pageType === "offer" || page.pageType === "search" || page.pageType === "unknown") {
    return "medium" as const;
  }

  return "low" as const;
}

function detectChallengeSignals(input: {
  readonly requestedUrl?: string | undefined;
  readonly statusCode?: number | undefined;
  readonly finalUrl?: string | undefined;
  readonly title?: string | undefined;
  readonly text?: string | undefined;
}) {
  const analysis = detectAccessWall(input);
  return analysis.likelyAccessWall ? analysis.signals : [];
}

export function mergeChallengeSignals(
  ...signalSets: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<string> {
  return [...new Set(signalSets.flat().filter((signal) => signal.trim().length > 0))].sort(
    compareStrings,
  );
}

function countRedirectChain(request: unknown) {
  if (!request || typeof request !== "object") {
    return undefined;
  }

  type RedirectChainNode = {
    readonly redirectedFrom?: () => RedirectChainNode | null;
  };

  let redirectCount = 0;
  let current: RedirectChainNode | null = request as RedirectChainNode;

  while (current) {
    if (typeof current.redirectedFrom !== "function") {
      break;
    }

    current = current.redirectedFrom();
    redirectCount += 1;
  }

  return redirectCount;
}

function buildAttempt(input: {
  readonly phase: BenchmarkPhase;
  readonly profile: BenchmarkProfile;
  readonly concurrency: number;
  readonly page: FrozenPage;
  readonly result: AttemptResult;
}) {
  const observedChallengeSignals =
    input.result.observedChallengeSignals.length > 0
      ? input.result.observedChallengeSignals
      : detectChallengeSignals({
          requestedUrl: input.page.url,
          statusCode: input.result.statusCode,
          finalUrl: input.result.finalUrl,
        });
  const challengeDetected = input.result.challengeDetected || observedChallengeSignals.length > 0;
  const timings = buildAttemptTimings(input.result);
  const success =
    input.result.error === undefined &&
    input.result.statusCode !== undefined &&
    input.result.statusCode < 400 &&
    !challengeDetected &&
    input.result.contentBytes > 0;

  const blocked =
    challengeDetected ||
    input.result.error !== undefined ||
    input.result.statusCode === 403 ||
    input.result.statusCode === 429;
  const failureCategory = classifyAttemptFailureCategory({
    result: {
      ...input.result,
      challengeDetected,
      observedChallengeSignals,
    },
    success,
  });

  return Schema.decodeUnknownSync(BenchmarkAttemptSchema)({
    phase: input.phase,
    profile: input.profile,
    concurrency: input.concurrency,
    siteId: input.page.siteId,
    domain: input.page.domain,
    url: input.page.url,
    pageType: input.page.pageType,
    frictionClass: toFrictionClass(input.page),
    expectedChallengeSignals: input.page.challengeSignals,
    statusCode: input.result.statusCode,
    success,
    blocked,
    redirected: input.result.redirected,
    challengeDetected,
    observedChallengeSignals,
    durationMs: timings.totalWallMs,
    contentBytes: Math.max(0, Math.round(input.result.contentBytes)),
    titlePresent: input.result.titlePresent,
    timings,
    finalUrl: input.result.finalUrl,
    error: input.result.error,
    ...(input.result.executionMetadata === undefined
      ? {}
      : { executionMetadata: input.result.executionMetadata }),
    ...(input.result.warnings === undefined || input.result.warnings.length === 0
      ? {}
      : { warnings: dedupeWarnings(input.result.warnings) }),
    ...(failureCategory === undefined ? {} : { failureCategory }),
  });
}

function formatAttemptError(error: unknown) {
  if (error instanceof Error) {
    const details =
      "details" in error && typeof error.details === "string" && error.details.trim().length > 0
        ? error.details.trim()
        : undefined;

    if (details !== undefined && details !== error.message) {
      return `${error.message} :: ${details}`;
    }

    return error.message;
  }

  if (typeof error === "object" && error !== null) {
    const message =
      "message" in error && typeof error.message === "string" ? error.message.trim() : undefined;
    const details =
      "details" in error && typeof error.details === "string" ? error.details.trim() : undefined;

    if (
      message !== undefined &&
      details !== undefined &&
      details.length > 0 &&
      details !== message
    ) {
      return `${message} :: ${details}`;
    }

    if (message !== undefined && message.length > 0) {
      return message;
    }

    if (details !== undefined && details.length > 0) {
      return details;
    }
  }

  return String(error);
}

function extractAttemptErrorWarnings(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "warnings" in error &&
    Array.isArray(error.warnings)
  ) {
    return dedupeWarnings(
      error.warnings.filter((warning): warning is string => typeof warning === "string"),
    );
  }

  return [] as const;
}

function dedupeWarnings(warnings: ReadonlyArray<string> | undefined) {
  if (warnings === undefined || warnings.length === 0) {
    return [];
  }

  return [...new Set(warnings.filter((warning) => warning.trim().length > 0))];
}

function benchmarkExecutionMetadataFromPlan(
  plan: ResolvedExecutionPlan,
): BenchmarkExecutionMetadata {
  return Schema.decodeUnknownSync(BenchmarkExecutionMetadataSchema)({
    source: "planned",
    providerId: plan.providerId,
    mode: plan.mode,
    egressProfileId: plan.egress.profileId,
    egressPluginId: plan.egress.pluginId,
    egressRouteKind: plan.egress.routeKind,
    egressRouteKey: plan.egress.routeKey,
    egressPoolId: plan.egress.poolId,
    egressRoutePolicyId: plan.egress.routePolicyId,
    identityProfileId: plan.identity.profileId,
    identityPluginId: plan.identity.pluginId,
    identityTenantId: plan.identity.tenantId,
    ...(plan.browser === undefined
      ? {}
      : { browserRuntimeProfileId: plan.browser.runtimeProfileId }),
  });
}

function benchmarkExecutionMetadataFromExecuted(metadata: {
  readonly providerId: string;
  readonly mode: "http" | "browser";
  readonly egressProfileId: string;
  readonly egressPluginId: string;
  readonly egressRouteKind: string;
  readonly egressRouteKey: string;
  readonly egressPoolId: string;
  readonly egressRoutePolicyId: string;
  readonly egressKey: string;
  readonly identityProfileId: string;
  readonly identityPluginId: string;
  readonly identityTenantId: string;
  readonly identityKey: string;
  readonly browserRuntimeProfileId?: string | undefined;
  readonly browserPoolKey?: string | undefined;
}): BenchmarkExecutionMetadata {
  return Schema.decodeUnknownSync(BenchmarkExecutionMetadataSchema)({
    source: "executed",
    ...metadata,
  });
}

async function resolveBenchmarkExecutionPlan(input: {
  readonly provideRuntime: SdkRuntimeHandle["provideRuntime"];
  readonly url: string;
  readonly defaultTimeoutMs: number;
  readonly defaultProviderId: string;
  readonly execution: {
    readonly mode?: "http" | "browser" | undefined;
    readonly http?: { readonly userAgent?: string | undefined } | undefined;
    readonly browser?:
      | {
          readonly timeoutMs?: number | undefined;
          readonly userAgent?: string | undefined;
        }
      | undefined;
  };
}) {
  const plan = await Effect.runPromise(
    Effect.gen(function* () {
      const executionRuntime = yield* AccessExecutionRuntime;
      return yield* executionRuntime.resolve({
        url: input.url,
        defaultTimeoutMs: input.defaultTimeoutMs,
        defaultProviderId: input.defaultProviderId,
        allowUnregisteredDefaultProviderFallback: true,
        execution: input.execution,
      });
    }).pipe(input.provideRuntime),
  );

  return {
    executionMetadata: benchmarkExecutionMetadataFromPlan(plan),
    warnings: dedupeWarnings(plan.warnings),
  } as const;
}

function isLocalFailureCategory(category: BenchmarkFailureCategory | undefined) {
  return (
    category === "local-selection" ||
    category === "local-egress-config" ||
    category === "local-identity-config"
  );
}

function hasRecoveredBrowserAllocationWarning(warnings: ReadonlyArray<string> | undefined) {
  return (
    warnings?.some((warning) => warning.startsWith(RECOVERED_BROWSER_ALLOCATION_WARNING_PREFIX)) ??
    false
  );
}

function classifyAccessWallFailureCategory(
  signals: ReadonlyArray<string>,
): BenchmarkFailureCategory {
  switch (classifyAccessWallKind(signals)) {
    case "challenge":
      return "access-wall-challenge";
    case "consent":
      return "access-wall-consent";
    case "rate-limit":
      return "access-wall-rate-limit";
    case "trap":
      return "access-wall-trap";
    default:
      return "access-wall";
  }
}

function classifyAttemptFailureCategory(input: {
  readonly result: AttemptResult;
  readonly success: boolean;
}): BenchmarkFailureCategory | undefined {
  if (input.success) {
    return undefined;
  }

  if (input.result.challengeDetected || input.result.observedChallengeSignals.length > 0) {
    return classifyAccessWallFailureCategory(input.result.observedChallengeSignals);
  }

  if (
    input.result.statusCode !== undefined &&
    (input.result.statusCode >= 400 || input.result.statusCode === 401)
  ) {
    return "http-error";
  }

  const error = (input.result.error ?? "").trim().toLowerCase();
  if (error.length === 0) {
    return input.result.contentBytes === 0 ? "empty-content" : "unknown-error";
  }

  if (
    error.includes("target page, context or browser has been closed") ||
    error.includes("browser has been closed") ||
    error.includes("page has been closed") ||
    error.includes("context closed")
  ) {
    return "browser-closed";
  }

  if (error.includes("crash")) {
    return "browser-crash";
  }

  if (error.includes("timeout") || error.includes("timed out") || error.includes("hard timeout")) {
    if (error.includes("navigation") || error.includes("goto")) {
      return "browser-navigation-timeout";
    }

    if (
      error.includes("dom-read") ||
      error.includes("dom read") ||
      error.includes("content read")
    ) {
      return "browser-dom-read-timeout";
    }

    if (error.includes("title-read") || error.includes("title read")) {
      return "browser-title-read-timeout";
    }

    return "timeout";
  }

  if (
    error.includes("failed to launch chromium") ||
    error.includes("requires patchright") ||
    error.includes("browser bootstrap failed")
  ) {
    return "browser-launch";
  }

  if (
    error.includes("allocate a browsing context") ||
    error.includes("context-allocation") ||
    error.includes("context allocation")
  ) {
    return "browser-context-allocation";
  }

  if (
    error.includes("allocate a browsing page") ||
    error.includes("page-allocation") ||
    error.includes("page allocation")
  ) {
    return "browser-page-allocation";
  }

  if (error.includes("route-registration") || error.includes("route registration")) {
    return "browser-route-registration";
  }

  if (error.includes("title-read") || error.includes("title read")) {
    return "browser-title-read-failed";
  }

  if (error.includes("header-read") || error.includes("header read")) {
    return "browser-header-read-failed";
  }

  if (error.includes("dom-read") || error.includes("dom read") || error.includes("content read")) {
    return "browser-dom-read-failed";
  }

  if (
    error.includes("navigation-response-missing") ||
    error.includes("completed without an http response")
  ) {
    return "browser-navigation-response-missing";
  }

  if (
    error.includes("net::err") ||
    error.includes("name_not_resolved") ||
    error.includes("connection refused") ||
    error.includes("connection reset") ||
    error.includes("connection closed") ||
    error.includes("dns")
  ) {
    return "browser-navigation-connection";
  }

  if (
    error.includes("aborted") ||
    error.includes("aborterror") ||
    error.includes("request-timeout") ||
    error.includes("blocked browser request")
  ) {
    return "browser-navigation-aborted";
  }

  if (error.includes("http 4") || error.includes("http 5")) {
    return "browser-navigation-http-error";
  }

  if (
    error.includes("no eligible egress profiles available") ||
    error.includes("duplicate egress profile id") ||
    error.includes("duplicate identity profile id") ||
    error.includes("unknown egress profile") ||
    error.includes("unknown identity profile") ||
    error.includes("unknown egress plugin") ||
    error.includes("unknown identity plugin") ||
    error.includes("selection policy returned an incompatible provider") ||
    error.includes("execution context/provider mode mismatch")
  ) {
    return "local-selection";
  }

  if (
    error.includes("invalid egress profile configuration") ||
    error.includes("invalid egress plugin config") ||
    error.includes('requires a non-empty "proxyurl" value') ||
    error.includes('"proxyurl" to be an absolute url') ||
    error.includes("invalid egress plugin/profile combination")
  ) {
    return "local-egress-config";
  }

  if (
    error.includes("invalid identity plugin config") ||
    error.includes("invalid identity plugin/profile combination")
  ) {
    return "local-identity-config";
  }

  if (
    error.includes("navigation") ||
    error.includes("goto") ||
    error.includes("browser access failed for")
  ) {
    return "browser-navigation-failed";
  }

  if (error.includes("network") || error.includes("fetch") || error.includes("access failed for")) {
    return "network-error";
  }

  return "unknown-error";
}

async function mapWithConcurrency<A, B>(
  values: ReadonlyArray<A>,
  concurrency: number,
  mapper: (value: A, index: number) => Promise<B>,
) {
  const results = Array.from({ length: values.length }) as B[];
  let index = 0;
  const workerCount = Math.max(1, Math.min(concurrency, values.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < values.length) {
        const nextIndex = index;
        index += 1;
        const value = values[nextIndex];
        if (value === undefined) {
          continue;
        }

        results[nextIndex] = await mapper(value, nextIndex);
      }
    }),
  );

  return results;
}

function buildSweepSummary(input: {
  readonly phase: BenchmarkPhase;
  readonly profile: BenchmarkProfile;
  readonly concurrency: number;
  readonly attempts: ReadonlyArray<BenchmarkAttempt>;
  readonly totalWallMs: number;
  readonly rssPeakMb: number;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
  readonly baselineThroughput: number;
}) {
  const attemptCount = input.attempts.length;
  const localFailureCount = input.attempts.filter((attempt) =>
    isLocalFailureCategory(attempt.failureCategory),
  ).length;
  const recoveredBrowserAllocationCount = input.attempts.filter((attempt) =>
    hasRecoveredBrowserAllocationWarning(attempt.warnings),
  ).length;
  const effectiveAttemptCount = attemptCount - localFailureCount;
  const successCount = input.attempts.filter(({ success }) => success).length;
  const throughputPagesPerMinute =
    input.totalWallMs <= 0 ? 0 : roundToThree((attemptCount / input.totalWallMs) * 60_000);
  const effectiveThroughputPagesPerMinute =
    input.totalWallMs <= 0
      ? 0
      : roundToThree((Math.max(0, effectiveAttemptCount) / input.totalWallMs) * 60_000);
  const parallelEfficiency =
    input.baselineThroughput <= 0
      ? 1
      : roundToThree(
          Math.min(1, throughputPagesPerMinute / (input.baselineThroughput * input.concurrency)),
        );

  return Schema.decodeUnknownSync(SweepSummarySchema)({
    phase: input.phase,
    profile: input.profile,
    concurrency: input.concurrency,
    attemptCount,
    successCount,
    successRate: roundToThree(safeRate(successCount, attemptCount)),
    blockedCount: input.attempts.filter(({ blocked }) => blocked).length,
    blockedRate: roundToThree(
      safeRate(input.attempts.filter(({ blocked }) => blocked).length, attemptCount),
    ),
    challengeRate: roundToThree(
      safeRate(
        input.attempts.filter(({ challengeDetected }) => challengeDetected).length,
        attemptCount,
      ),
    ),
    redirectedRate: roundToThree(
      safeRate(input.attempts.filter(({ redirected }) => redirected).length, attemptCount),
    ),
    titlePresentRate: roundToThree(
      safeRate(input.attempts.filter(({ titlePresent }) => titlePresent).length, attemptCount),
    ),
    localFailureCount,
    recoveredBrowserAllocationCount,
    effectiveAttemptCount,
    effectiveSuccessRate: roundToThree(safeRate(successCount, Math.max(1, effectiveAttemptCount))),
    totalWallMs: roundToThree(input.totalWallMs),
    throughputPagesPerMinute,
    effectiveThroughputPagesPerMinute,
    parallelEfficiency,
    contentBytes: summarizeDistribution(input.attempts.map(({ contentBytes }) => contentBytes)),
    durationMs: summarizeDistribution(input.attempts.map(({ durationMs }) => durationMs)),
    timings: summarizeAttemptTimings(input.attempts),
    rssPeakMb: roundToThree(input.rssPeakMb),
    cpuUserMs: roundToThree(input.cpuUserMs),
    cpuSystemMs: roundToThree(input.cpuSystemMs),
    bySite: groupBreakdowns(input.attempts, ({ siteId, domain }) => `${siteId} (${domain})`),
    byPageType: groupBreakdowns(input.attempts, ({ pageType }) => pageType),
    byFriction: groupBreakdowns(input.attempts, ({ frictionClass }) => frictionClass),
  });
}

function shouldStopAdaptiveScaling(input: {
  readonly previous: SweepSummary;
  readonly current: SweepSummary;
  readonly nextConcurrency: number | undefined;
}) {
  if (input.nextConcurrency === undefined || input.current.concurrency === 1) {
    return false;
  }

  const previousThroughput = Math.max(0.001, input.previous.throughputPagesPerMinute);
  const throughputGain = input.current.throughputPagesPerMinute / previousThroughput;
  const successDelta = Math.abs(input.current.successRate - input.previous.successRate);
  const blockedDelta = Math.abs(input.current.blockedRate - input.previous.blockedRate);
  const challengeDelta = Math.abs(input.current.challengeRate - input.previous.challengeRate);
  const qualityStable =
    successDelta <= ADAPTIVE_STOP_MAX_SUCCESS_DELTA &&
    blockedDelta <= ADAPTIVE_STOP_MAX_BLOCKED_DELTA &&
    challengeDelta <= ADAPTIVE_STOP_MAX_CHALLENGE_DELTA;
  const scalingSaturated =
    throughputGain < ADAPTIVE_STOP_MIN_GAIN ||
    input.current.parallelEfficiency < ADAPTIVE_STOP_MIN_PARALLEL_EFFICIENCY;

  return qualityStable && scalingSaturated;
}

async function loadFrozenPages(path: string) {
  const raw = await readFile(path, "utf8");
  const artifact = Schema.decodeUnknownSync(E9CommerceCorpusFreezeArtifactSchema)(JSON.parse(raw));
  return {
    path,
    pages: artifact.pages,
    selectedSiteCount: artifact.selectedSiteCount,
    selectedPageCount: artifact.selectedPageCount,
  };
}

function orderPagesForSeed(
  pages: ReadonlyArray<FrozenPage>,
  seed: string,
  salt: string,
): ReadonlyArray<FrozenPage> {
  return [...pages].sort((left, right) => {
    const hashOrder =
      hashString(`${seed}|${salt}|${left.url}`) - hashString(`${seed}|${salt}|${right.url}`);
    if (hashOrder !== 0) {
      return hashOrder;
    }

    return compareStrings(left.url, right.url);
  });
}

function selectStratifiedSample(
  pages: ReadonlyArray<FrozenPage>,
  samplePageCount: number,
  seed: string,
): ReadonlyArray<FrozenPage> {
  if (samplePageCount >= pages.length) {
    return pages;
  }

  const byBucket = new Map<string, FrozenPage[]>();
  for (const page of pages) {
    const bucketKey = [page.siteId, page.pageType, toFrictionClass(page)].join("|");
    const current = byBucket.get(bucketKey);
    if (current === undefined) {
      byBucket.set(bucketKey, [page]);
      continue;
    }

    current.push(page);
  }

  const orderedBuckets = [...byBucket.entries()]
    .map(([bucketKey, bucketPages]) => ({
      bucketKey,
      pages: orderPagesForSeed(bucketPages, seed, bucketKey),
    }))
    .sort((left, right) => {
      const hashOrder =
        hashString(`${seed}|bucket|${left.bucketKey}`) -
        hashString(`${seed}|bucket|${right.bucketKey}`);
      if (hashOrder !== 0) {
        return hashOrder;
      }

      return compareStrings(left.bucketKey, right.bucketKey);
    });

  const selected = new Array<FrozenPage>();
  let cursor = 0;
  while (selected.length < samplePageCount) {
    let addedInRound = false;
    for (const bucket of orderedBuckets) {
      const candidate = bucket.pages[cursor];
      if (candidate === undefined) {
        continue;
      }

      selected.push(candidate);
      addedInRound = true;
      if (selected.length >= samplePageCount) {
        break;
      }
    }

    if (!addedInRound) {
      break;
    }

    cursor += 1;
  }

  const originalOrder = new Map(pages.map((page, index) => [page.url, index] as const));
  return [...selected].sort((left, right) => {
    const leftIndex = originalOrder.get(left.url) ?? 0;
    const rightIndex = originalOrder.get(right.url) ?? 0;
    return leftIndex - rightIndex;
  });
}

function selectShardPages(
  pages: ReadonlyArray<FrozenPage>,
  shardCount: number,
  shardIndex: number,
): ReadonlyArray<FrozenPage> {
  if (shardCount <= 1) {
    return pages;
  }

  const normalizedIndex = shardIndex - 1;
  return pages.filter((_page, index) => index % shardCount === normalizedIndex);
}

function interleaveSweepPagesByDomain(
  pages: ReadonlyArray<FrozenPage>,
  seed: string,
): ReadonlyArray<FrozenPage> {
  if (pages.length <= 2) {
    return pages;
  }

  const byDomain = new Map<string, FrozenPage[]>();
  for (const page of pages) {
    const current = byDomain.get(page.domain);
    if (current === undefined) {
      byDomain.set(page.domain, [page]);
      continue;
    }

    current.push(page);
  }

  if (byDomain.size <= 1) {
    return orderPagesForSeed(pages, seed, "single-domain");
  }

  const buckets = [...byDomain.entries()]
    .map(([domain, bucketPages]) => ({
      domain,
      pages: orderPagesForSeed(bucketPages, seed, domain),
    }))
    .sort((left, right) => {
      const hashOrder =
        hashString(`${seed}|domain|${left.domain}`) - hashString(`${seed}|domain|${right.domain}`);
      if (hashOrder !== 0) {
        return hashOrder;
      }

      return compareStrings(left.domain, right.domain);
    });

  const interleaved = new Array<FrozenPage>();
  let cursor = 0;
  while (interleaved.length < pages.length) {
    let added = false;
    for (const bucket of buckets) {
      const candidate = bucket.pages[cursor];
      if (candidate === undefined) {
        continue;
      }

      interleaved.push(candidate);
      added = true;
    }

    if (!added) {
      break;
    }

    cursor += 1;
  }

  return interleaved;
}

function selectBenchmarkPages(input: {
  readonly path: string;
  readonly pages: ReadonlyArray<FrozenPage>;
  readonly selectedPageCount: number;
  readonly selectedSiteCount: number;
  readonly preset?: BenchmarkPreset | undefined;
  readonly samplePageCount?: number | undefined;
  readonly sampleSeed?: string | undefined;
  readonly shardCount?: number | undefined;
  readonly shardIndex?: number | undefined;
}): SelectedCorpus {
  const sourcePageCount = input.selectedPageCount;
  const sourceSiteCount = input.selectedSiteCount;
  const sampleSeed = input.sampleSeed ?? DEFAULT_SAMPLE_SEED;
  const sampledPages =
    input.samplePageCount === undefined || input.samplePageCount >= input.pages.length
      ? input.pages
      : selectStratifiedSample(input.pages, input.samplePageCount, sampleSeed);
  const shardCount = input.shardCount;
  const shardIndex = input.shardIndex;
  const executedPages =
    shardCount === undefined || shardIndex === undefined
      ? sampledPages
      : selectShardPages(sampledPages, shardCount, shardIndex);

  return {
    path: input.path,
    sourcePageCount,
    sourceSiteCount,
    selectedPageCount: sampledPages.length,
    selectedSiteCount: new Set(sampledPages.map(({ siteId }) => siteId)).size,
    selectedHighFrictionPageCount: sampledPages.filter((page) => toFrictionClass(page) === "high")
      .length,
    selectedPageTypeCounts: buildPageTypeCounts(sampledPages),
    pages: executedPages,
    ...(input.preset === undefined ? {} : { preset: input.preset }),
    ...(sampledPages.length === input.pages.length
      ? { samplingStrategy: "full-corpus" }
      : { samplingStrategy: "stratified-site-page-friction" }),
    ...(input.samplePageCount === undefined ? {} : { samplePageCount: input.samplePageCount }),
    ...(sampledPages.length === input.pages.length ? {} : { sampleSeed }),
    ...(shardCount === undefined ? {} : { shardCount }),
    ...(shardIndex === undefined ? {} : { shardIndex }),
    ...(shardCount === undefined || shardIndex === undefined
      ? {}
      : { shardPageCount: executedPages.length }),
  };
}

async function createEffectHttpRunner(input: { readonly timeoutMs: number }): Promise<SweepRunner> {
  const sdkEnvironment = await makeScopedSdkEnvironmentProvider();

  return {
    runPage: async (page) => {
      const startedAt = performance.now();
      let plannedExecution: Awaited<ReturnType<typeof resolveBenchmarkExecutionPlan>> | undefined;

      try {
        plannedExecution = await resolveBenchmarkExecutionPlan({
          provideRuntime: sdkEnvironment.provideRuntime,
          url: page.url,
          defaultTimeoutMs: input.timeoutMs,
          defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
          execution: {
            mode: "http",
            http: {
              userAgent: DEFAULT_HTTP_USER_AGENT,
            },
          },
        });
        const response = await Effect.runPromise(
          accessPreview({
            url: page.url,
            timeoutMs: input.timeoutMs,
            execution: {
              mode: "http",
              http: {
                userAgent: DEFAULT_HTTP_USER_AGENT,
              },
            },
          }).pipe(sdkEnvironment.provide),
        );
        const warningSignals = readAccessWallSignalsFromWarnings(response.warnings);
        const challengeSignals = mergeChallengeSignals(
          warningSignals,
          detectChallengeSignals({
            requestedUrl: page.url,
            statusCode: response.data.status,
            finalUrl: response.data.finalUrl,
          }),
        );

        return {
          statusCode: response.data.status,
          redirected: response.data.finalUrl !== response.data.url,
          challengeDetected: challengeSignals.length > 0,
          observedChallengeSignals: challengeSignals,
          durationMs: roundToThree(performance.now() - startedAt),
          reportedDurationMs: toFinite(response.data.durationMs),
          requestCount: response.data.timings?.requestCount,
          redirectCount: response.data.timings?.redirectCount,
          blockedRequestCount: response.data.timings?.blockedRequestCount,
          responseHeadersDurationMs: response.data.timings?.responseHeadersDurationMs,
          bodyReadDurationMs: response.data.timings?.bodyReadDurationMs,
          contentBytes: Math.max(0, response.data.contentLength),
          titlePresent: false,
          finalUrl: response.data.finalUrl,
          executionMetadata: benchmarkExecutionMetadataFromExecuted(response.data.execution),
          warnings: dedupeWarnings([...plannedExecution.warnings, ...response.warnings]),
        } satisfies AttemptResult;
      } catch (error) {
        const errorWarnings = extractAttemptErrorWarnings(error);
        return {
          redirected: false,
          challengeDetected: false,
          observedChallengeSignals: [],
          durationMs: roundToThree(performance.now() - startedAt),
          contentBytes: 0,
          titlePresent: false,
          error: formatAttemptError(error),
          ...(plannedExecution === undefined
            ? {}
            : {
                executionMetadata: plannedExecution.executionMetadata,
                warnings: dedupeWarnings([...plannedExecution.warnings, ...errorWarnings]),
              }),
        } satisfies AttemptResult;
      }
    },
    close: async () => {
      await sdkEnvironment.close();
    },
  };
}

async function createNativeFetchRunner(input: {
  readonly timeoutMs: number;
}): Promise<SweepRunner> {
  return {
    runPage: async (page) => {
      const startedAt = performance.now();
      let responseHeadersDurationMs: number | undefined;
      let bodyReadDurationMs: number | undefined;

      try {
        const responseStartedAt = performance.now();
        const response = await fetch(page.url, {
          headers: {
            "user-agent": DEFAULT_HTTP_USER_AGENT,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(input.timeoutMs),
        });
        responseHeadersDurationMs = roundToThree(performance.now() - responseStartedAt);
        const bodyStartedAt = performance.now();
        const html = await response.text();
        bodyReadDurationMs = roundToThree(performance.now() - bodyStartedAt);
        const durationMs = roundToThree(performance.now() - startedAt);
        const title = extractHtmlTitle(html);
        const challengeSignals = detectChallengeSignals({
          requestedUrl: page.url,
          statusCode: response.status,
          finalUrl: response.url,
          title,
          text: html.slice(0, 4_000),
        });

        return {
          statusCode: response.status,
          redirected: response.url !== page.url,
          challengeDetected: challengeSignals.length > 0,
          observedChallengeSignals: challengeSignals,
          durationMs,
          reportedDurationMs: durationMs,
          blockedRequestCount: 0,
          responseHeadersDurationMs,
          bodyReadDurationMs,
          contentBytes: Buffer.byteLength(html, "utf8"),
          titlePresent: typeof title === "string" && title.length > 0,
          finalUrl: response.url,
        } satisfies AttemptResult;
      } catch (error) {
        return {
          redirected: false,
          challengeDetected: false,
          observedChallengeSignals: [],
          durationMs: roundToThree(performance.now() - startedAt),
          responseHeadersDurationMs,
          bodyReadDurationMs,
          contentBytes: 0,
          titlePresent: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies AttemptResult;
      }
    },
    close: async () => undefined,
  };
}

async function createEffectBrowserRunner(input: {
  readonly timeoutMs: number;
}): Promise<SweepRunner> {
  const sdkEnvironment = await makeScopedSdkEnvironmentProvider();

  return {
    runPage: async (page) => {
      const startedAt = performance.now();
      let plannedExecution: Awaited<ReturnType<typeof resolveBenchmarkExecutionPlan>> | undefined;

      try {
        plannedExecution = await resolveBenchmarkExecutionPlan({
          provideRuntime: sdkEnvironment.provideRuntime,
          url: page.url,
          defaultTimeoutMs: input.timeoutMs,
          defaultProviderId: DEFAULT_BROWSER_PROVIDER_ID,
          execution: {
            mode: "browser",
            browser: {
              timeoutMs: input.timeoutMs,
              userAgent: DEFAULT_BROWSER_USER_AGENT,
            },
          },
        });
        const response = await Effect.runPromise(
          renderPreview({
            url: page.url,
            timeoutMs: input.timeoutMs,
            execution: {
              mode: "browser",
              browser: {
                timeoutMs: input.timeoutMs,
                userAgent: DEFAULT_BROWSER_USER_AGENT,
              },
            },
          }).pipe(sdkEnvironment.provide),
        );
        const [navigationArtifact, renderedDomArtifact] = response.data.artifacts;
        const warningSignals = readAccessWallSignalsFromWarnings(response.warnings);
        const challengeSignals = mergeChallengeSignals(
          warningSignals,
          detectChallengeSignals({
            requestedUrl: page.url,
            statusCode: response.data.status.code,
            finalUrl: navigationArtifact.finalUrl,
            title: renderedDomArtifact.title ?? undefined,
            text: renderedDomArtifact.textPreview,
          }),
        );

        return {
          statusCode: response.data.status.code,
          redirected: response.data.status.redirected,
          challengeDetected: challengeSignals.length > 0,
          observedChallengeSignals: challengeSignals,
          durationMs: roundToThree(performance.now() - startedAt),
          reportedDurationMs: toFinite(response.data.artifacts[2].durationMs),
          requestCount: response.data.artifacts[2].requestCount,
          redirectCount: response.data.artifacts[2].redirectCount,
          blockedRequestCount: response.data.artifacts[2].blockedRequestCount,
          responseHeadersDurationMs: response.data.artifacts[2].responseHeadersDurationMs,
          bodyReadDurationMs: response.data.artifacts[2].bodyReadDurationMs,
          routeRegistrationDurationMs: response.data.artifacts[2].routeRegistrationDurationMs,
          gotoDurationMs: response.data.artifacts[2].gotoDurationMs,
          loadStateDurationMs: response.data.artifacts[2].loadStateDurationMs,
          domReadDurationMs: response.data.artifacts[2].domReadDurationMs,
          headerReadDurationMs: response.data.artifacts[2].headerReadDurationMs,
          contentBytes: navigationArtifact.contentLength,
          titlePresent:
            typeof renderedDomArtifact.title === "string" && renderedDomArtifact.title.length > 0,
          finalUrl: navigationArtifact.finalUrl,
          executionMetadata: benchmarkExecutionMetadataFromExecuted(response.data.execution),
          warnings: dedupeWarnings([...plannedExecution.warnings, ...response.warnings]),
        } satisfies AttemptResult;
      } catch (error) {
        const errorWarnings = extractAttemptErrorWarnings(error);
        return {
          redirected: false,
          challengeDetected: false,
          observedChallengeSignals: [],
          durationMs: roundToThree(performance.now() - startedAt),
          contentBytes: 0,
          titlePresent: false,
          error: formatAttemptError(error),
          ...(plannedExecution === undefined
            ? {}
            : {
                executionMetadata: plannedExecution.executionMetadata,
                warnings: dedupeWarnings([...plannedExecution.warnings, ...errorWarnings]),
              }),
        } satisfies AttemptResult;
      }
    },
    close: async () => {
      await sdkEnvironment.close();
    },
  };
}

async function makeScopedSdkEnvironmentProvider() {
  const scope = Effect.runSync(Scope.make());

  try {
    const handle = await Effect.runPromise(
      makeSdkRuntimeHandle().pipe(Effect.provideService(Scope.Scope, scope)),
    );

    return {
      provide: handle.provideEnvironment,
      provideRuntime: handle.provideRuntime,
      close: async () => {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      },
    } as const;
  } catch (error) {
    Effect.runSync(Scope.close(scope, Exit.void));
    throw error;
  }
}

async function createPatchrightBrowserRunner(input: {
  readonly timeoutMs: number;
}): Promise<SweepRunner> {
  const browser = await chromium.launch({
    headless: true,
  });

  return {
    runPage: async (page) => {
      const startedAt = performance.now();
      let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
      let browserPage:
        | Awaited<ReturnType<Awaited<ReturnType<typeof browser.newContext>>["newPage"]>>
        | undefined;
      let contextCreateMs: number | undefined;
      let pageCreateMs: number | undefined;
      let result: AttemptResult | undefined;
      let gotoDurationMs: number | undefined;
      let domReadDurationMs: number | undefined;
      let titleReadDurationMs: number | undefined;
      let stage:
        | "context-allocation"
        | "page-allocation"
        | "navigation"
        | "dom-read"
        | "title-read"
        | undefined;

      try {
        const contextStartedAt = performance.now();
        stage = "context-allocation";
        context = await browser.newContext({
          userAgent: DEFAULT_BROWSER_USER_AGENT,
        });
        contextCreateMs = roundToThree(performance.now() - contextStartedAt);
        const pageStartedAt = performance.now();
        stage = "page-allocation";
        browserPage = await context.newPage();
        pageCreateMs = roundToThree(performance.now() - pageStartedAt);
        const gotoStartedAt = performance.now();
        stage = "navigation";
        const response = await browserPage.goto(page.url, {
          timeout: input.timeoutMs,
          waitUntil: "networkidle",
        });
        gotoDurationMs = roundToThree(performance.now() - gotoStartedAt);
        const domReadStartedAt = performance.now();
        stage = "dom-read";
        const html = await browserPage.content();
        domReadDurationMs = roundToThree(performance.now() - domReadStartedAt);
        const titleStartedAt = performance.now();
        stage = "title-read";
        const title = await browserPage.title();
        titleReadDurationMs = roundToThree(performance.now() - titleStartedAt);
        stage = undefined;
        const finalUrl = browserPage.url();
        const redirectCount =
          response && typeof response.request === "function"
            ? countRedirectChain(response.request())
            : undefined;
        const challengeSignals = detectChallengeSignals({
          requestedUrl: page.url,
          statusCode: response?.status(),
          finalUrl,
          title,
          text: html.slice(0, 4_000),
        });
        const reportedDurationMs = roundToThree(performance.now() - startedAt);

        result = {
          statusCode: response?.status(),
          redirected: finalUrl !== page.url,
          challengeDetected: challengeSignals.length > 0,
          observedChallengeSignals: challengeSignals,
          durationMs: 0,
          reportedDurationMs,
          requestCount:
            response === null || response === undefined
              ? undefined
              : redirectCount === undefined
                ? 1
                : redirectCount + 1,
          redirectCount,
          blockedRequestCount: 0,
          contextCreateDurationMs: contextCreateMs,
          pageCreateDurationMs: pageCreateMs,
          gotoDurationMs,
          domReadDurationMs,
          titleReadDurationMs,
          contentBytes: Buffer.byteLength(html, "utf8"),
          titlePresent: title.trim().length > 0,
          finalUrl,
        } satisfies AttemptResult;
      } catch (error) {
        result = {
          redirected: false,
          challengeDetected: false,
          observedChallengeSignals: [],
          durationMs: 0,
          contextCreateDurationMs: contextCreateMs,
          pageCreateDurationMs: pageCreateMs,
          gotoDurationMs,
          domReadDurationMs,
          titleReadDurationMs,
          contentBytes: 0,
          titlePresent: false,
          error:
            stage === undefined
              ? formatAttemptError(error)
              : `patchright ${stage} failed: ${formatAttemptError(error)}`,
        } satisfies AttemptResult;
      } finally {
        const cleanupStartedAt = performance.now();
        await browserPage?.close().catch(() => undefined);
        await context?.close().catch(() => undefined);
        const cleanupDurationMs = roundToThree(performance.now() - cleanupStartedAt);
        if (result !== undefined) {
          result = {
            ...result,
            durationMs: roundToThree(performance.now() - startedAt),
            cleanupDurationMs,
          };
        }
      }

      if (result === undefined) {
        throw new Error(`Patchright benchmark runner produced no result for ${page.url}`);
      }

      return result;
    },
    close: async () => {
      await browser.close();
    },
  };
}

function defaultHttpProfileFactories() {
  return [
    {
      profile: "effect-http" as const,
      createRunner: createEffectHttpRunner,
    },
    {
      profile: "native-fetch" as const,
      createRunner: createNativeFetchRunner,
    },
  ] as const;
}

function defaultBrowserProfileFactories() {
  return [
    {
      profile: "effect-browser" as const,
      createRunner: createEffectBrowserRunner,
    },
    {
      profile: "patchright-browser" as const,
      createRunner: createPatchrightBrowserRunner,
    },
  ] as const;
}

async function runPhase(input: {
  readonly benchmarkId: string;
  readonly generatedAt: string;
  readonly phase: BenchmarkPhase;
  readonly pages: ReadonlyArray<FrozenPage>;
  readonly concurrencyLevels: ReadonlyArray<number>;
  readonly timeoutMs: number;
  readonly profileFactories: ReadonlyArray<{
    readonly profile: BenchmarkProfile;
    readonly createRunner: SweepRunnerFactory;
  }>;
  readonly adaptiveStop: boolean;
  readonly onProgress?: E9BenchmarkSuiteProgressListener;
}) {
  const phaseStartedAt = performance.now();
  const attempts = new Array<BenchmarkAttempt>();
  const sweeps = new Array<SweepSummary>();
  const sourcePageOrder = new Map(input.pages.map((page, index) => [page.url, index + 1] as const));
  emitProgress(input.onProgress, {
    kind: "phase-start",
    benchmarkId: input.benchmarkId,
    generatedAt: input.generatedAt,
    phase: input.phase,
    pageCount: input.pages.length,
    profileCount: input.profileFactories.length,
    concurrencyLevels: [...input.concurrencyLevels],
    expectedSweepCount: input.profileFactories.length * input.concurrencyLevels.length,
  });

  for (const profileFactory of input.profileFactories) {
    const profileStartedAt = performance.now();
    const profileAttempts = new Array<BenchmarkAttempt>();
    const profileSweeps = new Array<SweepSummary>();
    let baselineThroughput = 0;
    emitProgress(input.onProgress, {
      kind: "profile-start",
      benchmarkId: input.benchmarkId,
      generatedAt: input.generatedAt,
      phase: input.phase,
      profile: profileFactory.profile,
      pageCount: input.pages.length,
      sweepCount: input.concurrencyLevels.length,
      concurrencyLevels: [...input.concurrencyLevels],
    });

    for (const [sweepIndex, concurrency] of input.concurrencyLevels.entries()) {
      const sweepPages = interleaveSweepPagesByDomain(
        input.pages,
        [
          input.generatedAt,
          input.benchmarkId,
          input.phase,
          profileFactory.profile,
          String(concurrency),
          String(sweepIndex + 1),
        ].join("|"),
      );
      const runner = await profileFactory.createRunner({
        timeoutMs: input.timeoutMs,
      });
      const startedAt = performance.now();
      const cpuStartedAt = process.cpuUsage();
      let peakRssBytes = process.memoryUsage().rss;
      let completedCount = 0;
      emitProgress(input.onProgress, {
        kind: "sweep-start",
        benchmarkId: input.benchmarkId,
        generatedAt: input.generatedAt,
        phase: input.phase,
        profile: profileFactory.profile,
        concurrency,
        pageCount: input.pages.length,
        sweepOrdinal: sweepIndex + 1,
        sweepCount: input.concurrencyLevels.length,
      });

      try {
        const sweepAttempts = await mapWithConcurrency(
          sweepPages,
          concurrency,
          async (page, pageIndex) => {
            peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
            const result = await runner.runPage(page);
            peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
            const attempt = buildAttempt({
              phase: input.phase,
              profile: profileFactory.profile,
              concurrency,
              page,
              result,
            });
            completedCount += 1;
            const elapsedMs = roundToThree(performance.now() - startedAt);
            const etaMs =
              completedCount >= input.pages.length || completedCount === 0
                ? 0
                : roundToThree(
                    (elapsedMs / completedCount) * (input.pages.length - completedCount),
                  );
            emitProgress(input.onProgress, {
              kind: "attempt-complete",
              benchmarkId: input.benchmarkId,
              generatedAt: input.generatedAt,
              phase: input.phase,
              profile: profileFactory.profile,
              concurrency,
              pageOrdinal: sourcePageOrder.get(page.url) ?? pageIndex + 1,
              completedCount,
              totalCount: input.pages.length,
              siteId: attempt.siteId,
              domain: attempt.domain,
              url: attempt.url,
              pageType: attempt.pageType,
              frictionClass: attempt.frictionClass,
              success: attempt.success,
              blocked: attempt.blocked,
              challengeDetected: attempt.challengeDetected,
              redirected: attempt.redirected,
              statusCode: attempt.statusCode,
              durationMs: attempt.durationMs,
              reportedDurationMs: attempt.timings.runnerReportedMs,
              overheadDurationMs: attempt.timings.overheadMs,
              requestCount: attempt.timings.requestCount,
              redirectCount: attempt.timings.redirectCount,
              blockedRequestCount: attempt.timings.blockedRequestCount,
              contentBytes: attempt.contentBytes,
              elapsedMs,
              etaMs,
              finalUrl: attempt.finalUrl,
              error: attempt.error,
              failureCategory: attempt.failureCategory,
              executionMetadata: attempt.executionMetadata,
              warnings: attempt.warnings,
            });
            return attempt;
          },
        );

        const cpuUsage = process.cpuUsage(cpuStartedAt);
        const totalWallMs = performance.now() - startedAt;
        const currentSummary = buildSweepSummary({
          phase: input.phase,
          profile: profileFactory.profile,
          concurrency,
          attempts: sweepAttempts,
          totalWallMs,
          rssPeakMb: peakRssBytes / 1024 / 1024,
          cpuUserMs: cpuUsage.user / 1_000,
          cpuSystemMs: cpuUsage.system / 1_000,
          baselineThroughput,
        });

        const finalSummary =
          concurrency === 1
            ? Schema.decodeUnknownSync(SweepSummarySchema)({
                ...currentSummary,
                parallelEfficiency: 1,
              })
            : currentSummary;

        if (concurrency === 1) {
          baselineThroughput = currentSummary.throughputPagesPerMinute;
        }

        profileSweeps.push(finalSummary);
        profileAttempts.push(...sweepAttempts);
        emitProgress(input.onProgress, {
          kind: "sweep-complete",
          benchmarkId: input.benchmarkId,
          generatedAt: input.generatedAt,
          phase: input.phase,
          profile: profileFactory.profile,
          concurrency,
          pageCount: input.pages.length,
          sweepOrdinal: sweepIndex + 1,
          sweepCount: input.concurrencyLevels.length,
          totalWallMs: finalSummary.totalWallMs,
          throughputPagesPerMinute: finalSummary.throughputPagesPerMinute,
          parallelEfficiency: finalSummary.parallelEfficiency,
          successCount: finalSummary.successCount,
          blockedCount: finalSummary.blockedCount,
          challengeCount: Math.round(finalSummary.challengeRate * finalSummary.attemptCount),
          recoveredBrowserAllocationCount: finalSummary.recoveredBrowserAllocationCount,
          rssPeakMb: finalSummary.rssPeakMb,
          cpuUserMs: finalSummary.cpuUserMs,
          cpuSystemMs: finalSummary.cpuSystemMs,
        });
        const previousSummary = profileSweeps.at(-2);
        const nextConcurrency = input.concurrencyLevels[sweepIndex + 1];
        if (
          input.adaptiveStop &&
          previousSummary !== undefined &&
          shouldStopAdaptiveScaling({
            previous: previousSummary,
            current: finalSummary,
            nextConcurrency,
          })
        ) {
          break;
        }
      } finally {
        await runner.close();
      }
    }

    attempts.push(...profileAttempts);
    sweeps.push(...profileSweeps);
    emitProgress(input.onProgress, {
      kind: "profile-complete",
      benchmarkId: input.benchmarkId,
      generatedAt: input.generatedAt,
      phase: input.phase,
      profile: profileFactory.profile,
      attemptCount: profileAttempts.length,
      sweepCount: profileSweeps.length,
      totalWallMs: roundToThree(performance.now() - profileStartedAt),
    });
  }

  const phaseArtifact = Schema.decodeUnknownSync(BenchmarkPhaseArtifactSchema)({
    phase: input.phase,
    pageCount: input.pages.length,
    attempts,
    sweeps,
  });
  emitProgress(input.onProgress, {
    kind: "phase-complete",
    benchmarkId: input.benchmarkId,
    generatedAt: input.generatedAt,
    phase: input.phase,
    attemptCount: phaseArtifact.attempts.length,
    sweepCount: phaseArtifact.sweeps.length,
    totalWallMs: roundToThree(performance.now() - phaseStartedAt),
  });
  return phaseArtifact;
}

function buildPageTypeCounts(pages: ReadonlyArray<FrozenPage>) {
  return Schema.decodeUnknownSync(PageTypeCountsSchema)({
    product: pages.filter(({ pageType }) => pageType === "product").length,
    listing: pages.filter(({ pageType }) => pageType === "listing").length,
    search: pages.filter(({ pageType }) => pageType === "search").length,
    offer: pages.filter(({ pageType }) => pageType === "offer").length,
    unknown: pages.filter(({ pageType }) => pageType === "unknown").length,
  });
}

function isSelectedHttpProfile(
  profile: BenchmarkProfile,
  selected: ReadonlyArray<HttpBenchmarkProfile> | undefined,
): profile is HttpBenchmarkProfile {
  return selected === undefined || selected.some((entry) => entry === profile);
}

function isSelectedBrowserProfile(
  profile: BenchmarkProfile,
  selected: ReadonlyArray<BrowserBenchmarkProfile> | undefined,
): profile is BrowserBenchmarkProfile {
  return selected === undefined || selected.some((entry) => entry === profile);
}

function emptyPhaseArtifact(phase: BenchmarkPhase, pageCount: number) {
  return Schema.decodeUnknownSync(BenchmarkPhaseArtifactSchema)({
    phase,
    pageCount,
    attempts: [],
    sweeps: [],
  });
}

function toSubbenchmarkStatus<T extends { readonly status: "pass" | "fail" }>(wrapper: {
  readonly totalWallMs: number;
  readonly skipped?: boolean | undefined;
  readonly artifact?: T | undefined;
}) {
  if (wrapper.skipped === true || wrapper.artifact === undefined || wrapper.totalWallMs <= 0) {
    return undefined;
  }

  return wrapper.artifact.status;
}

function computeSuiteStatus(input: {
  readonly httpCorpus: Schema.Schema.Type<typeof BenchmarkPhaseArtifactSchema>;
  readonly browserCorpus: Schema.Schema.Type<typeof BenchmarkPhaseArtifactSchema>;
  readonly scraplingParity: {
    readonly totalWallMs: number;
    readonly skipped?: boolean | undefined;
    readonly artifact?: Schema.Schema.Type<typeof E9ScraplingParityArtifactSchema> | undefined;
  };
  readonly highFrictionCanary: {
    readonly totalWallMs: number;
    readonly skipped?: boolean | undefined;
    readonly artifact?: Schema.Schema.Type<typeof E9HighFrictionCanaryArtifactSchema> | undefined;
  };
}) {
  const localFailureCount = [...input.httpCorpus.attempts, ...input.browserCorpus.attempts].filter(
    (attempt) => isLocalFailureCategory(attempt.failureCategory),
  ).length;
  const executedSubbenchmarkStatuses = [
    toSubbenchmarkStatus(input.scraplingParity),
    toSubbenchmarkStatus(input.highFrictionCanary),
  ].filter((status): status is "pass" | "fail" => status !== undefined);
  const sweeps = [...input.httpCorpus.sweeps, ...input.browserCorpus.sweeps];
  if (sweeps.length === 0) {
    if (
      executedSubbenchmarkStatuses.length > 0 &&
      executedSubbenchmarkStatuses.every((status) => status === "pass")
    ) {
      return "pass" as const;
    }

    if (executedSubbenchmarkStatuses.some((status) => status === "fail")) {
      return "fail" as const;
    }

    return "warn" as const;
  }

  const successSweepCount = sweeps.filter(
    (sweep) => sweep.effectiveAttemptCount > 0 && sweep.effectiveSuccessRate >= 0.5,
  ).length;
  const totalSweepCount = sweeps.length;
  if (
    successSweepCount === totalSweepCount &&
    executedSubbenchmarkStatuses.every((status) => status === "pass")
  ) {
    return localFailureCount > 0 ? ("warn" as const) : ("pass" as const);
  }

  if (
    successSweepCount >= Math.ceil(totalSweepCount / 2) &&
    !executedSubbenchmarkStatuses.some((status) => status === "fail")
  ) {
    return "warn" as const;
  }

  return "fail" as const;
}

function buildCountBreakdown(
  values: ReadonlyArray<string>,
  limit: number,
): ReadonlyArray<Schema.Schema.Type<typeof BenchmarkReportItemSchema>> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => {
      const countOrder = right[1] - left[1];
      if (countOrder !== 0) {
        return countOrder;
      }
      return compareStrings(left[0], right[0]);
    })
    .slice(0, limit)
    .map(([key, count]) => Schema.decodeUnknownSync(BenchmarkReportItemSchema)({ key, count }));
}

function mergeCountBreakdowns(
  values: ReadonlyArray<ReadonlyArray<Schema.Schema.Type<typeof BenchmarkReportItemSchema>>>,
  limit: number,
): ReadonlyArray<Schema.Schema.Type<typeof BenchmarkReportItemSchema>> {
  const counts = new Map<string, number>();
  for (const entries of values) {
    for (const entry of entries) {
      counts.set(entry.key, (counts.get(entry.key) ?? 0) + entry.count);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => {
      const countOrder = right[1] - left[1];
      if (countOrder !== 0) {
        return countOrder;
      }
      return compareStrings(left[0], right[0]);
    })
    .slice(0, limit)
    .map(([key, count]) => Schema.decodeUnknownSync(BenchmarkReportItemSchema)({ key, count }));
}

function buildSuiteSummary(input: {
  readonly corpus: E9BenchmarkSuiteArtifact["corpus"];
  readonly httpCorpus: Schema.Schema.Type<typeof BenchmarkPhaseArtifactSchema>;
  readonly browserCorpus: Schema.Schema.Type<typeof BenchmarkPhaseArtifactSchema>;
  readonly scraplingParity: E9BenchmarkSuiteArtifact["scraplingParity"];
  readonly highFrictionCanary: E9BenchmarkSuiteArtifact["highFrictionCanary"];
}) {
  const executedScrapling =
    input.scraplingParity.skipped !== true &&
    input.scraplingParity.artifact !== undefined &&
    input.scraplingParity.totalWallMs > 0;
  const executedCanary =
    input.highFrictionCanary.skipped !== true &&
    input.highFrictionCanary.artifact !== undefined &&
    input.highFrictionCanary.totalWallMs > 0;
  const executedPhases = [
    ...(input.httpCorpus.sweeps.length > 0 ? (["http"] as const) : []),
    ...(input.browserCorpus.sweeps.length > 0 ? (["browser"] as const) : []),
    ...(executedScrapling ? (["scrapling"] as const) : []),
    ...(executedCanary ? (["canary"] as const) : []),
  ];
  const skippedPhases = [
    ...(input.httpCorpus.sweeps.length > 0 ? [] : (["http"] as const)),
    ...(input.browserCorpus.sweeps.length > 0 ? [] : (["browser"] as const)),
    ...(executedScrapling ? [] : (["scrapling"] as const)),
    ...(executedCanary ? [] : (["canary"] as const)),
  ];
  const httpFailures = input.httpCorpus.attempts.filter(
    (attempt) => !attempt.success || attempt.blocked || attempt.challengeDetected,
  );
  const browserFailures = input.browserCorpus.attempts.filter(
    (attempt) => !attempt.success || attempt.blocked || attempt.challengeDetected,
  );
  const httpLocalFailures = httpFailures.filter((attempt) =>
    isLocalFailureCategory(attempt.failureCategory),
  );
  const browserLocalFailures = browserFailures.filter((attempt) =>
    isLocalFailureCategory(attempt.failureCategory),
  );
  const remoteFailures = [...httpFailures, ...browserFailures].filter(
    (attempt) => !isLocalFailureCategory(attempt.failureCategory),
  );
  const browserRecoveredBrowserAllocationCount = input.browserCorpus.attempts.filter((attempt) =>
    hasRecoveredBrowserAllocationWarning(attempt.warnings),
  ).length;

  return Schema.decodeUnknownSync(E9BenchmarkSuiteSummarySchema)({
    executedPhases,
    skippedPhases,
    sampled:
      input.corpus.sourcePageCount !== undefined &&
      input.corpus.selectedPageCount < input.corpus.sourcePageCount,
    totalAttemptCount: input.httpCorpus.attempts.length + input.browserCorpus.attempts.length,
    totalSweepCount: input.httpCorpus.sweeps.length + input.browserCorpus.sweeps.length,
    httpAttemptCount: input.httpCorpus.attempts.length,
    browserAttemptCount: input.browserCorpus.attempts.length,
    httpLocalFailureCount: httpLocalFailures.length,
    browserLocalFailureCount: browserLocalFailures.length,
    browserRecoveredBrowserAllocationCount,
    httpSuccessRate: roundToThree(
      safeRate(
        input.httpCorpus.attempts.filter((attempt) => attempt.success).length,
        Math.max(1, input.httpCorpus.attempts.length),
      ),
    ),
    browserSuccessRate: roundToThree(
      safeRate(
        input.browserCorpus.attempts.filter((attempt) => attempt.success).length,
        Math.max(1, input.browserCorpus.attempts.length),
      ),
    ),
    httpEffectiveSuccessRate: roundToThree(
      safeRate(
        input.httpCorpus.attempts.filter((attempt) => attempt.success).length,
        Math.max(1, input.httpCorpus.attempts.length - httpLocalFailures.length),
      ),
    ),
    browserEffectiveSuccessRate: roundToThree(
      safeRate(
        input.browserCorpus.attempts.filter((attempt) => attempt.success).length,
        Math.max(1, input.browserCorpus.attempts.length - browserLocalFailures.length),
      ),
    ),
    httpBestThroughputPagesPerMinute: roundToThree(
      Math.max(0, ...input.httpCorpus.sweeps.map((sweep) => sweep.throughputPagesPerMinute)),
    ),
    browserBestThroughputPagesPerMinute: roundToThree(
      Math.max(0, ...input.browserCorpus.sweeps.map((sweep) => sweep.throughputPagesPerMinute)),
    ),
    httpBestEffectiveThroughputPagesPerMinute: roundToThree(
      Math.max(
        0,
        ...input.httpCorpus.sweeps.map((sweep) => sweep.effectiveThroughputPagesPerMinute),
      ),
    ),
    browserBestEffectiveThroughputPagesPerMinute: roundToThree(
      Math.max(
        0,
        ...input.browserCorpus.sweeps.map((sweep) => sweep.effectiveThroughputPagesPerMinute),
      ),
    ),
    topHttpFailureDomains: buildCountBreakdown(
      httpFailures.map((attempt) => attempt.domain),
      5,
    ),
    topBrowserFailureDomains: buildCountBreakdown(
      browserFailures.map((attempt) => attempt.domain),
      5,
    ),
    topRemoteFailureDomains: buildCountBreakdown(
      remoteFailures.map((attempt) => attempt.domain),
      5,
    ),
    topRemoteFailureCategories: buildCountBreakdown(
      remoteFailures.map((attempt) => attempt.failureCategory ?? "unknown-error"),
      5,
    ),
    topBrowserFailureCategories: buildCountBreakdown(
      browserFailures.map((attempt) => attempt.failureCategory ?? "unknown-error"),
      5,
    ),
    topLocalFailureCategories: buildCountBreakdown(
      [...httpLocalFailures, ...browserLocalFailures].map(
        (attempt) => attempt.failureCategory ?? "unknown-error",
      ),
      5,
    ),
  });
}

function buildSuiteWarnings(input: {
  readonly summary: Schema.Schema.Type<typeof E9BenchmarkSuiteSummarySchema>;
}) {
  const warnings = new Array<string>();
  const topRemoteFailureCategories = input.summary.topRemoteFailureCategories ?? [];

  if (input.summary.skippedPhases.length > 0) {
    warnings.push(`Skipped phases: ${input.summary.skippedPhases.join(", ")}.`);
  }

  if (input.summary.sampled) {
    warnings.push(
      `Sampled run: executed ${input.summary.httpAttemptCount + input.summary.browserAttemptCount} attempts over ${input.summary.totalSweepCount} sweeps on a subset of the corpus.`,
    );
  }

  const totalLocalFailureCount =
    input.summary.httpLocalFailureCount + input.summary.browserLocalFailureCount;
  if (totalLocalFailureCount > 0) {
    warnings.push(
      `Local configuration or planning failures affected ${totalLocalFailureCount} attempts; raw throughput and success metrics are partially invalidated.`,
    );
  }

  if (input.summary.browserAttemptCount > 0 && input.summary.browserSuccessRate < 0.5) {
    warnings.push(
      `Browser lane is degraded: success rate ${Math.round(input.summary.browserSuccessRate * 1000) / 10}% across ${input.summary.browserAttemptCount} attempts.`,
    );
  }

  if (
    input.summary.browserAttemptCount > 0 &&
    input.summary.browserLocalFailureCount > 0 &&
    input.summary.browserEffectiveSuccessRate > input.summary.browserSuccessRate
  ) {
    warnings.push(
      `Browser effective success rate rises to ${Math.round(input.summary.browserEffectiveSuccessRate * 1000) / 10}% when local config failures are excluded.`,
    );
  }

  if (input.summary.browserRecoveredBrowserAllocationCount > 0) {
    warnings.push(
      `Recovered browser allocation protocol faults occurred ${input.summary.browserRecoveredBrowserAllocationCount} times; browser runtime retried successfully but engine stability noise is present.`,
    );
  }

  const topBrowserFailureDomain = input.summary.topBrowserFailureDomains[0];
  if (topBrowserFailureDomain !== undefined && topBrowserFailureDomain.count > 0) {
    warnings.push(
      `Browser failures cluster on ${topBrowserFailureDomain.key} (${topBrowserFailureDomain.count} attempts).`,
    );
  }

  const topBrowserFailureCategory = input.summary.topBrowserFailureCategories[0];
  if (topBrowserFailureCategory !== undefined && topBrowserFailureCategory.count > 0) {
    warnings.push(
      `Top browser failure category: ${topBrowserFailureCategory.key} (${topBrowserFailureCategory.count} attempts).`,
    );
  }

  const topRemoteFailureCategory = topRemoteFailureCategories[0];
  if (topRemoteFailureCategory !== undefined && topRemoteFailureCategory.count > 0) {
    warnings.push(
      `Top remote failure category: ${topRemoteFailureCategory.key} (${topRemoteFailureCategory.count} attempts).`,
    );
  }

  const topLocalFailureCategory = input.summary.topLocalFailureCategories[0];
  if (topLocalFailureCategory !== undefined && topLocalFailureCategory.count > 0) {
    warnings.push(
      `Top local failure category: ${topLocalFailureCategory.key} (${topLocalFailureCategory.count} attempts).`,
    );
  }

  return warnings;
}

function buildSuiteRecommendations(input: {
  readonly summary: Schema.Schema.Type<typeof E9BenchmarkSuiteSummarySchema>;
}) {
  const recommendations = new Array<string>();
  const topRemoteFailureDomains =
    input.summary.topRemoteFailureDomains ??
    mergeCountBreakdowns(
      [input.summary.topHttpFailureDomains, input.summary.topBrowserFailureDomains],
      5,
    );
  const topRemoteFailureCategories = input.summary.topRemoteFailureCategories ?? [];

  if (input.summary.sampled) {
    recommendations.push("Use the full-corpus preset when you need definitive release evidence.");
  }

  if (input.summary.browserAttemptCount > 0) {
    recommendations.push(
      "Review browser failure categories and top failing domains before treating browser fallback as production-ready.",
    );
  }

  if (input.summary.browserLocalFailureCount > 0 || input.summary.httpLocalFailureCount > 0) {
    recommendations.push(
      "Fix local selection/plugin configuration failures before comparing remote-site success or throughput across browser sweeps.",
    );
  }

  if (input.summary.browserRecoveredBrowserAllocationCount > 0) {
    recommendations.push(
      "Inspect Patchright/Chromium page-allocation stability and recovered protocol faults before trusting browser-lane reliability trends.",
    );
  }

  if (topRemoteFailureDomains.length > 0) {
    recommendations.push(
      `Prioritize diagnostics for ${topRemoteFailureDomains
        .slice(0, 3)
        .map((entry) => entry.key)
        .join(", ")}.`,
    );
  }

  const topRemoteFailureCategory =
    topRemoteFailureCategories[0]?.key ?? input.summary.topBrowserFailureCategories[0]?.key;
  switch (topRemoteFailureCategory) {
    case "access-wall-challenge":
      recommendations.push(
        "Top remote failures are challenge walls; prioritize identity or egress tuning and challenge-redirect diagnostics on the worst domains.",
      );
      break;
    case "access-wall-consent":
      recommendations.push(
        "Top remote failures are consent walls; prioritize consent-screen detection and domain-aware handling before judging fallback quality.",
      );
      break;
    case "access-wall-rate-limit":
      recommendations.push(
        "Top remote failures are rate limits; review pacing, concurrency and egress rotation before comparing site success rates.",
      );
      break;
    case "access-wall-trap":
      recommendations.push(
        "Top remote failures are trap or interstitial endpoints; recognize and bail out on known trap URLs before treating them as generic content failures.",
      );
      break;
  }

  if (
    input.summary.skippedPhases.includes("scrapling") ||
    input.summary.skippedPhases.includes("canary")
  ) {
    recommendations.push(
      "Run parity and canary phases separately or use the full-corpus suite when you need competitor and high-friction evidence.",
    );
  }

  if (input.summary.topLocalFailureCategories.length > 0) {
    recommendations.push(
      `Top local failure categories to close first: ${input.summary.topLocalFailureCategories
        .slice(0, 3)
        .map((entry) => entry.key)
        .join(", ")}.`,
    );
  }

  return recommendations;
}

function mergeAvailability(
  artifacts: ReadonlyArray<E9BenchmarkSuiteArtifact>,
  key: "available" | "unavailable",
) {
  const merged = new Map<string, Schema.Schema.Type<typeof CompetitorAvailabilitySchema>>();
  for (const artifact of artifacts) {
    for (const entry of artifact.profiles[key]) {
      merged.set(entry.profile, entry);
    }
  }

  return [...merged.values()].sort((left, right) => compareStrings(left.profile, right.profile));
}

function mergeAttempts(attempts: ReadonlyArray<BenchmarkAttempt>) {
  const merged = new Map<string, BenchmarkAttempt>();
  for (const attempt of attempts) {
    merged.set(
      [attempt.phase, attempt.profile, String(attempt.concurrency), attempt.url].join("|"),
      attempt,
    );
  }

  return [...merged.values()].sort((left, right) => {
    const profileOrder = compareStrings(left.profile, right.profile);
    if (profileOrder !== 0) {
      return profileOrder;
    }

    if (left.concurrency !== right.concurrency) {
      return left.concurrency - right.concurrency;
    }

    return compareStrings(left.url, right.url);
  });
}

function mergeSweepSummaries(sweeps: ReadonlyArray<SweepSummary>) {
  const latestBySweep = new Map<string, SweepSummary>();
  for (const sweep of sweeps) {
    latestBySweep.set(`${sweep.profile}|${String(sweep.concurrency)}`, sweep);
  }

  const byProfile = new Map<BenchmarkProfile, SweepSummary[]>();
  for (const sweep of latestBySweep.values()) {
    const current = byProfile.get(sweep.profile);
    if (current === undefined) {
      byProfile.set(sweep.profile, [sweep]);
      continue;
    }

    current.push(sweep);
  }

  const merged = new Array<SweepSummary>();
  for (const [, profileSweeps] of [...byProfile.entries()].sort(([left], [right]) =>
    compareStrings(left, right),
  )) {
    const sortedSweeps = [...profileSweeps].sort(
      (left, right) => left.concurrency - right.concurrency,
    );
    const baselineThroughput =
      sortedSweeps.find(({ concurrency }) => concurrency === 1)?.throughputPagesPerMinute ?? 0;

    for (const sweep of sortedSweeps) {
      merged.push(
        Schema.decodeUnknownSync(SweepSummarySchema)({
          ...sweep,
          parallelEfficiency:
            sweep.concurrency === 1 || baselineThroughput <= 0
              ? 1
              : roundToThree(
                  Math.min(
                    1,
                    sweep.throughputPagesPerMinute / (baselineThroughput * sweep.concurrency),
                  ),
                ),
        }),
      );
    }
  }

  return merged;
}

function mergePhaseArtifacts(
  artifacts: ReadonlyArray<E9BenchmarkSuiteArtifact>,
  key: "httpCorpus" | "browserCorpus",
) {
  const latest = artifacts.at(-1);
  if (latest === undefined) {
    throw new Error("At least one benchmark artifact is required.");
  }

  const mergedAttempts = mergeAttempts(artifacts.flatMap((artifact) => artifact[key].attempts));
  const pageCount =
    new Set(mergedAttempts.map(({ url }) => url)).size ||
    ([...artifacts].reverse().find((artifact) => artifact[key].pageCount > 0)?.[key].pageCount ??
      latest[key].pageCount);

  return Schema.decodeUnknownSync(BenchmarkPhaseArtifactSchema)({
    phase: latest[key].phase,
    pageCount,
    attempts: mergedAttempts,
    sweeps: mergeSweepSummaries(artifacts.flatMap((artifact) => artifact[key].sweeps)),
  });
}

function mergeCorpusMetadata(
  artifacts: ReadonlyArray<E9BenchmarkSuiteArtifact>,
  httpCorpus: Schema.Schema.Type<typeof BenchmarkPhaseArtifactSchema>,
  browserCorpus: Schema.Schema.Type<typeof BenchmarkPhaseArtifactSchema>,
) {
  const latest = artifacts.at(-1);
  if (latest === undefined) {
    throw new Error("At least one benchmark artifact is required.");
  }

  const mergedPageRecords = [
    ...new Map(
      [...httpCorpus.attempts, ...browserCorpus.attempts].map((attempt) => [attempt.url, attempt]),
    ).values(),
  ];
  const selectedPageCount = mergedPageRecords.length || latest.corpus.selectedPageCount;
  const selectedSiteCount =
    new Set(mergedPageRecords.map(({ siteId }) => siteId)).size || latest.corpus.selectedSiteCount;
  const highFrictionPageCount =
    mergedPageRecords.filter(({ frictionClass }) => frictionClass === "high").length ||
    latest.corpus.highFrictionPageCount;
  const pageTypeCounts =
    mergedPageRecords.length === 0
      ? latest.corpus.pageTypeCounts
      : Schema.decodeUnknownSync(PageTypeCountsSchema)({
          product: mergedPageRecords.filter(({ pageType }) => pageType === "product").length,
          listing: mergedPageRecords.filter(({ pageType }) => pageType === "listing").length,
          search: mergedPageRecords.filter(({ pageType }) => pageType === "search").length,
          offer: mergedPageRecords.filter(({ pageType }) => pageType === "offer").length,
          unknown: mergedPageRecords.filter(({ pageType }) => pageType === "unknown").length,
        });
  const mergedFromShards = artifacts.some((artifact) => (artifact.corpus.shardCount ?? 1) > 1);

  return {
    sourceArtifactPath: latest.corpus.sourceArtifactPath,
    ...(latest.corpus.sourcePageCount === undefined
      ? {}
      : { sourcePageCount: latest.corpus.sourcePageCount }),
    ...(latest.corpus.sourceSiteCount === undefined
      ? {}
      : { sourceSiteCount: latest.corpus.sourceSiteCount }),
    selectedPageCount,
    selectedSiteCount,
    highFrictionPageCount,
    pageTypeCounts,
    ...(latest.corpus.preset === undefined ? {} : { preset: latest.corpus.preset }),
    ...(latest.corpus.samplingStrategy === undefined
      ? {}
      : { samplingStrategy: latest.corpus.samplingStrategy }),
    ...(latest.corpus.samplePageCount === undefined
      ? {}
      : { samplePageCount: latest.corpus.samplePageCount }),
    ...(latest.corpus.sampleSeed === undefined ? {} : { sampleSeed: latest.corpus.sampleSeed }),
    ...(mergedFromShards
      ? {}
      : latest.corpus.shardCount === undefined
        ? {}
        : { shardCount: latest.corpus.shardCount }),
    ...(mergedFromShards
      ? {}
      : latest.corpus.shardIndex === undefined
        ? {}
        : { shardIndex: latest.corpus.shardIndex }),
    ...(mergedFromShards
      ? {}
      : latest.corpus.shardPageCount === undefined
        ? {}
        : { shardPageCount: latest.corpus.shardPageCount }),
  };
}

export function mergeE9BenchmarkArtifacts(
  artifacts: ReadonlyArray<E9BenchmarkSuiteArtifact>,
): E9BenchmarkSuiteArtifact {
  const [first] = artifacts;
  if (first === undefined) {
    throw new Error("At least one E9 benchmark artifact is required for merge.");
  }

  const latest = artifacts.at(-1) ?? first;
  const reversedArtifacts = [...artifacts].reverse();
  const httpCorpus = mergePhaseArtifacts(artifacts, "httpCorpus");
  const browserCorpus = mergePhaseArtifacts(artifacts, "browserCorpus");
  const scraplingParity =
    reversedArtifacts.find(
      (artifact) =>
        artifact.scraplingParity.skipped !== true &&
        artifact.scraplingParity.totalWallMs > 0 &&
        artifact.scraplingParity.artifact !== undefined,
    )?.scraplingParity ?? latest.scraplingParity;
  const highFrictionCanary =
    reversedArtifacts.find(
      (artifact) =>
        artifact.highFrictionCanary.skipped !== true &&
        artifact.highFrictionCanary.totalWallMs > 0 &&
        artifact.highFrictionCanary.artifact !== undefined,
    )?.highFrictionCanary ?? latest.highFrictionCanary;
  const corpus = mergeCorpusMetadata(artifacts, httpCorpus, browserCorpus);
  const summary = buildSuiteSummary({
    corpus,
    httpCorpus,
    browserCorpus,
    scraplingParity,
    highFrictionCanary,
  });
  const warnings = buildSuiteWarnings({ summary });
  const recommendations = buildSuiteRecommendations({ summary });

  return Schema.decodeUnknownSync(E9BenchmarkSuiteArtifactSchema)({
    benchmark: "e9-benchmark-suite",
    benchmarkId: latest.benchmarkId,
    generatedAt: latest.generatedAt,
    corpus,
    profiles: {
      available: mergeAvailability(artifacts, "available"),
      unavailable: mergeAvailability(artifacts, "unavailable"),
    },
    httpCorpus,
    browserCorpus,
    scraplingParity,
    highFrictionCanary,
    summary,
    warnings,
    recommendations,
    status: computeSuiteStatus({
      httpCorpus,
      browserCorpus,
      scraplingParity,
      highFrictionCanary,
    }),
  });
}

export async function runE9BenchmarkSuite(
  input: {
    readonly corpusArtifactPath?: string;
    readonly generatedAt?: string;
    readonly benchmarkId?: string;
    readonly preset?: BenchmarkPreset;
    readonly phases?: ReadonlyArray<BenchmarkCliPhase>;
    readonly httpProfiles?: ReadonlyArray<HttpBenchmarkProfile>;
    readonly browserProfiles?: ReadonlyArray<BrowserBenchmarkProfile>;
    readonly httpConcurrency?: ReadonlyArray<number>;
    readonly browserConcurrency?: ReadonlyArray<number>;
    readonly httpTimeoutMs?: number;
    readonly browserTimeoutMs?: number;
    readonly samplePageCount?: number;
    readonly sampleSeed?: string;
    readonly shardCount?: number;
    readonly shardIndex?: number;
    readonly adaptiveStop?: boolean;
  } = {},
  overrides: SuiteOverrides = {},
) {
  const suiteStartedAt = performance.now();
  const onProgress = overrides.onProgress;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const benchmarkId = input.benchmarkId ?? DEFAULT_BENCHMARK_ID;
  const corpusArtifactPath = input.corpusArtifactPath ?? DEFAULT_CORPUS_PATH;
  const preset = input.preset === undefined ? undefined : resolveBenchmarkPreset(input.preset);
  if (input.shardIndex !== undefined && input.shardCount === undefined) {
    throw new Error("Benchmark shard index requires shard count to also be set.");
  }
  if (
    input.shardCount !== undefined &&
    input.shardIndex !== undefined &&
    input.shardIndex > input.shardCount
  ) {
    throw new Error("Benchmark shard index must be less than or equal to shard count.");
  }
  const loadedCorpus =
    overrides.pages === undefined
      ? await loadFrozenPages(corpusArtifactPath)
      : {
          path: corpusArtifactPath,
          pages: overrides.pages,
          selectedSiteCount: new Set(overrides.pages.map(({ siteId }) => siteId)).size,
          selectedPageCount: overrides.pages.length,
        };
  const corpus = selectBenchmarkPages({
    path: loadedCorpus.path,
    pages: loadedCorpus.pages,
    selectedPageCount: loadedCorpus.selectedPageCount,
    selectedSiteCount: loadedCorpus.selectedSiteCount,
    ...(input.preset === undefined ? {} : { preset: input.preset }),
    ...(input.samplePageCount === undefined && preset?.samplePageCount === undefined
      ? {}
      : { samplePageCount: input.samplePageCount ?? preset?.samplePageCount }),
    ...(input.sampleSeed === undefined ? {} : { sampleSeed: input.sampleSeed }),
    ...(input.shardCount === undefined ? {} : { shardCount: input.shardCount }),
    ...(input.shardIndex === undefined ? {} : { shardIndex: input.shardIndex }),
  });

  const httpPages = corpus.pages;
  const browserPages = corpus.pages;
  const httpConcurrency = [
    ...(overrides.httpLevels ??
      input.httpConcurrency ??
      preset?.httpConcurrency ??
      DEFAULT_HTTP_CONCURRENCY),
  ];
  const browserConcurrency = [
    ...(overrides.browserLevels ??
      input.browserConcurrency ??
      preset?.browserConcurrency ??
      DEFAULT_BROWSER_CONCURRENCY),
  ];
  const selectedPhases = new Set<BenchmarkCliPhase>(
    input.phases ?? preset?.phases ?? ["http", "browser", "scrapling", "canary"],
  );
  const selectedHttpProfiles = input.httpProfiles ?? preset?.httpProfiles;
  const selectedBrowserProfiles = input.browserProfiles ?? preset?.browserProfiles;
  const httpProfileFactories = (
    overrides.httpProfileFactories ?? defaultHttpProfileFactories()
  ).filter(({ profile }) => isSelectedHttpProfile(profile, selectedHttpProfiles));
  const browserProfileFactories = (
    overrides.browserProfileFactories ?? defaultBrowserProfileFactories()
  ).filter(({ profile }) => isSelectedBrowserProfile(profile, selectedBrowserProfiles));
  const selectedPhaseList = [...selectedPhases.values()];
  const httpSelectedProfiles = httpProfileFactories.map(
    ({ profile }) => profile,
  ) as ReadonlyArray<HttpBenchmarkProfile>;
  const browserSelectedProfiles = browserProfileFactories.map(
    ({ profile }) => profile,
  ) as ReadonlyArray<BrowserBenchmarkProfile>;
  const expectedSweepCount =
    (selectedPhases.has("http") ? httpProfileFactories.length * httpConcurrency.length : 0) +
    (selectedPhases.has("browser")
      ? browserProfileFactories.length * browserConcurrency.length
      : 0);
  emitProgress(onProgress, {
    kind: "suite-start",
    benchmarkId,
    generatedAt,
    selectedPhases: selectedPhaseList,
    corpusPath: corpus.path,
    pageCount: corpus.pages.length,
    siteCount: new Set(corpus.pages.map(({ siteId }) => siteId)).size,
    httpProfiles: httpSelectedProfiles,
    browserProfiles: browserSelectedProfiles,
    httpConcurrency,
    browserConcurrency,
    expectedSweepCount,
  });

  const httpCorpus = selectedPhases.has("http")
    ? await runPhase({
        benchmarkId,
        generatedAt,
        phase: "live-http-corpus",
        pages: httpPages,
        concurrencyLevels: httpConcurrency,
        timeoutMs: input.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
        profileFactories: httpProfileFactories,
        adaptiveStop: input.adaptiveStop ?? preset?.adaptiveStop ?? false,
        ...(onProgress === undefined ? {} : { onProgress }),
      })
    : emptyPhaseArtifact("live-http-corpus", httpPages.length);

  const browserCorpus = selectedPhases.has("browser")
    ? await runPhase({
        benchmarkId,
        generatedAt,
        phase: "live-browser-corpus",
        pages: browserPages,
        concurrencyLevels: browserConcurrency,
        timeoutMs: input.browserTimeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS,
        profileFactories: browserProfileFactories,
        adaptiveStop: input.adaptiveStop ?? preset?.adaptiveStop ?? false,
        ...(onProgress === undefined ? {} : { onProgress }),
      })
    : emptyPhaseArtifact("live-browser-corpus", browserPages.length);

  const scraplingParity = selectedPhases.has("scrapling")
    ? await (async () => {
        emitProgress(onProgress, {
          kind: "subbenchmark-start",
          benchmarkId,
          generatedAt,
          task: "scrapling-parity",
        });
        const parityStartedAt = performance.now();
        const scraplingParityArtifact = await (
          overrides.scraplingParityRunner ?? (() => runE9ScraplingParity())
        )();
        const result = {
          totalWallMs: roundToThree(performance.now() - parityStartedAt),
          skipped: false,
          artifact: Schema.decodeUnknownSync(E9ScraplingParityArtifactSchema)(
            scraplingParityArtifact,
          ),
        };
        emitProgress(onProgress, {
          kind: "subbenchmark-complete",
          benchmarkId,
          generatedAt,
          task: "scrapling-parity",
          totalWallMs: result.totalWallMs,
          status: result.artifact.status,
        });
        return result;
      })()
    : {
        totalWallMs: 0,
        skipped: true,
      };

  const highFrictionCanary = selectedPhases.has("canary")
    ? await (async () => {
        emitProgress(onProgress, {
          kind: "subbenchmark-start",
          benchmarkId,
          generatedAt,
          task: "high-friction-canary",
        });
        const canaryStartedAt = performance.now();
        const highFrictionCanaryArtifact = await (
          overrides.highFrictionCanaryRunner ?? (() => runE9HighFrictionCanary())
        )();
        const result = {
          totalWallMs: roundToThree(performance.now() - canaryStartedAt),
          skipped: false,
          artifact: Schema.decodeUnknownSync(E9HighFrictionCanaryArtifactSchema)(
            highFrictionCanaryArtifact,
          ),
        };
        emitProgress(onProgress, {
          kind: "subbenchmark-complete",
          benchmarkId,
          generatedAt,
          task: "high-friction-canary",
          totalWallMs: result.totalWallMs,
          status: result.artifact.status,
        });
        return result;
      })()
    : {
        totalWallMs: 0,
        skipped: true,
      };

  const availableProfiles = [
    { profile: "effect-http", available: true },
    { profile: "native-fetch", available: true },
    { profile: "effect-browser", available: true },
    { profile: "patchright-browser", available: true },
    { profile: "scrapling-parser", available: true },
  ].map((entry) => Schema.decodeUnknownSync(CompetitorAvailabilitySchema)(entry));
  const unavailableProfiles = [
    {
      profile: "crawlee-http",
      available: false,
      reason: "Crawlee is not installed in this benchmark environment.",
    },
    {
      profile: "crawlee-playwright",
      available: false,
      reason: "Crawlee is not installed in this benchmark environment.",
    },
    {
      profile: "scrapy-http",
      available: false,
      reason: "Scrapy is not installed in this benchmark environment.",
    },
    {
      profile: "selenium-browser",
      available: false,
      reason: "Selenium is not installed in this benchmark environment.",
    },
    {
      profile: "effect-browser-stealth",
      available: false,
      reason:
        "A dedicated stealth-evasion runtime is not implemented yet; current E9 evidence only proves browser escalation and bypass qualification.",
    },
  ].map((entry) => Schema.decodeUnknownSync(CompetitorAvailabilitySchema)(entry));

  const status = computeSuiteStatus({
    httpCorpus,
    browserCorpus,
    scraplingParity,
    highFrictionCanary,
  });
  const artifactCorpus = {
    sourceArtifactPath: corpus.path,
    sourcePageCount: corpus.sourcePageCount,
    sourceSiteCount: corpus.sourceSiteCount,
    selectedPageCount: corpus.selectedPageCount,
    selectedSiteCount: corpus.selectedSiteCount,
    highFrictionPageCount: corpus.selectedHighFrictionPageCount,
    pageTypeCounts: corpus.selectedPageTypeCounts,
    ...(corpus.preset === undefined ? {} : { preset: corpus.preset }),
    ...(corpus.samplingStrategy === undefined ? {} : { samplingStrategy: corpus.samplingStrategy }),
    ...(corpus.samplePageCount === undefined ? {} : { samplePageCount: corpus.samplePageCount }),
    ...(corpus.sampleSeed === undefined ? {} : { sampleSeed: corpus.sampleSeed }),
    ...(corpus.shardCount === undefined ? {} : { shardCount: corpus.shardCount }),
    ...(corpus.shardIndex === undefined ? {} : { shardIndex: corpus.shardIndex }),
    ...(corpus.shardPageCount === undefined ? {} : { shardPageCount: corpus.shardPageCount }),
  };
  const summary = buildSuiteSummary({
    corpus: artifactCorpus,
    httpCorpus,
    browserCorpus,
    scraplingParity,
    highFrictionCanary,
  });
  const warnings = buildSuiteWarnings({ summary });
  const recommendations = buildSuiteRecommendations({ summary });

  const artifact = {
    benchmark: "e9-benchmark-suite",
    benchmarkId,
    generatedAt,
    corpus: artifactCorpus,
    profiles: {
      available: availableProfiles,
      unavailable: unavailableProfiles,
    },
    httpCorpus,
    browserCorpus,
    scraplingParity,
    highFrictionCanary,
    summary,
    warnings,
    recommendations,
    status,
  };

  const decodedArtifact = Schema.decodeUnknownSync(E9BenchmarkSuiteArtifactSchema)(artifact);
  emitProgress(onProgress, {
    kind: "suite-complete",
    benchmarkId,
    generatedAt,
    status: decodedArtifact.status,
    totalWallMs: roundToThree(performance.now() - suiteStartedAt),
    totalAttemptCount:
      decodedArtifact.httpCorpus.attempts.length + decodedArtifact.browserCorpus.attempts.length,
    totalSweepCount:
      decodedArtifact.httpCorpus.sweeps.length + decodedArtifact.browserCorpus.sweeps.length,
  });
  return decodedArtifact;
}
