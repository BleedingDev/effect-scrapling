import { Effect, Schema } from "effect";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import { ParserFailure } from "./tagged-errors.ts";

const NonNegativeFiniteSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

export const BenchmarkSummarySchema = Schema.Struct({
  samples: PositiveIntSchema,
  minMs: Schema.Finite,
  meanMs: Schema.Finite,
  p95Ms: Schema.Finite,
  maxMs: Schema.Finite,
});

export const PerformanceBudgetProfileSchema = Schema.Struct({
  caseCount: PositiveIntSchema,
  packCount: PositiveIntSchema,
});

export const PerformanceBudgetPolicySchema = Schema.Struct({
  baselineCorpusP95Ms: PositiveIntSchema,
  incumbentComparisonP95Ms: PositiveIntSchema,
  heapDeltaKiB: PositiveIntSchema,
});

export const PerformanceBudgetMeasurementsSchema = Schema.Struct({
  baselineCorpus: BenchmarkSummarySchema,
  incumbentComparison: BenchmarkSummarySchema,
  heapDeltaKiB: NonNegativeFiniteSchema,
});

const PerformanceBudgetComparisonSchema = Schema.Struct({
  baselinePath: Schema.NullOr(Schema.String),
  comparable: Schema.Boolean,
  incompatibleReason: Schema.NullOr(NonEmptyStringSchema),
  deltas: Schema.Struct({
    baselineCorpusP95Ms: Schema.NullOr(Schema.Finite),
    incumbentComparisonP95Ms: Schema.NullOr(Schema.Finite),
    heapDeltaKiB: Schema.NullOr(Schema.Finite),
  }),
});

export const PerformanceBudgetArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e7-performance-budget"),
  benchmarkId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
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
  comparison: PerformanceBudgetComparisonSchema,
  violations: Schema.Array(Schema.String),
  status: Schema.Literals(["pass", "fail"] as const),
});

const PerformanceBudgetInputSchema = Schema.Struct({
  benchmarkId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  environment: Schema.Struct({
    bun: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
  }),
  sampleSize: PositiveIntSchema,
  warmupIterations: NonNegativeIntSchema,
  profile: PerformanceBudgetProfileSchema,
  policy: PerformanceBudgetPolicySchema,
  measurements: PerformanceBudgetMeasurementsSchema,
  baselinePath: Schema.optional(Schema.String),
  baseline: Schema.optional(PerformanceBudgetArtifactSchema),
});

export type BenchmarkSummary = Schema.Schema.Type<typeof BenchmarkSummarySchema>;
export type PerformanceBudgetProfile = Schema.Schema.Type<typeof PerformanceBudgetProfileSchema>;
export type PerformanceBudgetPolicy = Schema.Schema.Type<typeof PerformanceBudgetPolicySchema>;
export type PerformanceBudgetMeasurements = Schema.Schema.Type<
  typeof PerformanceBudgetMeasurementsSchema
>;
export type PerformanceBudgetArtifact = Schema.Schema.Type<typeof PerformanceBudgetArtifactSchema>;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

export function roundToThree(value: number) {
  return Number(value.toFixed(3));
}

export function percentile95(values: readonly number[]) {
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

function sameProfile(left: PerformanceBudgetProfile, right: PerformanceBudgetProfile) {
  return left.caseCount === right.caseCount && left.packCount === right.packCount;
}

export function buildIncompatibleBaselineReason(
  options: Pick<PerformanceBudgetArtifact, "sampleSize" | "warmupIterations">,
  profile: PerformanceBudgetProfile,
  baseline: PerformanceBudgetArtifact,
) {
  if (baseline.sampleSize !== options.sampleSize) {
    return `Expected baseline sampleSize ${options.sampleSize}, received ${baseline.sampleSize}.`;
  }

  if (baseline.warmupIterations !== options.warmupIterations) {
    return `Expected baseline warmupIterations ${options.warmupIterations}, received ${baseline.warmupIterations}.`;
  }

  if (!sameProfile(baseline.profile, profile)) {
    return "Expected the baseline workload profile to match the current benchmark workload profile.";
  }

  return null;
}

function buildComparison(
  input: {
    readonly baselinePath?: string;
    readonly sampleSize: number;
    readonly warmupIterations: number;
  },
  profile: PerformanceBudgetProfile,
  measurements: PerformanceBudgetMeasurements,
  baseline: PerformanceBudgetArtifact | undefined,
) {
  const incompatibleReason =
    baseline === undefined ? null : buildIncompatibleBaselineReason(input, profile, baseline);
  const comparable = baseline !== undefined && incompatibleReason === null;

  return Schema.decodeUnknownSync(PerformanceBudgetComparisonSchema)({
    baselinePath: input.baselinePath ?? null,
    comparable,
    incompatibleReason,
    deltas: {
      baselineCorpusP95Ms:
        comparable && baseline !== undefined
          ? roundToThree(
              measurements.baselineCorpus.p95Ms - baseline.measurements.baselineCorpus.p95Ms,
            )
          : null,
      incumbentComparisonP95Ms:
        comparable && baseline !== undefined
          ? roundToThree(
              measurements.incumbentComparison.p95Ms -
                baseline.measurements.incumbentComparison.p95Ms,
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
  measurements: PerformanceBudgetMeasurements,
  policy: PerformanceBudgetPolicy,
) {
  const violations = new Array<string>();

  if (measurements.baselineCorpus.p95Ms > policy.baselineCorpusP95Ms) {
    violations.push(
      `Expected baseline-corpus p95 <= ${policy.baselineCorpusP95Ms}ms, received ${measurements.baselineCorpus.p95Ms}ms.`,
    );
  }

  if (measurements.incumbentComparison.p95Ms > policy.incumbentComparisonP95Ms) {
    violations.push(
      `Expected incumbent-comparison p95 <= ${policy.incumbentComparisonP95Ms}ms, received ${measurements.incumbentComparison.p95Ms}ms.`,
    );
  }

  if (measurements.heapDeltaKiB > policy.heapDeltaKiB) {
    violations.push(
      `Expected heap delta <= ${policy.heapDeltaKiB}KiB, received ${measurements.heapDeltaKiB}KiB.`,
    );
  }

  return violations;
}

export function evaluatePerformanceBudget(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(PerformanceBudgetInputSchema)(input),
      catch: (cause) =>
        new ParserFailure({
          message: readCauseMessage(
            cause,
            "Failed to decode E7 performance budget input through shared contracts.",
          ),
        }),
    });
    const comparison = buildComparison(
      {
        sampleSize: decoded.sampleSize,
        warmupIterations: decoded.warmupIterations,
        ...(decoded.baselinePath === undefined ? {} : { baselinePath: decoded.baselinePath }),
      },
      decoded.profile,
      decoded.measurements,
      decoded.baseline,
    );
    const violations = buildViolations(decoded.measurements, decoded.policy);

    return Schema.decodeUnknownSync(PerformanceBudgetArtifactSchema)({
      benchmark: "e7-performance-budget",
      benchmarkId: decoded.benchmarkId,
      generatedAt: decoded.generatedAt,
      environment: decoded.environment,
      sampleSize: decoded.sampleSize,
      warmupIterations: decoded.warmupIterations,
      profile: decoded.profile,
      budgets: decoded.policy,
      measurements: decoded.measurements,
      comparison,
      violations,
      status: violations.length === 0 ? "pass" : "fail",
    });
  });
}
