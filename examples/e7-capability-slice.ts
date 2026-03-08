import { Effect, Schema } from "effect";
import {
  runBaselineCorpus,
  BaselineCorpusArtifactSchema,
} from "../libs/foundation/core/src/baseline-corpus-runtime.ts";
import {
  analyzeDriftRegression,
  DriftRegressionArtifactSchema,
} from "../libs/foundation/core/src/drift-regression-runtime.ts";
import {
  runIncumbentComparison,
  IncumbentComparisonArtifactSchema,
} from "../libs/foundation/core/src/incumbent-comparison-runtime.ts";
import {
  evaluatePromotionGatePolicy,
  PromotionGateEvaluationSchema,
} from "../libs/foundation/core/src/promotion-gate-policy-runtime.ts";
import {
  evaluateQualityMetrics,
  QualityMetricsArtifactSchema,
} from "../libs/foundation/core/src/quality-metrics-runtime.ts";
import {
  buildQualityReportExport,
  QualityReportArtifactSchema,
} from "../libs/foundation/core/src/quality-report-runtime.ts";
import { LiveCanaryArtifactSchema } from "../libs/foundation/core/src/live-canary-runtime.ts";
import {
  QualitySoakArtifactSchema,
  evaluateQualitySoakSuite,
} from "../libs/foundation/core/src/quality-soak-suite-runtime.ts";
import { ChaosProviderSuiteArtifactSchema } from "../libs/foundation/core/src/chaos-provider-suite-runtime.ts";
import {
  PerformanceBudgetArtifactSchema,
  evaluatePerformanceBudget,
} from "../libs/foundation/core/src/performance-gate-runtime.ts";
import { createDefaultBaselineCorpus } from "../scripts/benchmarks/e7-baseline-corpus.ts";
import { runDefaultChaosProviderSuite } from "../scripts/benchmarks/e7-chaos-provider-suite.ts";
import { runDefaultLiveCanary } from "../scripts/benchmarks/e7-live-canary.ts";
import { PolicyViolation } from "../libs/foundation/core/src/tagged-errors.ts";

const PromotionDecisionSchema = Schema.Union([
  Schema.Literal("promote"),
  Schema.Literal("hold"),
  Schema.Literal("quarantine"),
]);
const ReportStatusSchema = Schema.Union([
  Schema.Literal("pass"),
  Schema.Literal("warn"),
  Schema.Literal("fail"),
]);
const BinaryStatusSchema = Schema.Union([Schema.Literal("pass"), Schema.Literal("fail")]);

const E7CapabilitySlicePathSchema = Schema.Struct({
  baselineCorpusId: Schema.String,
  comparisonIncumbentCorpusId: Schema.String,
  comparisonCandidateCorpusId: Schema.String,
  qualityMetricsCorpusId: Schema.String,
  comparisonId: Schema.String,
  driftComparisonId: Schema.String,
  qualityMetricsComparisonId: Schema.String,
  driftAnalysisId: Schema.String,
  promotionQualityAnalysisId: Schema.String,
  performanceBenchmarkId: Schema.String,
  promotionPerformanceBenchmarkId: Schema.String,
  promotionCanarySuiteId: Schema.String,
  chaosSuiteId: Schema.String,
  liveCanarySuiteId: Schema.String,
  soakSuiteId: Schema.String,
  qualityMetricsId: Schema.String,
  promotionEvaluationId: Schema.String,
  qualityReportId: Schema.String,
  promotionDecision: PromotionDecisionSchema,
  qualityReportDecision: PromotionDecisionSchema,
  qualityReportStatus: ReportStatusSchema,
  liveCanaryVerdict: PromotionDecisionSchema,
  chaosStatus: BinaryStatusSchema,
  soakStatus: BinaryStatusSchema,
});

export class E7CapabilitySliceEvidence extends Schema.Class<E7CapabilitySliceEvidence>(
  "E7CapabilitySliceEvidence",
)({
  evidencePath: E7CapabilitySlicePathSchema,
  baselineCorpus: BaselineCorpusArtifactSchema,
  incumbentComparison: IncumbentComparisonArtifactSchema,
  driftRegression: DriftRegressionArtifactSchema,
  performanceBudget: PerformanceBudgetArtifactSchema,
  chaosProviderSuite: ChaosProviderSuiteArtifactSchema,
  liveCanary: LiveCanaryArtifactSchema,
  qualityMetrics: QualityMetricsArtifactSchema,
  promotionGate: PromotionGateEvaluationSchema,
  qualityReport: QualityReportArtifactSchema,
  qualitySoak: QualitySoakArtifactSchema,
}) {}

