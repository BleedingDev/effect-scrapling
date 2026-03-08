import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  QualityMetricsArtifactSchema,
  evaluateQualityMetrics,
} from "../../libs/foundation/core/src/quality-metrics-runtime.ts";
import { IncumbentComparisonArtifactSchema } from "../../libs/foundation/core/src/incumbent-comparison-runtime.ts";
import { runDefaultBaselineCorpus } from "../../scripts/benchmarks/e7-baseline-corpus.ts";
import { runIncumbentComparison } from "../../libs/foundation/core/src/incumbent-comparison-runtime.ts";

const CATALOG_CASE_ID = "case-catalog-example-com";
const CATALOG_PACK_ID = "pack-catalog-example-com";
const OFFERS_CASE_ID = "case-offers-example-com";
const OFFERS_PACK_ID = "pack-offers-example-com";

type ComparisonArtifact = Schema.Schema.Type<typeof IncumbentComparisonArtifactSchema>;
type CanonicalMetrics = NonNullable<
  ComparisonArtifact["results"][number]["snapshotDiff"]["canonicalMetrics"]
>;

async function makeFixtureEvidence() {
  const baseline = await runDefaultBaselineCorpus();
  const comparison = await Effect.runPromise(
    runIncumbentComparison({
      id: "comparison-retail-smoke",
      createdAt: "2026-03-08T21:00:00.000Z",
      incumbent: baseline,
      candidate: baseline,
    }),
  );

  return { baseline, comparison };
}

function replaceCanonicalMetrics(
  comparison: ComparisonArtifact,
  metricsByCaseId: Readonly<Record<string, CanonicalMetrics>>,
) {
  return Schema.decodeUnknownSync(IncumbentComparisonArtifactSchema)({
    ...comparison,
    results: comparison.results.map((result) => ({
      ...result,
      snapshotDiff: {
        ...result.snapshotDiff,
        canonicalMetrics: metricsByCaseId[result.caseId] ?? result.snapshotDiff.canonicalMetrics,
      },
    })),
  });
}

function findPackSummary(
  artifact: Schema.Schema.Type<typeof QualityMetricsArtifactSchema>,
  packId: string,
) {
  const summary = artifact.packSummaries.find((entry) => entry.packId === packId);
  if (summary === undefined) {
    throw new Error(`Expected quality metrics artifact to include pack summary ${packId}.`);
  }

  return summary;
}

