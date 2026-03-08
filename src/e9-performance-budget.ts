import { Effect, Schema } from "effect";
import { createDefaultE9RetailerCorpus } from "./e9-fixture-corpus.ts";
import {
  createDefaultE9ReferencePackValidationInput,
  runE9ReferencePackValidation,
} from "./e9-reference-pack-validation.ts";
import { runE9ScraplingParity } from "./e9-scrapling-parity.ts";
import { runE9HighFrictionCanary } from "./e9-high-friction-canary.ts";
import { runE9LaunchReadiness } from "./e9-launch-readiness.ts";

const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeNumberSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

const MeasurementSummarySchema = Schema.Struct({
  samples: PositiveIntSchema,
  minMs: NonNegativeNumberSchema,
  meanMs: NonNegativeNumberSchema,
  p95Ms: NonNegativeNumberSchema,
  maxMs: NonNegativeNumberSchema,
});

export const E9PerformanceBudgetPolicySchema = Schema.Struct({
  referencePackValidationP95Ms: NonNegativeNumberSchema,
  scraplingParityP95Ms: NonNegativeNumberSchema,
  highFrictionCanaryP95Ms: NonNegativeNumberSchema,
  launchReadinessP95Ms: NonNegativeNumberSchema,
  totalP95Ms: NonNegativeNumberSchema,
  heapDeltaKiB: NonNegativeNumberSchema,
});

export const E9PerformanceBudgetArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e9-performance-budget"),
  benchmarkId: Schema.String,
  generatedAt: Schema.String,
  sampleSize: PositiveIntSchema,
  warmupIterations: NonNegativeIntSchema,
  profile: Schema.Struct({
    caseCount: PositiveIntSchema,
    scenarioCount: PositiveIntSchema,
  }),
  policy: E9PerformanceBudgetPolicySchema,
  measurements: Schema.Struct({
    referencePackValidation: MeasurementSummarySchema,
    scraplingParity: MeasurementSummarySchema,
    highFrictionCanary: MeasurementSummarySchema,
    launchReadiness: MeasurementSummarySchema,
    total: MeasurementSummarySchema,
    heapDeltaKiB: NonNegativeNumberSchema,
  }),
  baselinePath: Schema.optional(Schema.String),
  deltas: Schema.optional(
    Schema.Struct({
      referencePackValidationP95Ms: Schema.Number,
      scraplingParityP95Ms: Schema.Number,
      highFrictionCanaryP95Ms: Schema.Number,
      launchReadinessP95Ms: Schema.Number,
      totalP95Ms: Schema.Number,
      heapDeltaKiB: Schema.Number,
    }),
  ),
  status: Schema.Literals(["pass", "fail"] as const),
});

export const E9_PERFORMANCE_BUDGETS = Schema.decodeUnknownSync(E9PerformanceBudgetPolicySchema)({
  referencePackValidationP95Ms: 500,
  scraplingParityP95Ms: 8_000,
  highFrictionCanaryP95Ms: 1_000,
  launchReadinessP95Ms: 500,
  totalP95Ms: 9_000,
  heapDeltaKiB: 131_072,
});

function roundToThree(value: number) {
  return Math.round(value * 1000) / 1000;
}

function summarizeMeasurements(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const minMs = sorted[0] ?? 0;
  const maxMs = sorted.at(-1) ?? 0;
  const meanMs = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const percentileIndex = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  const p95Ms = sorted[percentileIndex] ?? maxMs;

  return Schema.decodeUnknownSync(MeasurementSummarySchema)({
    samples: sorted.length,
    minMs: roundToThree(minMs),
    meanMs: roundToThree(meanMs),
    p95Ms: roundToThree(p95Ms),
    maxMs: roundToThree(maxMs),
  });
}

async function measure(
  sampleSize: number,
  warmupIterations: number,
  effectFactory: () => Promise<unknown>,
) {
  for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
    await effectFactory();
  }

  const samples = new Array<number>();
  for (let iteration = 0; iteration < sampleSize; iteration += 1) {
    const startedAt = performance.now();
    await effectFactory();
    samples.push(performance.now() - startedAt);
  }

  return summarizeMeasurements(samples);
}

