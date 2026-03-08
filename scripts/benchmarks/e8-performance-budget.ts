#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema, SchemaGetter } from "effect";
import {
  runArtifactExportOperation,
  runBenchmarkOperation,
  runWorkspaceDoctor,
  showWorkspaceConfig,
} from "../../src/e8.ts";
import { runE8CapabilitySlice } from "../../examples/e8-capability-slice.ts";

const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeFiniteSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const PositiveIntFromString = Schema.FiniteFromString.check(Schema.isInt()).check(
  Schema.isGreaterThan(0),
);
const NonNegativeIntFromString = Schema.FiniteFromString.check(Schema.isInt()).check(
  Schema.isGreaterThanOrEqualTo(0),
);
const PositiveIntArgumentSchema = Schema.Trim.pipe(
  Schema.check(Schema.isPattern(/^\d+$/u)),
  Schema.decodeTo(PositiveIntFromString, {
    decode: SchemaGetter.passthrough(),
    encode: SchemaGetter.String(),
  }),
);
const NonNegativeIntArgumentSchema = Schema.Trim.pipe(
  Schema.check(Schema.isPattern(/^\d+$/u)),
  Schema.decodeTo(NonNegativeIntFromString, {
    decode: SchemaGetter.passthrough(),
    encode: SchemaGetter.String(),
  }),
);

const BenchmarkSummarySchema = Schema.Struct({
  samples: PositiveIntSchema,
  minMs: Schema.Finite,
  meanMs: Schema.Finite,
  p95Ms: Schema.Finite,
  maxMs: Schema.Finite,
});

const StabilityObservationSchema = Schema.Struct({
  expected: NonEmptyStringSchema,
  observed: NonEmptyStringSchema,
  consistent: Schema.Boolean,
});

export const PerformanceBudgetProfileSchema = Schema.Struct({
  workspaceRunsPerSample: PositiveIntSchema,
  capabilitySliceRunsPerSample: PositiveIntSchema,
  benchmarkRunsPerSample: PositiveIntSchema,
  artifactExportsPerSample: PositiveIntSchema,
});

export const PerformanceBudgetPolicySchema = Schema.Struct({
  workspaceDoctorP95Ms: PositiveIntSchema,
  workspaceConfigP95Ms: PositiveIntSchema,
  capabilitySliceP95Ms: PositiveIntSchema,
  benchmarkRunP95Ms: PositiveIntSchema,
  artifactExportP95Ms: PositiveIntSchema,
  heapDeltaKiB: PositiveIntSchema,
});

export const PerformanceBudgetMeasurementsSchema = Schema.Struct({
  workspaceDoctor: BenchmarkSummarySchema,
  workspaceConfig: BenchmarkSummarySchema,
  capabilitySlice: BenchmarkSummarySchema,
  benchmarkRun: BenchmarkSummarySchema,
  artifactExport: BenchmarkSummarySchema,
  heapDeltaKiB: NonNegativeFiniteSchema,
});

export const PerformanceBudgetStabilitySchema = Schema.Struct({
  workspaceDoctorFingerprint: StabilityObservationSchema,
  workspaceConfigFingerprint: StabilityObservationSchema,
  capabilitySliceFingerprint: StabilityObservationSchema,
  benchmarkManifestFingerprint: StabilityObservationSchema,
  artifactExportFingerprint: StabilityObservationSchema,
});

const PerformanceBudgetComparisonSchema = Schema.Struct({
  baselinePath: Schema.NullOr(Schema.String),
  comparable: Schema.Boolean,
  incompatibleReason: Schema.NullOr(NonEmptyStringSchema),
  deltas: Schema.Struct({
    workspaceDoctorP95Ms: Schema.NullOr(Schema.Finite),
    workspaceConfigP95Ms: Schema.NullOr(Schema.Finite),
    capabilitySliceP95Ms: Schema.NullOr(Schema.Finite),
    benchmarkRunP95Ms: Schema.NullOr(Schema.Finite),
    artifactExportP95Ms: Schema.NullOr(Schema.Finite),
    heapDeltaKiB: Schema.NullOr(Schema.Finite),
  }),
});

