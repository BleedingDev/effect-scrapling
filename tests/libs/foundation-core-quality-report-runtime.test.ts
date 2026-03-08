import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { analyzeDriftRegression } from "../../libs/foundation/core/src/drift-regression-runtime.ts";
import {
  buildQualityReportExport,
  QualityReportArtifactSchema,
} from "../../libs/foundation/core/src/quality-report-runtime.ts";
import { evaluatePromotionGatePolicy } from "../../libs/foundation/core/src/promotion-gate-policy-runtime.ts";
import { runBenchmark as runPerformanceBudgetBenchmark } from "../../scripts/benchmarks/e7-performance-budget.ts";
import { runDefaultBaselineCorpus } from "../../scripts/benchmarks/e7-baseline-corpus.ts";
import { runDefaultChaosProviderSuite } from "../../scripts/benchmarks/e7-chaos-provider-suite.ts";
import { runDefaultIncumbentComparison } from "../../scripts/benchmarks/e7-incumbent-comparison.ts";

async function makeEvidence() {
  const baselineCorpus = await runDefaultBaselineCorpus();
  const incumbentComparison = await runDefaultIncumbentComparison();
  const driftRegression = await Effect.runPromise(
    analyzeDriftRegression({
      id: "analysis-e7-quality-report-test",
      createdAt: "2026-03-08T19:05:00.000Z",
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
      evaluationId: "promotion-e7-quality-report-test",
      generatedAt: "2026-03-08T19:10:00.000Z",
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

describe("foundation-core quality report runtime", () => {
  it.effect("builds a deterministic report with full verdict evidence", () =>
    Effect.gen(function* () {
      const evidence = yield* Effect.promise(() => makeEvidence());
      const artifact = yield* buildQualityReportExport({
        reportId: "report-e7-quality-test",
        generatedAt: "2026-03-08T19:15:00.000Z",
        evidence,
      });

      expect(Schema.is(QualityReportArtifactSchema)(artifact)).toBe(true);
      expect(artifact.summary.decision).toBe(evidence.promotionGate.verdict);
      expect(artifact.summary.status).toBe("warn");
      expect(artifact.summary.warningSectionKeys).toEqual(["performanceBudget", "promotionGate"]);
      expect(artifact.summary.failingSectionKeys).toEqual([]);
      expect(artifact.sections.map(({ key }) => key)).toEqual([
        "baselineCorpus",
        "incumbentComparison",
        "driftRegression",
        "performanceBudget",
        "chaosProviderSuite",
        "promotionGate",
      ]);
      expect(artifact.evidence.driftRegression.analysisId).toBe(
        evidence.promotionGate.quality.analysisId,
      );
      expect(artifact.evidence.performanceBudget.benchmarkId).toBe(
        evidence.promotionGate.performance.benchmarkId,
      );
      expect(artifact.sections.map(({ key, status }) => ({ key, status }))).toEqual([
        { key: "baselineCorpus", status: "pass" },
        { key: "incumbentComparison", status: "pass" },
        { key: "driftRegression", status: "pass" },
        { key: "performanceBudget", status: "warn" },
        { key: "chaosProviderSuite", status: "pass" },
        { key: "promotionGate", status: "warn" },
      ]);
      expect(artifact.summary.highlights).toHaveLength(4);
    }),
  );

  it.effect("rejects misaligned evidence bundles through shared contracts", () =>
    Effect.gen(function* () {
      const evidence = yield* Effect.promise(() => makeEvidence());
      const error = yield* Effect.flip(
        buildQualityReportExport({
          reportId: "report-e7-quality-test",
          generatedAt: "2026-03-08T19:15:00.000Z",
          evidence: {
            ...evidence,
            promotionGate: {
              ...evidence.promotionGate,
              quality: {
                ...evidence.promotionGate.quality,
                analysisId: "analysis-mismatch",
              },
            },
          },
        }),
      );

      expect(error.message).toContain("promotion gate");
      expect(error.message).toContain("drift regression analysis id");
    }),
  );

  it.effect("marks failing sections when chaos evidence fails and promotion quarantines", () =>
    Effect.gen(function* () {
      const evidence = yield* Effect.promise(() => makeEvidence());
      const artifact = yield* buildQualityReportExport({
        reportId: "report-e7-quality-test-fail",
        generatedAt: "2026-03-08T19:16:00.000Z",
        evidence: {
          ...evidence,
          chaosProviderSuite: {
            ...evidence.chaosProviderSuite,
            failedScenarioIds: ["scenario-provider-outage"],
            status: "fail",
          },
          promotionGate: {
            ...evidence.promotionGate,
            verdict: "quarantine",
          },
        },
      });

      expect(artifact.summary.status).toBe("fail");
      expect(artifact.summary.decision).toBe("quarantine");
      expect(artifact.summary.warningSectionKeys).toEqual(["performanceBudget"]);
      expect(artifact.summary.failingSectionKeys).toEqual(["chaosProviderSuite", "promotionGate"]);
      expect(artifact.sections.map(({ key, status }) => ({ key, status }))).toEqual([
        { key: "baselineCorpus", status: "pass" },
        { key: "incumbentComparison", status: "pass" },
        { key: "driftRegression", status: "pass" },
        { key: "performanceBudget", status: "warn" },
        { key: "chaosProviderSuite", status: "fail" },
        { key: "promotionGate", status: "fail" },
      ]);
      expect(artifact.sections[4]?.evidenceIds).toEqual([evidence.chaosProviderSuite.suiteId]);
      expect(artifact.sections[5]?.evidenceIds).toEqual([
        evidence.promotionGate.evaluationId,
        evidence.promotionGate.quality.analysisId,
        evidence.promotionGate.performance.benchmarkId,
      ]);
      expect(
        artifact.summary.highlights.some((message) => message.includes("Promotion gate")),
      ).toBe(true);
    }),
  );

  it.effect("rejects chaos evidence that lost planner rationale traces", () =>
    Effect.gen(function* () {
      const evidence = yield* Effect.promise(() => makeEvidence());
      const error = yield* Effect.flip(
        buildQualityReportExport({
          reportId: "report-e7-quality-test",
          generatedAt: "2026-03-08T19:15:00.000Z",
          evidence: {
            ...evidence,
            chaosProviderSuite: {
              ...evidence.chaosProviderSuite,
              results: evidence.chaosProviderSuite.results.map((result, index) =>
                index === 0 ? { ...result, plannerRationale: [] } : result,
              ),
            },
          },
        }),
      );

      expect(error.message).toContain("planner rationale");
    }),
  );
});
