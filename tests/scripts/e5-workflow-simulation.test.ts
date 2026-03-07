import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  BenchmarkArtifactSchema,
  DEFAULT_OBSERVATIONS_PER_TARGET,
  DEFAULT_SAMPLE_SIZE,
  DEFAULT_TARGET_COUNT,
  DEFAULT_WARMUP_ITERATIONS,
  buildArtifact,
  parseOptions,
  roundToThree,
  runBenchmark,
  runSimulationSample,
  summarizeMeasurements,
} from "../../scripts/benchmarks/e5-workflow-simulation.ts";

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
    expect(sample.durationMs).toBeGreaterThan(0);
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
        "20",
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
        "20",
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
      expect(persisted.profile.totalObservations).toBe(10_000);
      expect(persisted.stability.observedCheckpointCount).toBe(60);
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
        },
        {
          durationMs: 110,
          observationsPerSecond: 2_400,
          checkpointsPerSecond: 1_450,
          checkpointCount: 6,
          stageFingerprint: "snapshot>quality>reflect",
          totalObservations: 10,
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
        },
        {
          durationMs: 20_500,
          observationsPerSecond: 10,
          checkpointsPerSecond: 5,
          checkpointCount: 5,
          stageFingerprint: "snapshot>reflect",
          totalObservations: 10,
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
        },
        {
          durationMs: 100,
          observationsPerSecond: 25_000,
          checkpointsPerSecond: 1_500,
          checkpointCount: 5,
          stageFingerprint: "snapshot>reflect",
          totalObservations: 10,
        },
      ],
      baseline,
    );

    expect(flakyCandidate.status).toBe("fail");
    expect(flakyCandidate.stability.consistentCheckpointCount).toBe(false);
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
