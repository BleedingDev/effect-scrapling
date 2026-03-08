import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  E7CapabilitySliceEvidenceSchema,
  runE7CapabilitySlice,
  runE7CapabilitySliceEncoded,
} from "../../examples/e7-capability-slice.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const exampleEntry = fileURLToPath(
  new URL("../../examples/e7-capability-slice.ts", import.meta.url),
);
const encodeEvidence = Schema.encodeSync(E7CapabilitySliceEvidenceSchema);
const decodeEvidence = Schema.decodeUnknownSync(E7CapabilitySliceEvidenceSchema);

type EncodedEvidence = ReturnType<typeof encodeEvidence>;

function stableProjection(encoded: EncodedEvidence) {
  return {
    evidencePath: encoded.evidencePath,
    baselineCorpus: {
      corpusId: encoded.baselineCorpus.corpusId,
      caseCount: encoded.baselineCorpus.caseCount,
      packCount: encoded.baselineCorpus.packCount,
    },
    incumbentComparison: {
      comparisonId: encoded.incumbentComparison.comparisonId,
      results: encoded.incumbentComparison.results.map(({ caseId, verdict, packId }) => ({
        caseId,
        verdict,
        packId,
      })),
    },
    driftRegression: {
      analysisId: encoded.driftRegression.analysisId,
      comparisonId: encoded.driftRegression.comparisonId,
      findings: encoded.driftRegression.findings,
    },
    performanceBudget: {
      benchmarkId: encoded.performanceBudget.benchmarkId,
      status: encoded.performanceBudget.status,
      profile: encoded.performanceBudget.profile,
      sampleSize: encoded.performanceBudget.sampleSize,
      warmupIterations: encoded.performanceBudget.warmupIterations,
    },
    chaosProviderSuite: {
      suiteId: encoded.chaosProviderSuite.suiteId,
      status: encoded.chaosProviderSuite.status,
      failedScenarioIds: encoded.chaosProviderSuite.failedScenarioIds,
      results: encoded.chaosProviderSuite.results.map(({ scenarioId, actualProvider, status }) => ({
        scenarioId,
        actualProvider,
        status,
      })),
    },
    liveCanary: {
      suiteId: encoded.liveCanary.suiteId,
      status: encoded.liveCanary.status,
      summary: encoded.liveCanary.summary,
      results: encoded.liveCanary.results.map(({ scenarioId, provider, status }) => ({
        scenarioId,
        provider,
        status,
      })),
    },
    qualityMetrics: {
      metricsId: encoded.qualityMetrics.metricsId,
      corpusId: encoded.qualityMetrics.corpusId,
      comparisonId: encoded.qualityMetrics.comparisonId,
      overall: encoded.qualityMetrics.overall,
    },
    promotionGate: {
      evaluationId: encoded.promotionGate.evaluationId,
      verdict: encoded.promotionGate.verdict,
      quality: encoded.promotionGate.quality,
      performance: {
        benchmarkId: encoded.promotionGate.performance.benchmarkId,
        verdict: encoded.promotionGate.performance.verdict,
      },
      canary:
        encoded.promotionGate.canary === undefined
          ? undefined
          : {
              suiteId: encoded.promotionGate.canary.suiteId,
              verdict: encoded.promotionGate.canary.verdict,
            },
    },
    qualityReport: {
      reportId: encoded.qualityReport.reportId,
      summary: encoded.qualityReport.summary,
      sections: encoded.qualityReport.sections.map(({ key, status, evidenceIds }) => ({
        key,
        status,
        evidenceIds,
      })),
    },
    qualitySoak: {
      suiteId: encoded.qualitySoak.suiteId,
      status: encoded.qualitySoak.status,
      sampleCount: encoded.qualitySoak.sampleCount,
      stability: {
        baselineFingerprintStable: encoded.qualitySoak.stability.baselineFingerprintStable,
        comparisonFingerprintStable: encoded.qualitySoak.stability.comparisonFingerprintStable,
        unboundedGrowthDetected: encoded.qualitySoak.stability.unboundedGrowthDetected,
      },
    },
  };
}

