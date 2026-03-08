import { Effect, Schema } from "effect";
import {
  DriftRegressionArtifactSchema,
  LiveCanaryArtifactSchema,
  PerformanceBudgetArtifactSchema,
  PromotionGateEvaluationSchema,
  evaluatePromotionGatePolicy,
} from "effect-scrapling/e7";

export const e7SdkConsumerPrerequisites = [
  "Bun >= 1.3.10",
  'Run from repository root with "bun run example:e7-sdk-consumer".',
  'Use only the public "effect-scrapling/e7" package subpath for E7 consumers.',
] as const;

export const e7SdkConsumerPitfalls = [
  "Promotion decisions stay truthful only when quality, performance, and canary evidence reference the same pack counts and deterministic IDs.",
  "A valid performance artifact can still force a hold verdict when the baseline is not comparable.",
  "Do not import repo-private benchmark helpers from consumer code; the public E7 surface is enough for deterministic policy evaluation.",
] as const;

function makeQualityEvidence() {
  return Schema.decodeUnknownSync(DriftRegressionArtifactSchema)({
    benchmark: "e7-drift-regression-analysis",
    analysisId: "analysis-sdk-e7-consumer",
    generatedAt: "2026-03-08T21:30:00.000Z",
    comparisonId: "comparison-sdk-e7-consumer",
    caseCount: 1,
    packCount: 1,
    findings: [],
    packSummaries: [
      {
        packId: "pack-sdk-example-com",
        severity: "none",
        caseCount: 1,
        regressedCaseCount: 0,
        findingCount: 0,
        highestDriftMagnitude: 0,
        highestConfidenceDrop: 0,
        signatures: [],
      },
    ],
  });
}

function makePerformanceEvidence(packCount = 1) {
  return Schema.decodeUnknownSync(PerformanceBudgetArtifactSchema)({
    benchmark: "e7-performance-budget",
    benchmarkId: "e7-performance-budget-sdk-consumer",
    generatedAt: "2026-03-08T21:31:00.000Z",
    environment: {
      bun: process.versions.bun,
      platform: process.platform,
      arch: process.arch,
    },
    sampleSize: 2,
    warmupIterations: 0,
    profile: {
      caseCount: 1,
      packCount,
    },
    budgets: {
      baselineCorpusP95Ms: 50,
      incumbentComparisonP95Ms: 150,
      heapDeltaKiB: 4096,
    },
    measurements: {
      baselineCorpus: {
        samples: 2,
        minMs: 41.2,
        meanMs: 42.1,
        p95Ms: 42.9,
        maxMs: 42.9,
      },
      incumbentComparison: {
        samples: 2,
        minMs: 118.3,
        meanMs: 119.4,
        p95Ms: 120.1,
        maxMs: 120.1,
      },
      heapDeltaKiB: 2048,
    },
    comparison: {
      baselinePath: "/virtual/e7-performance-budget-baseline.json",
      comparable: true,
      incompatibleReason: null,
      deltas: {
        baselineCorpusP95Ms: 0,
        incumbentComparisonP95Ms: 0,
        heapDeltaKiB: 0,
      },
    },
    violations: [],
    status: "pass",
  });
}

function makeCanaryEvidence() {
  return Schema.decodeUnknownSync(LiveCanaryArtifactSchema)({
    benchmark: "e7-live-canary",
    suiteId: "suite-sdk-e7-consumer",
    generatedAt: "2026-03-08T21:32:00.000Z",
    status: "pass",
    summary: {
      scenarioCount: 1,
      passedScenarioCount: 1,
      failedScenarioIds: [],
      verdict: "promote",
    },
    results: [
      {
        scenarioId: "scenario-sdk-e7-consumer",
        authorizationId: "auth-sdk-e7-consumer",
        provider: "browser",
        action: "active",
        failedStages: [],
        status: "pass",
        plannerRationale: [
          {
            key: "mode",
            message: "Access mode resolved to hybrid.",
          },
          {
            key: "rendering",
            message: "Rendering policy resolved to onDemand.",
          },
          {
            key: "budget",
            message: "Concurrency budget resolved to 4/16.",
          },
          {
            key: "capture-path",
            message: "Capture step selected browser provider for the consumer smoke path.",
          },
        ],
      },
    ],
  });
}

export function runE7SdkConsumerExample() {
  return Effect.gen(function* () {
    const evaluation = yield* evaluatePromotionGatePolicy({
      evaluationId: "promotion-sdk-e7-consumer",
      generatedAt: "2026-03-08T21:33:00.000Z",
      quality: makeQualityEvidence(),
      performance: makePerformanceEvidence(),
      canary: makeCanaryEvidence(),
    });

    const expectedError = yield* evaluatePromotionGatePolicy({
      evaluationId: "promotion-sdk-e7-consumer-invalid",
      generatedAt: "2026-03-08T21:34:00.000Z",
      quality: makeQualityEvidence(),
      performance: makePerformanceEvidence(2),
      canary: makeCanaryEvidence(),
    }).pipe(
      Effect.match({
        onFailure: (error) => ({
          code: "ParserFailure",
          message: error.message,
        }),
        onSuccess: () => ({
          code: "UnexpectedSuccess",
          message: "Expected mismatched E7 pack counts to be rejected.",
        }),
      }),
    );

    return {
      importPaths: ["effect-scrapling/e7"] as const,
      prerequisites: e7SdkConsumerPrerequisites,
      pitfalls: e7SdkConsumerPitfalls,
      payload: {
        evaluation: Schema.encodeSync(PromotionGateEvaluationSchema)(evaluation),
        expectedError,
      },
    };
  });
}

if (import.meta.main) {
  const result = await Effect.runPromise(runE7SdkConsumerExample());
  console.log(JSON.stringify(result, null, 2));
}
