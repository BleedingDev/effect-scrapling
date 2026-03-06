import { Effect, Schema, SchemaGetter } from "effect";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";

const RATE_DELTA_SCHEMA = Schema.Number.check(Schema.isGreaterThanOrEqualTo(-1)).check(
  Schema.isLessThanOrEqualTo(1),
);
const GATE_STATUS_SCHEMA = Schema.Literals(["pass", "fail"] as const);
const QUALITY_ACTION_SCHEMA = Schema.Literals([
  "promote-shadow",
  "active",
  "guarded",
  "quarantined",
  "retired",
] as const);

const QUALITY_VERDICT_FIELDS = {
  id: CanonicalIdentifierSchema,
  packId: CanonicalIdentifierSchema,
  snapshotDiffId: CanonicalIdentifierSchema,
  action: QUALITY_ACTION_SCHEMA,
  createdAt: IsoDateTimeSchema,
} as const;

const PACK_PROMOTION_DECISION_FIELDS = {
  id: CanonicalIdentifierSchema,
  packId: CanonicalIdentifierSchema,
  triggerVerdictId: CanonicalIdentifierSchema,
  createdAt: IsoDateTimeSchema,
} as const;

class SnapshotDiffMetrics extends Schema.Class<SnapshotDiffMetrics>("SnapshotDiffMetrics")({
  fieldRecallDelta: RATE_DELTA_SCHEMA,
  falsePositiveDelta: RATE_DELTA_SCHEMA,
  driftDelta: RATE_DELTA_SCHEMA,
  latencyDeltaMs: Schema.Int,
  memoryDelta: Schema.Finite,
}) {}

export class SnapshotDiff extends Schema.Class<SnapshotDiff>("SnapshotDiff")({
  id: CanonicalIdentifierSchema,
  baselineSnapshotId: CanonicalIdentifierSchema,
  candidateSnapshotId: CanonicalIdentifierSchema,
  metrics: SnapshotDiffMetrics,
  createdAt: IsoDateTimeSchema,
}) {}

export const SnapshotDiffSchema = SnapshotDiff;

const REQUIRED_FIELD_COVERAGE_GATE_SCHEMA = Schema.Struct({
  name: Schema.Literal("requiredFieldCoverage"),
  status: GATE_STATUS_SCHEMA,
});
const FALSE_POSITIVE_RATE_GATE_SCHEMA = Schema.Struct({
  name: Schema.Literal("falsePositiveRate"),
  status: GATE_STATUS_SCHEMA,
});
const INCUMBENT_COMPARISON_GATE_SCHEMA = Schema.Struct({
  name: Schema.Literal("incumbentComparison"),
  status: GATE_STATUS_SCHEMA,
});
const REPLAY_DETERMINISM_GATE_SCHEMA = Schema.Struct({
  name: Schema.Literal("replayDeterminism"),
  status: GATE_STATUS_SCHEMA,
});
const WORKFLOW_RESUME_GATE_SCHEMA = Schema.Struct({
  name: Schema.Literal("workflowResume"),
  status: GATE_STATUS_SCHEMA,
});
const SOAK_STABILITY_GATE_SCHEMA = Schema.Struct({
  name: Schema.Literal("soakStability"),
  status: GATE_STATUS_SCHEMA,
});
const SECURITY_REDACTION_GATE_SCHEMA = Schema.Struct({
  name: Schema.Literal("securityRedaction"),
  status: GATE_STATUS_SCHEMA,
});

const QUALITY_GATE_SCHEMA = Schema.Union([
  REQUIRED_FIELD_COVERAGE_GATE_SCHEMA,
  FALSE_POSITIVE_RATE_GATE_SCHEMA,
  INCUMBENT_COMPARISON_GATE_SCHEMA,
  REPLAY_DETERMINISM_GATE_SCHEMA,
  WORKFLOW_RESUME_GATE_SCHEMA,
  SOAK_STABILITY_GATE_SCHEMA,
  SECURITY_REDACTION_GATE_SCHEMA,
]);

