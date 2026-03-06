#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema, SchemaGetter } from "effect";
import {
  ArtifactMetadataRecordSchema,
  CoreErrorEnvelopeSchema,
  PackPromotionDecisionSchema,
  QualityVerdictSchema,
  RunCheckpointSchema,
  RunExecutionConfigSchema,
  RunPlanSchema,
  RunStatsSchema,
  SnapshotDiffSchema,
  SnapshotSchema,
  StorageLocatorSchema,
} from "@effect-scrapling/foundation-core";
import { runE1CapabilitySlice } from "../../examples/e1-capability-slice.ts";

const DEFAULT_SAMPLE_SIZE = 12;
const DEFAULT_WARMUP_ITERATIONS = 3;
const ARTIFACTS_SCHEMA = Schema.Array(ArtifactMetadataRecordSchema);
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

const PERFORMANCE_BUDGETS = {
  capabilitySliceP95Ms: 50,
  contractRoundtripP95Ms: 10,
  heapDeltaKiB: 16_384,
} as const;

const BenchmarkSummarySchema = Schema.Struct({
  samples: Schema.Int.check(Schema.isGreaterThan(0)),
  minMs: Schema.Finite,
  meanMs: Schema.Finite,
  p95Ms: Schema.Finite,
  maxMs: Schema.Finite,
});

const BenchmarkArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e1-performance-budget"),
  generatedAt: Schema.String,
  environment: Schema.Struct({
    bun: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
  }),
  sampleSize: Schema.Int.check(Schema.isGreaterThan(0)),
  warmupIterations: Schema.Int.check(Schema.isGreaterThan(0)),
  budgets: Schema.Struct({
    capabilitySliceP95Ms: Schema.Int.check(Schema.isGreaterThan(0)),
    contractRoundtripP95Ms: Schema.Int.check(Schema.isGreaterThan(0)),
    heapDeltaKiB: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
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

const ContractRoundtripPayloadSchema = Schema.Struct({
  resolvedConfig: RunExecutionConfigSchema,
  plan: RunPlanSchema,
  checkpoint: RunCheckpointSchema,
  stats: RunStatsSchema,
  snapshot: SnapshotSchema,
  diff: SnapshotDiffSchema,
  verdict: QualityVerdictSchema,
  decision: PackPromotionDecisionSchema,
  exportedLocator: StorageLocatorSchema,
  errorEnvelope: CoreErrorEnvelopeSchema,
  artifacts: ARTIFACTS_SCHEMA,
});

function decodePositiveIntegerOption(rawValue: string | undefined, fallback: number) {
  if (rawValue === undefined) {
    return fallback;
  }

  return Schema.decodeUnknownSync(PositiveIntArgumentSchema)(rawValue);
}

function parseOptions(args: readonly string[]) {
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

function roundToThree(value: number) {
  return Number.parseFloat(value.toFixed(3));
}

function summarizeMeasurements(values: readonly number[]) {
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
  effectFactory: () => Effect.Effect<unknown, never, never>,
) {
  for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
    await Effect.runPromise(effectFactory());
  }

  const values: number[] = [];
  for (let iteration = 0; iteration < sampleSize; iteration += 1) {
    const startedAt = performance.now();
    await Effect.runPromise(effectFactory());
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

function buildArtifact(
  options: ReturnType<typeof parseOptions>,
  measurements: {
    readonly capabilitySlice: Schema.Schema.Type<typeof BenchmarkSummarySchema>;
    readonly contractRoundtrip: Schema.Schema.Type<typeof BenchmarkSummarySchema>;
    readonly heapDeltaKiB: number;
  },
  baseline: Schema.Schema.Type<typeof BenchmarkArtifactSchema> | undefined,
) {
  const status =
    measurements.capabilitySlice.p95Ms <= PERFORMANCE_BUDGETS.capabilitySliceP95Ms &&
    measurements.contractRoundtrip.p95Ms <= PERFORMANCE_BUDGETS.contractRoundtripP95Ms &&
    measurements.heapDeltaKiB <= PERFORMANCE_BUDGETS.heapDeltaKiB
      ? "pass"
      : "fail";

  return Schema.decodeUnknownSync(BenchmarkArtifactSchema)({
    benchmark: "e1-performance-budget",
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
        contractRoundtripP95Ms: baseline
          ? roundToThree(
              measurements.contractRoundtrip.p95Ms - baseline.measurements.contractRoundtrip.p95Ms,
            )
          : null,
        heapDeltaKiB: baseline
          ? roundToThree(measurements.heapDeltaKiB - baseline.measurements.heapDeltaKiB)
          : null,
      },
    },
    status,
  });
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const baseline = await readBaseline(options.baselinePath);
  const heapStart = process.memoryUsage().heapUsed;

  const capabilitySlice = await measureEffect(options.sampleSize, options.warmupIterations, () =>
    runE1CapabilitySlice().pipe(Effect.orDie),
  );
  const samplePayload = await Effect.runPromise(runE1CapabilitySlice());
  const contractRoundtrip = await measureEffect(options.sampleSize, options.warmupIterations, () =>
    Effect.sync(() => {
      const contractPayload = Schema.decodeUnknownSync(ContractRoundtripPayloadSchema)({
        resolvedConfig: samplePayload.resolvedConfig,
        plan: samplePayload.plan,
        checkpoint: samplePayload.checkpoint,
        stats: samplePayload.stats,
        snapshot: samplePayload.snapshot,
        diff: samplePayload.diff,
        verdict: samplePayload.verdict,
        decision: samplePayload.decision,
        exportedLocator: samplePayload.exportedLocator,
        errorEnvelope: samplePayload.errorEnvelope,
        artifacts: samplePayload.artifacts,
      });

      Schema.encodeSync(ContractRoundtripPayloadSchema)(contractPayload);
    }),
  );
  const heapDeltaKiB = roundToThree((process.memoryUsage().heapUsed - heapStart) / 1024);

  const artifact = buildArtifact(
    options,
    {
      capabilitySlice,
      contractRoundtrip,
      heapDeltaKiB,
    },
    baseline,
  );

  if (options.artifactPath !== undefined) {
    await mkdir(dirname(options.artifactPath), { recursive: true });
    await writeFile(options.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(artifact, null, 2));

  if (artifact.status !== "pass") {
    process.exitCode = 1;
  }
}

await main();
