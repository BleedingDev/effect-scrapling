import { Effect, Schema } from "effect";
import { DriftRegressionArtifactSchema } from "../../libs/foundation/core/src/drift-regression-runtime.ts";
import {
  evaluatePerformanceBudget,
  summarizeMeasurements,
  type PerformanceBudgetArtifact,
} from "../../libs/foundation/core/src/performance-gate-runtime.ts";

export function makeQualityArtifact(input?: {
  readonly severities?: ReadonlyArray<"none" | "low" | "moderate" | "high" | "critical">;
}) {
  const severities = input?.severities ?? ["none", "none"];

  return Schema.decodeUnknownSync(DriftRegressionArtifactSchema)({
    benchmark: "e7-drift-regression-analysis",
    analysisId: "analysis-e7-001",
    generatedAt: "2026-03-08T17:00:00.000Z",
    comparisonId: "comparison-e7-001",
    caseCount: severities.length,
    packCount: severities.length,
    findings: severities.flatMap((severity, index) =>
      severity === "none"
        ? []
        : [
            {
              id: `finding-${index + 1}`,
              caseId: `case-${index + 1}`,
              packId: `pack-${index + 1}`,
              targetId: `target-${index + 1}`,
              snapshotDiffId: `diff-${index + 1}`,
              field: "price",
              kind: "fieldChanged",
              signature: `price:fieldChanged:${severity}`,
              severity,
              driftMagnitude: severity === "critical" ? 0.3 : severity === "high" ? 0.15 : 0.06,
              confidenceDrop: severity === "critical" ? 0.25 : severity === "high" ? 0.16 : 0.08,
              message: `Regression severity ${severity} for pack-${index + 1}.`,
            },
          ],
    ),
    packSummaries: severities.map((severity, index) => ({
      packId: `pack-${index + 1}`,
      severity,
      caseCount: 1,
      regressedCaseCount: severity === "none" ? 0 : 1,
      findingCount: severity === "none" ? 0 : 1,
      highestDriftMagnitude: severity === "critical" ? 0.3 : severity === "high" ? 0.15 : 0.06,
      highestConfidenceDrop: severity === "critical" ? 0.25 : severity === "high" ? 0.16 : 0.08,
      signatures: severity === "none" ? [] : [`price:fieldChanged:${severity}`],
    })),
  });
}

function makePerformanceInput(overrides?: {
  readonly sampleSize?: number;
  readonly warmupIterations?: number;
  readonly profile?: {
    readonly caseCount: number;
    readonly packCount: number;
  };
  readonly policy?: {
    readonly baselineCorpusP95Ms: number;
    readonly incumbentComparisonP95Ms: number;
    readonly heapDeltaKiB: number;
  };
  readonly measurements?: {
    readonly baselineCorpus: ReturnType<typeof summarizeMeasurements>;
    readonly incumbentComparison: ReturnType<typeof summarizeMeasurements>;
    readonly heapDeltaKiB: number;
  };
  readonly baselinePath?: string;
  readonly baseline?: PerformanceBudgetArtifact;
}) {
  return {
    benchmarkId: "e7-performance-budget",
    generatedAt: "2026-03-08T16:00:00.000Z",
    environment: {
      bun: "1.3.10",
      platform: "darwin",
      arch: "arm64",
    },
    sampleSize: overrides?.sampleSize ?? 3,
    warmupIterations: overrides?.warmupIterations ?? 1,
    profile: overrides?.profile ?? {
      caseCount: 2,
      packCount: 2,
    },
    policy: overrides?.policy ?? {
      baselineCorpusP95Ms: 500,
      incumbentComparisonP95Ms: 1000,
      heapDeltaKiB: 16_384,
    },
    measurements: overrides?.measurements ?? {
      baselineCorpus: summarizeMeasurements([10, 15, 20]),
      incumbentComparison: summarizeMeasurements([25, 35, 45]),
      heapDeltaKiB: 512,
    },
    ...(overrides?.baselinePath === undefined ? {} : { baselinePath: overrides.baselinePath }),
    ...(overrides?.baseline === undefined ? {} : { baseline: overrides.baseline }),
  };
}

export async function makePerformanceArtifact(
  overrides?: Parameters<typeof makePerformanceInput>[0],
) {
  return await Effect.runPromise(evaluatePerformanceBudget(makePerformanceInput(overrides)));
}