export const PerformanceBudgetArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e8-performance-budget"),
  benchmarkId: NonEmptyStringSchema,
  generatedAt: NonEmptyStringSchema,
  environment: Schema.Struct({
    bun: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
  }),
  sampleSize: PositiveIntSchema,
  warmupIterations: NonNegativeIntSchema,
  profile: PerformanceBudgetProfileSchema,
  budgets: PerformanceBudgetPolicySchema,
  measurements: PerformanceBudgetMeasurementsSchema,
  stability: PerformanceBudgetStabilitySchema,
  comparison: PerformanceBudgetComparisonSchema,
  violations: Schema.Array(NonEmptyStringSchema),
  status: Schema.Literals(["pass", "fail"] as const),
});

export const DEFAULT_SAMPLE_SIZE = 2;
export const DEFAULT_WARMUP_ITERATIONS = 0;
export const FIXED_GENERATED_AT = "2026-03-09T09:00:00.000Z";
export const BENCHMARK_ID = "e8-performance-budget";
export const DEFAULT_PROFILE = Schema.decodeUnknownSync(PerformanceBudgetProfileSchema)({
  workspaceRunsPerSample: 8,
  capabilitySliceRunsPerSample: 1,
  benchmarkRunsPerSample: 3,
  artifactExportsPerSample: 3,
});
export const PERFORMANCE_BUDGETS = Schema.decodeUnknownSync(PerformanceBudgetPolicySchema)({
  workspaceDoctorP95Ms: 100,
  workspaceConfigP95Ms: 120,
  capabilitySliceP95Ms: 2500,
  benchmarkRunP95Ms: 450,
  artifactExportP95Ms: 600,
  heapDeltaKiB: 36_864,
});

function roundToThree(value: number) {
  return Number(value.toFixed(3));
}

function percentile95(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

export function summarizeMeasurements(values: readonly number[]) {
  return Schema.decodeUnknownSync(BenchmarkSummarySchema)({
    samples: values.length,
    minMs: roundToThree(Math.min(...values)),
    meanMs: roundToThree(values.reduce((total, value) => total + value, 0) / values.length),
    p95Ms: roundToThree(percentile95(values)),
    maxMs: roundToThree(Math.max(...values)),
  });
}

export function parseOptions(args: readonly string[]) {
  let artifactPath: string | undefined;
  let baselinePath: string | undefined;
  let sampleSize = DEFAULT_SAMPLE_SIZE;
  let warmupIterations = DEFAULT_WARMUP_ITERATIONS;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const rawValue = args[index + 1];

    if (argument === "--artifact") {
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error("Missing value for argument: --artifact");
      }

      artifactPath = resolve(rawValue);
      index += 1;
      continue;
    }

    if (argument === "--baseline") {
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error("Missing value for argument: --baseline");
      }

      baselinePath = resolve(rawValue);
      index += 1;
      continue;
    }

    if (argument === "--sample-size") {
      sampleSize = Schema.decodeUnknownSync(PositiveIntArgumentSchema)(rawValue);
      index += 1;
      continue;
    }

    if (argument === "--warmup") {
      warmupIterations = Schema.decodeUnknownSync(NonNegativeIntArgumentSchema)(rawValue);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    ...(artifactPath === undefined ? {} : { artifactPath }),
    ...(baselinePath === undefined ? {} : { baselinePath }),
    sampleSize,
    warmupIterations,
  };
}

type BenchmarkOptions = ReturnType<typeof parseOptions>;
type PerformanceBudgetArtifact = Schema.Schema.Type<typeof PerformanceBudgetArtifactSchema>;

export async function measureEffect(
  sampleSize: number,
  warmupIterations: number,
  iterationsPerSample: number,
  effectFactory: () => Promise<unknown>,
) {
  for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
    for (let repeat = 0; repeat < iterationsPerSample; repeat += 1) {
      await effectFactory();
    }
  }

  const values = new Array<number>();
  for (let iteration = 0; iteration < sampleSize; iteration += 1) {
    const startedAt = performance.now();
    for (let repeat = 0; repeat < iterationsPerSample; repeat += 1) {
      await effectFactory();
    }
    values.push((performance.now() - startedAt) / iterationsPerSample);
  }

  return summarizeMeasurements(values);
}

