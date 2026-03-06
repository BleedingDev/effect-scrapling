import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const BASELINE_PATH = join(REPO_ROOT, "docs", "artifacts", "e1-performance-budget-baseline.json");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "benchmarks", "e1-performance-budget.ts");

const BenchmarkSummarySchema = Schema.Struct({
  samples: Schema.Int.check(Schema.isGreaterThan(0)),
  minMs: Schema.Finite,
  meanMs: Schema.Finite,
  p95Ms: Schema.Finite,
  maxMs: Schema.Finite,
});

const BenchmarkArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e1-performance-budget"),
  sampleSize: Schema.Int.check(Schema.isGreaterThan(0)),
  warmupIterations: Schema.Int.check(Schema.isGreaterThan(0)),
  measurements: Schema.Struct({
    capabilitySlice: BenchmarkSummarySchema,
    contractRoundtrip: BenchmarkSummarySchema,
    heapDeltaKiB: Schema.Finite,
  }),
  comparison: Schema.Struct({
    baselinePath: Schema.NullOr(Schema.String),
    deltas: Schema.Struct({
      capabilitySliceP95Ms: Schema.NullOr(Schema.Finite),
      contractRoundtripP95Ms: Schema.NullOr(Schema.Finite),
      heapDeltaKiB: Schema.NullOr(Schema.Finite),
    }),
  }),
  status: Schema.Literals(["pass", "fail"] as const),
});

describe("E1 performance budget verification", () => {
  it("keeps a committed baseline artifact with the expected contract", async () => {
    const artifact = Schema.decodeUnknownSync(BenchmarkArtifactSchema)(
      JSON.parse(await readFile(BASELINE_PATH, "utf8")),
    );

    expect(artifact.benchmark).toBe("e1-performance-budget");
    expect(artifact.measurements.capabilitySlice.p95Ms).toBeGreaterThan(0);
    expect(artifact.measurements.contractRoundtrip.p95Ms).toBeGreaterThan(0);
    expect(artifact.measurements.heapDeltaKiB).toBeGreaterThanOrEqual(0);
  });

  it("emits a deterministic output contract when run against the baseline", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", SCRIPT_PATH, "--sample-size", "3", "--warmup", "1", "--baseline", BASELINE_PATH],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    expect(result.exitCode).toBe(0);

    const artifact = Schema.decodeUnknownSync(BenchmarkArtifactSchema)(
      JSON.parse(new TextDecoder().decode(result.stdout)),
    );

    expect(artifact.sampleSize).toBe(3);
    expect(artifact.warmupIterations).toBe(1);
    expect(artifact.comparison.baselinePath).toBe(BASELINE_PATH);
    expect(artifact.comparison.deltas.capabilitySliceP95Ms).not.toBeNull();
    expect(artifact.status).toBe("pass");
  });
});