describe("examples/e7-capability-slice", () => {
  it.effect("executes the E7 end-to-end capability slice with typed aligned evidence", () =>
    Effect.gen(function* () {
      const evidence = yield* runE7CapabilitySlice();
      const encoded = encodeEvidence(evidence);

      expect(encoded.evidencePath).toMatchObject({
        baselineCorpusId: encoded.baselineCorpus.corpusId,
        comparisonIncumbentCorpusId: encoded.incumbentComparison.incumbentCorpusId,
        comparisonCandidateCorpusId: encoded.incumbentComparison.candidateCorpusId,
        qualityMetricsCorpusId: encoded.qualityMetrics.corpusId,
        comparisonId: encoded.incumbentComparison.comparisonId,
        driftComparisonId: encoded.driftRegression.comparisonId,
        qualityMetricsComparisonId: encoded.qualityMetrics.comparisonId,
        driftAnalysisId: encoded.driftRegression.analysisId,
        promotionQualityAnalysisId: encoded.promotionGate.quality.analysisId,
        performanceBenchmarkId: encoded.performanceBudget.benchmarkId,
        promotionPerformanceBenchmarkId: encoded.promotionGate.performance.benchmarkId,
        promotionCanarySuiteId: encoded.liveCanary.suiteId,
        chaosSuiteId: encoded.chaosProviderSuite.suiteId,
        liveCanarySuiteId: encoded.liveCanary.suiteId,
        soakSuiteId: encoded.qualitySoak.suiteId,
        qualityMetricsId: encoded.qualityMetrics.metricsId,
        promotionEvaluationId: encoded.promotionGate.evaluationId,
        qualityReportId: encoded.qualityReport.reportId,
      });

      expect(encoded.baselineCorpus.caseCount).toBe(2);
      expect(encoded.incumbentComparison.results.map(({ verdict }) => verdict)).toEqual([
        "match",
        "match",
      ]);
      expect(
        encoded.incumbentComparison.results.every(
          ({ snapshotDiff }) => (snapshotDiff.changes?.length ?? 0) === 0,
        ),
      ).toBe(true);
      expect(encoded.driftRegression.findings).toEqual([]);
      expect(encoded.qualityMetrics).toMatchObject({
        benchmark: "e7-quality-metrics",
        corpusId: encoded.baselineCorpus.corpusId,
        comparisonId: encoded.incumbentComparison.comparisonId,
      });
      expect(encoded.qualityMetrics.overall.fieldRecallRate).toBe(1);
      expect(encoded.qualityMetrics.overall.falsePositiveRate).toBe(0);
      expect(encoded.liveCanary).toMatchObject({
        benchmark: "e7-live-canary",
        suiteId: encoded.evidencePath.liveCanarySuiteId,
        status: "pass",
      });
      expect(encoded.liveCanary.summary.verdict).toBe(encoded.evidencePath.liveCanaryVerdict);
      expect(encoded.chaosProviderSuite).toMatchObject({
        benchmark: "e7-chaos-provider-suite",
        suiteId: encoded.evidencePath.chaosSuiteId,
        status: "pass",
      });
      expect(encoded.chaosProviderSuite.failedScenarioIds).toEqual([]);
      expect(encoded.promotionGate.quality.analysisId).toBe(encoded.driftRegression.analysisId);
      expect(encoded.promotionGate.performance.benchmarkId).toBe(
        encoded.performanceBudget.benchmarkId,
      );
      expect(encoded.promotionGate.canary?.suiteId).toBe(encoded.liveCanary.suiteId);
      expect(encoded.evidencePath.promotionDecision).toBe("hold");
      expect(encoded.qualityReport.summary.decision).toBe(encoded.promotionGate.verdict);
      expect(encoded.qualityReport.summary.status).toBe(encoded.evidencePath.qualityReportStatus);
      expect(encoded.qualityReport.summary.status).toBe("warn");
      expect(encoded.qualityReport.summary.warningSectionKeys).toEqual([
        "performanceBudget",
        "promotionGate",
      ]);
      expect(encoded.qualityReport.evidence.promotionGate.evaluationId).toBe(
        encoded.promotionGate.evaluationId,
      );
      expect(encoded.qualitySoak).toMatchObject({
        benchmark: "e7-soak-endurance-suite",
        suiteId: encoded.evidencePath.soakSuiteId,
        status: "pass",
        sampleCount: 2,
      });
      expect(encoded.qualitySoak.stability.baselineFingerprintStable).toBe(true);
      expect(encoded.qualitySoak.stability.comparisonFingerprintStable).toBe(true);
      expect(encoded.qualitySoak.stability.unboundedGrowthDetected).toBe(false);
    }),
  );

  it("runs standalone and emits schema-valid linked evidence JSON", async () => {
    const expected = await Effect.runPromise(runE7CapabilitySliceEncoded());
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", exampleEntry],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = new TextDecoder().decode(result.stderr).trim();
    expect(result.exitCode).toBe(0);
    expect(stderr).toBe("");

    const stdout = new TextDecoder().decode(result.stdout);
    const decoded = decodeEvidence(JSON.parse(stdout));
    const actual = encodeEvidence(decoded);

    expect(stableProjection(actual)).toEqual(stableProjection(expected));
  });
});
