import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "@effect-scrapling/foundation-core";
import {
  BaselineCorpusArtifactSchema,
  ChaosProviderSuiteArtifactSchema,
  IncumbentComparisonArtifactSchema,
  LiveCanaryArtifactSchema,
  PerformanceBudgetArtifactSchema,
  PromotionGateEvaluationSchema,
  QualityMetricsArtifactSchema,
  QualityReportArtifactSchema,
  QualitySoakArtifactSchema,
} from "./e7.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const BenchmarkArtifactKeySchema = Schema.Literals([
  "baselineCorpus",
  "incumbentComparison",
  "performanceBudget",
  "qualityMetrics",
  "liveCanary",
  "chaosProviderSuite",
  "promotionGate",
  "qualityReport",
  "soakEndurance",
] as const);

const BenchmarkArtifactManifestSchema = Schema.Array(
  Schema.Struct({
    key: BenchmarkArtifactKeySchema,
    artifactId: CanonicalIdentifierSchema,
    artifactPath: NonEmptyStringSchema,
    sourceCommand: NonEmptyStringSchema,
  }),
).pipe(
  Schema.refine(
    (
      entries,
    ): entries is ReadonlyArray<{
      readonly key: Schema.Schema.Type<typeof BenchmarkArtifactKeySchema>;
      readonly artifactId: string;
      readonly artifactPath: string;
      readonly sourceCommand: string;
    }> => entries.length > 0 && new Set(entries.map(({ key }) => key)).size === entries.length,
    {
      message: "Expected deterministic E8 benchmark artifact manifest entries.",
    },
  ),
);

export const E8BenchmarkBundleSchema = Schema.Struct({
  baselineCorpus: BaselineCorpusArtifactSchema,
  incumbentComparison: IncumbentComparisonArtifactSchema,
  performanceBudget: PerformanceBudgetArtifactSchema,
  qualityMetrics: QualityMetricsArtifactSchema,
  liveCanary: LiveCanaryArtifactSchema,
  chaosProviderSuite: ChaosProviderSuiteArtifactSchema,
  promotionGate: PromotionGateEvaluationSchema,
  qualityReport: QualityReportArtifactSchema,
  soakEndurance: QualitySoakArtifactSchema,
});

export const E8BenchmarkRunMetadataSchema = Schema.Struct({
  bundleId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  artifactCount: PositiveIntSchema,
  manifest: BenchmarkArtifactManifestSchema,
});

export const E8BenchmarkRunEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("benchmark run"),
  data: E8BenchmarkRunMetadataSchema,
  warnings: Schema.Array(NonEmptyStringSchema),
});

export const E8ArtifactExportSchema = Schema.Struct({
  benchmark: Schema.Literal("e8-artifact-export"),
  exportId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  metadata: Schema.Struct({
    bundleId: CanonicalIdentifierSchema,
    artifactCount: PositiveIntSchema,
    manifest: BenchmarkArtifactManifestSchema,
    sanitizedPathCount: NonNegativeIntSchema,
    sanitizedPaths: Schema.Array(NonEmptyStringSchema),
  }),
  bundle: E8BenchmarkBundleSchema,
});

export const E8ArtifactExportEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("artifact export"),
  data: Schema.Struct({
    artifact: E8ArtifactExportSchema,
  }),
  warnings: Schema.Array(NonEmptyStringSchema),
});

const ArtifactExportInputSchema = Schema.Struct({
  bundle: Schema.optional(E8BenchmarkBundleSchema),
  exportId: Schema.optional(CanonicalIdentifierSchema),
  generatedAt: Schema.optional(IsoDateTimeSchema),
});

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXED_GENERATED_AT = "2026-03-09T08:30:00.000Z";
const FIXED_BUNDLE_ID = "bundle-e8-benchmark-surface";
const FIXED_EXPORT_ID = "export-e8-benchmark-surface";