async function persistArtifact(path: string, artifact: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

async function readBaseline(path: string | undefined) {
  if (path === undefined) {
    return undefined;
  }

  return Schema.decodeUnknownSync(PerformanceBudgetArtifactSchema)(
    JSON.parse(await readFile(path, "utf8")),
  );
}

export async function runWorkspaceDoctorObservation() {
  const envelope = await Effect.runPromise(runWorkspaceDoctor());
  return `${envelope.command}|${envelope.data.checks
    .map(({ name, ok }) => `${name}:${ok ? "ok" : "fail"}`)
    .sort()
    .join("|")}`;
}

export async function runWorkspaceConfigObservation() {
  const envelope = await Effect.runPromise(showWorkspaceConfig());
  return JSON.stringify({
    command: envelope.command,
    browserPool: envelope.data.browserPool,
    sourceOrder: envelope.data.sourceOrder,
    checkpointInterval: envelope.data.runConfigDefaults.checkpointInterval,
  });
}

export async function runCapabilitySliceObservation() {
  const evidence = await Effect.runPromise(runE8CapabilitySlice());
  return [
    evidence.evidencePath.importedTargetIds.join(">"),
    evidence.evidencePath.listedTargetIds.join(">"),
    evidence.evidencePath.packId,
    evidence.evidencePath.promotedPackVersion,
    evidence.evidencePath.workflowRunId,
    evidence.evidencePath.snapshotDiffId,
    evidence.evidencePath.qualityMetricsId,
    evidence.evidencePath.benchmarkBundleId,
    evidence.paritySummary.status,
    evidence.paritySummary.mismatchCount,
  ].join("|");
}

export async function runBenchmarkObservation() {
  const envelope = await Effect.runPromise(runBenchmarkOperation());
  return envelope.data.manifest.map(({ key, artifactId }) => `${key}:${artifactId}`).join("|");
}

export async function runArtifactExportObservation() {
  const envelope = await Effect.runPromise(runArtifactExportOperation());
  return JSON.stringify({
    exportId: envelope.data.artifact.exportId,
    bundleId: envelope.data.artifact.metadata.bundleId,
    sanitizedPathCount: envelope.data.artifact.metadata.sanitizedPathCount,
    manifestKeys: envelope.data.artifact.metadata.manifest.map(({ key }) => key),
  });
}

function buildStabilityObservation(values: readonly string[]) {
  const expected = values[0] ?? "missing";
  const observed = values.at(-1) ?? "missing";
  return Schema.decodeUnknownSync(StabilityObservationSchema)({
    expected,
    observed,
    consistent: values.length > 0 && values.every((value) => value === expected),
  });
}

export function buildStability(input: {
  readonly workspaceDoctor: readonly string[];
  readonly workspaceConfig: readonly string[];
  readonly capabilitySlice: readonly string[];
  readonly benchmarkRun: readonly string[];
  readonly artifactExport: readonly string[];
}) {
  return Schema.decodeUnknownSync(PerformanceBudgetStabilitySchema)({
    workspaceDoctorFingerprint: buildStabilityObservation(input.workspaceDoctor),
    workspaceConfigFingerprint: buildStabilityObservation(input.workspaceConfig),
    capabilitySliceFingerprint: buildStabilityObservation(input.capabilitySlice),
    benchmarkManifestFingerprint: buildStabilityObservation(input.benchmarkRun),
    artifactExportFingerprint: buildStabilityObservation(input.artifactExport),
  });
}

function sameProfile(
  left: Schema.Schema.Type<typeof PerformanceBudgetProfileSchema>,
  right: Schema.Schema.Type<typeof PerformanceBudgetProfileSchema>,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildIncompatibleBaselineReason(
  options: Pick<PerformanceBudgetArtifact, "sampleSize" | "warmupIterations">,
  profile: Schema.Schema.Type<typeof PerformanceBudgetProfileSchema>,
  baseline: PerformanceBudgetArtifact,
) {
  if (baseline.sampleSize !== options.sampleSize) {
    return `Expected baseline sampleSize ${options.sampleSize}, received ${baseline.sampleSize}.`;
  }

  if (baseline.warmupIterations !== options.warmupIterations) {
    return `Expected baseline warmupIterations ${options.warmupIterations}, received ${baseline.warmupIterations}.`;
  }

  if (!sameProfile(baseline.profile, profile)) {
    return "Expected the baseline workload profile to match the current E8 benchmark workload profile.";
  }

  return null;
}

function buildComparison(
  options: Pick<BenchmarkOptions, "baselinePath" | "sampleSize" | "warmupIterations">,
  profile: Schema.Schema.Type<typeof PerformanceBudgetProfileSchema>,
  measurements: Schema.Schema.Type<typeof PerformanceBudgetMeasurementsSchema>,
  baseline: PerformanceBudgetArtifact | undefined,
) {
  const incompatibleReason =
    baseline === undefined ? null : buildIncompatibleBaselineReason(options, profile, baseline);
  const comparable = baseline !== undefined && incompatibleReason === null;

  return Schema.decodeUnknownSync(PerformanceBudgetComparisonSchema)({
    baselinePath: options.baselinePath ?? null,
    comparable,
    incompatibleReason,
    deltas: {
      workspaceDoctorP95Ms:
        comparable && baseline !== undefined
          ? roundToThree(
              measurements.workspaceDoctor.p95Ms - baseline.measurements.workspaceDoctor.p95Ms,
            )
          : null,
      workspaceConfigP95Ms:
        comparable && baseline !== undefined
          ? roundToThree(
              measurements.workspaceConfig.p95Ms - baseline.measurements.workspaceConfig.p95Ms,
            )
          : null,
      capabilitySliceP95Ms:
        comparable && baseline !== undefined
          ? roundToThree(
              measurements.capabilitySlice.p95Ms - baseline.measurements.capabilitySlice.p95Ms,
            )
          : null,
      benchmarkRunP95Ms:
        comparable && baseline !== undefined
          ? roundToThree(measurements.benchmarkRun.p95Ms - baseline.measurements.benchmarkRun.p95Ms)
          : null,
      artifactExportP95Ms:
        comparable && baseline !== undefined
          ? roundToThree(
              measurements.artifactExport.p95Ms - baseline.measurements.artifactExport.p95Ms,
            )
          : null,
      heapDeltaKiB:
        comparable && baseline !== undefined
          ? roundToThree(measurements.heapDeltaKiB - baseline.measurements.heapDeltaKiB)
          : null,
    },
  });
}

function buildViolations(
  measurements: Schema.Schema.Type<typeof PerformanceBudgetMeasurementsSchema>,
  stability: Schema.Schema.Type<typeof PerformanceBudgetStabilitySchema>,
) {
  const violations = new Array<string>();

  if (measurements.workspaceDoctor.p95Ms > PERFORMANCE_BUDGETS.workspaceDoctorP95Ms) {
    violations.push(
      `Expected workspace-doctor p95 <= ${PERFORMANCE_BUDGETS.workspaceDoctorP95Ms}ms, received ${measurements.workspaceDoctor.p95Ms}ms.`,
    );
  }

  if (measurements.workspaceConfig.p95Ms > PERFORMANCE_BUDGETS.workspaceConfigP95Ms) {
    violations.push(
      `Expected workspace-config p95 <= ${PERFORMANCE_BUDGETS.workspaceConfigP95Ms}ms, received ${measurements.workspaceConfig.p95Ms}ms.`,
    );
  }

  if (measurements.capabilitySlice.p95Ms > PERFORMANCE_BUDGETS.capabilitySliceP95Ms) {
    violations.push(
      `Expected capability-slice p95 <= ${PERFORMANCE_BUDGETS.capabilitySliceP95Ms}ms, received ${measurements.capabilitySlice.p95Ms}ms.`,
    );
  }

  if (measurements.benchmarkRun.p95Ms > PERFORMANCE_BUDGETS.benchmarkRunP95Ms) {
    violations.push(
      `Expected benchmark-run p95 <= ${PERFORMANCE_BUDGETS.benchmarkRunP95Ms}ms, received ${measurements.benchmarkRun.p95Ms}ms.`,
    );
  }

  if (measurements.artifactExport.p95Ms > PERFORMANCE_BUDGETS.artifactExportP95Ms) {
    violations.push(
      `Expected artifact-export p95 <= ${PERFORMANCE_BUDGETS.artifactExportP95Ms}ms, received ${measurements.artifactExport.p95Ms}ms.`,
    );
  }

  if (measurements.heapDeltaKiB > PERFORMANCE_BUDGETS.heapDeltaKiB) {
    violations.push(
      `Expected heap delta <= ${PERFORMANCE_BUDGETS.heapDeltaKiB}KiB, received ${measurements.heapDeltaKiB}KiB.`,
    );
  }

  for (const [label, observation] of Object.entries(stability)) {
    if (!observation.consistent) {
      violations.push(`Expected ${label} stability to remain consistent across samples.`);
    }
  }

  return violations;
}

export function buildArtifact(
  options: Pick<BenchmarkOptions, "baselinePath" | "sampleSize" | "warmupIterations">,
  measurements: Schema.Schema.Type<typeof PerformanceBudgetMeasurementsSchema>,
  stability: Schema.Schema.Type<typeof PerformanceBudgetStabilitySchema>,
  baseline: PerformanceBudgetArtifact | undefined,
) {
  const comparison = buildComparison(options, DEFAULT_PROFILE, measurements, baseline);
  const violations = buildViolations(measurements, stability);

  return Schema.decodeUnknownSync(PerformanceBudgetArtifactSchema)({
    benchmark: "e8-performance-budget",
    benchmarkId: BENCHMARK_ID,
    generatedAt: FIXED_GENERATED_AT,
    environment: {
      bun: process.versions.bun,
      platform: process.platform,
      arch: process.arch,
    },
    sampleSize: options.sampleSize,
    warmupIterations: options.warmupIterations,
    profile: DEFAULT_PROFILE,
    budgets: PERFORMANCE_BUDGETS,
    measurements,
    stability,
    comparison,
    violations,
    status: violations.length === 0 ? "pass" : "fail",
  });
}

export async function runBenchmark(args: readonly string[]) {
  const options = parseOptions(args);
  const baseline = await readBaseline(options.baselinePath);

  const startedHeap = process.memoryUsage().heapUsed;
  const measurements = Schema.decodeUnknownSync(PerformanceBudgetMeasurementsSchema)({
    workspaceDoctor: await measureEffect(
      options.sampleSize,
      options.warmupIterations,
      DEFAULT_PROFILE.workspaceRunsPerSample,
      () => Effect.runPromise(runWorkspaceDoctor()),
    ),
    workspaceConfig: await measureEffect(
      options.sampleSize,
      options.warmupIterations,
      DEFAULT_PROFILE.workspaceRunsPerSample,
      () => Effect.runPromise(showWorkspaceConfig()),
    ),
    capabilitySlice: await measureEffect(
      options.sampleSize,
      options.warmupIterations,
      DEFAULT_PROFILE.capabilitySliceRunsPerSample,
      () => Effect.runPromise(runE8CapabilitySlice()),
    ),
    benchmarkRun: await measureEffect(
      options.sampleSize,
      options.warmupIterations,
      DEFAULT_PROFILE.benchmarkRunsPerSample,
      () => Effect.runPromise(runBenchmarkOperation()),
    ),
    artifactExport: await measureEffect(
      options.sampleSize,
      options.warmupIterations,
      DEFAULT_PROFILE.artifactExportsPerSample,
      () => Effect.runPromise(runArtifactExportOperation()),
    ),
    heapDeltaKiB: roundToThree(Math.max(0, process.memoryUsage().heapUsed - startedHeap) / 1024),
  });

  const stability = buildStability({
    workspaceDoctor: await Promise.all(
      Array.from({ length: options.sampleSize }, () => runWorkspaceDoctorObservation()),
    ),
    workspaceConfig: await Promise.all(
      Array.from({ length: options.sampleSize }, () => runWorkspaceConfigObservation()),
    ),
    capabilitySlice: await Promise.all(
      Array.from({ length: options.sampleSize }, () => runCapabilitySliceObservation()),
    ),
    benchmarkRun: await Promise.all(
      Array.from({ length: options.sampleSize }, () => runBenchmarkObservation()),
    ),
    artifactExport: await Promise.all(
      Array.from({ length: options.sampleSize }, () => runArtifactExportObservation()),
    ),
  });

  const artifact = buildArtifact(options, measurements, stability, baseline);
  if (options.artifactPath !== undefined) {
    await persistArtifact(options.artifactPath, artifact);
  }
  return artifact;
}

if (import.meta.main) {
  const artifact = await runBenchmark(process.argv.slice(2));
  console.log(JSON.stringify(artifact, null, 2));
  if (artifact.status === "fail") {
    process.exitCode = 1;
  }
}
