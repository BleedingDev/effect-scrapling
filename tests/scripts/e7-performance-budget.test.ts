import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { PerformanceBudgetArtifactSchema } from "../../libs/foundation/core/src/performance-gate-runtime.ts";
import {
  DEFAULT_SAMPLE_SIZE,
  DEFAULT_WARMUP_ITERATIONS,
  parseOptions,
  runBenchmark,
} from "../../scripts/benchmarks/e7-performance-budget.ts";

describe("e7 performance budget benchmark harness", () => {
  afterEach(() => {
    mock.restore();
  });

  it("parses explicit benchmark options through schema-backed integer decoding", () => {
    expect(
      parseOptions([
        "--artifact",
        "tmp/e7-performance-scorecard.json",
        "--baseline",
        "tmp/e7-performance-baseline.json",
        "--sample-size",
        "2",
        "--warmup",
        "0",
      ]),
    ).toEqual({
      artifactPath: expect.stringContaining("tmp/e7-performance-scorecard.json"),
      baselinePath: expect.stringContaining("tmp/e7-performance-baseline.json"),
      sampleSize: 2,
      warmupIterations: 0,
    });
    expect(parseOptions([])).toEqual({
      sampleSize: DEFAULT_SAMPLE_SIZE,
      warmupIterations: DEFAULT_WARMUP_ITERATIONS,
    });
  });

  it("writes a comparable scorecard artifact when the benchmark harness runs end-to-end", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e7-performance-budget-"));
    const baselinePath = join(directory, "baseline.json");
    const artifactPath = join(directory, "artifact.json");

    try {
      await runBenchmark(["--artifact", baselinePath, "--sample-size", "2", "--warmup", "0"]);

      const artifact = await runBenchmark([
        "--artifact",
        artifactPath,
        "--baseline",
        baselinePath,
        "--sample-size",
        "2",
        "--warmup",
        "0",
      ]);
      const persisted = Schema.decodeUnknownSync(PerformanceBudgetArtifactSchema)(
        JSON.parse(await readFile(artifactPath, "utf8")),
      );

      expect(persisted).toEqual(artifact);
      expect(persisted.comparison.baselinePath).toBe(resolve(baselinePath));
      expect(persisted.comparison.comparable).toBe(true);
      expect(persisted.comparison.incompatibleReason).toBeNull();
      expect(persisted.measurements.baselineCorpus.p95Ms).toBeGreaterThan(0);
      expect(persisted.measurements.incumbentComparison.p95Ms).toBeGreaterThan(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
