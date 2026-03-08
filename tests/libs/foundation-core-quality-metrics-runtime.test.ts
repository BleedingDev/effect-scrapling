import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  QualityMetricsArtifactSchema,
  evaluateQualityMetrics,
} from "../../libs/foundation/core/src/quality-metrics-runtime.ts";
import { IncumbentComparisonArtifactSchema } from "../../libs/foundation/core/src/incumbent-comparison-runtime.ts";
import {
  createDefaultBaselineCorpus,
  runDefaultBaselineCorpus,
} from "../../scripts/benchmarks/e7-baseline-corpus.ts";
import { runIncumbentComparison } from "../../libs/foundation/core/src/incumbent-comparison-runtime.ts";
import { runBaselineCorpus } from "../../libs/foundation/core/src/baseline-corpus-runtime.ts";

describe("foundation-core quality metrics runtime", () => {
  it.effect(
    "computes deterministic recall and false-positive metrics from fixture-backed comparison artifacts",
    () =>
      Effect.gen(function* () {
        const baselineInput = yield* Effect.promise(() => createDefaultBaselineCorpus());
        const baseline = yield* Effect.promise(() => runDefaultBaselineCorpus());
        const baselineOffersCase = baseline.results.find(
          ({ caseId }) => caseId === "case-offers-example-com",
        );
        if (baselineOffersCase === undefined) {
          throw new Error("Expected the default E7 baseline corpus to include the offers case.");
        }
        const baselineObservation =
          baselineOffersCase.orchestration.snapshotAssembly.snapshot.observations[0];
        if (baselineObservation === undefined) {
          throw new Error(
            "Expected the default E7 baseline offers case to include at least one observation.",
          );
        }
        const candidateInput = {
          ...baselineInput,
          cases: baselineInput.cases.map((entry) =>
            entry.caseId === "case-offers-example-com"
              ? {
                  ...entry,
                  captureBundle: {
                    ...entry.captureBundle,
                    artifacts: entry.captureBundle.artifacts.map((artifact) =>
                      artifact.kind === "html"
                        ? {
                            ...artifact,
                            payload:
                              "<html><body><h1>Offers Widget Updated</h1><span data-price='USD 899.00'>USD 899.00</span></body></html>",
                          }
                        : artifact,
                    ),
                  },
                }
              : entry,
          ),
        };
        const candidate = yield* runBaselineCorpus(candidateInput);
        const comparison = yield* runIncumbentComparison({
          id: "comparison-retail-smoke",
          createdAt: "2026-03-08T21:00:00.000Z",
          incumbent: baseline,
          candidate,
        });
        const mutated = Schema.decodeUnknownSync(IncumbentComparisonArtifactSchema)({
          ...comparison,
          results: comparison.results.map((result) =>
            result.caseId === "case-offers-example-com"
              ? {
                  ...result,
                  snapshotDiff: {
                    ...result.snapshotDiff,
                    changes: [
                      {
                        changeType: "remove",
                        field: "availability",
                        baseline: baselineObservation,
                        confidenceDelta: -0.2,
                      },
                      {
                        changeType: "add",
                        field: "promoBadge",
                        candidate: baselineObservation,
                        confidenceDelta: 0.1,
                      },
                    ],
                    canonicalMetrics: {
                      baselineFieldCount: 2,
                      candidateFieldCount: 2,
                      unchangedFieldCount: 1,
                      addedFieldCount: 1,
                      removedFieldCount: 1,
                      changedFieldCount: 0,
                      baselineConfidenceScore: 0.95,
                      candidateConfidenceScore: 0.9,
                      confidenceDelta: -0.05,
                    },
                  },
                }
              : result,
          ),
        });

        const artifact = yield* evaluateQualityMetrics({
          metricsId: "metrics-e7-quality",
          generatedAt: "2026-03-08T21:00:00.000Z",
          baseline,
          comparison: mutated,
        });

        expect(Schema.is(QualityMetricsArtifactSchema)(artifact)).toBe(true);
        expect(artifact.overall.baselineFieldCount).toBe(4);
        expect(artifact.overall.candidateFieldCount).toBe(4);
        expect(artifact.overall.missingFieldCount).toBe(1);
        expect(artifact.overall.unexpectedFieldCount).toBe(1);
        expect(artifact.overall.fieldRecallRate).toBe(0.75);
        expect(artifact.overall.falsePositiveRate).toBe(0.25);
        expect(artifact.packSummaries[1]?.packId).toBe("pack-offers-example-com");
        expect(artifact.packSummaries[1]?.summary.fieldRecallRate).toBe(0.5);
        expect(artifact.packSummaries[1]?.summary.falsePositiveRate).toBe(0.5);
      }),
  );

  it.effect(
    "reports perfect recall and zero false positives on the real default fixture dataset",
    () =>
      Effect.gen(function* () {
        const baseline = yield* Effect.promise(() => runDefaultBaselineCorpus());
        const comparison = yield* runIncumbentComparison({
          id: "comparison-retail-smoke",
          createdAt: "2026-03-08T21:00:00.000Z",
          incumbent: baseline,
          candidate: baseline,
        });
        const artifact = yield* evaluateQualityMetrics({
          metricsId: "metrics-e7-quality-perfect",
          generatedAt: "2026-03-08T21:00:00.000Z",
          baseline,
          comparison,
        });

        expect(artifact.overall.fieldRecallRate).toBe(1);
        expect(artifact.overall.falsePositiveRate).toBe(0);
        expect(artifact.packSummaries.map(({ summary }) => summary.fieldRecallRate)).toEqual([
          1, 1,
        ]);
      }),
  );

  it.effect("rejects misaligned baseline and comparison evidence", () =>
    Effect.gen(function* () {
      const baseline = yield* Effect.promise(() => runDefaultBaselineCorpus());
      const comparison = yield* runIncumbentComparison({
        id: "comparison-retail-smoke",
        createdAt: "2026-03-08T21:00:00.000Z",
        incumbent: baseline,
        candidate: baseline,
      });
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
