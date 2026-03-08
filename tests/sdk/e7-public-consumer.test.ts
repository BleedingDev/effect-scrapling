import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { QualityReportArtifactSchema, buildQualityReportExport } from "effect-scrapling/e7";
import { analyzeDriftRegression } from "../../libs/foundation/core/src/drift-regression-runtime.ts";
import { evaluatePromotionGatePolicy } from "../../libs/foundation/core/src/promotion-gate-policy-runtime.ts";
import { runDefaultBaselineCorpus } from "../../scripts/benchmarks/e7-baseline-corpus.ts";
import { runDefaultChaosProviderSuite } from "../../scripts/benchmarks/e7-chaos-provider-suite.ts";
import { runDefaultIncumbentComparison } from "../../scripts/benchmarks/e7-incumbent-comparison.ts";
import { runBenchmark as runPerformanceBudgetBenchmark } from "../../scripts/benchmarks/e7-performance-budget.ts";

async function makeEvidence() {
  const baselineCorpus = await runDefaultBaselineCorpus();
  const incumbentComparison = await runDefaultIncumbentComparison();
  const driftRegression = await Effect.runPromise(
    analyzeDriftRegression({
      id: "analysis-sdk-e7",
      createdAt: "2026-03-08T20:03:00.000Z",
      comparison: incumbentComparison,
    }),
  );
  const performanceBudget = await runPerformanceBudgetBenchmark([
    "--sample-size",
    "2",
    "--warmup",
    "0",
  ]);
  const chaosProviderSuite = await runDefaultChaosProviderSuite();
  const promotionGate = await Effect.runPromise(
    evaluatePromotionGatePolicy({
      evaluationId: "promotion-sdk-e7",
      generatedAt: "2026-03-08T20:06:00.000Z",
      quality: driftRegression,
      performance: performanceBudget,
    }),
  );

  return {
    baselineCorpus,
    incumbentComparison,
    driftRegression,
    performanceBudget,
    chaosProviderSuite,
    promotionGate,
  };
}

type QualityReportEvidence = Awaited<ReturnType<typeof makeEvidence>>;

function makeFailingEvidence(evidence: QualityReportEvidence): QualityReportEvidence {
  const firstResult = evidence.chaosProviderSuite.results[0];
  if (firstResult === undefined) {
    throw new Error("Expected chaos provider suite fixture to include at least one result.");
  }

  return {
    ...evidence,
    chaosProviderSuite: {
      ...evidence.chaosProviderSuite,
      status: "fail",
      failedScenarioIds: [firstResult.scenarioId],
      results: evidence.chaosProviderSuite.results.map((result) =>
        result.scenarioId === firstResult.scenarioId
          ? { ...result, status: "fail" as const }
          : result,
      ),
    },
  };
}

describe("E7 public SDK consumer contract", () => {
  it.effect("builds a quality report through the public E7 export surface", () =>
    Effect.gen(function* () {
      const artifact = yield* Effect.promise(async () =>
        Effect.runPromise(
          buildQualityReportExport({
            reportId: "report-sdk-e7",
            generatedAt: "2026-03-08T20:07:00.000Z",
            evidence: await makeEvidence(),
          }),
        ),
      );

      expect(Schema.is(QualityReportArtifactSchema)(artifact)).toBe(true);
      expect(artifact.summary.decision).toBe(artifact.evidence.promotionGate.verdict);
      expect(artifact.summary.status).toBe("warn");
      expect(artifact.summary.warningSectionKeys).toEqual(["performanceBudget", "promotionGate"]);
      expect(artifact.sections[5]?.key).toBe("promotionGate");
      expect(artifact.sections[5]?.evidenceIds).toEqual([
        "promotion-sdk-e7",
        "analysis-sdk-e7",
        "e7-performance-budget",
      ]);
      expect(artifact.evidence.promotionGate.evaluationId).toBe("promotion-sdk-e7");
    }),
  );

  it.effect("surfaces failing artifact evidence through the public E7 export surface", () =>
    Effect.gen(function* () {
      const evidence = yield* Effect.promise(() => makeEvidence());
      const artifact = yield* Effect.promise(async () =>
        Effect.runPromise(
          buildQualityReportExport({
            reportId: "report-sdk-e7-fail",
            generatedAt: "2026-03-08T20:08:00.000Z",
            evidence: makeFailingEvidence(evidence),
          }),
        ),
      );

      expect(artifact.summary.decision).toBe("hold");
      expect(artifact.summary.status).toBe("fail");
      expect(artifact.summary.warningSectionKeys).toEqual(["performanceBudget", "promotionGate"]);
      expect(artifact.summary.failingSectionKeys).toEqual(["chaosProviderSuite"]);
      expect(artifact.sections[4]?.key).toBe("chaosProviderSuite");
      expect(artifact.sections[4]?.status).toBe("fail");
      expect(artifact.sections[4]?.evidenceIds).toEqual([evidence.chaosProviderSuite.suiteId]);
    }),
  );

  it.effect("rejects misaligned evidence through the public E7 export surface", () =>
    Effect.gen(function* () {
      const evidence = yield* Effect.promise(() => makeEvidence());
      const error = yield* Effect.promise(async () =>
        Effect.runPromise(
          Effect.flip(
            buildQualityReportExport({
              reportId: "report-sdk-e7-misaligned",
              generatedAt: "2026-03-08T20:09:00.000Z",
              evidence: {
                ...evidence,
                promotionGate: {
                  ...evidence.promotionGate,
                  quality: {
                    ...evidence.promotionGate.quality,
                    analysisId: "analysis-sdk-e7-mismatch",
                  },
                },
              },
            }),
          ),
        ),
      );

      expect(error.message).toContain("promotion gate");
      expect(error.message).toContain("drift regression analysis id");
    }),
  );
});
