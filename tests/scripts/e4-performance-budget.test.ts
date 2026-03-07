import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import { runSoakLoadSuite } from "../../scripts/benchmarks/e4-browser-soak-load.ts";
import {
  BenchmarkArtifactSchema,
  DEFAULT_SAMPLE_SIZE,
  DEFAULT_WARMUP_ITERATIONS,
  buildArtifact,
  buildPerformanceBudgets,
  calculateThroughputRunsPerSecond,
  calculateSteadyStateDurationMs,
  parseOptions,
  roundToThree,
  runBenchmark,
  summarizeMeasurements,
} from "../../scripts/benchmarks/e4-performance-budget.ts";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_ROUNDS,
  DEFAULT_WARMUP_ITERATIONS as DEFAULT_SOAK_WARMUP_ITERATIONS,
} from "../../scripts/benchmarks/e4-browser-soak-load.ts";

describe("e4 performance budget benchmark harness", () => {
  it("parses explicit benchmark options through schema-backed integer decoding", () => {
    expect(
      parseOptions([
        "--artifact",
        "tmp/e4-scorecard.json",
        "--baseline",
        "tmp/e4-baseline.json",
        "--sample-size",
        "5",
        "--warmup",
        "1",
        "--rounds",
        "4",
        "--concurrency",
        "3",
        "--soak-warmup",
        "0",
      ]),
    ).toEqual({
      artifactPath: expect.stringContaining("tmp/e4-scorecard.json"),
      baselinePath: expect.stringContaining("tmp/e4-baseline.json"),
      sampleSize: 5,
      warmupIterations: 1,
      rounds: 4,
      concurrency: 3,
      soakWarmupIterations: 0,
    });

    expect(parseOptions([])).toEqual({
      sampleSize: DEFAULT_SAMPLE_SIZE,
      warmupIterations: DEFAULT_WARMUP_ITERATIONS,
      rounds: DEFAULT_ROUNDS,
      concurrency: DEFAULT_CONCURRENCY,
      soakWarmupIterations: DEFAULT_SOAK_WARMUP_ITERATIONS,
    });
  });

  it("writes a passing scorecard artifact when the benchmark harness runs end-to-end", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e4-performance-budget-"));
    const baselinePath = join(directory, "baseline.json");
    const artifactPath = join(directory, "artifact.json");

    try {
      await runBenchmark([
        "--artifact",
        baselinePath,
        "--sample-size",
        "2",
        "--warmup",
        "1",
        "--rounds",
        "2",
        "--concurrency",
        "2",
        "--soak-warmup",
        "0",
      ]);

      const artifact = await runBenchmark([
        "--artifact",
        artifactPath,
        "--baseline",
        baselinePath,
        "--sample-size",
        "2",
        "--warmup",
        "1",
        "--rounds",
        "2",
        "--concurrency",
        "2",
        "--soak-warmup",
        "0",
      ]);
      const persisted = Schema.decodeUnknownSync(BenchmarkArtifactSchema)(
        JSON.parse(await readFile(artifactPath, "utf8")),
      );

      expect(artifact.status).toBe("pass");
      expect(persisted).toEqual(artifact);
      expect(persisted.comparison.baselinePath).toBe(resolve(baselinePath));
      expect(persisted.measurements.throughputRunsPerSecond).toBeGreaterThan(0);
      expect(persisted.resources.finalSnapshot.openBrowsers).toBe(0);
      expect(persisted.resources.finalSnapshot.openContexts).toBe(0);
      expect(persisted.resources.finalSnapshot.openPages).toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("computes pass/fail scorecards from deterministic summaries and soak artifacts", async () => {
    const passSoak = await runSoakLoadSuite({
      rounds: 2,
      concurrency: 2,
      warmupIterations: 0,
    });
    const options = {
      baselinePath: resolve("./tmp/e4-performance-baseline.json"),
      sampleSize: 3,
      warmupIterations: 1,
      rounds: 2,
      concurrency: 2,
      soakWarmupIterations: 0,
    };
    const passMeasurements = {
      capabilitySlice: summarizeMeasurements([4, 5, 6]),
      soakArtifact: passSoak,
      soakSteadyStateDurationMs: calculateSteadyStateDurationMs(passSoak),
      throughputRunsPerSecond: Math.max(
        buildPerformanceBudgets(2).minimumThroughputRunsPerSecond + 25,
        calculateThroughputRunsPerSecond(passSoak, calculateSteadyStateDurationMs(passSoak)),
      ),
      heapDeltaKiB: 512,
    };
    const baseline = buildArtifact(options, passMeasurements, undefined);

    expect(baseline.status).toBe("pass");
    expect(baseline.budgets.maxPeakOpenContexts).toBe(2);
    expect(baseline.comparison.baselinePath).toBe(resolve("./tmp/e4-performance-baseline.json"));
    expect(baseline.comparison.deltas).toEqual({
      capabilitySliceP95Ms: null,
      soakRoundDurationP95Ms: null,
      throughputRunsPerSecond: null,
      heapDeltaKiB: null,
    });

    const failSoak = await runSoakLoadSuite({
      rounds: 2,
      concurrency: 3,
      warmupIterations: 0,
      policy: {
        maxOpenContexts: 1,
        maxOpenPages: 1,
      },
    });
    const failMeasurements = {
      capabilitySlice: summarizeMeasurements([
        1,
        1,
        buildPerformanceBudgets(3).capabilitySliceP95Ms + 1,
      ]),
      soakArtifact: failSoak,
      soakSteadyStateDurationMs: calculateSteadyStateDurationMs(failSoak),
      throughputRunsPerSecond: buildPerformanceBudgets(3).minimumThroughputRunsPerSecond - 1,
      heapDeltaKiB: buildPerformanceBudgets(3).heapDeltaKiB + 1,
    };
    const candidate = buildArtifact(
      {
        ...options,
        concurrency: 3,
      },
      failMeasurements,
      baseline,
    );

    expect(candidate.status).toBe("fail");
    expect(candidate.violations.some((message) => message.includes("capability-slice p95"))).toBe(
      true,
    );
    expect(
      candidate.violations.some((message) => message.includes("steady-state throughput")),
    ).toBe(true);
    expect(candidate.violations.some((message) => message.includes("heap delta"))).toBe(true);
    expect(candidate.violations.some((message) => message.includes("leak alarms"))).toBe(true);
    expect(candidate.comparison.deltas).toEqual({
      capabilitySliceP95Ms: roundToThree(
        failMeasurements.capabilitySlice.p95Ms - baseline.measurements.capabilitySlice.p95Ms,
      ),
      soakRoundDurationP95Ms: roundToThree(
        failMeasurements.soakArtifact.measurements.roundDurationMs.p95Ms -
          baseline.measurements.soakRoundDurationMs.p95Ms,
      ),
      throughputRunsPerSecond: roundToThree(
        failMeasurements.throughputRunsPerSecond - baseline.measurements.throughputRunsPerSecond,
      ),
      heapDeltaKiB: roundToThree(
        failMeasurements.heapDeltaKiB - baseline.measurements.heapDeltaKiB,
      ),
    });
  });
});
