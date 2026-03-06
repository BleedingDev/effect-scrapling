import { Schema } from "effect";
import { ArtifactKindSchema } from "./budget-lease-artifact.js";
import {
  CanonicalHttpUrlSchema,
  CanonicalIdentifierSchema,
  IsoDateTimeSchema,
  type CanonicalIdentifier,
} from "./schema-primitives.js";

const PositiveCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveSequenceSchema = Schema.Int.check(Schema.isGreaterThan(0));
const MaxAttemptsSchema = Schema.Int.check(Schema.isGreaterThan(0)).check(
  Schema.isLessThanOrEqualTo(32),
);
const CheckpointIntervalSchema = Schema.Int.check(Schema.isGreaterThan(0)).check(
  Schema.isLessThanOrEqualTo(10_000),
);
const ResumeTokenSchema = Schema.Trim.check(Schema.isNonEmpty());

export const RunStageSchema = Schema.Literals([
  "capture",
  "extract",
  "snapshot",
  "diff",
  "quality",
  "reflect",
] as const);

export const RunOutcomeSchema = Schema.Literals([
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const);

class RunStep extends Schema.Class<RunStep>("RunStep")({
  id: CanonicalIdentifierSchema,
  stage: RunStageSchema,
  requiresBrowser: Schema.Boolean,
  artifactKind: Schema.optional(ArtifactKindSchema),
}) {}

const RunStepsSchema = Schema.Array(RunStep).pipe(
  Schema.refine(
    (steps): steps is ReadonlyArray<Schema.Schema.Type<typeof RunStep>> =>
      steps.length > 0 &&
      new Set(steps.map(({ id }) => id)).size === steps.length &&
      new Set(steps.map(({ stage }) => stage)).size === steps.length,
    {
      message:
        "Expected a run plan with at least one step and without duplicate step ids or stages.",
    },
  ),
);

export class RunPlan extends Schema.Class<RunPlan>("RunPlan")({
  id: CanonicalIdentifierSchema,
  targetId: CanonicalIdentifierSchema,
  packId: CanonicalIdentifierSchema,
  accessPolicyId: CanonicalIdentifierSchema,
  concurrencyBudgetId: CanonicalIdentifierSchema,
  entryUrl: CanonicalHttpUrlSchema,
  maxAttempts: MaxAttemptsSchema,
  checkpointInterval: CheckpointIntervalSchema,
  steps: RunStepsSchema,
  createdAt: IsoDateTimeSchema,
}) {}

class RunStatsBase extends Schema.Class<RunStatsBase>("RunStats")({
  runId: CanonicalIdentifierSchema,
  plannedSteps: PositiveCountSchema,
  completedSteps: PositiveCountSchema,
  checkpointCount: PositiveCountSchema,
  artifactCount: PositiveCountSchema,
  outcome: RunOutcomeSchema,
  startedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}) {}

export const RunStatsSchema = RunStatsBase.pipe(
  Schema.refine(
    (stats): stats is Schema.Schema.Type<typeof RunStatsBase> =>
      stats.completedSteps <= stats.plannedSteps &&
      Date.parse(stats.updatedAt) >= Date.parse(stats.startedAt) &&
      (stats.outcome !== "succeeded" || stats.completedSteps === stats.plannedSteps),
    {
      message:
        "Expected run stats with monotonic timestamps, bounded completed steps, and full completion for succeeded runs.",
    },
  ),
);

const StepIdListSchema = Schema.Array(CanonicalIdentifierSchema).pipe(
  Schema.refine(
    (stepIds): stepIds is ReadonlyArray<CanonicalIdentifier> =>
      new Set(stepIds).size === stepIds.length,
    {
      message: "Expected step id lists without duplicates.",
    },
  ),
);

const ArtifactIdListSchema = Schema.Array(CanonicalIdentifierSchema).pipe(
  Schema.refine(
    (artifactIds): artifactIds is ReadonlyArray<CanonicalIdentifier> =>
      new Set(artifactIds).size === artifactIds.length,
    {
      message: "Expected artifact id lists without duplicates.",
    },
  ),
);

class RunCheckpointBase extends Schema.Class<RunCheckpointBase>("RunCheckpoint")({
  id: CanonicalIdentifierSchema,
  runId: CanonicalIdentifierSchema,
  planId: CanonicalIdentifierSchema,
  sequence: PositiveSequenceSchema,
  stage: RunStageSchema,
  nextStepId: Schema.optional(CanonicalIdentifierSchema),
  completedStepIds: StepIdListSchema,
  pendingStepIds: StepIdListSchema,
  artifactIds: ArtifactIdListSchema,
  resumeToken: Schema.optional(ResumeTokenSchema),
  stats: RunStatsSchema,
  storedAt: IsoDateTimeSchema,
}) {}

export const RunCheckpointSchema = RunCheckpointBase.pipe(
  Schema.refine(
    (checkpoint): checkpoint is Schema.Schema.Type<typeof RunCheckpointBase> => {
      const completed = new Set(checkpoint.completedStepIds);
      const hasOverlap = checkpoint.pendingStepIds.some((stepId) => completed.has(stepId));
      const pendingCount = checkpoint.pendingStepIds.length;

      return (
        !hasOverlap &&
        checkpoint.stats.runId === checkpoint.runId &&
        checkpoint.stats.plannedSteps === checkpoint.completedStepIds.length + pendingCount &&
        checkpoint.stats.completedSteps === checkpoint.completedStepIds.length &&
        (checkpoint.nextStepId === undefined ||
          checkpoint.pendingStepIds.includes(checkpoint.nextStepId))
      );
    },
    {
      message:
        "Expected checkpoints with consistent run stats, disjoint completed/pending step sets, and a next step drawn from the pending queue.",
    },
  ),
);

export const RunPlanSchema = RunPlan;
export const RunStats = RunStatsSchema;
export const RunCheckpoint = RunCheckpointSchema;

export type RunStage = Schema.Schema.Type<typeof RunStageSchema>;
export type RunOutcome = Schema.Schema.Type<typeof RunOutcomeSchema>;
export type RunStats = Schema.Schema.Type<typeof RunStatsSchema>;
export type RunCheckpoint = Schema.Schema.Type<typeof RunCheckpointSchema>;
export type RunPlanEncoded = Schema.Codec.Encoded<typeof RunPlanSchema>;
export type RunStatsEncoded = Schema.Codec.Encoded<typeof RunStatsSchema>;
export type RunCheckpointEncoded = Schema.Codec.Encoded<typeof RunCheckpointSchema>;