export const E7CapabilitySliceEvidenceSchema = E7CapabilitySliceEvidence;

function makePerformanceBudgetArtifact(caseCount: number, packCount: number) {
  return evaluatePerformanceBudget({
    benchmarkId: "e7-performance-budget-capability-slice",
    generatedAt: "2026-03-08T22:03:00.000Z",
    environment: {
      bun: "1.3.10",
      platform: "darwin",
      arch: "arm64",
    },
    sampleSize: 2,
    warmupIterations: 0,
    profile: {
      caseCount,
      packCount,
    },
    policy: {
      baselineCorpusP95Ms: 500,
      incumbentComparisonP95Ms: 1200,
      heapDeltaKiB: 16384,
    },
    measurements: {
      baselineCorpus: {
        samples: 2,
        minMs: 42,
        meanMs: 43.5,
        p95Ms: 45,
        maxMs: 45,
      },
      incumbentComparison: {
        samples: 2,
        minMs: 115,
        meanMs: 118.5,
        p95Ms: 122,
        maxMs: 122,
      },
      heapDeltaKiB: 640,
    },
  });
}

function makeQualitySoakArtifact() {
  return evaluateQualitySoakSuite({
    suiteId: "suite-e7-soak-capability-slice",
    generatedAt: "2026-03-08T22:21:00.000Z",
    samples: [
      {
        iteration: 1,
        baselineCorpusMs: 45,
        incumbentComparisonMs: 122,
        heapDeltaKiB: 640,
        baselineFingerprint:
          "corpus-retail-smoke|2|2|case-catalog-example-com:match|case-offers-example-com:match",
        comparisonFingerprint:
          "comparison-retail-smoke|2|2|case-catalog-example-com:match|case-offers-example-com:match",
      },
      {
        iteration: 2,
        baselineCorpusMs: 45.5,
        incumbentComparisonMs: 123,
        heapDeltaKiB: 641,
        baselineFingerprint:
          "corpus-retail-smoke|2|2|case-catalog-example-com:match|case-offers-example-com:match",
        comparisonFingerprint:
          "comparison-retail-smoke|2|2|case-catalog-example-com:match|case-offers-example-com:match",
      },
    ],
  });
}

function ensureAligned(invariant: string, expected: string, actual: string) {
  return expected === actual
    ? Effect.void
    : Effect.fail(
        new PolicyViolation({
          message: `E7 capability slice invariant failed for ${invariant}: expected ${expected}, received ${actual}.`,
        }),
      );
}

