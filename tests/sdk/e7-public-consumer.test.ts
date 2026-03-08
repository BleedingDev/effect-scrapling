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
      expect(artifact.sections[5]?.key).toBe("promotionGate");
      expect(artifact.evidence.promotionGate.evaluationId).toBe("promotion-sdk-e7");
    }),
  );
});
