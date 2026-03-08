import { Effect, Schema } from "effect";
import { QualityVerdictSchema, SnapshotDiffSchema } from "./diff-verdict.ts";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import { PackStateSchema, SitePackSchema } from "./site-pack.ts";
import { PolicyViolation } from "./tagged-errors.ts";

const RateDeltaSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(-1)).check(
  Schema.isLessThanOrEqualTo(1),
);
const NonNegativeFiniteSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonEmptyMessageSchema = Schema.Trim.check(Schema.isNonEmpty());
const StageStatusSchema = Schema.Union([Schema.Literal("pass"), Schema.Literal("fail")]);
const ValidatorStageNameSchema = Schema.Union([
  Schema.Literal("schema"),
  Schema.Literal("replay"),
  Schema.Literal("canary"),
  Schema.Literal("chaos"),
]);

const DefaultValidatorPolicy = Object.freeze({
  minimumRecallDelta: -0.05,
  maximumFalsePositiveDelta: 0.05,
  maximumDriftDelta: 0.1,
  maximumLatencyDeltaMs: 250,
  maximumMemoryDelta: 32,
});

const ValidatorPolicyBaseSchema = Schema.Struct({
  minimumRecallDelta: RateDeltaSchema,
  maximumFalsePositiveDelta: NonNegativeFiniteSchema.check(Schema.isLessThanOrEqualTo(1)),
  maximumDriftDelta: NonNegativeFiniteSchema.check(Schema.isLessThanOrEqualTo(1)),
  maximumLatencyDeltaMs: NonNegativeIntSchema,
  maximumMemoryDelta: NonNegativeFiniteSchema,
});

const ValidatorPolicySchema = ValidatorPolicyBaseSchema.pipe(
  Schema.refine(
    (policy): policy is Schema.Schema.Type<typeof ValidatorPolicyBaseSchema> =>
      policy.minimumRecallDelta <= policy.maximumDriftDelta,
    {
      message:
        "Expected validator thresholds where minimumRecallDelta does not exceed the allowed drift threshold.",
    },
  ),
);

export class PackValidationDelta extends Schema.Class<PackValidationDelta>("PackValidationDelta")({
  recallDelta: RateDeltaSchema,
  falsePositiveDelta: RateDeltaSchema,
  driftDelta: RateDeltaSchema,
  latencyDeltaMs: Schema.Int,
  memoryDelta: Schema.Finite,
}) {}

export class ValidatorStageResult extends Schema.Class<ValidatorStageResult>(
  "ValidatorStageResult",
)({
  stage: ValidatorStageNameSchema,
  status: StageStatusSchema,
  rationale: NonEmptyMessageSchema,
}) {}

const ValidatorStageResultsSchema = Schema.Array(ValidatorStageResult).pipe(
  Schema.refine(
    (stages): stages is ReadonlyArray<ValidatorStageResult> =>
      stages.length === 4 && new Set(stages.map(({ stage }) => stage)).size === 4,
    {
      message: "Expected one deterministic validator result for each ladder stage.",
    },
  ),
);

export class PackValidationVerdict extends Schema.Class<PackValidationVerdict>(
  "PackValidationVerdict",
)({
  id: CanonicalIdentifierSchema,
  packId: CanonicalIdentifierSchema,
  packState: PackStateSchema,
  snapshotDiffId: CanonicalIdentifierSchema,
  createdAt: IsoDateTimeSchema,
  deltas: PackValidationDelta,
  stages: ValidatorStageResultsSchema,
  qualityVerdict: QualityVerdictSchema,
}) {}

const ValidatorCheckResultsSchema = Schema.Struct({
  replayDeterminism: Schema.Boolean,
  workflowResume: Schema.Boolean,
  canary: Schema.Boolean,
  chaos: Schema.Boolean,
  securityRedaction: Schema.Boolean,
  soakStability: Schema.Boolean,
});

const ValidatorInputSchema = Schema.Struct({
  pack: SitePackSchema,
  snapshotDiff: SnapshotDiffSchema,
  checks: ValidatorCheckResultsSchema,
  createdAt: IsoDateTimeSchema,
  policy: Schema.optional(ValidatorPolicySchema),
});

export const PackValidationDeltaSchema = PackValidationDelta;
export const ValidatorStageResultSchema = ValidatorStageResult;
export const PackValidationVerdictSchema = PackValidationVerdict;

type ValidatorPolicy = Schema.Schema.Type<typeof ValidatorPolicySchema>;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function resolvePolicy(policy: ValidatorPolicy | undefined) {
  return policy ?? Schema.decodeUnknownSync(ValidatorPolicySchema)(DefaultValidatorPolicy);
}

function gateStatus(pass: boolean) {
  return pass ? "pass" : "fail";
}