const E8_ARTIFACT_PATHS = {
  baselineCorpus: resolve(REPO_ROOT, "docs/artifacts/e7-baseline-corpus-artifact.json"),
  incumbentComparison: resolve(REPO_ROOT, "docs/artifacts/e7-incumbent-comparison-artifact.json"),
  performanceBudget: resolve(REPO_ROOT, "docs/artifacts/e7-performance-budget-scorecard.json"),
  qualityMetrics: resolve(REPO_ROOT, "docs/artifacts/e7-quality-metrics-artifact.json"),
  liveCanary: resolve(REPO_ROOT, "docs/artifacts/e7-live-canary-artifact.json"),
  chaosProviderSuite: resolve(REPO_ROOT, "docs/artifacts/e7-chaos-provider-suite-artifact.json"),
  promotionGate: resolve(REPO_ROOT, "docs/artifacts/e7-promotion-gate-policy-artifact.json"),
  qualityReport: resolve(REPO_ROOT, "docs/artifacts/e7-quality-report-artifact.json"),
  soakEndurance: resolve(REPO_ROOT, "docs/artifacts/e7-soak-endurance-artifact.json"),
} as const;

function toRepoRelativePath(path: string) {
  const normalizedPath = path.replaceAll("\\", "/");
  if (!isAbsolute(normalizedPath)) {
    return normalizedPath;
  }

  const relativePath = relative(REPO_ROOT, normalizedPath).replaceAll("\\", "/");
  return relativePath.startsWith("..") ? basename(normalizedPath) : relativePath;
}

function manifestEntry(
  key: Schema.Schema.Type<typeof BenchmarkArtifactKeySchema>,
  artifactId: string,
  sourceCommand: string,
) {
  return {
    key,
    artifactId,
    artifactPath: toRepoRelativePath(E8_ARTIFACT_PATHS[key]),
    sourceCommand,
  };
}

function buildManifest(bundle: Schema.Schema.Type<typeof E8BenchmarkBundleSchema>) {
  return Schema.decodeUnknownSync(BenchmarkArtifactManifestSchema)([
    manifestEntry("baselineCorpus", bundle.baselineCorpus.corpusId, "benchmark:e7-baseline-corpus"),
    manifestEntry(
      "incumbentComparison",
      bundle.incumbentComparison.comparisonId,
      "benchmark:e7-incumbent-comparison",
    ),
    manifestEntry(
      "performanceBudget",
      bundle.performanceBudget.benchmarkId,
      "benchmark:e7-performance-budget",
    ),
    manifestEntry(
      "qualityMetrics",
      bundle.qualityMetrics.metricsId,
      "benchmark:e7-quality-metrics",
    ),
    manifestEntry("liveCanary", bundle.liveCanary.suiteId, "benchmark:e7-live-canary"),
    manifestEntry(
      "chaosProviderSuite",
      bundle.chaosProviderSuite.suiteId,
      "benchmark:e7-chaos-provider-suite",
    ),
    manifestEntry(
      "promotionGate",
      bundle.promotionGate.evaluationId,
      "benchmark:e7-promotion-gate-policy",
    ),
    manifestEntry("qualityReport", bundle.qualityReport.reportId, "benchmark:e7-quality-report"),
    manifestEntry(
      "soakEndurance",
      bundle.soakEndurance.suiteId,
      "benchmark:e7-soak-endurance-suite",
    ),
  ]);
}

