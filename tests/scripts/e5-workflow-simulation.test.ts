import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { compileCrawlPlans } from "../../libs/foundation/core/src/crawl-plan-runtime.ts";
import {
  BenchmarkArtifactSchema,
  DEFAULT_OBSERVATIONS_PER_TARGET,
  DEFAULT_SAMPLE_SIZE,
  DEFAULT_TARGET_COUNT,
  DEFAULT_WARMUP_ITERATIONS,
  buildArtifact,
  createSimulationCompilerInput,
  parseOptions,
  roundToThree,
  runBenchmark,
  runSimulationSample,
  summarizeMeasurements,
} from "../../scripts/benchmarks/e5-workflow-simulation.ts";

const stableBudgetEvents = {
  acquired: 2,
  rejected: 0,
  released: 2,
  peakGlobalInUse: 2,
  peakPerDomainInUse: 2,
} as const;

const stableWorkClaims = {
  recordCount: 2,
  maxClaimCount: 1,
  maxTakeoverCount: 0,
  decisions: {
    acquired: 2,
    alreadyClaimed: 0,
    alreadyCompleted: 0,
    superseded: 0,
  },
} as const;

describe("e5 workflow simulation benchmark harness", () => {
  it("parses explicit benchmark options through schema-backed integer decoding", () => {
    expect(
      parseOptions([
        "--artifact",
        "tmp/e5-scorecard.json",
        "--baseline",
        "tmp/e5-baseline.json",
        "--targets",
        "4",
        "--observations-per-target",
        "50",
        "--sample-size",
        "2",
        "--warmup",
        "1",
      ]),
    ).toEqual({
      artifactPath: expect.stringContaining("tmp/e5-scorecard.json"),
      baselinePath: expect.stringContaining("tmp/e5-baseline.json"),
      targetCount: 4,
      observationsPerTarget: 50,
      sampleSize: 2,
      warmupIterations: 1,
    });

    expect(parseOptions([])).toEqual({
      targetCount: DEFAULT_TARGET_COUNT,
      observationsPerTarget: DEFAULT_OBSERVATIONS_PER_TARGET,
      sampleSize: DEFAULT_SAMPLE_SIZE,
      warmupIterations: DEFAULT_WARMUP_ITERATIONS,
    });

    expect(() => parseOptions(["--artifact"])).toThrow();
    expect(() => parseOptions(["--sample-size"])).toThrow();
    expect(() => parseOptions(["--warmup", "-1"])).toThrow();
    expect(() => parseOptions(["--unknown"])).toThrow();
  });

  it("runs a deterministic workflow simulation sample with stable checkpoint metrics", async () => {
    const sample = await Effect.runPromise(
      runSimulationSample({
        targetCount: 2,
        observationsPerTarget: 5,
        totalObservations: 10,
      }),
    );

    expect(sample.totalObservations).toBe(10);
    expect(sample.checkpointCount).toBe(6);
    expect(sample.stageFingerprint).toBe("snapshot>quality>reflect");
    expect(sample.budgetEvents).toEqual({
      acquired: 2,
      rejected: 0,
      released: 2,
      peakGlobalInUse: 1,
      peakPerDomainInUse: 1,
    });
    expect(sample.workClaims.recordCount).toBeGreaterThan(0);
    expect(sample.workClaims.maxClaimCount).toBe(1);
    expect(sample.workClaims.maxTakeoverCount).toBe(0);
    expect(sample.workClaims.decisions.alreadyClaimed).toBe(0);
    expect(sample.workClaims.decisions.alreadyCompleted).toBe(0);
    expect(sample.workClaims.decisions.superseded).toBe(0);
    expect(sample.workClaims.decisions.acquired).toBe(sample.workClaims.recordCount);
    expect(sample.durationMs).toBeGreaterThan(0);
  });

  it("supports simulation profiles above one hundred targets without violating target priority contracts", async () => {
    const sample = await Effect.runPromise(
      runSimulationSample({
        targetCount: 101,
        observationsPerTarget: 1,
        totalObservations: 101,
      }),
    );

    expect(sample.totalObservations).toBe(101);
    expect(sample.checkpointCount).toBe(303);
    expect(sample.stageFingerprint).toBe("snapshot>quality>reflect");
    expect(sample.budgetEvents.acquired).toBe(101);
    expect(sample.budgetEvents.rejected).toBe(0);
    expect(sample.budgetEvents.released).toBe(101);
    expect(sample.workClaims.maxClaimCount).toBe(1);
    expect(sample.workClaims.maxTakeoverCount).toBe(0);
  });

  it("compiles large simulation profiles in deterministic canonical target order", async () => {
    const compiledPlans = await Effect.runPromise(
      compileCrawlPlans(
        createSimulationCompilerInput({
          targetCount: 1002,
          observationsPerTarget: 1,
          totalObservations: 1002,
        }),
      ),
    );

    expect(compiledPlans).toHaveLength(1002);
    expect(compiledPlans[0]?.plan.targetId).toBe("target-product-0001");
    expect(compiledPlans[1]?.plan.targetId).toBe("target-product-0002");
    expect(compiledPlans[999]?.plan.targetId).toBe("target-product-1000");
    expect(compiledPlans[1000]?.plan.targetId).toBe("target-product-1001");
    expect(compiledPlans[1001]?.plan.targetId).toBe("target-product-1002");
  });

  it("writes a passing scorecard artifact when the benchmark harness runs end to end", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e5-workflow-simulation-"));
    const baselinePath = join(directory, "baseline.json");
    const artifactPath = join(directory, "artifact.json");

    try {
      await runBenchmark([
        "--artifact",
        baselinePath,
        "--targets",
        "40",
        "--observations-per-target",
        "500",
        "--sample-size",
        "1",
        "--warmup",
        "0",
      ]);

      const artifact = await runBenchmark([
        "--artifact",
        artifactPath,
        "--baseline",
        baselinePath,
        "--targets",
        "40",
        "--observations-per-target",
        "500",
        "--sample-size",
        "1",
        "--warmup",
        "0",
      ]);
      const persisted = Schema.decodeUnknownSync(BenchmarkArtifactSchema)(
        JSON.parse(await readFile(artifactPath, "utf8")),
      );

      expect(artifact.status).toBe("pass");
      expect(persisted).toEqual(artifact);
      expect(persisted.profile.totalObservations).toBe(20_000);
      expect(persisted.stability.observedCheckpointCount).toBe(120);
      expect(persisted.stability.consistentCheckpointCount).toBe(true);
      expect(persisted.stability.observedStageFingerprint).toBe("snapshot>quality>reflect");
      expect(persisted.stability.consistentStageFingerprint).toBe(true);
      expect(persisted.comparison.baselinePath).toBe(resolve(baselinePath));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("computes pass/fail scorecards from deterministic summaries and stability mismatches", () => {
    const options = {
      baselinePath: resolve("./tmp/e5-workflow-baseline.json"),
      targetCount: 2,
      observationsPerTarget: 5,
      sampleSize: 2,
      warmupIterations: 1,
    };
    const profile = {
      targetCount: 2,
      observationsPerTarget: 5,
      totalObservations: 10,
    };
    const baseline = buildArtifact(
      options,
      profile,
      [
        {
          durationMs: 100,
          observationsPerSecond: 2_500,
          checkpointsPerSecond: 1_500,
          checkpointCount: 6,
          stageFingerprint: "snapshot>quality>reflect",
          totalObservations: 10,
          budgetEvents: stableBudgetEvents,
          workClaims: stableWorkClaims,
        },
        {
          durationMs: 110,
          observationsPerSecond: 2_400,
          checkpointsPerSecond: 1_450,
          checkpointCount: 6,
          stageFingerprint: "snapshot>quality>reflect",
          totalObservations: 10,
          budgetEvents: stableBudgetEvents,
          workClaims: stableWorkClaims,
        },
      ],
      undefined,
    );

    expect(baseline.status).toBe("fail");

    const candidate = buildArtifact(
      options,
      profile,
      [
        {
          durationMs: 20_001,
          observationsPerSecond: 10,
          checkpointsPerSecond: 5,
          checkpointCount: 5,
          stageFingerprint: "snapshot>reflect",
          totalObservations: 10,
          budgetEvents: stableBudgetEvents,
          workClaims: stableWorkClaims,
        },
        {
          durationMs: 20_500,
          observationsPerSecond: 10,
          checkpointsPerSecond: 5,
          checkpointCount: 5,
          stageFingerprint: "snapshot>reflect",
          totalObservations: 10,
          budgetEvents: stableBudgetEvents,
          workClaims: stableWorkClaims,
        },
      ],
      baseline,
    );

    expect(candidate.status).toBe("fail");
    expect(candidate.violations.some((message) => message.includes("workflow duration p95"))).toBe(
      true,
    );
    expect(candidate.violations.some((message) => message.includes("observation throughput"))).toBe(
      true,
    );
    expect(candidate.violations.some((message) => message.includes("checkpoint throughput"))).toBe(
      true,
    );
    expect(candidate.violations.some((message) => message.includes("checkpoint count"))).toBe(true);
    expect(
      candidate.violations.some((message) =>
        message.includes("checkpoint count varied across repeated simulation samples"),
      ),
    ).toBe(false);
    expect(
      candidate.violations.some((message) => message.includes("checkpoint stage fingerprint")),
    ).toBe(true);
    expect(candidate.comparison.deltas).toEqual({
      workflowDurationP95Ms: roundToThree(
        candidate.measurements.workflowDurationMs.p95 -
          baseline.measurements.workflowDurationMs.p95,
      ),
      observationsPerSecondMean: roundToThree(
        candidate.measurements.observationsPerSecond.mean -
          baseline.measurements.observationsPerSecond.mean,
      ),
      checkpointsPerSecondMean: roundToThree(
        candidate.measurements.checkpointsPerSecond.mean -
          baseline.measurements.checkpointsPerSecond.mean,
      ),
    });
    expect(summarizeMeasurements([100, 110]).samples).toBe(2);

    const flakyCandidate = buildArtifact(
      options,
      profile,
      [
        {
          durationMs: 100,
          observationsPerSecond: 25_000,
          checkpointsPerSecond: 1_500,
          checkpointCount: 6,
          stageFingerprint: "snapshot>quality>reflect",
          totalObservations: 10,
          budgetEvents: stableBudgetEvents,
          workClaims: stableWorkClaims,
        },
        {
          durationMs: 100,
          observationsPerSecond: 25_000,
          checkpointsPerSecond: 1_500,
          checkpointCount: 5,
          stageFingerprint: "snapshot>reflect",
          totalObservations: 10,
          budgetEvents: stableBudgetEvents,
          workClaims: stableWorkClaims,
        },
      ],
      baseline,
    );

    expect(flakyCandidate.status).toBe("fail");
    expect(flakyCandidate.stability.observedCheckpointCount).toBe(5);
    expect(flakyCandidate.stability.consistentCheckpointCount).toBe(false);
    expect(flakyCandidate.stability.observedStageFingerprint).toBe(
      "snapshot>quality>reflect|snapshot>reflect",
    );
    expect(flakyCandidate.stability.consistentStageFingerprint).toBe(false);
    expect(
      flakyCandidate.violations.some((message) =>
        message.includes("checkpoint count varied across repeated simulation samples"),
      ),
    ).toBe(true);
    expect(
      flakyCandidate.violations.some((message) =>
        message.includes("checkpoint stage fingerprint varied across repeated simulation samples"),
      ),
    ).toBe(true);
  });
});
