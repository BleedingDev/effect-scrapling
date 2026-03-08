import { Effect, Schema } from "effect";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import { ParserFailure } from "./tagged-errors.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const NonNegativeFiniteSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const SoakSuiteStatusSchema = Schema.Literals(["pass", "fail"] as const);

export class QualitySoakSample extends Schema.Class<QualitySoakSample>("QualitySoakSample")({
  iteration: PositiveIntSchema,
  baselineCorpusMs: NonNegativeFiniteSchema,
  incumbentComparisonMs: NonNegativeFiniteSchema,
  heapDeltaKiB: NonNegativeFiniteSchema,
  baselineFingerprint: NonEmptyStringSchema,
  comparisonFingerprint: NonEmptyStringSchema,
}) {}

const QualitySoakSamplesSchema = Schema.Array(QualitySoakSample).pipe(
  Schema.refine(
    (samples): samples is ReadonlyArray<QualitySoakSample> =>
      samples.length > 0 && samples.every((sample, index) => sample.iteration === index + 1),
    {
      message: "Expected deterministic quality soak samples with contiguous iteration numbers.",
    },
  ),
);

export class QualitySoakPolicy extends Schema.Class<QualitySoakPolicy>("QualitySoakPolicy")({
  maxBaselineCorpusGrowthMs: NonNegativeFiniteSchema,
  maxIncumbentComparisonGrowthMs: NonNegativeFiniteSchema,
  maxHeapGrowthKiB: NonNegativeFiniteSchema,
  maxConsecutiveHeapGrowth: NonNegativeIntSchema,
}) {}

export class QualitySoakStabilityReport extends Schema.Class<QualitySoakStabilityReport>(
  "QualitySoakStabilityReport",
)({
  baselineCorpusGrowthMs: NonNegativeFiniteSchema,
  incumbentComparisonGrowthMs: NonNegativeFiniteSchema,
  heapGrowthKiB: NonNegativeFiniteSchema,
  maxConsecutiveHeapGrowth: NonNegativeIntSchema,
  baselineFingerprintStable: Schema.Boolean,
  comparisonFingerprintStable: Schema.Boolean,
  unboundedGrowthDetected: Schema.Boolean,
}) {}

export class QualitySoakArtifact extends Schema.Class<QualitySoakArtifact>("QualitySoakArtifact")({
  benchmark: Schema.Literal("e7-soak-endurance-suite"),
  suiteId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  policy: QualitySoakPolicy,
  sampleCount: PositiveIntSchema,
  status: SoakSuiteStatusSchema,
  violations: Schema.Array(NonEmptyStringSchema),
  stability: QualitySoakStabilityReport,
  samples: QualitySoakSamplesSchema,
}) {}

const QualitySoakInputSchema = Schema.Struct({
  suiteId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  policy: Schema.optional(QualitySoakPolicy),
  samples: QualitySoakSamplesSchema,
});

const DefaultQualitySoakPolicy = Object.freeze({
  maxBaselineCorpusGrowthMs: 100,
  maxIncumbentComparisonGrowthMs: 200,
  maxHeapGrowthKiB: 4_096,
  maxConsecutiveHeapGrowth: 4,
});

export const QualitySoakSampleSchema = QualitySoakSample;
export const QualitySoakPolicySchema = QualitySoakPolicy;
export const QualitySoakStabilityReportSchema = QualitySoakStabilityReport;
export const QualitySoakArtifactSchema = QualitySoakArtifact;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function roundToThree(value: number) {
  return Number(value.toFixed(3));
}

function positiveGrowth(first: number, last: number) {
  return roundToThree(Math.max(0, last - first));
}

function countConsecutiveIncreases(values: ReadonlyArray<number>) {
  let longest = 0;
  let current = 0;
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const value = values[index];
    if (previous !== undefined && value !== undefined && value > previous) {
      current += 1;
      longest = Math.max(longest, current);
      continue;
    }

    current = 0;
  }

  return longest;
}

function resolvePolicy(policy: Schema.Schema.Type<typeof QualitySoakPolicySchema> | undefined) {
  return policy ?? Schema.decodeUnknownSync(QualitySoakPolicySchema)(DefaultQualitySoakPolicy);
}

function fingerprintStable(values: ReadonlyArray<string>) {
  return new Set(values).size === 1;
}

