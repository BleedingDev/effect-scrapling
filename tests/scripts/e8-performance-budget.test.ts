import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, setDefaultTimeout } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  BENCHMARK_ID,
  DEFAULT_SAMPLE_SIZE,
  DEFAULT_WARMUP_ITERATIONS,
  FIXED_GENERATED_AT,
  PERFORMANCE_BUDGETS,
  PerformanceBudgetArtifactSchema,
  buildArtifact,
  buildStability,
  parseOptions,
  runArtifactExportObservation,
  runBenchmark,
  runBenchmarkObservation,
  runCapabilitySliceObservation,
  runWorkspaceConfigObservation,
  runWorkspaceDoctorObservation,
  summarizeMeasurements,
} from "../../scripts/benchmarks/e8-performance-budget.ts";

setDefaultTimeout(20_000);

describe("E8 performance budget harness", () => {
  it("parses explicit benchmark options through schema-backed integer decoding", () => {
    expect(
      parseOptions([
        "--artifact",
        "tmp/e8-performance-scorecard.json",
        "--baseline",
        "tmp/e8-performance-baseline.json",
        "--sample-size",
        "3",
        "--warmup",
        "1",
      ]),
    ).toEqual({
      artifactPath: expect.stringContaining("tmp/e8-performance-scorecard.json"),
      baselinePath: expect.stringContaining("tmp/e8-performance-baseline.json"),
      sampleSize: 3,
      warmupIterations: 1,
    });

    expect(parseOptions([])).toEqual({
      sampleSize: DEFAULT_SAMPLE_SIZE,
      warmupIterations: DEFAULT_WARMUP_ITERATIONS,
    });
  });

  it("keeps the deterministic E8 fingerprints stable across benchmark observations", async () => {
    expect(await runWorkspaceDoctorObservation()).toContain("doctor|");
    expect(await runWorkspaceConfigObservation()).toContain("config show");
    expect(await runCapabilitySliceObservation()).toContain("bundle-e8-benchmark-surface");
    expect(await runBenchmarkObservation()).toContain("baselineCorpus:");
    expect(await runArtifactExportObservation()).toContain("export-e8-benchmark-surface");
  });

  it("writes a comparable scorecard artifact when the benchmark harness runs end to end", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e8-performance-budget-"));
    const baselinePath = join(directory, "baseline.json");
    const artifactPath = join(directory, "artifact.json");

    try {
      await runBenchmark(["--artifact", baselinePath, "--sample-size", "1", "--warmup", "0"]);

      const artifact = await runBenchmark([
        "--artifact",
        artifactPath,
        "--baseline",
        baselinePath,
        "--sample-size",
        "1",
        "--warmup",
        "0",
      ]);
      const persisted = Schema.decodeUnknownSync(PerformanceBudgetArtifactSchema)(
        JSON.parse(await readFile(artifactPath, "utf8")),
      );

      expect(persisted).toEqual(artifact);
      expect(persisted.benchmark).toBe("e8-performance-budget");
      expect(persisted.benchmarkId).toBe(BENCHMARK_ID);
      expect(persisted.generatedAt).toBe(FIXED_GENERATED_AT);
      expect(persisted.comparison.baselinePath).toBe(resolve(baselinePath));
      expect(persisted.comparison.comparable).toBe(true);
      expect(persisted.measurements.workspaceDoctor.p95Ms).toBeGreaterThan(0);
      expect(persisted.measurements.workspaceConfig.p95Ms).toBeGreaterThan(0);
      expect(persisted.measurements.capabilitySlice.p95Ms).toBeGreaterThan(0);
      expect(persisted.measurements.benchmarkRun.p95Ms).toBeGreaterThan(0);
      expect(persisted.measurements.artifactExport.p95Ms).toBeGreaterThan(0);
      expect(persisted.stability.workspaceDoctorFingerprint.consistent).toBe(true);
      expect(persisted.stability.workspaceConfigFingerprint.consistent).toBe(true);
      expect(persisted.stability.capabilitySliceFingerprint.consistent).toBe(true);
      expect(persisted.stability.benchmarkManifestFingerprint.consistent).toBe(true);
      expect(persisted.stability.artifactExportFingerprint.consistent).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("computes fail status when budgets are breached or stability drifts", () => {
    const stable = buildStability({
      workspaceDoctor: ["doctor|bun:ok", "doctor|bun:ok"],
      workspaceConfig: ['{"command":"config show"}', '{"command":"config show"}'],
      capabilitySlice: ["capability|bundle", "capability|bundle"],
      benchmarkRun: ["baselineCorpus:a", "baselineCorpus:a"],
      artifactExport: ['{"exportId":"x"}', '{"exportId":"x"}'],
    });
    const baseline = buildArtifact(
      {
        baselinePath: resolve("./docs/artifacts/e8-performance-budget-baseline.json"),
        sampleSize: 2,
        warmupIterations: 0,
      },
      {
        workspaceDoctor: summarizeMeasurements([8, 9]),
        workspaceConfig: summarizeMeasurements([10, 11]),
        capabilitySlice: summarizeMeasurements([200, 210]),
        benchmarkRun: summarizeMeasurements([50, 60]),
        artifactExport: summarizeMeasurements([50, 60]),
        heapDeltaKiB: 1024,
      },
      stable,
      undefined,
    );

    expect(baseline.status).toBe("pass");
    expect(baseline.comparison.comparable).toBe(false);

    const unstable = buildStability({
      workspaceDoctor: ["doctor|bun:ok", "doctor|bun:drift"],
      workspaceConfig: ['{"command":"config show"}', '{"command":"config show","drift":true}'],
      capabilitySlice: ["capability|bundle", "capability|bundle-drift"],
      benchmarkRun: ["baselineCorpus:a", "baselineCorpus:b"],
      artifactExport: ['{"exportId":"x"}', '{"exportId":"y"}'],
    });
    const candidate = buildArtifact(
      {
        baselinePath: resolve("./docs/artifacts/e8-performance-budget-baseline.json"),
        sampleSize: 2,
        warmupIterations: 0,
      },
      {
        workspaceDoctor: summarizeMeasurements([PERFORMANCE_BUDGETS.workspaceDoctorP95Ms + 5, 1]),
        workspaceConfig: summarizeMeasurements([PERFORMANCE_BUDGETS.workspaceConfigP95Ms + 5, 1]),
        capabilitySlice: summarizeMeasurements([PERFORMANCE_BUDGETS.capabilitySliceP95Ms + 5, 1]),
        benchmarkRun: summarizeMeasurements([PERFORMANCE_BUDGETS.benchmarkRunP95Ms + 5, 1]),
        artifactExport: summarizeMeasurements([PERFORMANCE_BUDGETS.artifactExportP95Ms + 5, 1]),
        heapDeltaKiB: PERFORMANCE_BUDGETS.heapDeltaKiB + 1,
      },
      unstable,
      baseline,
    );

    expect(candidate.status).toBe("fail");
    expect(candidate.violations.some((message) => message.includes("workspace-doctor p95"))).toBe(
      true,
    );
    expect(candidate.violations.some((message) => message.includes("workspace-config p95"))).toBe(
      true,
    );
    expect(candidate.violations.some((message) => message.includes("capability-slice p95"))).toBe(
      true,
    );
    expect(candidate.violations.some((message) => message.includes("benchmark-run p95"))).toBe(
      true,
    );
    expect(candidate.violations.some((message) => message.includes("artifact-export p95"))).toBe(
      true,
    );
    expect(candidate.violations.some((message) => message.includes("heap delta"))).toBe(true);
    expect(
      candidate.violations.some((message) => message.includes("workspaceDoctorFingerprint")),
    ).toBe(true);
    expect(candidate.comparison.comparable).toBe(true);
  });
});