export function runE7CapabilitySlice() {
  return Effect.gen(function* () {
    const baselineInput = yield* Effect.promise(() => createDefaultBaselineCorpus());
    const baselineCorpus = yield* runBaselineCorpus(baselineInput);
    const incumbentComparison = yield* runIncumbentComparison({
      id: "comparison-e7-capability-slice",
      createdAt: "2026-03-08T22:00:00.000Z",
      incumbent: baselineCorpus,
      candidate: baselineCorpus,
    });
    const driftRegression = yield* analyzeDriftRegression({
      id: "analysis-e7-capability-slice",
      createdAt: "2026-03-08T22:05:00.000Z",
      comparison: incumbentComparison,
    });
    const performanceBudget = yield* makePerformanceBudgetArtifact(
      baselineCorpus.caseCount,
      baselineCorpus.packCount,
    );
    const chaosProviderSuite = yield* Effect.promise(() => runDefaultChaosProviderSuite());
    const liveCanary = yield* Effect.promise(() => runDefaultLiveCanary());
    const qualityMetrics = yield* evaluateQualityMetrics({
      metricsId: "metrics-e7-capability-slice",
      generatedAt: "2026-03-08T22:10:00.000Z",
      baseline: baselineCorpus,
      comparison: incumbentComparison,
    });
    const promotionGate = yield* evaluatePromotionGatePolicy({
      evaluationId: "promotion-e7-capability-slice",
      generatedAt: "2026-03-08T22:15:00.000Z",
      quality: driftRegression,
      performance: performanceBudget,
      canary: liveCanary,
    });
    const qualityReport = yield* buildQualityReportExport({
      reportId: "report-e7-capability-slice",
      generatedAt: "2026-03-08T22:20:00.000Z",
      evidence: {
        baselineCorpus,
        incumbentComparison,
        driftRegression,
        performanceBudget,
        chaosProviderSuite,
        promotionGate,
      },
    });
    const qualitySoak = yield* makeQualitySoakArtifact();

    yield* ensureAligned(
      "comparison incumbent corpus",
      baselineCorpus.corpusId,
      incumbentComparison.incumbentCorpusId,
    );
    yield* ensureAligned(
      "comparison candidate corpus",
      baselineCorpus.corpusId,
      incumbentComparison.candidateCorpusId,
    );
    yield* ensureAligned(
      "drift comparison",
      incumbentComparison.comparisonId,
      driftRegression.comparisonId,
    );
    yield* ensureAligned(
      "quality metrics corpus",
      baselineCorpus.corpusId,
      qualityMetrics.corpusId,
    );
    yield* ensureAligned(
      "quality metrics comparison",
      incumbentComparison.comparisonId,
      qualityMetrics.comparisonId,
    );
    yield* ensureAligned(
      "promotion quality analysis",
      driftRegression.analysisId,
      promotionGate.quality.analysisId,
    );
    yield* ensureAligned(
      "promotion performance benchmark",
      performanceBudget.benchmarkId,
      promotionGate.performance.benchmarkId,
    );
    yield* ensureAligned(
      "promotion canary suite",
      liveCanary.suiteId,
      promotionGate.canary?.suiteId ?? "",
    );
    yield* ensureAligned("report decision", promotionGate.verdict, qualityReport.summary.decision);

    return Schema.decodeUnknownSync(E7CapabilitySliceEvidenceSchema)({
      evidencePath: {
        baselineCorpusId: baselineCorpus.corpusId,
        comparisonIncumbentCorpusId: incumbentComparison.incumbentCorpusId,
        comparisonCandidateCorpusId: incumbentComparison.candidateCorpusId,
        qualityMetricsCorpusId: qualityMetrics.corpusId,
        comparisonId: incumbentComparison.comparisonId,
        driftComparisonId: driftRegression.comparisonId,
        qualityMetricsComparisonId: qualityMetrics.comparisonId,
        driftAnalysisId: driftRegression.analysisId,
        promotionQualityAnalysisId: promotionGate.quality.analysisId,
        performanceBenchmarkId: performanceBudget.benchmarkId,
        promotionPerformanceBenchmarkId: promotionGate.performance.benchmarkId,
        promotionCanarySuiteId: promotionGate.canary?.suiteId ?? liveCanary.suiteId,
        chaosSuiteId: chaosProviderSuite.suiteId,
        liveCanarySuiteId: liveCanary.suiteId,
        soakSuiteId: qualitySoak.suiteId,
        qualityMetricsId: qualityMetrics.metricsId,
        promotionEvaluationId: promotionGate.evaluationId,
        qualityReportId: qualityReport.reportId,
        promotionDecision: promotionGate.verdict,
        qualityReportDecision: qualityReport.summary.decision,
        qualityReportStatus: qualityReport.summary.status,
        liveCanaryVerdict: liveCanary.summary.verdict,
        chaosStatus: chaosProviderSuite.status,
        soakStatus: qualitySoak.status,
      },
      baselineCorpus,
      incumbentComparison,
      driftRegression,
      performanceBudget,
      chaosProviderSuite,
      liveCanary,
      qualityMetrics,
      promotionGate,
      qualityReport,
      qualitySoak,
    });
  });
}

export function runE7CapabilitySliceEncoded() {
  return runE7CapabilitySlice().pipe(
    Effect.map((evidence) => Schema.encodeSync(E7CapabilitySliceEvidenceSchema)(evidence)),
  );
}

if (import.meta.main) {
  const encoded = await Effect.runPromise(runE7CapabilitySliceEncoded());
  process.stdout.write(`${JSON.stringify(encoded, null, 2)}\n`);
}