function buildStability(
  samples: ReadonlyArray<Schema.Schema.Type<typeof QualitySoakSampleSchema>>,
  policy: Schema.Schema.Type<typeof QualitySoakPolicySchema>,
) {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("Expected at least one soak sample.");
  }

  const baselineCorpusGrowthMs = positiveGrowth(first.baselineCorpusMs, last.baselineCorpusMs);
  const incumbentComparisonGrowthMs = positiveGrowth(
    first.incumbentComparisonMs,
    last.incumbentComparisonMs,
  );
  const heapGrowthKiB = positiveGrowth(first.heapDeltaKiB, last.heapDeltaKiB);
  const maxConsecutiveHeapGrowth = countConsecutiveIncreases(
    samples.map(({ heapDeltaKiB }) => heapDeltaKiB),
  );
  const baselineFingerprintStable = fingerprintStable(
    samples.map(({ baselineFingerprint }) => baselineFingerprint),
  );
  const comparisonFingerprintStable = fingerprintStable(
    samples.map(({ comparisonFingerprint }) => comparisonFingerprint),
  );
  const unboundedGrowthDetected =
    baselineCorpusGrowthMs > policy.maxBaselineCorpusGrowthMs ||
    incumbentComparisonGrowthMs > policy.maxIncumbentComparisonGrowthMs ||
    heapGrowthKiB > policy.maxHeapGrowthKiB ||
    maxConsecutiveHeapGrowth > policy.maxConsecutiveHeapGrowth;

  return Schema.decodeUnknownSync(QualitySoakStabilityReportSchema)({
    baselineCorpusGrowthMs,
    incumbentComparisonGrowthMs,
    heapGrowthKiB,
    maxConsecutiveHeapGrowth,
    baselineFingerprintStable,
    comparisonFingerprintStable,
    unboundedGrowthDetected,
  });
}

function buildViolations(
  stability: Schema.Schema.Type<typeof QualitySoakStabilityReportSchema>,
  policy: Schema.Schema.Type<typeof QualitySoakPolicySchema>,
) {
  const violations = new Array<string>();

  if (!stability.baselineFingerprintStable) {
    violations.push("Expected the soak suite baseline corpus fingerprint to remain stable.");
  }

  if (!stability.comparisonFingerprintStable) {
    violations.push("Expected the soak suite incumbent comparison fingerprint to remain stable.");
  }

  if (stability.baselineCorpusGrowthMs > policy.maxBaselineCorpusGrowthMs) {
    violations.push(
      `Expected baseline corpus growth <= ${policy.maxBaselineCorpusGrowthMs}ms, received ${stability.baselineCorpusGrowthMs}ms.`,
    );
  }

  if (stability.incumbentComparisonGrowthMs > policy.maxIncumbentComparisonGrowthMs) {
    violations.push(
      `Expected incumbent comparison growth <= ${policy.maxIncumbentComparisonGrowthMs}ms, received ${stability.incumbentComparisonGrowthMs}ms.`,
    );
  }

  if (stability.heapGrowthKiB > policy.maxHeapGrowthKiB) {
    violations.push(
      `Expected heap growth <= ${policy.maxHeapGrowthKiB}KiB, received ${stability.heapGrowthKiB}KiB.`,
    );
  }

  if (stability.maxConsecutiveHeapGrowth > policy.maxConsecutiveHeapGrowth) {
    violations.push(
      `Expected max consecutive heap growth <= ${policy.maxConsecutiveHeapGrowth}, received ${stability.maxConsecutiveHeapGrowth}.`,
    );
  }

  return violations;
}

export function evaluateQualitySoakSuite(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(QualitySoakInputSchema)(input),
      catch: (cause) =>
        new ParserFailure({
          message: readCauseMessage(
            cause,
            "Failed to decode the E7 quality soak suite input through shared contracts.",
          ),
        }),
    });
    const policy = resolvePolicy(decoded.policy);
    const stability = buildStability(decoded.samples, policy);
    const violations = buildViolations(stability, policy);

    return Schema.decodeUnknownSync(QualitySoakArtifactSchema)({
      benchmark: "e7-soak-endurance-suite",
      suiteId: decoded.suiteId,
      generatedAt: decoded.generatedAt,
      policy,
      sampleCount: decoded.samples.length,
      status: violations.length === 0 ? "pass" : "fail",
      violations,
      stability,
      samples: decoded.samples,
    });
  });
}

export type QualitySoakSampleEncoded = Schema.Codec.Encoded<typeof QualitySoakSampleSchema>;
export type QualitySoakPolicyEncoded = Schema.Codec.Encoded<typeof QualitySoakPolicySchema>;
export type QualitySoakStabilityReportEncoded = Schema.Codec.Encoded<
  typeof QualitySoakStabilityReportSchema
>;
export type QualitySoakArtifactEncoded = Schema.Codec.Encoded<typeof QualitySoakArtifactSchema>;
