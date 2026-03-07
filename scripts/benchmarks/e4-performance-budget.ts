#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Logger, Schema, SchemaGetter } from "effect";
import { runE4CapabilitySlice } from "../../examples/e4-capability-slice.ts";
import {
  BrowserSoakLoadArtifactSchema,
  DEFAULT_CONCURRENCY,
  DEFAULT_ROUNDS,
  DEFAULT_WARMUP_ITERATIONS as DEFAULT_SOAK_WARMUP_ITERATIONS,
  runSoakLoadSuite,
} from "./e4-browser-soak-load.ts";

export const DEFAULT_SAMPLE_SIZE = 12;
export const DEFAULT_WARMUP_ITERATIONS = 3;
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
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

export const PERFORMANCE_BUDGETS = {
  capabilitySliceP95Ms: 40,
  soakRoundDurationP95Ms: 40,
  minimumThroughputRunsPerSecondFloor: 50,
  minimumThroughputRunsPerSecondPerConcurrency: 25,
  heapDeltaKiB: 16_384,
  maxPeakOpenBrowsers: 1,
  maxFinalOpenBrowsers: 0,
  maxFinalOpenContexts: 0,
  maxFinalOpenPages: 0,
  maxLeakAlarms: 0,
  maxCrashTelemetry: 0,
} as const;

export const BenchmarkSummarySchema = Schema.Struct({
  samples: Schema.Int.check(Schema.isGreaterThan(0)),
  minMs: Schema.Finite,
  meanMs: Schema.Finite,
  p95Ms: Schema.Finite,
  maxMs: Schema.Finite,
});

export const PerformanceBudgetsSchema = Schema.Struct({
  capabilitySliceP95Ms: Schema.Int.check(Schema.isGreaterThan(0)),
  soakRoundDurationP95Ms: Schema.Int.check(Schema.isGreaterThan(0)),
  minimumThroughputRunsPerSecond: Schema.Int.check(Schema.isGreaterThan(0)),
  heapDeltaKiB: Schema.Int.check(Schema.isGreaterThan(0)),
  maxPeakOpenBrowsers: NonNegativeIntSchema,
  maxPeakOpenContexts: Schema.Int.check(Schema.isGreaterThan(0)),
  maxPeakOpenPages: Schema.Int.check(Schema.isGreaterThan(0)),
  maxFinalOpenBrowsers: NonNegativeIntSchema,
  maxFinalOpenContexts: NonNegativeIntSchema,
  maxFinalOpenPages: NonNegativeIntSchema,
  maxLeakAlarms: NonNegativeIntSchema,
  maxCrashTelemetry: NonNegativeIntSchema,
});

export const BenchmarkArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e4-performance-budget"),
  generatedAt: Schema.String,
  environment: Schema.Struct({
    bun: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
  }),
  sampleSize: Schema.Int.check(Schema.isGreaterThan(0)),
  warmupIterations: NonNegativeIntSchema,
  soakRounds: Schema.Int.check(Schema.isGreaterThan(0)),
  soakConcurrency: Schema.Int.check(Schema.isGreaterThan(0)),
  soakWarmupIterations: NonNegativeIntSchema,
  budgets: PerformanceBudgetsSchema,
  measurements: Schema.Struct({
    capabilitySlice: BenchmarkSummarySchema,
    soakRoundDurationMs: BenchmarkSummarySchema,
    soakSteadyStateDurationMs: Schema.Finite,
    throughputRunsPerSecond: Schema.Finite,
    heapDeltaKiB: Schema.Finite,
  }),
  resources: Schema.Struct({
    captures: BrowserSoakLoadArtifactSchema.fields.captures,
    peaks: BrowserSoakLoadArtifactSchema.fields.peaks,
    finalSnapshot: BrowserSoakLoadArtifactSchema.fields.finalSnapshot,
    alarms: BrowserSoakLoadArtifactSchema.fields.alarms,
    crashTelemetry: BrowserSoakLoadArtifactSchema.fields.crashTelemetry,
  }),
  comparison: Schema.Struct({
    baselinePath: Schema.NullOr(Schema.String),
    deltas: Schema.Struct({
      capabilitySliceP95Ms: Schema.NullOr(Schema.Finite),
      soakRoundDurationP95Ms: Schema.NullOr(Schema.Finite),
      throughputRunsPerSecond: Schema.NullOr(Schema.Finite),
      heapDeltaKiB: Schema.NullOr(Schema.Finite),
    }),
  }),
  violations: Schema.Array(Schema.String),
  status: Schema.Literals(["pass", "fail"] as const),
});

