import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { LiveCanaryArtifactSchema } from "../../libs/foundation/core/src/live-canary-runtime.ts";
import { summarizeMeasurements } from "../../libs/foundation/core/src/performance-gate-runtime.ts";
import {
  evaluatePromotionGatePolicy,
  PromotionGateEvaluationSchema,
} from "../../libs/foundation/core/src/promotion-gate-policy-runtime.ts";
import { makePerformanceArtifact, makeQualityArtifact } from "../helpers/e7-promotion-fixtures.ts";

describe("foundation-core promotion gate policy runtime", () => {
  it("promotes when quality regressions stay clear and performance is comparable within thresholds", async () => {
    const baseline = await makePerformanceArtifact();
    const performance = await makePerformanceArtifact({
      baselinePath: "/tmp/e7-performance-budget-baseline.json",
      baseline,
      measurements: {
        baselineCorpus: summarizeMeasurements([11, 14, 18]),
        incumbentComparison: summarizeMeasurements([28, 34, 46]),
        heapDeltaKiB: 700,
      },
    });

    const evaluation = await Effect.runPromise(
      evaluatePromotionGatePolicy({
        evaluationId: "promotion-e7-001",
        generatedAt: "2026-03-08T17:30:00.000Z",
        quality: makeQualityArtifact(),
        performance,
      }),
    );

    expect(Schema.is(PromotionGateEvaluationSchema)(evaluation)).toBe(true);
    expect(evaluation.verdict).toBe("promote");
    expect(evaluation.quality.verdict).toBe("promote");
    expect(evaluation.performance.verdict).toBe("promote");
    expect(evaluation.rationale.map(({ code }) => code)).toEqual([
      "quality-clean",
      "performance-clean",
    ]);
  });

  it("holds when quality is clean but comparable performance deltas exceed the promote threshold", async () => {
    const baseline = await makePerformanceArtifact();
    const performance = await makePerformanceArtifact({
      baselinePath: "/tmp/e7-performance-budget-baseline.json",
      baseline,
      measurements: {
        baselineCorpus: summarizeMeasurements([20, 30, 60]),
        incumbentComparison: summarizeMeasurements([40, 60, 80]),
        heapDeltaKiB: 900,
      },
    });

    const evaluation = await Effect.runPromise(
      evaluatePromotionGatePolicy({
        evaluationId: "promotion-e7-002",
        generatedAt: "2026-03-08T17:30:00.000Z",
        quality: makeQualityArtifact(),
        performance,
      }),
    );

    expect(evaluation.verdict).toBe("hold");
    expect(evaluation.performance.verdict).toBe("hold");
    expect(evaluation.performance.holdDeltaMetrics).toEqual(["baseline-corpus p95"]);
    expect(
      evaluation.rationale.some(
        ({ code, message }) =>
          code === "performance-hold" && message.includes("baseline-corpus p95"),
      ),
    ).toBe(true);
  });

  it("holds when drift regression severity reaches the configured hold threshold", async () => {
    const baseline = await makePerformanceArtifact();
    const performance = await makePerformanceArtifact({
      baselinePath: "/tmp/e7-performance-budget-baseline.json",
      baseline,
    });

    const evaluation = await Effect.runPromise(
      evaluatePromotionGatePolicy({
        evaluationId: "promotion-e7-003",
        generatedAt: "2026-03-08T17:30:00.000Z",
        quality: makeQualityArtifact({
          severities: ["moderate", "none"],
        }),
        performance,
      }),
    );

    expect(evaluation.verdict).toBe("hold");
    expect(evaluation.quality.verdict).toBe("hold");
    expect(evaluation.quality.holdPackIds).toEqual(["pack-1"]);
    expect(
      evaluation.rationale.some(
        ({ code, message }) => code === "quality-hold" && message.includes("pack-1"),
      ),
    ).toBe(true);
  });

  it("holds when the baseline artifact is not comparable and policy requires comparability", async () => {
    const baseline = await makePerformanceArtifact();
    const performance = await makePerformanceArtifact({
      baselinePath: "/tmp/e7-performance-budget-baseline.json",
      baseline,
      sampleSize: 4,
      measurements: {
        baselineCorpus: summarizeMeasurements([12, 15, 19, 21]),
        incumbentComparison: summarizeMeasurements([26, 34, 42, 49]),
        heapDeltaKiB: 700,
      },
    });

    const evaluation = await Effect.runPromise(
      evaluatePromotionGatePolicy({
        evaluationId: "promotion-e7-003b",
        generatedAt: "2026-03-08T17:30:00.000Z",
        quality: makeQualityArtifact(),
        performance,
      }),
    );

    expect(evaluation.verdict).toBe("hold");
    expect(evaluation.performance.verdict).toBe("hold");
    expect(
      evaluation.rationale.some(
        ({ code, message }) => code === "performance-hold" && message.includes("not comparable"),
      ),
    ).toBe(true);
  });

  it("quarantines when either quality hits critical severity or the performance budget fails", async () => {
    const baseline = await makePerformanceArtifact();
    const performance = await makePerformanceArtifact({
      baselinePath: "/tmp/e7-performance-budget-baseline.json",
      baseline,
      measurements: {
        baselineCorpus: summarizeMeasurements([200, 300, 600]),
        incumbentComparison: summarizeMeasurements([300, 600, 1200]),
        heapDeltaKiB: 20_000,
      },
    });

    const evaluation = await Effect.runPromise(
      evaluatePromotionGatePolicy({
        evaluationId: "promotion-e7-004",
        generatedAt: "2026-03-08T17:30:00.000Z",
        quality: makeQualityArtifact({
          severities: ["critical", "none"],
        }),
        performance,
      }),
    );

    expect(evaluation.verdict).toBe("quarantine");
    expect(evaluation.quality.verdict).toBe("quarantine");
    expect(evaluation.performance.verdict).toBe("quarantine");
    expect(evaluation.quality.quarantinePackIds).toEqual(["pack-1"]);
    expect(
      evaluation.rationale.some(
        ({ code, message }) => code === "quality-quarantine" && message.includes("pack-1"),
      ),
    ).toBe(true);
    expect(
      evaluation.rationale.some(
        ({ code, message }) =>
          code === "performance-quarantine" && message.includes("performance budget failed"),
      ),
    ).toBe(true);
  });

  it("quarantines when a comparable performance delta lands exactly on the quarantine threshold", async () => {
    const baseline = await makePerformanceArtifact();
    const performance = await makePerformanceArtifact({
      baselinePath: "/tmp/e7-performance-budget-baseline.json",
      baseline,
      measurements: {
        baselineCorpus: summarizeMeasurements([20, 30, 120]),
        incumbentComparison: summarizeMeasurements([25, 35, 45]),
        heapDeltaKiB: 700,
      },
    });

    const evaluation = await Effect.runPromise(
      evaluatePromotionGatePolicy({
        evaluationId: "promotion-e7-004b",
        generatedAt: "2026-03-08T17:30:00.000Z",
        quality: makeQualityArtifact(),
        performance,
      }),
    );

    expect(evaluation.verdict).toBe("quarantine");
    expect(evaluation.performance.verdict).toBe("quarantine");
    expect(evaluation.performance.quarantineDeltaMetrics).toEqual(["baseline-corpus p95"]);
  });

  it("rejects malformed policy threshold ordering through shared contracts", async () => {
    const baseline = await makePerformanceArtifact();
    const performance = await makePerformanceArtifact({
      baselinePath: "/tmp/e7-performance-budget-baseline.json",
      baseline,
    });

    await expect(
      Effect.runPromise(
        evaluatePromotionGatePolicy({
          evaluationId: "promotion-e7-005",
          generatedAt: "2026-03-08T17:30:00.000Z",
          quality: makeQualityArtifact(),
          performance,
          policy: {
            minimumHoldSeverity: "high",
            minimumQuarantineSeverity: "moderate",
            requireComparablePerformanceBaseline: true,
            maximumPromoteBaselineCorpusP95DeltaMs: 25,
            maximumPromoteIncumbentComparisonP95DeltaMs: 50,
            maximumPromoteHeapDeltaKiB: 1024,
            minimumQuarantineBaselineCorpusP95DeltaMs: 20,
            minimumQuarantineIncumbentComparisonP95DeltaMs: 40,
            minimumQuarantineHeapDeltaKiB: 1000,
          },
        }),
      ),
    ).rejects.toThrow("ordered from hold to quarantine");
  });

  it("rejects incompatible quality and performance evidence profiles", async () => {
    const performance = await makePerformanceArtifact({
      profile: {
        caseCount: 3,
        packCount: 2,
      },
    });

    await expect(
      Effect.runPromise(
        evaluatePromotionGatePolicy({
          evaluationId: "promotion-e7-006",
          generatedAt: "2026-03-08T17:30:00.000Z",
          quality: makeQualityArtifact({
            severities: ["none", "none"],
          }),
          performance,
        }),
      ),
    ).rejects.toThrow("same case count");
  });

  it("rejects mismatched pack counts between quality analysis and performance profile", async () => {
    const performance = await makePerformanceArtifact({
      profile: {
        caseCount: 2,
        packCount: 3,
      },
    });

    await expect(
      Effect.runPromise(
        evaluatePromotionGatePolicy({
          evaluationId: "promotion-e7-007",
          generatedAt: "2026-03-08T17:30:00.000Z",
          quality: makeQualityArtifact(),
          performance,
        }),
      ),
    ).rejects.toThrow("same pack count");
  });

  it("holds when live canary evidence records failing but non-quarantine scenarios", async () => {
    const baseline = await makePerformanceArtifact();
    const performance = await makePerformanceArtifact({
      baselinePath: "/tmp/e7-performance-budget-baseline.json",
      baseline,
    });
    const canary = Schema.decodeUnknownSync(LiveCanaryArtifactSchema)({
      benchmark: "e7-live-canary",
      suiteId: "suite-e7-live-canary",
      generatedAt: "2026-03-08T21:15:00.000Z",
      status: "fail",
      summary: {
        scenarioCount: 2,
        passedScenarioCount: 1,
        failedScenarioIds: ["scenario-hold"],
        verdict: "hold",
      },
      results: [
        {
          scenarioId: "scenario-hold",
          authorizationId: "auth-scenario-hold",
          provider: "browser",
          action: "guarded",
          failedStages: ["canary"],
          status: "fail",
          plannerRationale: [
            { key: "mode", message: "Hybrid canary path." },
            { key: "rendering", message: "Escalated to browser." },
          ],
        },
        {
          scenarioId: "scenario-pass",
          authorizationId: "auth-scenario-pass",
          provider: "http",
          action: "active",
          failedStages: [],
          status: "pass",
          plannerRationale: [
            { key: "mode", message: "HTTP canary path." },
            { key: "capture-path", message: "HTTP capture is sufficient." },
          ],
        },
      ],
    });

    const evaluation = await Effect.runPromise(
      evaluatePromotionGatePolicy({
        evaluationId: "promotion-e7-canary-hold",
        generatedAt: "2026-03-08T21:15:00.000Z",
        quality: makeQualityArtifact(),
        performance,
        canary,
      }),
    );

    expect(evaluation.verdict).toBe("hold");
    expect(evaluation.canary?.verdict).toBe("hold");
    expect(
      evaluation.rationale.some(
        ({ code, message }) => code === "canary-hold" && message.includes("scenario-hold"),
      ),
    ).toBe(true);
  });
});