const QUALITY_GATES_SCHEMA = Schema.Array(QUALITY_GATE_SCHEMA).pipe(
  Schema.decode({
    decode: SchemaGetter.checkEffect((gates) =>
      Effect.succeed(
        gates.length === 7 && new Set(gates.map(({ name }) => name)).size === 7
          ? undefined
          : "Expected a deterministic verdict with one result for each promotion gate.",
      ),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);

export const QualityVerdictSchema = Schema.Struct({
  ...QUALITY_VERDICT_FIELDS,
  gates: QUALITY_GATES_SCHEMA,
});

const PROMOTE_SHADOW_FROM_DRAFT_SCHEMA = Schema.Struct({
  ...PACK_PROMOTION_DECISION_FIELDS,
  fromState: Schema.Literal("draft"),
  toState: Schema.Literal("shadow"),
  action: Schema.Literal("promote-shadow"),
});
const PROMOTE_SHADOW_FROM_ACTIVE_SCHEMA = Schema.Struct({
  ...PACK_PROMOTION_DECISION_FIELDS,
  fromState: Schema.Literal("active"),
  toState: Schema.Literal("shadow"),
  action: Schema.Literal("promote-shadow"),
});
const PROMOTE_SHADOW_FROM_GUARDED_SCHEMA = Schema.Struct({
  ...PACK_PROMOTION_DECISION_FIELDS,
  fromState: Schema.Literal("guarded"),
  toState: Schema.Literal("shadow"),
  action: Schema.Literal("promote-shadow"),
});
const PROMOTE_SHADOW_FROM_QUARANTINED_SCHEMA = Schema.Struct({
  ...PACK_PROMOTION_DECISION_FIELDS,
  fromState: Schema.Literal("quarantined"),
  toState: Schema.Literal("shadow"),
  action: Schema.Literal("promote-shadow"),
});
const GUARDED_PACK_SCHEMA = Schema.Struct({
  ...PACK_PROMOTION_DECISION_FIELDS,
  fromState: Schema.Literal("active"),
  toState: Schema.Literal("guarded"),
  action: Schema.Literal("guarded"),
});
const ACTIVATE_SHADOW_PACK_SCHEMA = Schema.Struct({
  ...PACK_PROMOTION_DECISION_FIELDS,
  fromState: Schema.Literal("shadow"),
  toState: Schema.Literal("active"),
  action: Schema.Literal("active"),
});
const ACTIVATE_GUARDED_PACK_SCHEMA = Schema.Struct({
  ...PACK_PROMOTION_DECISION_FIELDS,
  fromState: Schema.Literal("guarded"),
  toState: Schema.Literal("active"),
  action: Schema.Literal("active"),
});
const ACTIVATE_QUARANTINED_PACK_SCHEMA = Schema.Struct({
  ...PACK_PROMOTION_DECISION_FIELDS,
  fromState: Schema.Literal("quarantined"),
  toState: Schema.Literal("active"),
  action: Schema.Literal("active"),
});
const QUARANTINE_ACTIVE_PACK_SCHEMA = Schema.Struct({
  ...PACK_PROMOTION_DECISION_FIELDS,
  fromState: Schema.Literal("active"),
  toState: Schema.Literal("quarantined"),
  action: Schema.Literal("quarantined"),
});
const QUARANTINE_GUARDED_PACK_SCHEMA = Schema.Struct({
  ...PACK_PROMOTION_DECISION_FIELDS,
  fromState: Schema.Literal("guarded"),
  toState: Schema.Literal("quarantined"),
  action: Schema.Literal("quarantined"),
});
const RETIRE_DRAFT_PACK_SCHEMA = Schema.Struct({
  ...PACK_PROMOTION_DECISION_FIELDS,
  fromState: Schema.Literal("draft"),
  toState: Schema.Literal("retired"),
  action: Schema.Literal("retired"),
});
const RETIRE_SHADOW_PACK_SCHEMA = Schema.Struct({
  ...PACK_PROMOTION_DECISION_FIELDS,
  fromState: Schema.Literal("shadow"),
  toState: Schema.Literal("retired"),
  action: Schema.Literal("retired"),
});
const RETIRE_ACTIVE_PACK_SCHEMA = Schema.Struct({
  ...PACK_PROMOTION_DECISION_FIELDS,
  fromState: Schema.Literal("active"),
  toState: Schema.Literal("retired"),
  action: Schema.Literal("retired"),
});
const RETIRE_GUARDED_PACK_SCHEMA = Schema.Struct({
  ...PACK_PROMOTION_DECISION_FIELDS,
  fromState: Schema.Literal("guarded"),
  toState: Schema.Literal("retired"),
  action: Schema.Literal("retired"),
});
const RETIRE_QUARANTINED_PACK_SCHEMA = Schema.Struct({
  ...PACK_PROMOTION_DECISION_FIELDS,
  fromState: Schema.Literal("quarantined"),
  toState: Schema.Literal("retired"),
  action: Schema.Literal("retired"),
});

export const PackPromotionDecisionSchema = Schema.Union([
  PROMOTE_SHADOW_FROM_DRAFT_SCHEMA,
  PROMOTE_SHADOW_FROM_ACTIVE_SCHEMA,
  PROMOTE_SHADOW_FROM_GUARDED_SCHEMA,
  PROMOTE_SHADOW_FROM_QUARANTINED_SCHEMA,
  ACTIVATE_SHADOW_PACK_SCHEMA,
  ACTIVATE_GUARDED_PACK_SCHEMA,
  ACTIVATE_QUARANTINED_PACK_SCHEMA,
  GUARDED_PACK_SCHEMA,
  QUARANTINE_ACTIVE_PACK_SCHEMA,
  QUARANTINE_GUARDED_PACK_SCHEMA,
  RETIRE_DRAFT_PACK_SCHEMA,
  RETIRE_SHADOW_PACK_SCHEMA,
  RETIRE_ACTIVE_PACK_SCHEMA,
  RETIRE_GUARDED_PACK_SCHEMA,
  RETIRE_QUARANTINED_PACK_SCHEMA,
]);

export const PackPromotionDecision = PackPromotionDecisionSchema;

export type SnapshotDiffEncoded = Schema.Codec.Encoded<typeof SnapshotDiffSchema>;
export type SnapshotDiffMetricsEncoded = Schema.Codec.Encoded<typeof SnapshotDiffMetrics>;
export type QualityVerdict = Schema.Schema.Type<typeof QualityVerdictSchema>;
export type QualityVerdictEncoded = Schema.Codec.Encoded<typeof QualityVerdictSchema>;
export type PackPromotionDecisionEncoded = Schema.Codec.Encoded<typeof PackPromotionDecisionSchema>;
