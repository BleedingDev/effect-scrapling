import { Effect, Schema } from "effect";
import { BaselineCorpusArtifactSchema } from "./baseline-corpus-runtime.ts";
import { IncumbentComparisonArtifactSchema } from "./incumbent-comparison-runtime.ts";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import { ParserFailure } from "./tagged-errors.ts";

const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const BoundedRateSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);

export class QualityMetricSummary extends Schema.Class<QualityMetricSummary>(
  "QualityMetricSummary",
)({
  caseCount: NonNegativeIntSchema,
  baselineFieldCount: NonNegativeIntSchema,
  candidateFieldCount: NonNegativeIntSchema,
  recalledFieldCount: NonNegativeIntSchema,
  missingFieldCount: NonNegativeIntSchema,
  unexpectedFieldCount: NonNegativeIntSchema,
  changedFieldCount: NonNegativeIntSchema,
  fieldRecallRate: BoundedRateSchema,
  falsePositiveRate: BoundedRateSchema,
}) {}

export class PackQualityMetricSummary extends Schema.Class<PackQualityMetricSummary>(
  "PackQualityMetricSummary",
)({
  packId: CanonicalIdentifierSchema,
  caseIds: Schema.Array(CanonicalIdentifierSchema),
  summary: QualityMetricSummary,
}) {}

const PackQualityMetricSummariesSchema = Schema.Array(PackQualityMetricSummary).pipe(
  Schema.refine(
    (summaries): summaries is ReadonlyArray<PackQualityMetricSummary> =>
      new Set(summaries.map(({ packId }) => packId)).size === summaries.length,
    {
      message: "Expected one deterministic E7 quality-metrics summary per pack id.",
    },
  ),
);

export class QualityMetricsArtifact extends Schema.Class<QualityMetricsArtifact>(
  "QualityMetricsArtifact",
)({
  benchmark: Schema.Literal("e7-quality-metrics"),
  metricsId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  corpusId: CanonicalIdentifierSchema,
  comparisonId: CanonicalIdentifierSchema,
  caseCount: NonNegativeIntSchema,
  packCount: NonNegativeIntSchema,
  overall: QualityMetricSummary,
  packSummaries: PackQualityMetricSummariesSchema,
}) {}

const QualityMetricsInputSchema = Schema.Struct({
  metricsId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  baseline: BaselineCorpusArtifactSchema,
  comparison: IncumbentComparisonArtifactSchema,
});

type BaselineCorpusArtifact = Schema.Schema.Type<typeof BaselineCorpusArtifactSchema>;
type IncumbentComparisonArtifact = Schema.Schema.Type<typeof IncumbentComparisonArtifactSchema>;
type IncumbentComparisonResult = IncumbentComparisonArtifact["results"][number];
type SnapshotDiffCanonicalMetrics = NonNullable<
  IncumbentComparisonResult["snapshotDiff"]["canonicalMetrics"]
>;

export const QualityMetricSummarySchema = QualityMetricSummary;
export const PackQualityMetricSummarySchema = PackQualityMetricSummary;
export const QualityMetricsArtifactSchema = QualityMetricsArtifact;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function roundRate(value: number) {
  return Number(value.toFixed(6));
}

function comparePackSummaries(left: PackQualityMetricSummary, right: PackQualityMetricSummary) {
  return left.packId.localeCompare(right.packId);
}

function buildBaselineIndex(baseline: BaselineCorpusArtifact) {
  return new Map(baseline.results.map((result) => [result.caseId, result] as const));
}

function validateAlignment(
  baseline: BaselineCorpusArtifact,
  comparison: IncumbentComparisonArtifact,
) {
  if (
    baseline.corpusId !== comparison.incumbentCorpusId ||
    baseline.corpusId !== comparison.candidateCorpusId
  ) {
    return Effect.fail(
      new ParserFailure({
        message:
          "Expected E7 quality metrics inputs where baseline and comparison reference the same corpus id.",
      }),
    );
  }

  if (baseline.caseCount !== comparison.caseCount || baseline.packCount !== comparison.packCount) {
    return Effect.fail(
      new ParserFailure({
        message:
          "Expected E7 quality metrics inputs where baseline and comparison reference the same caseCount and packCount.",
      }),
    );
  }

  const baselineIndex = buildBaselineIndex(baseline);

  for (const result of comparison.results) {
    const baselineResult = baselineIndex.get(result.caseId);
    if (baselineResult === undefined) {
      return Effect.fail(
        new ParserFailure({
          message: `Expected baseline evidence for comparison case ${result.caseId}.`,
        }),
      );
    }

    if (baselineResult.packId !== result.packId || baselineResult.targetId !== result.targetId) {
      return Effect.fail(
        new ParserFailure({
          message:
            "Expected E7 quality metrics inputs with aligned caseId, packId, and targetId values.",
        }),
      );
    }

    if (result.snapshotDiff.canonicalMetrics === undefined) {
      return Effect.fail(
        new ParserFailure({
          message:
            "Expected E7 quality metrics inputs with canonical snapshot metrics for every comparison result.",
        }),
      );
    }
  }

  return Effect.succeed(baselineIndex);
}