async function loadBundleFromDisk() {
  return Schema.decodeUnknownSync(E8BenchmarkBundleSchema)({
    baselineCorpus: JSON.parse(await readFile(E8_ARTIFACT_PATHS.baselineCorpus, "utf8")),
    incumbentComparison: JSON.parse(await readFile(E8_ARTIFACT_PATHS.incumbentComparison, "utf8")),
    performanceBudget: JSON.parse(await readFile(E8_ARTIFACT_PATHS.performanceBudget, "utf8")),
    qualityMetrics: JSON.parse(await readFile(E8_ARTIFACT_PATHS.qualityMetrics, "utf8")),
    liveCanary: JSON.parse(await readFile(E8_ARTIFACT_PATHS.liveCanary, "utf8")),
    chaosProviderSuite: JSON.parse(await readFile(E8_ARTIFACT_PATHS.chaosProviderSuite, "utf8")),
    promotionGate: JSON.parse(await readFile(E8_ARTIFACT_PATHS.promotionGate, "utf8")),
    qualityReport: JSON.parse(await readFile(E8_ARTIFACT_PATHS.qualityReport, "utf8")),
    soakEndurance: JSON.parse(await readFile(E8_ARTIFACT_PATHS.soakEndurance, "utf8")),
  });
}

function sanitizeBundle(
  bundle: Schema.Schema.Type<typeof E8BenchmarkBundleSchema>,
): readonly [Schema.Schema.Type<typeof E8BenchmarkBundleSchema>, ReadonlyArray<string>] {
  const baselinePath = bundle.performanceBudget.comparison.baselinePath;
  if (baselinePath === undefined || baselinePath === null) {
    return [bundle, []];
  }

  const sanitizedBaselinePath = toRepoRelativePath(baselinePath);
  if (sanitizedBaselinePath === baselinePath) {
    return [bundle, []];
  }

  return [
    Schema.decodeUnknownSync(E8BenchmarkBundleSchema)({
      ...bundle,
      performanceBudget: {
        ...bundle.performanceBudget,
        comparison: {
          ...bundle.performanceBudget.comparison,
          baselinePath: sanitizedBaselinePath,
        },
      },
    }),
    [sanitizedBaselinePath],
  ];
}

function readCauseMessage(cause: unknown) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return "unknown cause";
}

const loadCommittedBundleEffect = Effect.tryPromise({
  try: () => loadBundleFromDisk(),
  catch: (cause) =>
    new Error(
      `Failed to load committed E7 benchmark artifacts for E8 export: ${readCauseMessage(cause)}`,
    ),
});

export const runBenchmarkOperation = Effect.fn("E8.runBenchmarkOperation")(function* () {
  const bundle = yield* loadCommittedBundleEffect;

  return Schema.decodeUnknownSync(E8BenchmarkRunEnvelopeSchema)({
    ok: true,
    command: "benchmark run",
    data: {
      bundleId: FIXED_BUNDLE_ID,
      generatedAt: FIXED_GENERATED_AT,
      artifactCount: 9,
      manifest: buildManifest(bundle),
    },
    warnings: [],
  });
});

export const runArtifactExportOperation = Effect.fn("E8.runArtifactExportOperation")(function* (
  input?: unknown,
) {
  const decoded =
    input === undefined
      ? undefined
      : yield* Effect.try({
          try: () => Schema.decodeUnknownSync(ArtifactExportInputSchema)(input),
          catch: () => new Error("Invalid E8 artifact export payload."),
        });
  const bundle = decoded?.bundle ?? (yield* loadCommittedBundleEffect);
  const [sanitizedBundle, sanitizedPaths] = sanitizeBundle(bundle);
  const artifact = Schema.decodeUnknownSync(E8ArtifactExportSchema)({
    benchmark: "e8-artifact-export",
    exportId: decoded?.exportId ?? FIXED_EXPORT_ID,
    generatedAt: decoded?.generatedAt ?? FIXED_GENERATED_AT,
    metadata: {
      bundleId: FIXED_BUNDLE_ID,
      artifactCount: 9,
      manifest: buildManifest(sanitizedBundle),
      sanitizedPathCount: sanitizedPaths.length,
      sanitizedPaths,
    },
    bundle: sanitizedBundle,
  });

  return Schema.decodeUnknownSync(E8ArtifactExportEnvelopeSchema)({
    ok: true,
    command: "artifact export",
    data: {
      artifact,
    },
    warnings: [],
  });
});
