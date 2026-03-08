import { Schema } from "effect";
import { ArtifactKindSchema } from "./budget-lease-artifact.ts";
import {
  CanonicalHttpUrlSchema,
  CanonicalIdentifierSchema,
  IsoDateTimeSchema,
  TimeoutMsSchema,
  type CanonicalIdentifier,
} from "./schema-primitives.ts";
import { CoreErrorEnvelopeSchema } from "./tagged-errors.ts";

const PositiveCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveSequenceSchema = Schema.Int.check(Schema.isGreaterThan(0));
const MaxAttemptsSchema = Schema.Int.check(Schema.isGreaterThan(0)).check(
  Schema.isLessThanOrEqualTo(32),
);
const CheckpointIntervalSchema = Schema.Int.check(Schema.isGreaterThan(0)).check(
  Schema.isLessThanOrEqualTo(10_000),
);
const ResumeTokenSchema = Schema.Trim.check(Schema.isNonEmpty());
const RunTimeoutMsSchema = TimeoutMsSchema;
const UnitIntervalSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);
const FLOAT_TOLERANCE = 1e-9;

function approximatelyEquals(left: number, right: number) {
  return Math.abs(left - right) <= FLOAT_TOLERANCE;
}

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

export const WorkflowControlOperationSchema = Schema.Literals([
  "resume",
  "replay",
  "cancel",
  "defer",
  "retry",
] as const);

class WorkflowControlAuditBase extends Schema.Class<WorkflowControlAuditBase>(
  "WorkflowControlAudit",
)({
  operation: WorkflowControlOperationSchema,
  sourceCheckpointId: CanonicalIdentifierSchema,
  requestedAt: IsoDateTimeSchema,
}) {}

export const WorkflowControlAuditSchema = WorkflowControlAuditBase;

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
  timeoutMs: RunTimeoutMsSchema,
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

class RunProgressViewBase extends Schema.Class<RunProgressViewBase>("RunProgressView")({
  plannedSteps: PositiveCountSchema,
  completedSteps: PositiveCountSchema,
  pendingSteps: PositiveCountSchema,
  checkpointCount: PositiveCountSchema,
  artifactCount: PositiveCountSchema,
  completionRatio: UnitIntervalSchema,
  completedStepIds: StepIdListSchema,
  pendingStepIds: StepIdListSchema,
}) {}

export const RunProgressViewSchema = RunProgressViewBase.pipe(
  Schema.refine(
    (progress): progress is Schema.Schema.Type<typeof RunProgressViewBase> =>
      progress.plannedSteps === progress.completedSteps + progress.pendingSteps &&
      progress.completedStepIds.length === progress.completedSteps &&
      progress.pendingStepIds.length === progress.pendingSteps,
    {
      message:
        "Expected run progress views with deterministic completed and pending step accounting.",
    },
  ),
);

class RunBudgetUtilizationBase extends Schema.Class<RunBudgetUtilizationBase>(
  "RunBudgetUtilization",
)({
  maxAttempts: MaxAttemptsSchema,
  configuredTimeoutMs: RunTimeoutMsSchema,
  elapsedMs: PositiveCountSchema,
  remainingTimeoutMs: PositiveCountSchema,
  timeoutUtilization: UnitIntervalSchema,
  checkpointInterval: CheckpointIntervalSchema,
  stepsUntilNextCheckpoint: PositiveCountSchema,
}) {}