function summaryFromCanonicalMetrics(
  canonicalMetrics: ReadonlyArray<SnapshotDiffCanonicalMetrics>,
  caseCount: number,
) {
  const baselineFieldCount = canonicalMetrics.reduce(
    (total, metrics) => total + metrics.baselineFieldCount,
    0,
  );
  const candidateFieldCount = canonicalMetrics.reduce(
    (total, metrics) => total + metrics.candidateFieldCount,
    0,
  );
  const missingFieldCount = canonicalMetrics.reduce(
    (total, metrics) => total + metrics.removedFieldCount,
    0,
  );
  const unexpectedFieldCount = canonicalMetrics.reduce(
    (total, metrics) => total + metrics.addedFieldCount,
    0,
  );
  const changedFieldCount = canonicalMetrics.reduce(
    (total, metrics) => total + metrics.changedFieldCount,
    0,
  );
  const recalledFieldCount = Math.max(0, baselineFieldCount - missingFieldCount);

  return Schema.decodeUnknownSync(QualityMetricSummarySchema)({
    caseCount,
    baselineFieldCount,
    candidateFieldCount,
    recalledFieldCount,
    missingFieldCount,
    unexpectedFieldCount,
    changedFieldCount,
    fieldRecallRate:
      baselineFieldCount === 0 ? 1 : roundRate(recalledFieldCount / baselineFieldCount),
    falsePositiveRate:
      candidateFieldCount === 0 ? 0 : roundRate(unexpectedFieldCount / candidateFieldCount),
  });
}

export function evaluateQualityMetrics(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(QualityMetricsInputSchema)(input),
      catch: (cause) =>
        new ParserFailure({
          message: readCauseMessage(
            cause,
            "Failed to decode E7 quality metrics input through shared contracts.",
          ),
        }),
    });
    yield* validateAlignment(decoded.baseline, decoded.comparison);

    const grouped = new Map<string, Array<IncumbentComparisonResult>>();
    for (const result of decoded.comparison.results) {
      const packResults = grouped.get(result.packId) ?? [];
      packResults.push(result);
      grouped.set(result.packId, packResults);
    }

    const packSummaries = Array.from(grouped.entries(), ([packId, results]) =>
      Schema.decodeUnknownSync(PackQualityMetricSummarySchema)({
        packId,
        caseIds: results
          .map(({ caseId }) => caseId)
          .sort((left, right) => left.localeCompare(right)),
        summary: summaryFromCanonicalMetrics(
          results
            .map(({ snapshotDiff }) => snapshotDiff.canonicalMetrics!)
            .filter((metrics) => metrics !== undefined),
          results.length,
        ),
      }),
    ).sort(comparePackSummaries);

    return Schema.decodeUnknownSync(QualityMetricsArtifactSchema)({
      benchmark: "e7-quality-metrics",
      metricsId: decoded.metricsId,
      generatedAt: decoded.generatedAt,
      corpusId: decoded.baseline.corpusId,
      comparisonId: decoded.comparison.comparisonId,
      caseCount: decoded.comparison.caseCount,
      packCount: decoded.comparison.packCount,
      overall: summaryFromCanonicalMetrics(
        decoded.comparison.results
          .map(({ snapshotDiff }) => snapshotDiff.canonicalMetrics!)
          .filter((metrics) => metrics !== undefined),
        decoded.comparison.caseCount,
      ),
      packSummaries,
    });
  });
}

export type QualityMetricSummaryEncoded = Schema.Codec.Encoded<typeof QualityMetricSummarySchema>;
export type PackQualityMetricSummaryEncoded = Schema.Codec.Encoded<
  typeof PackQualityMetricSummarySchema
>;
export type QualityMetricsArtifactEncoded = Schema.Codec.Encoded<
  typeof QualityMetricsArtifactSchema
>;