export type BenchmarkSummary = Schema.Schema.Type<typeof BenchmarkSummarySchema>;
export type PerformanceBudgets = Schema.Schema.Type<typeof PerformanceBudgetsSchema>;
export type BenchmarkArtifact = Schema.Schema.Type<typeof BenchmarkArtifactSchema>;
export type BrowserSoakLoadArtifact = Schema.Schema.Type<typeof BrowserSoakLoadArtifactSchema>;

const quietLoggers = new Set<Logger.Logger<unknown, unknown>>();

function decodePositiveIntegerOption(rawValue: string | undefined, fallback: number) {
  if (rawValue === undefined) {
    return fallback;
  }

  return Schema.decodeUnknownSync(PositiveIntArgumentSchema)(rawValue);
}

function decodeNonNegativeIntegerOption(rawValue: string | undefined, fallback: number) {
  if (rawValue === undefined) {
    return fallback;
  }

  return Schema.decodeUnknownSync(NonNegativeIntArgumentSchema)(rawValue);
}

export function parseOptions(args: readonly string[]) {
  let artifactPath: string | undefined;
  let baselinePath: string | undefined;
  let sampleSize = DEFAULT_SAMPLE_SIZE;
  let warmupIterations = DEFAULT_WARMUP_ITERATIONS;
  let rounds = DEFAULT_ROUNDS;
  let concurrency = DEFAULT_CONCURRENCY;
  let soakWarmupIterations = DEFAULT_SOAK_WARMUP_ITERATIONS;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--artifact") {
      artifactPath = args[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--baseline") {
      baselinePath = args[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--sample-size") {
      sampleSize = decodePositiveIntegerOption(args[index + 1], DEFAULT_SAMPLE_SIZE);
      index += 1;
      continue;
    }

    if (argument === "--warmup") {
      warmupIterations = decodeNonNegativeIntegerOption(args[index + 1], DEFAULT_WARMUP_ITERATIONS);
      index += 1;
      continue;
    }

    if (argument === "--rounds") {
      rounds = decodePositiveIntegerOption(args[index + 1], DEFAULT_ROUNDS);
      index += 1;
      continue;
    }

    if (argument === "--concurrency") {
      concurrency = decodePositiveIntegerOption(args[index + 1], DEFAULT_CONCURRENCY);
      index += 1;
      continue;
    }

    if (argument === "--soak-warmup") {
      soakWarmupIterations = decodeNonNegativeIntegerOption(
        args[index + 1],
        DEFAULT_SOAK_WARMUP_ITERATIONS,
      );
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    ...(artifactPath !== undefined ? { artifactPath: resolve(artifactPath) } : {}),
    ...(baselinePath !== undefined ? { baselinePath: resolve(baselinePath) } : {}),
    sampleSize,
    warmupIterations,
    rounds,
    concurrency,
    soakWarmupIterations,
  };
}

export type BenchmarkOptions = ReturnType<typeof parseOptions>;

export function percentile95(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

export function roundToThree(value: number) {
  return Number.parseFloat(value.toFixed(3));
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

export async function measureEffect(
  sampleSize: number,
  warmupIterations: number,
  effectFactory: () => ReturnType<typeof runE4CapabilitySlice>,
) {
  for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
    await Effect.runPromise(
      effectFactory().pipe(Effect.provideService(Logger.CurrentLoggers, quietLoggers)),
    );
  }

  const values = new Array<number>();

  for (let iteration = 0; iteration < sampleSize; iteration += 1) {
    const startedAt = performance.now();
    await Effect.runPromise(
      effectFactory().pipe(Effect.provideService(Logger.CurrentLoggers, quietLoggers)),
    );
    values.push(performance.now() - startedAt);
  }

  return summarizeMeasurements(values);
}

export async function readBaseline(path: string | undefined) {
  if (path === undefined) {
    return undefined;
  }

  const baseline = await readFile(path, "utf8");
  return Schema.decodeUnknownSync(BenchmarkArtifactSchema)(JSON.parse(baseline));
}

export function buildPerformanceBudgets(concurrency: number) {
  return Schema.decodeUnknownSync(PerformanceBudgetsSchema)({
    capabilitySliceP95Ms: PERFORMANCE_BUDGETS.capabilitySliceP95Ms,
    soakRoundDurationP95Ms: PERFORMANCE_BUDGETS.soakRoundDurationP95Ms,
    minimumThroughputRunsPerSecond: Math.max(
      PERFORMANCE_BUDGETS.minimumThroughputRunsPerSecondFloor,
      PERFORMANCE_BUDGETS.minimumThroughputRunsPerSecondPerConcurrency * concurrency,
    ),
    heapDeltaKiB: PERFORMANCE_BUDGETS.heapDeltaKiB,
    maxPeakOpenBrowsers: PERFORMANCE_BUDGETS.maxPeakOpenBrowsers,
    maxPeakOpenContexts: concurrency,
    maxPeakOpenPages: concurrency,
    maxFinalOpenBrowsers: PERFORMANCE_BUDGETS.maxFinalOpenBrowsers,
    maxFinalOpenContexts: PERFORMANCE_BUDGETS.maxFinalOpenContexts,
    maxFinalOpenPages: PERFORMANCE_BUDGETS.maxFinalOpenPages,
    maxLeakAlarms: PERFORMANCE_BUDGETS.maxLeakAlarms,
    maxCrashTelemetry: PERFORMANCE_BUDGETS.maxCrashTelemetry,
  });
}

export function calculateSteadyStateDurationMs(soakArtifact: BrowserSoakLoadArtifact) {
  return roundToThree(soakArtifact.measurements.roundDurationMs.meanMs * soakArtifact.rounds);
}

export function calculateThroughputRunsPerSecond(
  soakArtifact: BrowserSoakLoadArtifact,
  steadyStateDurationMs: number,
) {
  if (steadyStateDurationMs <= 0) {
    return 0;
  }

  return roundToThree((soakArtifact.captures.totalRuns * 1_000) / steadyStateDurationMs);
}

function collectViolations(input: {
  readonly budgets: PerformanceBudgets;
  readonly capabilitySlice: BenchmarkSummary;
  readonly soakArtifact: BrowserSoakLoadArtifact;
  readonly throughputRunsPerSecond: number;
  readonly heapDeltaKiB: number;
}) {
  const violations = [...input.soakArtifact.violations];

  if (input.capabilitySlice.p95Ms > input.budgets.capabilitySliceP95Ms) {
    violations.push(
      `Expected E4 capability-slice p95 <= ${input.budgets.capabilitySliceP95Ms}ms, received ${input.capabilitySlice.p95Ms}ms.`,
    );
  }

  if (
    input.soakArtifact.measurements.roundDurationMs.p95Ms > input.budgets.soakRoundDurationP95Ms
  ) {
    violations.push(
      `Expected E4 soak round p95 <= ${input.budgets.soakRoundDurationP95Ms}ms, received ${input.soakArtifact.measurements.roundDurationMs.p95Ms}ms.`,
    );
  }

  if (input.throughputRunsPerSecond < input.budgets.minimumThroughputRunsPerSecond) {
    violations.push(
      `Expected E4 steady-state throughput >= ${input.budgets.minimumThroughputRunsPerSecond} runs/s, received ${input.throughputRunsPerSecond} runs/s.`,
    );
  }

  if (input.heapDeltaKiB > input.budgets.heapDeltaKiB) {
    violations.push(
      `Expected heap delta <= ${input.budgets.heapDeltaKiB} KiB, received ${input.heapDeltaKiB} KiB.`,
    );
  }

  return violations;
}

export function buildArtifact(
  options: BenchmarkOptions,
  measurements: {
    readonly capabilitySlice: BenchmarkSummary;
    readonly soakArtifact: BrowserSoakLoadArtifact;
    readonly soakSteadyStateDurationMs: number;
    readonly throughputRunsPerSecond: number;
    readonly heapDeltaKiB: number;
  },
  baseline: BenchmarkArtifact | undefined,
) {
  const budgets = buildPerformanceBudgets(options.concurrency);
  const violations = collectViolations({
    budgets,
    capabilitySlice: measurements.capabilitySlice,
    soakArtifact: measurements.soakArtifact,
    throughputRunsPerSecond: measurements.throughputRunsPerSecond,
    heapDeltaKiB: measurements.heapDeltaKiB,
  });

  return Schema.decodeUnknownSync(BenchmarkArtifactSchema)({
    benchmark: "e4-performance-budget",
    generatedAt: new Date().toISOString(),
    environment: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    sampleSize: options.sampleSize,
    warmupIterations: options.warmupIterations,
    soakRounds: options.rounds,
    soakConcurrency: options.concurrency,
    soakWarmupIterations: options.soakWarmupIterations,
    budgets,
    measurements: {
      capabilitySlice: measurements.capabilitySlice,
      soakRoundDurationMs: measurements.soakArtifact.measurements.roundDurationMs,
      soakSteadyStateDurationMs: measurements.soakSteadyStateDurationMs,
      throughputRunsPerSecond: measurements.throughputRunsPerSecond,
      heapDeltaKiB: measurements.heapDeltaKiB,
    },
    resources: {
      captures: measurements.soakArtifact.captures,
      peaks: measurements.soakArtifact.peaks,
      finalSnapshot: measurements.soakArtifact.finalSnapshot,
      alarms: measurements.soakArtifact.alarms,
      crashTelemetry: measurements.soakArtifact.crashTelemetry,
    },
    comparison: {
      baselinePath: options.baselinePath ?? null,
      deltas: {
        capabilitySliceP95Ms: baseline
          ? roundToThree(
              measurements.capabilitySlice.p95Ms - baseline.measurements.capabilitySlice.p95Ms,
            )
          : null,
        soakRoundDurationP95Ms: baseline
          ? roundToThree(
              measurements.soakArtifact.measurements.roundDurationMs.p95Ms -
                baseline.measurements.soakRoundDurationMs.p95Ms,
            )
          : null,
        throughputRunsPerSecond: baseline
          ? roundToThree(
              measurements.throughputRunsPerSecond - baseline.measurements.throughputRunsPerSecond,
            )
          : null,
        heapDeltaKiB: baseline
          ? roundToThree(measurements.heapDeltaKiB - baseline.measurements.heapDeltaKiB)
          : null,
      },
    },
    violations,
    status: violations.length === 0 ? "pass" : "fail",
  });
}

export async function writeArtifact(path: string | undefined, artifact: unknown) {
  if (path === undefined) {
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function collectMeasurements(options: BenchmarkOptions) {
  const heapStart = process.memoryUsage().heapUsed;
  const capabilitySlice = await measureEffect(options.sampleSize, options.warmupIterations, () =>
    runE4CapabilitySlice(),
  );
  const soakArtifact = await runSoakLoadSuite({
    rounds: options.rounds,
    concurrency: options.concurrency,
    warmupIterations: options.soakWarmupIterations,
  });
  const soakSteadyStateDurationMs = calculateSteadyStateDurationMs(soakArtifact);
  const throughputRunsPerSecond = calculateThroughputRunsPerSecond(
    soakArtifact,
    soakSteadyStateDurationMs,
  );
  const heapDeltaKiB = roundToThree((process.memoryUsage().heapUsed - heapStart) / 1_024);

  return {
    capabilitySlice,
    soakArtifact,
    soakSteadyStateDurationMs,
    throughputRunsPerSecond,
    heapDeltaKiB,
  };
}

export async function runBenchmark(args: readonly string[] = Bun.argv.slice(2)) {
  const options = parseOptions(args);
  const baseline = await readBaseline(options.baselinePath);
  const measurements = await collectMeasurements(options);
  const artifact = buildArtifact(options, measurements, baseline);

  await writeArtifact(options.artifactPath, artifact);

  return artifact;
}

export async function main(args: readonly string[] = Bun.argv.slice(2)) {
  const artifact = await runBenchmark(args);
  console.log(JSON.stringify(artifact, null, 2));

  if (artifact.status !== "pass") {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
