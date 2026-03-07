#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Match, Schema, SchemaGetter } from "effect";
import { runE2CapabilitySlice } from "../../examples/e2-capability-slice.ts";
import {
  GoldenFixtureBankSchema,
  replayGoldenFixture,
} from "../../libs/foundation/core/src/golden-fixtures.ts";

const GOLDEN_FIXTURE_BANK_URL = new URL(
  "../../tests/fixtures/foundation-core-e2-golden-fixtures.json",
  import.meta.url,
);
const GOLDEN_FIXTURE_ID = "golden-product-relocated";
export const DEFAULT_SAMPLE_SIZE = 12;
export const DEFAULT_WARMUP_ITERATIONS = 3;

const PositiveIntFromString = Schema.FiniteFromString.check(Schema.isInt()).check(
  Schema.isGreaterThan(0),
);
const PositiveIntArgumentSchema = Schema.Trim.pipe(
  Schema.check(Schema.isPattern(/^\d+$/u)),
  Schema.decodeTo(PositiveIntFromString, {
    decode: SchemaGetter.passthrough(),
    encode: SchemaGetter.String(),
  }),
);

export const PERFORMANCE_BUDGETS = {
  capabilitySliceP95Ms: 75,
  goldenReplayP95Ms: 60,
  heapDeltaKiB: 16_384,
} as const;

export const BenchmarkSummarySchema = Schema.Struct({
  samples: Schema.Int.check(Schema.isGreaterThan(0)),
  minMs: Schema.Finite,
  meanMs: Schema.Finite,
  p95Ms: Schema.Finite,
  maxMs: Schema.Finite,
});

export const BenchmarkArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e2-performance-budget"),
  generatedAt: Schema.String,
  environment: Schema.Struct({
    bun: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
  }),
  sampleSize: Schema.Int.check(Schema.isGreaterThan(0)),
  warmupIterations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  budgets: Schema.Struct({
    capabilitySliceP95Ms: Schema.Int.check(Schema.isGreaterThan(0)),
    goldenReplayP95Ms: Schema.Int.check(Schema.isGreaterThan(0)),
    heapDeltaKiB: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  measurements: Schema.Struct({
    capabilitySlice: BenchmarkSummarySchema,
    goldenReplay: BenchmarkSummarySchema,
    heapDeltaKiB: Schema.Finite,
  }),
  comparison: Schema.Struct({
    baselinePath: Schema.NullOr(Schema.String),
    deltas: Schema.Struct({
      capabilitySliceP95Ms: Schema.NullOr(Schema.Finite),
      goldenReplayP95Ms: Schema.NullOr(Schema.Finite),
      heapDeltaKiB: Schema.NullOr(Schema.Finite),
    }),
  }),
  violations: Schema.Array(Schema.String),
  status: Schema.Literals(["pass", "fail"] as const),
});

export type BenchmarkArtifact = Schema.Schema.Type<typeof BenchmarkArtifactSchema>;

function decodePositiveIntegerOption(rawValue: string | undefined, fallback: number) {
  if (rawValue === undefined) {
    return fallback;
  }

  return Schema.decodeUnknownSync(PositiveIntArgumentSchema)(rawValue);
}

export function parseOptions(args: readonly string[]) {
  let artifactPath: string | undefined;
  let baselinePath: string | undefined;
  let sampleSize = DEFAULT_SAMPLE_SIZE;
  let warmupIterations = DEFAULT_WARMUP_ITERATIONS;

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
      warmupIterations = decodePositiveIntegerOption(args[index + 1], DEFAULT_WARMUP_ITERATIONS);
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
  };
}