export const RunBudgetUtilizationSchema = RunBudgetUtilizationBase.pipe(
  Schema.refine(
    (budget): budget is Schema.Schema.Type<typeof RunBudgetUtilizationBase> => {
      const expectedRemainingTimeoutMs = Math.max(budget.configuredTimeoutMs - budget.elapsedMs, 0);
      const expectedTimeoutUtilization = Math.min(budget.elapsedMs / budget.configuredTimeoutMs, 1);

      return (
        budget.remainingTimeoutMs <= budget.configuredTimeoutMs &&
        budget.remainingTimeoutMs === expectedRemainingTimeoutMs &&
        approximatelyEquals(budget.timeoutUtilization, expectedTimeoutUtilization) &&
        budget.stepsUntilNextCheckpoint <= budget.checkpointInterval
      );
    },
    {
      message:
        "Expected run budget utilization views with bounded timeout and checkpoint budget metrics.",
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
  control: Schema.optional(WorkflowControlAuditSchema),
  failure: Schema.optional(CoreErrorEnvelopeSchema),
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
        (checkpoint.control === undefined ||
          ((checkpoint.control.operation !== "cancel" ||
            checkpoint.stats.outcome === "cancelled") &&
            (checkpoint.control.operation !== "defer" || checkpoint.stats.outcome === "running") &&
            (checkpoint.control.operation !== "retry" ||
              checkpoint.stats.outcome !== "cancelled"))) &&
        ((checkpoint.stats.outcome === "failed" && checkpoint.failure !== undefined) ||
          (checkpoint.stats.outcome !== "failed" && checkpoint.failure === undefined)) &&
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

class WorkflowInspectionSnapshotBase extends Schema.Class<WorkflowInspectionSnapshotBase>(
  "WorkflowInspectionSnapshot",
)({
  runId: CanonicalIdentifierSchema,
  planId: CanonicalIdentifierSchema,
  targetId: CanonicalIdentifierSchema,
  packId: CanonicalIdentifierSchema,
  accessPolicyId: CanonicalIdentifierSchema,
  concurrencyBudgetId: CanonicalIdentifierSchema,
  entryUrl: CanonicalHttpUrlSchema,
  status: RunOutcomeSchema,
  stage: RunStageSchema,
  nextStepId: Schema.optional(CanonicalIdentifierSchema),
  startedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  storedAt: IsoDateTimeSchema,
  stats: RunStatsSchema,
  progress: RunProgressViewSchema,
  budget: RunBudgetUtilizationSchema,
  control: Schema.optional(WorkflowControlAuditSchema),
  error: Schema.optional(CoreErrorEnvelopeSchema),
}) {}

export const WorkflowInspectionSnapshotSchema = WorkflowInspectionSnapshotBase.pipe(
  Schema.refine(
    (inspection): inspection is Schema.Schema.Type<typeof WorkflowInspectionSnapshotBase> => {
      const expectedCompletionRatio =
        inspection.progress.plannedSteps === 0
          ? 0
          : inspection.progress.completedSteps / inspection.progress.plannedSteps;
      const hasPendingSteps = inspection.progress.pendingSteps > 0;
      const nextStepAligned =
        (inspection.nextStepId === undefined && !hasPendingSteps) ||
        (inspection.nextStepId !== undefined &&
          inspection.progress.pendingStepIds.includes(inspection.nextStepId));
      const succeededSnapshotAligned =
        inspection.status !== "succeeded" ||
        (inspection.progress.pendingSteps === 0 &&
          inspection.nextStepId === undefined &&
          approximatelyEquals(inspection.progress.completionRatio, 1));

      return (
        inspection.runId === inspection.stats.runId &&
        inspection.status === inspection.stats.outcome &&
        inspection.startedAt === inspection.stats.startedAt &&
        inspection.updatedAt === inspection.stats.updatedAt &&
        inspection.progress.plannedSteps === inspection.stats.plannedSteps &&
        inspection.progress.completedSteps === inspection.stats.completedSteps &&
        inspection.progress.checkpointCount === inspection.stats.checkpointCount &&
        inspection.progress.artifactCount === inspection.stats.artifactCount &&
        (inspection.control === undefined ||
          ((inspection.control.operation !== "cancel" || inspection.status === "cancelled") &&
            (inspection.control.operation !== "defer" || inspection.status === "running") &&
            (inspection.control.operation !== "retry" || inspection.status !== "cancelled"))) &&
        approximatelyEquals(inspection.progress.completionRatio, expectedCompletionRatio) &&
        nextStepAligned &&
        succeededSnapshotAligned &&
        ((inspection.status === "failed" && inspection.error !== undefined) ||
          (inspection.status !== "failed" && inspection.error === undefined))
      );
    },
    {
      message:
        "Expected workflow inspection snapshots with aligned run stats, progress accounting, and failure metadata.",
    },
  ),
);

class WorkflowControlResultBase extends Schema.Class<WorkflowControlResultBase>(
  "WorkflowControlResult",
)({
  operation: WorkflowControlOperationSchema,
  requestedRunId: CanonicalIdentifierSchema,
  resolvedRunId: CanonicalIdentifierSchema,
  sourceCheckpointId: CanonicalIdentifierSchema,
  checkpoint: RunCheckpointSchema,
}) {}

export const WorkflowControlResultSchema = WorkflowControlResultBase.pipe(
  Schema.refine(
    (result): result is Schema.Schema.Type<typeof WorkflowControlResultBase> => {
      const controlAligned =
        (result.operation === "resume" || result.operation === "replay") &&
        result.checkpoint.control === undefined
          ? true
          : result.checkpoint.control !== undefined &&
            result.checkpoint.control.operation === result.operation &&
            result.checkpoint.control.sourceCheckpointId === result.sourceCheckpointId;

      return (
        result.checkpoint.runId === result.resolvedRunId &&
        controlAligned &&
        ((result.operation === "replay" && result.resolvedRunId !== result.requestedRunId) ||
          (result.operation !== "replay" && result.resolvedRunId === result.requestedRunId)) &&
        (result.operation !== "cancel" || result.checkpoint.stats.outcome === "cancelled") &&
        (result.operation !== "defer" || result.checkpoint.stats.outcome === "running")
      );
    },
    {
      message:
        "Expected workflow control results with a checkpoint aligned to the resolved run id, operation-specific run identity semantics, and auditable control metadata.",
    },
  ),
);

export const RunPlanSchema = RunPlan;
export const RunStats = RunStatsSchema;
export const RunCheckpoint = RunCheckpointSchema;
export const RunProgressView = RunProgressViewSchema;
export const RunBudgetUtilization = RunBudgetUtilizationSchema;
export const WorkflowControlAudit = WorkflowControlAuditSchema;
export const WorkflowInspectionSnapshot = WorkflowInspectionSnapshotSchema;
export const WorkflowControlResult = WorkflowControlResultSchema;

export type RunStage = Schema.Schema.Type<typeof RunStageSchema>;
export type RunOutcome = Schema.Schema.Type<typeof RunOutcomeSchema>;
export type WorkflowControlOperation = Schema.Schema.Type<typeof WorkflowControlOperationSchema>;
export type RunStats = Schema.Schema.Type<typeof RunStatsSchema>;
export type RunCheckpoint = Schema.Schema.Type<typeof RunCheckpointSchema>;
export type RunProgressView = Schema.Schema.Type<typeof RunProgressViewSchema>;
export type RunBudgetUtilization = Schema.Schema.Type<typeof RunBudgetUtilizationSchema>;
export type WorkflowControlAudit = Schema.Schema.Type<typeof WorkflowControlAuditSchema>;
export type WorkflowInspectionSnapshot = Schema.Schema.Type<
  typeof WorkflowInspectionSnapshotSchema
>;
export type WorkflowControlResult = Schema.Schema.Type<typeof WorkflowControlResultSchema>;
export type RunPlanEncoded = Schema.Codec.Encoded<typeof RunPlanSchema>;
export type RunStatsEncoded = Schema.Codec.Encoded<typeof RunStatsSchema>;
export type RunCheckpointEncoded = Schema.Codec.Encoded<typeof RunCheckpointSchema>;
export type WorkflowControlAuditEncoded = Schema.Codec.Encoded<typeof WorkflowControlAuditSchema>;
export type WorkflowInspectionSnapshotEncoded = Schema.Codec.Encoded<
  typeof WorkflowInspectionSnapshotSchema
>;
export type WorkflowControlResultEncoded = Schema.Codec.Encoded<typeof WorkflowControlResultSchema>;