export async function runE9PerformanceBudget(input: {
  readonly benchmarkId: string;
  readonly generatedAt: string;
  readonly sampleSize: number;
  readonly warmupIterations: number;
  readonly policy?: Schema.Schema.Type<typeof E9PerformanceBudgetPolicySchema>;
  readonly baselinePath?: string;
  readonly baseline?: Schema.Schema.Type<typeof E9PerformanceBudgetArtifactSchema>;
}) {
  const policy = input.policy ?? E9_PERFORMANCE_BUDGETS;
  const validationInput = await createDefaultE9ReferencePackValidationInput();
  const corpus = await createDefaultE9RetailerCorpus();
  const profile = {
    caseCount: corpus.length,
    scenarioCount: corpus.length,
  };

  const startedHeap = process.memoryUsage().heapUsed;
  const measurements = {
    referencePackValidation: await measure(input.sampleSize, input.warmupIterations, () =>
      Effect.runPromise(runE9ReferencePackValidation(validationInput)),
    ),
    scraplingParity: await measure(input.sampleSize, input.warmupIterations, () =>
      runE9ScraplingParity(),
    ),
    highFrictionCanary: await measure(input.sampleSize, input.warmupIterations, () =>
      runE9HighFrictionCanary(),
    ),
    launchReadiness: await measure(input.sampleSize, input.warmupIterations, () =>
      runE9LaunchReadiness(),
    ),
    total: await measure(input.sampleSize, input.warmupIterations, async () => {
      await Effect.runPromise(runE9ReferencePackValidation(validationInput));
      await runE9ScraplingParity();
      await runE9HighFrictionCanary();
      await runE9LaunchReadiness();
    }),
    heapDeltaKiB: roundToThree(Math.max(0, process.memoryUsage().heapUsed - startedHeap) / 1024),
  };

  const baselineComparable =
    input.baseline !== undefined &&
    input.baseline.profile.caseCount === profile.caseCount &&
    input.baseline.profile.scenarioCount === profile.scenarioCount &&
    input.baseline.sampleSize === input.sampleSize &&
    input.baseline.warmupIterations === input.warmupIterations;
  const deltas =
    !baselineComparable || input.baseline === undefined
      ? undefined
      : {
          referencePackValidationP95Ms: roundToThree(
            measurements.referencePackValidation.p95Ms -
              input.baseline.measurements.referencePackValidation.p95Ms,
          ),
          scraplingParityP95Ms: roundToThree(
            measurements.scraplingParity.p95Ms - input.baseline.measurements.scraplingParity.p95Ms,
          ),
          highFrictionCanaryP95Ms: roundToThree(
            measurements.highFrictionCanary.p95Ms -
              input.baseline.measurements.highFrictionCanary.p95Ms,
          ),
          launchReadinessP95Ms: roundToThree(
            measurements.launchReadiness.p95Ms - input.baseline.measurements.launchReadiness.p95Ms,
          ),
          totalP95Ms: roundToThree(
            measurements.total.p95Ms - input.baseline.measurements.total.p95Ms,
          ),
          heapDeltaKiB: roundToThree(
            measurements.heapDeltaKiB - input.baseline.measurements.heapDeltaKiB,
          ),
        };
  const status =
    measurements.referencePackValidation.p95Ms <= policy.referencePackValidationP95Ms &&
    measurements.scraplingParity.p95Ms <= policy.scraplingParityP95Ms &&
    measurements.highFrictionCanary.p95Ms <= policy.highFrictionCanaryP95Ms &&
    measurements.launchReadiness.p95Ms <= policy.launchReadinessP95Ms &&
    measurements.total.p95Ms <= policy.totalP95Ms &&
    measurements.heapDeltaKiB <= policy.heapDeltaKiB
      ? "pass"
      : "fail";

  return Schema.decodeUnknownSync(E9PerformanceBudgetArtifactSchema)({
    benchmark: "e9-performance-budget",
    benchmarkId: input.benchmarkId,
    generatedAt: input.generatedAt,
    sampleSize: input.sampleSize,
    warmupIterations: input.warmupIterations,
    profile,
    policy,
    measurements,
    ...(input.baselinePath === undefined ? {} : { baselinePath: input.baselinePath }),
    ...(deltas === undefined ? {} : { deltas }),
    status,
  });
}
