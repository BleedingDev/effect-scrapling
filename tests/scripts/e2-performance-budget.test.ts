import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  BenchmarkArtifactSchema,
  DEFAULT_SAMPLE_SIZE,
  DEFAULT_WARMUP_ITERATIONS,
  buildArtifact,
  parseOptions,
  roundToThree,
  runBenchmark,
  summarizeMeasurements,
} from "../../scripts/benchmarks/e2-performance-budget.ts";

describe("e2 performance budget benchmark harness", () => {
  it("parses explicit benchmark options through schema-backed integer decoding", () => {
    expect(
      parseOptions([
        "--artifact",
        "tmp/e2-scorecard.json",
        "--baseline",
        "tmp/e2-baseline.json",
        "--sample-size",
        "5",
        "--warmup",
        "1",
      ]),
    ).toEqual({
      artifactPath: expect.stringContaining("tmp/e2-scorecard.json"),
      baselinePath: expect.stringContaining("tmp/e2-baseline.json"),
      sampleSize: 5,
      warmupIterations: 1,
    });

    expect(parseOptions([])).toEqual({
      sampleSize: DEFAULT_SAMPLE_SIZE,
      warmupIterations: DEFAULT_WARMUP_ITERATIONS,
    });
  });

  it("writes a passing scorecard artifact when the benchmark harness runs end to end", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e2-performance-budget-"));
    const baselinePath = join(directory, "baseline.json");
    const artifactPath = join(directory, "artifact.json");

    try {
      await runBenchmark(["--artifact", baselinePath, "--sample-size", "2", "--warmup", "1"]);

      const artifact = await runBenchmark([
        "--artifact",
        artifactPath,
        "--baseline",
        baselinePath,
        "--sample-size",
        "2",
        "--warmup",
        "1",
      ]);
      const persisted = Schema.decodeUnknownSync(BenchmarkArtifactSchema)(
        JSON.parse(await readFile(artifactPath, "utf8")),
      );

      expect(artifact.status).toBe("pass");
      expect(persisted).toEqual(artifact);
      expect(persisted.comparison.baselinePath).toBe(resolve(baselinePath));
      expect(persisted.measurements.capabilitySlice.p95Ms).toBeGreaterThan(0);
      expect(persisted.measurements.goldenReplay.p95Ms).toBeGreaterThan(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("computes pass/fail scorecards from deterministic summaries", () => {
    const options = {
      baselinePath: resolve("./tmp/e2-performance-baseline.json"),
      sampleSize: 3,
      warmupIterations: 1,
    };
    const baseline = buildArtifact(
      options,
      {
        capabilitySlice: summarizeMeasurements([5, 6, 7]),
        goldenReplay: summarizeMeasurements([3, 4, 5]),
        heapDeltaKiB: 512,
      },
      undefined,
    );

    expect(baseline.status).toBe("pass");
    expect(baseline.comparison.deltas).toEqual({
      capabilitySliceP95Ms: null,
      goldenReplayP95Ms: null,
      heapDeltaKiB: null,
    });

    const candidate = buildArtifact(
      options,
      {
        capabilitySlice: summarizeMeasurements([1, 1, 80]),
        goldenReplay: summarizeMeasurements([1, 1, 61]),
        heapDeltaKiB: 16_385,
      },
      baseline,
    );

    expect(candidate.status).toBe("fail");
    expect(candidate.violations.some((message) => message.includes("capability-slice p95"))).toBe(
      true,
    );
    expect(candidate.violations.some((message) => message.includes("golden-replay p95"))).toBe(
      true,
    );
    expect(candidate.violations.some((message) => message.includes("heap delta"))).toBe(true);
    expect(candidate.comparison.deltas).toEqual({
      capabilitySliceP95Ms: roundToThree(
        candidate.measurements.capabilitySlice.p95Ms - baseline.measurements.capabilitySlice.p95Ms,
      ),
      goldenReplayP95Ms: roundToThree(
        candidate.measurements.goldenReplay.p95Ms - baseline.measurements.goldenReplay.p95Ms,
      ),
      heapDeltaKiB: roundToThree(
        candidate.measurements.heapDeltaKiB - baseline.measurements.heapDeltaKiB,
      ),
    });
  });
});