function stageResult(
  stage: Schema.Schema.Type<typeof ValidatorStageNameSchema>,
  pass: boolean,
  rationale: string,
) {
  return Schema.decodeUnknownSync(ValidatorStageResultSchema)({
    stage,
    status: gateStatus(pass),
    rationale,
  });
}

function resolveAction(
  packState: Schema.Schema.Type<typeof PackStateSchema>,
  allPass: boolean,
  criticalFailure: boolean,
) {
  if (allPass) {
    return packState === "draft" ? "promote-shadow" : "active";
  }

  if (criticalFailure) {
    return packState === "draft" ? "retired" : "quarantined";
  }

  return "guarded";
}

export function evaluateValidatorLadder(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(ValidatorInputSchema)(input),
      catch: (cause) =>
        new PolicyViolation({
          message: readCauseMessage(
            cause,
            "Failed to decode validator ladder input through shared contracts.",
          ),
        }),
    });
    const policy = resolvePolicy(decoded.policy);
    const metrics = decoded.snapshotDiff.metrics;

    const requiredFieldCoverage = metrics.fieldRecallDelta >= policy.minimumRecallDelta;
    const falsePositiveRate = metrics.falsePositiveDelta <= policy.maximumFalsePositiveDelta;
    const incumbentComparison =
      metrics.driftDelta <= policy.maximumDriftDelta &&
      metrics.latencyDeltaMs <= policy.maximumLatencyDeltaMs &&
      metrics.memoryDelta <= policy.maximumMemoryDelta &&
      decoded.checks.canary;
    const replayDeterminism = decoded.checks.replayDeterminism;
    const workflowResume = decoded.checks.workflowResume;
    const soakStability = decoded.checks.soakStability && decoded.checks.chaos;
    const securityRedaction = decoded.checks.securityRedaction;

    const stages = Schema.decodeUnknownSync(ValidatorStageResultsSchema)([
      stageResult(
        "schema",
        requiredFieldCoverage && falsePositiveRate,
        `Schema checks require recall >= ${policy.minimumRecallDelta} and false-positive delta <= ${policy.maximumFalsePositiveDelta}.`,
      ),
      stageResult(
        "replay",
        replayDeterminism && workflowResume,
        "Replay checks require deterministic replay plus workflow resume support.",
      ),
      stageResult(
        "canary",
        incumbentComparison && securityRedaction,
        `Canary checks require drift <= ${policy.maximumDriftDelta}, latency <= ${policy.maximumLatencyDeltaMs}ms, memory <= ${policy.maximumMemoryDelta}, and redaction-safe output.`,
      ),
      stageResult(
        "chaos",
        soakStability,
        "Chaos checks require soak stability and passing chaos probes.",
      ),
    ]);

    const gates = [
      { name: "requiredFieldCoverage", status: gateStatus(requiredFieldCoverage) },
      { name: "falsePositiveRate", status: gateStatus(falsePositiveRate) },
      { name: "incumbentComparison", status: gateStatus(incumbentComparison) },
      { name: "replayDeterminism", status: gateStatus(replayDeterminism) },
      { name: "workflowResume", status: gateStatus(workflowResume) },
      { name: "soakStability", status: gateStatus(soakStability) },
      { name: "securityRedaction", status: gateStatus(securityRedaction) },
    ];
    const allPass = gates.every(({ status }) => status === "pass");
    const criticalFailure = !workflowResume || !securityRedaction || !soakStability;

    return Schema.decodeUnknownSync(PackValidationVerdictSchema)({
      id: `validator-${decoded.pack.id}-${decoded.snapshotDiff.id}`,
      packId: decoded.pack.id,
      packState: decoded.pack.state,
      snapshotDiffId: decoded.snapshotDiff.id,
      createdAt: decoded.createdAt,
      deltas: {
        recallDelta: metrics.fieldRecallDelta,
        falsePositiveDelta: metrics.falsePositiveDelta,
        driftDelta: metrics.driftDelta,
        latencyDeltaMs: metrics.latencyDeltaMs,
        memoryDelta: metrics.memoryDelta,
      },
      stages,
      qualityVerdict: {
        id: `quality-${decoded.pack.id}-${decoded.snapshotDiff.id}`,
        packId: decoded.pack.id,
        snapshotDiffId: decoded.snapshotDiff.id,
        action: resolveAction(decoded.pack.state, allPass, criticalFailure),
        gates,
        createdAt: decoded.createdAt,
      },
    });
  });
}

export type PackValidationVerdictEncoded = Schema.Codec.Encoded<typeof PackValidationVerdictSchema>;
export type ValidatorStageResultEncoded = Schema.Codec.Encoded<typeof ValidatorStageResultSchema>;
