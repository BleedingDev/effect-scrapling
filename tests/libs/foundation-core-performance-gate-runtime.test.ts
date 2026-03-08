import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  evaluatePerformanceBudget,
  type PerformanceBudgetArtifact,
  summarizeMeasurements,
} from "../../libs/foundation/core/src/performance-gate-runtime.ts";

function makeInput(overrides?: {
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

describe("foundation-core performance gate runtime", () => {
  it("evaluates a passing performance artifact with null deltas when no baseline exists", async () => {
    const artifact = await Effect.runPromise(evaluatePerformanceBudget(makeInput()));

    expect(artifact.status).toBe("pass");
    expect(artifact.violations).toEqual([]);
    expect(artifact.comparison).toEqual({
      baselinePath: null,
      comparable: false,
      incompatibleReason: null,
      deltas: {
        baselineCorpusP95Ms: null,
        incumbentComparisonP95Ms: null,
        heapDeltaKiB: null,
      },
    });
  });

  it("evaluates violations and comparable deltas against a compatible baseline", async () => {
    const baseline = await Effect.runPromise(evaluatePerformanceBudget(makeInput()));
    const artifact = await Effect.runPromise(
      evaluatePerformanceBudget(
        makeInput({
          baselinePath: "/tmp/e7-performance-budget-baseline.json",
          baseline,
          measurements: {
            baselineCorpus: summarizeMeasurements([200, 300, 600]),
            incumbentComparison: summarizeMeasurements([300, 600, 1200]),
            heapDeltaKiB: 20_000,
          },
        }),
      ),
    );

    expect(artifact.status).toBe("fail");
    expect(artifact.violations.some((message) => message.includes("baseline-corpus p95"))).toBe(
      true,
    );
    expect(
      artifact.violations.some((message) => message.includes("incumbent-comparison p95")),
    ).toBe(true);
    expect(artifact.violations.some((message) => message.includes("heap delta"))).toBe(true);
    expect(artifact.comparison.comparable).toBe(true);
    expect(artifact.comparison.incompatibleReason).toBeNull();
    expect(artifact.comparison.deltas.baselineCorpusP95Ms).not.toBeNull();
  });

  it("suppresses deltas when the baseline profile is incompatible", async () => {
    const baseline = await Effect.runPromise(
      evaluatePerformanceBudget(makeInput({ sampleSize: 4 })),
    );
    const artifact = await Effect.runPromise(
      evaluatePerformanceBudget(
        makeInput({
          baselinePath: "/tmp/e7-performance-budget-baseline.json",
          baseline,
        }),
      ),
    );

    expect(artifact.comparison.comparable).toBe(false);
    expect(artifact.comparison.incompatibleReason).toContain("sampleSize");
    expect(artifact.comparison.deltas).toEqual({
      baselineCorpusP95Ms: null,
      incumbentComparisonP95Ms: null,
      heapDeltaKiB: null,
    });
  });

  it("suppresses deltas when the baseline warmup count is incompatible", async () => {
    const baseline = await Effect.runPromise(
      evaluatePerformanceBudget(makeInput({ warmupIterations: 2 })),
    );
    const artifact = await Effect.runPromise(
      evaluatePerformanceBudget(
        makeInput({
          baselinePath: "/tmp/e7-performance-budget-baseline.json",
          baseline,
        }),
      ),
    );

    expect(artifact.comparison.comparable).toBe(false);
    expect(artifact.comparison.incompatibleReason).toBe(
      "Expected baseline warmupIterations 1, received 2.",
    );
    expect(artifact.comparison.deltas).toEqual({
      baselineCorpusP95Ms: null,
      incumbentComparisonP95Ms: null,
      heapDeltaKiB: null,
    });
  });

  it("passes when measurements land exactly on the configured budget thresholds", async () => {
    const artifact = await Effect.runPromise(
      evaluatePerformanceBudget(
        makeInput({
          measurements: {
            baselineCorpus: summarizeMeasurements([500, 500, 500]),
            incumbentComparison: summarizeMeasurements([1000, 1000, 1000]),
            heapDeltaKiB: 16_384,
          },
        }),
      ),
    );

    expect(artifact.status).toBe("pass");
    expect(artifact.violations).toEqual([]);
  });

  it("suppresses deltas when the baseline workload profile is incompatible", async () => {
    const baseline = await Effect.runPromise(
      evaluatePerformanceBudget(
        makeInput({
          profile: {
            caseCount: 3,
            packCount: 2,
          },
        }),
      ),
    );
    const artifact = await Effect.runPromise(
      evaluatePerformanceBudget(
        makeInput({
          baselinePath: "/tmp/e7-performance-budget-baseline.json",
          baseline,
        }),
      ),
    );

    expect(artifact.comparison.comparable).toBe(false);
    expect(artifact.comparison.incompatibleReason).toBe(
      "Expected the baseline workload profile to match the current benchmark workload profile.",
    );
    expect(artifact.comparison.deltas).toEqual({
      baselineCorpusP95Ms: null,
      incumbentComparisonP95Ms: null,
      heapDeltaKiB: null,
    });
  });
});