function percentile95(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

export function roundToThree(value: number) {
  return Math.round(value * 1_000) / 1_000;
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

async function measureEffect(
  sampleSize: number,
  warmupIterations: number,
  effectFactory: () => Effect.Effect<unknown, unknown, never>,
) {
  for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
    await Effect.runPromise(effectFactory().pipe(Effect.orDie));
  }

  const values = new Array<number>();

  for (let iteration = 0; iteration < sampleSize; iteration += 1) {
    const startedAt = performance.now();
    await Effect.runPromise(effectFactory().pipe(Effect.orDie));
    values.push(performance.now() - startedAt);
  }

  return summarizeMeasurements(values);
}

async function readBaseline(path: string | undefined) {
  if (path === undefined) {
    return undefined;
  }

  const baseline = await readFile(path, "utf8");
  return Schema.decodeUnknownSync(BenchmarkArtifactSchema)(JSON.parse(baseline));
}

async function loadGoldenFixtureCase() {
  const bank = Schema.decodeUnknownSync(GoldenFixtureBankSchema)(
    await Bun.file(GOLDEN_FIXTURE_BANK_URL).json(),
  );
  const fixture = bank.find(({ fixtureId }) => fixtureId === GOLDEN_FIXTURE_ID);
  if (fixture === undefined) {
    throw new Error(`Could not find E2 golden fixture ${GOLDEN_FIXTURE_ID}.`);
  }

  return fixture;
}

function createViolations(measurements: BenchmarkArtifact["measurements"]) {
  const violations = new Array<string>();

  if (measurements.capabilitySlice.p95Ms > PERFORMANCE_BUDGETS.capabilitySliceP95Ms) {
    violations.push(
      `capability-slice p95 ${measurements.capabilitySlice.p95Ms}ms exceeded budget ${PERFORMANCE_BUDGETS.capabilitySliceP95Ms}ms`,
    );
  }

  if (measurements.goldenReplay.p95Ms > PERFORMANCE_BUDGETS.goldenReplayP95Ms) {
    violations.push(
      `golden-replay p95 ${measurements.goldenReplay.p95Ms}ms exceeded budget ${PERFORMANCE_BUDGETS.goldenReplayP95Ms}ms`,
    );
  }

  if (measurements.heapDeltaKiB > PERFORMANCE_BUDGETS.heapDeltaKiB) {
    violations.push(
      `heap delta ${measurements.heapDeltaKiB}KiB exceeded budget ${PERFORMANCE_BUDGETS.heapDeltaKiB}KiB`,
    );
  }

  return violations;
}

export function buildArtifact(
  options: ReturnType<typeof parseOptions>,
  measurements: BenchmarkArtifact["measurements"],
  baseline: BenchmarkArtifact | undefined,
) {
  const violations = createViolations(measurements);

  return Schema.decodeUnknownSync(BenchmarkArtifactSchema)({
    benchmark: "e2-performance-budget",
    generatedAt: new Date().toISOString(),
    environment: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    sampleSize: options.sampleSize,
    warmupIterations: options.warmupIterations,
    budgets: PERFORMANCE_BUDGETS,
    measurements,
    comparison: {
      baselinePath: options.baselinePath ?? null,
      deltas: {
        capabilitySliceP95Ms: baseline
          ? roundToThree(
              measurements.capabilitySlice.p95Ms - baseline.measurements.capabilitySlice.p95Ms,
            )
          : null,
        goldenReplayP95Ms: baseline
          ? roundToThree(measurements.goldenReplay.p95Ms - baseline.measurements.goldenReplay.p95Ms)
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

export async function runBenchmark(args: readonly string[]) {
  const options = parseOptions(args);
  const baseline = await readBaseline(options.baselinePath);
  const fixture = await loadGoldenFixtureCase();
  const heapStart = process.memoryUsage().heapUsed;
  const capabilitySlice = await measureEffect(options.sampleSize, options.warmupIterations, () =>
    runE2CapabilitySlice(),
  );
  const goldenReplay = await measureEffect(options.sampleSize, options.warmupIterations, () =>
    Effect.promise(async () => {
      const replay = await Effect.runPromise(replayGoldenFixture(fixture));
      return Match.value(replay).pipe(
        Match.when({ kind: "success" }, (success) => success),
        Match.when({ kind: "failure" }, ({ error }) => {
          throw new Error(
            `Expected E2 golden replay ${GOLDEN_FIXTURE_ID} to succeed, got ${error.code}: ${error.message}`,
          );
        }),
        Match.exhaustive,
      );
    }),
  );
  const heapDeltaKiB = roundToThree((process.memoryUsage().heapUsed - heapStart) / 1024);
  const artifact = buildArtifact(
    options,
    {
      capabilitySlice,
      goldenReplay,
      heapDeltaKiB,
    },
    baseline,
  );

  if (options.artifactPath !== undefined) {
    await mkdir(dirname(options.artifactPath), { recursive: true });
    await writeFile(options.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  }

  return artifact;
}

async function main() {
  const artifact = await runBenchmark(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  if (artifact.status === "fail") {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
