import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const BASELINE_PATH = join(REPO_ROOT, "docs", "artifacts", "e0-performance-budget-baseline.json");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "benchmarks", "e0-performance-budget.ts");

type BenchmarkArtifact = {
  readonly benchmark: string;
  readonly sampleSize: number;
  readonly warmupIterations: number;
  readonly measurements: {
    readonly accessPreview: { readonly p95Ms: number };
    readonly extractRun: { readonly p95Ms: number };
    readonly runDoctor: { readonly p95Ms: number };
    readonly heapDeltaKiB: number;
  };
  readonly comparison: {
    readonly baselinePath: string | null;
    readonly deltas: {
      readonly accessPreviewP95Ms: number | null;
      readonly extractRunP95Ms: number | null;
      readonly runDoctorP95Ms: number | null;
      readonly heapDeltaKiB: number | null;
    };
  };
  readonly status: "pass" | "fail";
};

describe("E0 performance budget verification", () => {
  it("keeps a committed baseline artifact with the expected contract", async () => {
    const artifact = JSON.parse(await readFile(BASELINE_PATH, "utf8")) as BenchmarkArtifact;

    expect(artifact.benchmark).toBe("e0-performance-budget");
    expect(artifact.sampleSize).toBeGreaterThan(0);
    expect(artifact.warmupIterations).toBeGreaterThan(0);
    expect(artifact.measurements.accessPreview.p95Ms).toBeGreaterThan(0);
    expect(artifact.measurements.extractRun.p95Ms).toBeGreaterThan(0);
    expect(artifact.measurements.runDoctor.p95Ms).toBeGreaterThan(0);
    expect(artifact.measurements.heapDeltaKiB).toBeGreaterThanOrEqual(0);
    expect(["pass", "fail"]).toContain(artifact.status);
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

    const stdout = new TextDecoder().decode(result.stdout);
    const artifact = JSON.parse(stdout) as BenchmarkArtifact;

    expect(artifact.benchmark).toBe("e0-performance-budget");
    expect(artifact.sampleSize).toBe(3);
    expect(artifact.warmupIterations).toBe(1);
    expect(artifact.comparison.baselinePath).toBe(BASELINE_PATH);
    expect(artifact.comparison.deltas.accessPreviewP95Ms).not.toBeNull();
    expect(artifact.status).toBe("pass");
  });
});