describe("foundation-core quality metrics runtime", () => {
  it.effect(
    "computes deterministic recall and false-positive metrics from explicit canonical metric fixtures",
    () =>
      Effect.gen(function* () {
        const { baseline, comparison } = yield* Effect.promise(() => makeFixtureEvidence());
        const mutated = replaceCanonicalMetrics(comparison, {
          [CATALOG_CASE_ID]: {
            baselineFieldCount: 3,
            candidateFieldCount: 2,
            unchangedFieldCount: 1,
            addedFieldCount: 0,
            removedFieldCount: 1,
            changedFieldCount: 1,
            baselineConfidenceScore: 0.94,
            candidateConfidenceScore: 0.91,
            confidenceDelta: -0.03,
          },
          [OFFERS_CASE_ID]: {
            baselineFieldCount: 1,
            candidateFieldCount: 3,
            unchangedFieldCount: 0,
            addedFieldCount: 2,
            removedFieldCount: 0,
            changedFieldCount: 1,
            baselineConfidenceScore: 0.88,
            candidateConfidenceScore: 0.9,
            confidenceDelta: 0.02,
          },
        });

        const artifact = yield* evaluateQualityMetrics({
          metricsId: "metrics-e7-quality",
          generatedAt: "2026-03-08T21:00:00.000Z",
          baseline,
          comparison: mutated,
        });

        expect(Schema.is(QualityMetricsArtifactSchema)(artifact)).toBe(true);
        expect(artifact.overall).toEqual({
          caseCount: 2,
          baselineFieldCount: 4,
          candidateFieldCount: 5,
          recalledFieldCount: 3,
          missingFieldCount: 1,
          unexpectedFieldCount: 2,
          changedFieldCount: 2,
          fieldRecallRate: 0.75,
          falsePositiveRate: 0.4,
        });
        expect(findPackSummary(artifact, CATALOG_PACK_ID)).toEqual({
          packId: CATALOG_PACK_ID,
          caseIds: [CATALOG_CASE_ID],
          summary: {
            caseCount: 1,
            baselineFieldCount: 3,
            candidateFieldCount: 2,
            recalledFieldCount: 2,
            missingFieldCount: 1,
            unexpectedFieldCount: 0,
            changedFieldCount: 1,
            fieldRecallRate: 0.666667,
            falsePositiveRate: 0,
          },
        });
        expect(findPackSummary(artifact, OFFERS_PACK_ID)).toEqual({
          packId: OFFERS_PACK_ID,
          caseIds: [OFFERS_CASE_ID],
          summary: {
            caseCount: 1,
            baselineFieldCount: 1,
            candidateFieldCount: 3,
            recalledFieldCount: 1,
            missingFieldCount: 0,
            unexpectedFieldCount: 2,
            changedFieldCount: 1,
            fieldRecallRate: 1,
            falsePositiveRate: 0.666667,
          },
        });
      }),
  );

  it.effect("handles zero-baseline and zero-candidate branches without division errors", () =>
    Effect.gen(function* () {
      const { baseline, comparison } = yield* Effect.promise(() => makeFixtureEvidence());
      const mutated = replaceCanonicalMetrics(comparison, {
        [CATALOG_CASE_ID]: {
          baselineFieldCount: 0,
          candidateFieldCount: 2,
          unchangedFieldCount: 0,
          addedFieldCount: 2,
          removedFieldCount: 0,
          changedFieldCount: 0,
          baselineConfidenceScore: 0,
          candidateConfidenceScore: 0.76,
          confidenceDelta: 0.76,
        },
        [OFFERS_CASE_ID]: {
          baselineFieldCount: 1,
          candidateFieldCount: 0,
          unchangedFieldCount: 0,
          addedFieldCount: 0,
          removedFieldCount: 1,
          changedFieldCount: 0,
          baselineConfidenceScore: 0.83,
          candidateConfidenceScore: 0,
          confidenceDelta: -0.83,
        },
      });

      const artifact = yield* evaluateQualityMetrics({
        metricsId: "metrics-e7-quality-zero-counts",
        generatedAt: "2026-03-08T21:00:00.000Z",
        baseline,
        comparison: mutated,
      });

      expect(artifact.overall).toEqual({
        caseCount: 2,
        baselineFieldCount: 1,
        candidateFieldCount: 2,
        recalledFieldCount: 0,
        missingFieldCount: 1,
        unexpectedFieldCount: 2,
        changedFieldCount: 0,
        fieldRecallRate: 0,
        falsePositiveRate: 1,
      });
      expect(findPackSummary(artifact, CATALOG_PACK_ID).summary.fieldRecallRate).toBe(1);
      expect(findPackSummary(artifact, CATALOG_PACK_ID).summary.falsePositiveRate).toBe(1);
      expect(findPackSummary(artifact, OFFERS_PACK_ID).summary.fieldRecallRate).toBe(0);
      expect(findPackSummary(artifact, OFFERS_PACK_ID).summary.falsePositiveRate).toBe(0);
    }),
  );

  it.effect(
    "reports perfect recall and zero false positives on the real default fixture dataset",
    () =>
      Effect.gen(function* () {
        const { baseline, comparison } = yield* Effect.promise(() => makeFixtureEvidence());
        const artifact = yield* evaluateQualityMetrics({
          metricsId: "metrics-e7-quality-perfect",
          generatedAt: "2026-03-08T21:00:00.000Z",
          baseline,
          comparison,
        });

        expect(artifact.overall).toEqual({
          caseCount: 2,
          baselineFieldCount: 4,
          candidateFieldCount: 4,
          recalledFieldCount: 4,
          missingFieldCount: 0,
          unexpectedFieldCount: 0,
          changedFieldCount: 0,
          fieldRecallRate: 1,
          falsePositiveRate: 0,
        });
        expect(artifact.packSummaries).toEqual([
          {
            packId: CATALOG_PACK_ID,
            caseIds: [CATALOG_CASE_ID],
            summary: {
              caseCount: 1,
              baselineFieldCount: 2,
              candidateFieldCount: 2,
              recalledFieldCount: 2,
              missingFieldCount: 0,
              unexpectedFieldCount: 0,
              changedFieldCount: 0,
              fieldRecallRate: 1,
              falsePositiveRate: 0,
            },
          },
          {
            packId: OFFERS_PACK_ID,
            caseIds: [OFFERS_CASE_ID],
            summary: {
              caseCount: 1,
              baselineFieldCount: 2,
              candidateFieldCount: 2,
              recalledFieldCount: 2,
              missingFieldCount: 0,
              unexpectedFieldCount: 0,
              changedFieldCount: 0,
              fieldRecallRate: 1,
              falsePositiveRate: 0,
            },
          },
        ]);
      }),
  );

  it.effect("rejects comparison inputs without canonical snapshot metrics", () =>
    Effect.gen(function* () {
      const { baseline, comparison } = yield* Effect.promise(() => makeFixtureEvidence());
      const error = yield* Effect.flip(
        evaluateQualityMetrics({
          metricsId: "metrics-e7-quality-no-canonical-metrics",
          generatedAt: "2026-03-08T21:00:00.000Z",
          baseline,
          comparison: {
            ...comparison,
            results: comparison.results.map((result, index) =>
              index === 0
                ? {
                    ...result,
                    snapshotDiff: {
                      ...result.snapshotDiff,
                      canonicalMetrics: undefined,
                    },
                  }
                : result,
            ),
          },
        }),
      );

      expect(error.message).toContain("canonical snapshot metrics");
    }),
  );

  it.effect("rejects misaligned baseline and comparison evidence", () =>
    Effect.gen(function* () {
      const { baseline, comparison } = yield* Effect.promise(() => makeFixtureEvidence());
      const error = yield* Effect.flip(
        evaluateQualityMetrics({
          metricsId: "metrics-e7-quality-misaligned",
          generatedAt: "2026-03-08T21:00:00.000Z",
          baseline,
          comparison: {
            ...comparison,
            candidateCorpusId: "corpus-other",
          },
        }),
      );

      expect(error.message).toContain("same corpus id");
    }),
  );
});
