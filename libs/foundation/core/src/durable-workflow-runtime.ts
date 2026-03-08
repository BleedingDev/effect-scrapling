import { randomUUID } from "node:crypto";
import { Effect, Layer, Option, Predicate, Schema } from "effect";
import { BudgetExceededError } from "./access-budget-runtime.ts";
import {
  ArtifactMetadataRecordSchema,
  ArtifactMetadataStore,
  CheckpointRecordSchema,
  RunCheckpointStore,
  StorageLocatorSchema,
  checkpointPayloadSha256,
} from "./config-storage.ts";
import { QualityVerdictSchema, SnapshotDiffSchema } from "./diff-verdict.ts";
import { SnapshotSchema } from "./observation-snapshot.ts";
import {
  RunCheckpointSchema,
  RunOutcomeSchema,
  RunPlanSchema,
  WorkflowControlAuditSchema,
  WorkflowControlResultSchema,
  WorkflowInspectionSnapshotSchema,
  type RunPlan,
  type WorkflowControlOperation,
} from "./run-state.ts";
import { CanonicalIdentifierSchema } from "./schema-primitives.ts";
import {
  BrowserAccess,
  CaptureStore,
  DiffEngine,
  Extractor,
  HttpAccess,
  PackRegistry,
  QualityGate,
  ReflectionEngine,
  SnapshotStore,
  WorkflowRunner,
} from "./service-topology.ts";
import {
  CheckpointCorruption,
  type CoreErrorEnvelope,
  DriftDetected,
  DuplicateWorkClaim,
  ExtractionMismatch,
  ParserFailure,
  PolicyViolation,
  ProviderUnavailable,
  RenderCrashError,
  TimeoutError,
  toCoreErrorEnvelope,
} from "./tagged-errors.ts";
import {
  WorkflowWorkClaimCompletionRequestSchema,
  WorkflowWorkClaimKeySchema,
  WorkflowWorkClaimRecordSchema,
  WorkflowWorkClaimReleaseRequestSchema,
  WorkflowWorkClaimRequestSchema,
  WorkflowWorkClaimStore,
} from "./workflow-work-claim-store.ts";

const workflowStageOrder = [
  "capture",
  "extract",
  "snapshot",
  "diff",
  "quality",
  "reflect",
] as const;

type ArtifactMetadataRecord = Schema.Schema.Type<typeof ArtifactMetadataRecordSchema>;
type Snapshot = Schema.Schema.Type<typeof SnapshotSchema>;
type SnapshotDiff = Schema.Schema.Type<typeof SnapshotDiffSchema>;
type QualityVerdict = Schema.Schema.Type<typeof QualityVerdictSchema>;
type WorkflowStep = RunPlan["steps"][number];
type WorkflowExecutionState = {
  readonly runId: string;
  readonly plan: RunPlan;
  readonly completedStepIds: ReadonlyArray<string>;
  readonly pendingStepIds: ReadonlyArray<string>;
  readonly artifactIds: ReadonlyArray<string>;
  readonly context: WorkflowResumeContext;
  readonly startedAt: string;
};

export class WorkflowResumeContextSchemaClass extends Schema.Class<WorkflowResumeContextSchemaClass>(
  "WorkflowResumeContext",
)({
  runId: CanonicalIdentifierSchema,
  plan: RunPlanSchema,
  extractedSnapshot: Schema.optional(SnapshotSchema),
  candidateSnapshotId: Schema.optional(CanonicalIdentifierSchema),
  baselineSnapshotId: Schema.optional(CanonicalIdentifierSchema),
  diff: Schema.optional(SnapshotDiffSchema),
  verdict: Schema.optional(QualityVerdictSchema),
}) {}

export const WorkflowResumeContextSchema = WorkflowResumeContextSchemaClass;
type WorkflowResumeContext = Schema.Schema.Type<typeof WorkflowResumeContextSchema>;

export type DurableWorkflowBaselineResolver = (input: {
  readonly plan: RunPlan;
  readonly candidateSnapshot: Snapshot;
}) => Effect.Effect<Snapshot, PolicyViolation | ProviderUnavailable>;

export type DurableWorkflowRuntimeOptions = {
  readonly now?: () => Date;
  readonly createRunId?: (plan: RunPlan) => string;
  readonly runnerInstanceId?: string;
  readonly resolveBaselineSnapshot?: DurableWorkflowBaselineResolver;
  readonly withWorkflowBudgetPermit?: <A, E, R>(input: {
    readonly effect: Effect.Effect<A, E, R>;
    readonly plan: RunPlan;
  }) => Effect.Effect<A, E | BudgetExceededError | PolicyViolation | ProviderUnavailable, R>;
};

function hasFailureMessage(cause: unknown): cause is { readonly message: string } {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }

  return Predicate.hasProperty(cause, "message") && typeof cause.message === "string";
}

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function toWorkflowFailure(
  cause: unknown,
  fallback: string,
): {
  readonly error: PolicyViolation | ProviderUnavailable;
  readonly failure: CoreErrorEnvelope;
} {
  if (Predicate.isTagged("ProviderUnavailable")(cause) && hasFailureMessage(cause)) {
    return {
      error: new ProviderUnavailable({ message: cause.message }),
      failure: toCoreErrorEnvelope(new ProviderUnavailable({ message: cause.message })),
    };
  }

  if (Predicate.isTagged("TimeoutError")(cause) && hasFailureMessage(cause)) {
    return {
      error: new ProviderUnavailable({ message: cause.message }),
      failure: toCoreErrorEnvelope(new TimeoutError({ message: cause.message })),
    };
  }

  if (Predicate.isTagged("RenderCrashError")(cause) && hasFailureMessage(cause)) {
    return {
      error: new ProviderUnavailable({ message: cause.message }),
      failure: toCoreErrorEnvelope(new RenderCrashError({ message: cause.message })),
    };
  }

  if (Predicate.isTagged("PolicyViolation")(cause) && hasFailureMessage(cause)) {
    return {
      error: new PolicyViolation({ message: cause.message }),
      failure: toCoreErrorEnvelope(new PolicyViolation({ message: cause.message })),
    };
  }

  if (Predicate.isTagged("DuplicateWorkClaim")(cause) && hasFailureMessage(cause)) {
    return {
      error: new ProviderUnavailable({ message: cause.message }),
      failure: toCoreErrorEnvelope(new DuplicateWorkClaim({ message: cause.message })),
    };
  }

  if (Predicate.isTagged("BudgetExceededError")(cause) && hasFailureMessage(cause)) {
    return {
      error: new ProviderUnavailable({ message: cause.message }),
      failure: toCoreErrorEnvelope(new ProviderUnavailable({ message: cause.message })),
    };
  }

  if (Predicate.isTagged("ExtractionMismatch")(cause) && hasFailureMessage(cause)) {
    return {
      error: new PolicyViolation({ message: cause.message }),
      failure: toCoreErrorEnvelope(new ExtractionMismatch({ message: cause.message })),
    };
  }

  if (Predicate.isTagged("ParserFailure")(cause) && hasFailureMessage(cause)) {
    return {
      error: new PolicyViolation({ message: cause.message }),
      failure: toCoreErrorEnvelope(new ParserFailure({ message: cause.message })),
    };
  }

  if (Predicate.isTagged("DriftDetected")(cause) && hasFailureMessage(cause)) {
    return {
      error: new PolicyViolation({ message: cause.message }),
      failure: toCoreErrorEnvelope(new DriftDetected({ message: cause.message })),
    };
  }

  const message = readCauseMessage(cause, fallback);
  return {
    error: new ProviderUnavailable({ message }),
    failure: toCoreErrorEnvelope(new ProviderUnavailable({ message })),
  };
}

function buildInspectionSnapshot(input: {
  readonly checkpoint: Schema.Schema.Type<typeof RunCheckpointSchema>;
  readonly plan: RunPlan;
}) {
  const elapsedMs = Math.max(
    Date.parse(input.checkpoint.stats.updatedAt) - Date.parse(input.checkpoint.stats.startedAt),
    0,
  );
  const remainingTimeoutMs = Math.max(input.plan.timeoutMs - elapsedMs, 0);
  const timeoutUtilization = Math.min(elapsedMs / input.plan.timeoutMs, 1);
  const pendingSteps = input.checkpoint.pendingStepIds.length;

  return Schema.decodeUnknownSync(WorkflowInspectionSnapshotSchema)({
    runId: input.checkpoint.runId,
    planId: input.plan.id,
    targetId: input.plan.targetId,
    packId: input.plan.packId,
    accessPolicyId: input.plan.accessPolicyId,
    concurrencyBudgetId: input.plan.concurrencyBudgetId,
    entryUrl: input.plan.entryUrl,
    status: input.checkpoint.stats.outcome,
    stage: input.checkpoint.stage,
    ...(input.checkpoint.nextStepId === undefined
      ? {}
      : { nextStepId: input.checkpoint.nextStepId }),
    startedAt: input.checkpoint.stats.startedAt,
    updatedAt: input.checkpoint.stats.updatedAt,
    storedAt: input.checkpoint.storedAt,
    stats: input.checkpoint.stats,
    progress: {
      plannedSteps: input.checkpoint.stats.plannedSteps,
      completedSteps: input.checkpoint.stats.completedSteps,
      pendingSteps,
      checkpointCount: input.checkpoint.stats.checkpointCount,
      artifactCount: input.checkpoint.stats.artifactCount,
      completionRatio:
        input.checkpoint.stats.plannedSteps === 0
          ? 0
          : input.checkpoint.stats.completedSteps / input.checkpoint.stats.plannedSteps,
      completedStepIds: input.checkpoint.completedStepIds,
      pendingStepIds: input.checkpoint.pendingStepIds,
    },
    budget: {
      maxAttempts: input.plan.maxAttempts,
      configuredTimeoutMs: input.plan.timeoutMs,
      elapsedMs,
      remainingTimeoutMs,
      timeoutUtilization,
      checkpointInterval: input.plan.checkpointInterval,
      stepsUntilNextCheckpoint:
        pendingSteps === 0 ? 0 : Math.min(input.plan.checkpointInterval, pendingSteps),
    },
    ...(input.checkpoint.control === undefined ? {} : { control: input.checkpoint.control }),
    ...(input.checkpoint.failure === undefined ? {} : { error: input.checkpoint.failure }),
  });
}

function decodePlan(plan: RunPlan) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(RunPlanSchema)(plan),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode durable workflow plan through shared contracts.",
      }),
  }).pipe(
    Effect.flatMap((decodedPlan) => {
      const stagePrefix = workflowStageOrder.slice(0, decodedPlan.steps.length);
      const isCanonicalPrefix = decodedPlan.steps.every(
        (step, index) => step.stage === stagePrefix[index],
      );

      return isCanonicalPrefix
        ? Effect.succeed(decodedPlan)
        : Effect.fail(
            new PolicyViolation({
              message:
                "Durable workflow plans must follow the canonical capture -> extract -> snapshot -> diff -> quality -> reflect stage prefix.",
            }),
          );
    }),
  );
}

function decodeCheckpoint(checkpoint: Schema.Codec.Encoded<typeof RunCheckpointSchema>) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(RunCheckpointSchema)(checkpoint),
    catch: () =>
      new CheckpointCorruption({
        message: "Failed to decode durable workflow checkpoint through shared contracts.",
      }),
  });
}

function buildResumeContext(input: {
  readonly runId: string;
  readonly plan: RunPlan;
  readonly extractedSnapshot?: Snapshot;
  readonly candidateSnapshotId?: string;
  readonly baselineSnapshotId?: string;
  readonly diff?: SnapshotDiff;
  readonly verdict?: QualityVerdict;
}) {
  return Schema.decodeUnknownSync(WorkflowResumeContextSchema)({
    runId: input.runId,
    plan: input.plan,
    ...(input.extractedSnapshot === undefined
      ? {}
      : { extractedSnapshot: input.extractedSnapshot }),
    ...(input.candidateSnapshotId === undefined
      ? {}
      : { candidateSnapshotId: input.candidateSnapshotId }),
    ...(input.baselineSnapshotId === undefined
      ? {}
      : { baselineSnapshotId: input.baselineSnapshotId }),
    ...(input.diff === undefined ? {} : { diff: input.diff }),
    ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
  });
}

function encodeResumeToken(context: WorkflowResumeContext) {
  return JSON.stringify(Schema.encodeSync(WorkflowResumeContextSchema)(context));
}

function decodeResumeToken(token: string) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(WorkflowResumeContextSchema)(JSON.parse(token)),
    catch: () =>
      new CheckpointCorruption({
        message: "Failed to decode durable workflow resume token through shared contracts.",
      }),
  });
}

function decodeRunId(runId: string) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(CanonicalIdentifierSchema)(runId),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode durable workflow run identifier through shared contracts.",
      }),
  });
}

function artifactLocatorKey(artifact: ArtifactMetadataRecord) {
  return `${artifact.locator.namespace}/${artifact.locator.key}`;
}

function sortArtifacts(artifacts: ReadonlyArray<ArtifactMetadataRecord>) {
  return [...artifacts].sort((left, right) => {
    const locatorOrder = artifactLocatorKey(left).localeCompare(artifactLocatorKey(right));
    if (locatorOrder !== 0) {
      return locatorOrder;
    }

    return left.artifactId.localeCompare(right.artifactId);
  });
}

function formatSequence(sequence: number) {
  return sequence.toString().padStart(4, "0");
}

function formatReplayStamp(date: Date) {
  return date.toISOString().replace(/[-:.TZ]/gu, "");
}

function createReplayRunId(input: {
  readonly runId: string;
  readonly checkpointSequence: number;
  readonly replayedAt: Date;
}) {
  return `${input.runId}-replay-${formatSequence(input.checkpointSequence)}-${formatReplayStamp(input.replayedAt)}`;
}

function createClaimantId(runId: string, runnerInstanceId: string) {
  return `workflow-runner-${runnerInstanceId}-${runId}`;
}

function createWorkDedupeKey(step: WorkflowStep) {
  return `workflow/${step.stage}/${step.id}`;
}

function createWorkClaimId(input: {
  readonly checkpointSequence: number;
  readonly runId: string;
  readonly runnerInstanceId: string;
  readonly step: WorkflowStep;
}) {
  return `claim-${input.runnerInstanceId}-${input.runId}-${input.step.id}-${formatSequence(input.checkpointSequence + 1)}`;
}

function createCheckpointSourceId(runId: string, sequence: number) {
  return sequence === 0
    ? `checkpoint-seed-${runId}`
    : `checkpoint-${runId}-${formatSequence(sequence)}`;
}

function makeWorkflowWorkClaimKey(runId: string, step: WorkflowStep) {
  return {
    runId,
    dedupeKey: createWorkDedupeKey(step),
  } satisfies Schema.Schema.Type<typeof WorkflowWorkClaimKeySchema>;
}

function makeWorkflowWorkClaimRequest(input: {
  readonly checkpointSequence: number;
  readonly runId: string;
  readonly runnerInstanceId: string;
  readonly step: WorkflowStep;
  readonly plan: RunPlan;
}) {
  return {
    key: makeWorkflowWorkClaimKey(input.runId, input.step),
    checkpoint: {
      planId: input.plan.id,
      checkpointId: createCheckpointSourceId(input.runId, input.checkpointSequence),
      checkpointSequence: input.checkpointSequence + 1,
      stage: input.step.stage,
      stepId: input.step.id,
    },
    claimId: createWorkClaimId(input),
    claimantId: createClaimantId(input.runId, input.runnerInstanceId),
    ttlMs: input.plan.timeoutMs,
  } satisfies Schema.Schema.Type<typeof WorkflowWorkClaimRequestSchema>;
}

function makeWorkflowWorkClaimReleaseRequest(input: {
  readonly claimId: string;
  readonly releaseReason: string;
  readonly runId: string;
  readonly step: WorkflowStep;
}) {
  return {
    key: makeWorkflowWorkClaimKey(input.runId, input.step),
    claimId: input.claimId,
    releaseReason: input.releaseReason,
  } satisfies Schema.Schema.Type<typeof WorkflowWorkClaimReleaseRequestSchema>;
}

function makeWorkflowWorkClaimCompletionRequest(input: {
  readonly artifactIds: ReadonlyArray<string>;
  readonly claimId: string;
  readonly resumeToken: string;
  readonly runId: string;
  readonly step: WorkflowStep;
}) {
  return {
    key: makeWorkflowWorkClaimKey(input.runId, input.step),
    claimId: input.claimId,
    artifactIds: input.artifactIds,
    resumeToken: input.resumeToken,
  } satisfies Schema.Schema.Type<typeof WorkflowWorkClaimCompletionRequestSchema>;
}

function resolveStep(plan: RunPlan, stepId: string) {
  const step = plan.steps.find((candidate) => candidate.id === stepId);

  return step === undefined
    ? Effect.fail(
        new CheckpointCorruption({
          message: `Durable workflow checkpoint references unknown step ${stepId}.`,
        }),
      )
    : Effect.succeed(step);
}

function resolveCheckpointStage(
  plan: RunPlan,
  completedStepIds: ReadonlyArray<string>,
  pendingStepIds: ReadonlyArray<string>,
) {
  const stageStepId = pendingStepIds[0] ?? completedStepIds[completedStepIds.length - 1];

  return stageStepId === undefined
    ? Effect.fail(
        new CheckpointCorruption({
          message: "Durable workflow checkpoints require at least one planned stage.",
        }),
      )
    : resolveStep(plan, stageStepId);
}

function advanceState(
  state: WorkflowExecutionState,
  step: WorkflowStep,
  update: {
    readonly artifactIds?: ReadonlyArray<string>;
    readonly context: WorkflowResumeContext;
  },
) {
  return Effect.gen(function* () {
    const [currentStepId, ...remainingPendingStepIds] = state.pendingStepIds;
    if (currentStepId !== step.id) {
      return yield* Effect.fail(
        new CheckpointCorruption({
          message: `Durable workflow expected step ${currentStepId ?? "none"} but attempted ${step.id}.`,
        }),
      );
    }

    return {
      runId: state.runId,
      plan: state.plan,
      completedStepIds: [...state.completedStepIds, step.id],
      pendingStepIds: remainingPendingStepIds,
      artifactIds: update.artifactIds ?? state.artifactIds,
      context: update.context,
      startedAt: state.startedAt,
    } satisfies WorkflowExecutionState;
  });
}

function validateCheckpointAgainstPlan(
  checkpoint: Schema.Schema.Type<typeof RunCheckpointSchema>,
  plan: RunPlan,
  expectedRunId: string,
) {
  return Effect.gen(function* () {
    const combinedStepIds = [...checkpoint.completedStepIds, ...checkpoint.pendingStepIds];
    const plannedStepIds = plan.steps.map((step) => step.id);

    if (
      checkpoint.runId !== expectedRunId ||
      checkpoint.planId !== plan.id ||
      combinedStepIds.length !== plannedStepIds.length ||
      combinedStepIds.some((stepId, index) => stepId !== plannedStepIds[index])
    ) {
      return yield* Effect.fail(
        new CheckpointCorruption({
          message:
            "Durable workflow checkpoint no longer matches the encoded plan ordering or run identity.",
        }),
      );
    }

    if (checkpoint.pendingStepIds.length === 0 && checkpoint.stats.outcome !== "succeeded") {
      return yield* Effect.fail(
        new CheckpointCorruption({
          message:
            "Durable workflow checkpoint cannot be terminal without a succeeded run outcome.",
        }),
      );
    }

    const stageStep = yield* resolveCheckpointStage(
      plan,
      checkpoint.completedStepIds,
      checkpoint.pendingStepIds,
    );
    if (
      stageStep.stage !== checkpoint.stage ||
      checkpoint.nextStepId !== checkpoint.pendingStepIds[0]
    ) {
      return yield* Effect.fail(
        new CheckpointCorruption({
          message:
            "Durable workflow checkpoint stage metadata is inconsistent with the pending queue.",
        }),
      );
    }
  });
}

export function makeDurableWorkflowRunner(options: DurableWorkflowRuntimeOptions = {}) {
  const now = options.now ?? (() => new Date());
  const createRunId = options.createRunId ?? ((plan: RunPlan) => plan.id);
  const runnerInstanceId = options.runnerInstanceId ?? randomUUID();
  const resolveBaselineSnapshot: DurableWorkflowBaselineResolver =
    options.resolveBaselineSnapshot ?? ((input) => Effect.succeed(input.candidateSnapshot));
  const withWorkflowBudgetPermit =
    options.withWorkflowBudgetPermit ??
    (<A, E, R>(input: { readonly effect: Effect.Effect<A, E, R>; readonly plan: RunPlan }) =>
      input.effect);

  return Effect.gen(function* () {
    const browserAccess = yield* BrowserAccess;
    const captureStore = yield* CaptureStore;
    const diffEngine = yield* DiffEngine;
    const extractor = yield* Extractor;
    const httpAccess = yield* HttpAccess;
    const packRegistry = yield* PackRegistry;
    const qualityGate = yield* QualityGate;
    const reflectionEngine = yield* ReflectionEngine;
    const snapshotStore = yield* SnapshotStore;
    const artifactMetadataStore = yield* ArtifactMetadataStore;
    const checkpointStore = yield* RunCheckpointStore;
    const workflowWorkClaimStore = yield* WorkflowWorkClaimStore;

    const loadArtifacts = Effect.fn("DurableWorkflowRunner.loadArtifacts")(function* (
      artifactIds: ReadonlyArray<string>,
    ) {
      return yield* Effect.forEach(artifactIds, (artifactId) =>
        artifactMetadataStore.getById(artifactId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new CheckpointCorruption({
                    message: `Durable workflow artifact ${artifactId} is missing from persistent metadata storage.`,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        ),
      );
    });

    const restoreClaimedStepState = Effect.fn("DurableWorkflowRunner.restoreClaimedStepState")(
      function* (
        state: WorkflowExecutionState,
        step: WorkflowStep,
        record: Schema.Schema.Type<typeof WorkflowWorkClaimRecordSchema>,
      ) {
        if (record.resumeToken === undefined) {
          return yield* Effect.fail(
            new CheckpointCorruption({
              message: `Durable workflow work claim for ${step.id} is missing a persisted resume token.`,
            }),
          );
        }

        const context = yield* decodeResumeToken(record.resumeToken);
        return yield* advanceState(state, step, {
          artifactIds: record.artifactIds ?? state.artifactIds,
          context,
        });
      },
    );

    const loadSnapshot = Effect.fn("DurableWorkflowRunner.loadSnapshot")(function* (
      snapshotId: string,
      label: "baseline" | "candidate",
    ) {
      return yield* snapshotStore.getById(snapshotId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new CheckpointCorruption({
                  message: `Durable workflow ${label} snapshot ${snapshotId} is missing from persistent storage.`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
    });

    const inspectCheckpoint = Effect.fn("DurableWorkflowRunner.inspectCheckpoint")(function* (
      checkpoint: Schema.Schema.Type<typeof RunCheckpointSchema>,
    ) {
      if (checkpoint.resumeToken === undefined) {
        return yield* Effect.fail(
          new CheckpointCorruption({
            message:
              "Durable workflow checkpoints require a resume token for deterministic inspection snapshots.",
          }),
        );
      }

      const context = yield* decodeResumeToken(checkpoint.resumeToken);
      const plan = yield* decodePlan(context.plan).pipe(
        Effect.mapError(
          ({ message }) =>
            new CheckpointCorruption({
              message,
            }),
        ),
      );
      yield* validateCheckpointAgainstPlan(checkpoint, plan, context.runId);

      return buildInspectionSnapshot({ checkpoint, plan });
    });

    const findLatestCheckpointRecord = Effect.fn(
      "DurableWorkflowRunner.findLatestCheckpointRecord",
    )(function* (runId: string) {
      const decodedRunId = yield* decodeRunId(runId);
      return yield* checkpointStore.latest(decodedRunId);
    });

    const persistCheckpoint = Effect.fn("DurableWorkflowRunner.persistCheckpoint")(function* (
      state: WorkflowExecutionState,
      sequence: number,
      outcome: Schema.Schema.Type<typeof RunOutcomeSchema>,
      failure?: CoreErrorEnvelope,
      control?: {
        readonly operation: WorkflowControlOperation;
        readonly sourceCheckpointId: string;
      },
    ) {
      const storedAt = now().toISOString();
      const stageStep = yield* resolveCheckpointStage(
        state.plan,
        state.completedStepIds,
        state.pendingStepIds,
      );
      const controlAudit =
        control === undefined
          ? undefined
          : yield* Effect.try({
              try: () =>
                Schema.decodeUnknownSync(WorkflowControlAuditSchema)({
                  operation: control.operation,
                  sourceCheckpointId: control.sourceCheckpointId,
                  requestedAt: storedAt,
                }),
              catch: (cause) =>
                new CheckpointCorruption({
                  message: `Failed to encode durable workflow control audit metadata through shared contracts. ${readCauseMessage(cause, "Unknown workflow control audit schema failure.")}`,
                }),
            });
      const checkpoint = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(RunCheckpointSchema)({
            id: `checkpoint-${state.runId}-${formatSequence(sequence)}`,
            runId: state.runId,
            planId: state.plan.id,
            sequence,
            stage: stageStep.stage,
            ...(state.pendingStepIds[0] === undefined
              ? {}
              : { nextStepId: state.pendingStepIds[0] }),
            completedStepIds: state.completedStepIds,
            pendingStepIds: state.pendingStepIds,
            artifactIds: state.artifactIds,
            resumeToken: encodeResumeToken(state.context),
            ...(controlAudit === undefined ? {} : { control: controlAudit }),
            ...(failure === undefined ? {} : { failure }),
            stats: {
              runId: state.runId,
              plannedSteps: state.plan.steps.length,
              completedSteps: state.completedStepIds.length,
              checkpointCount: sequence,
              artifactCount: state.artifactIds.length,
              outcome,
              startedAt: state.startedAt,
              updatedAt: storedAt,
            },
            storedAt,
          }),
        catch: (cause) =>
          new CheckpointCorruption({
            message: `Failed to encode durable workflow checkpoint through shared contracts. ${readCauseMessage(cause, "Unknown checkpoint schema failure.")}`,
          }),
      });
      const encodedCheckpoint = Schema.encodeSync(RunCheckpointSchema)(checkpoint);
      const locator = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(StorageLocatorSchema)({
            namespace: `checkpoints/${state.plan.targetId}`,
            key: `${state.runId}/${formatSequence(sequence)}.json`,
          }),
        catch: (cause) =>
          new CheckpointCorruption({
            message: `Failed to encode durable workflow checkpoint locator through shared contracts. ${readCauseMessage(cause, "Unknown checkpoint locator schema failure.")}`,
          }),
      });
      const record = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(CheckpointRecordSchema)({
            id: checkpoint.id,
            runId: checkpoint.runId,
            planId: checkpoint.planId,
            locator,
            checkpoint,
            sha256: checkpointPayloadSha256(encodedCheckpoint),
            encoding: "json",
            compression: "none",
            storedAt,
          }),
        catch: (cause) =>
          new CheckpointCorruption({
            message: `Failed to encode durable workflow checkpoint record through shared contracts. ${readCauseMessage(cause, "Unknown checkpoint record schema failure.")}`,
          }),
      });

      yield* checkpointStore.put(record);

      return encodedCheckpoint;
    });

    const executeStep = Effect.fn("DurableWorkflowRunner.executeStep")(function* (
      state: WorkflowExecutionState,
      step: WorkflowStep,
    ) {
      switch (step.stage) {
        case "capture": {
          const capturedArtifacts = yield* withWorkflowBudgetPermit({
            plan: state.plan,
            effect: step.requiresBrowser
              ? browserAccess.capture(state.plan)
              : httpAccess.capture(state.plan),
          });
          const persistedArtifacts = sortArtifacts(yield* captureStore.persist(capturedArtifacts));
          yield* Effect.forEach(persistedArtifacts, (artifact) =>
            artifactMetadataStore.put(artifact),
          );

          return yield* advanceState(state, step, {
            artifactIds: persistedArtifacts.map((artifact) => artifact.artifactId),
            context: buildResumeContext({
              runId: state.runId,
              plan: state.plan,
            }),
          });
        }

        case "extract": {
          if (state.artifactIds.length === 0) {
            return yield* Effect.fail(
              new CheckpointCorruption({
                message:
                  "Durable workflow extract stages require persisted capture artifacts before resume.",
              }),
            );
          }

          const artifacts = yield* loadArtifacts(state.artifactIds);
          const snapshot = yield* extractor.extract(state.plan, artifacts);

          return yield* advanceState(state, step, {
            context: buildResumeContext({
              runId: state.runId,
              plan: state.plan,
              extractedSnapshot: snapshot,
            }),
          });
        }

        case "snapshot": {
          if (state.context.extractedSnapshot === undefined) {
            return yield* Effect.fail(
              new CheckpointCorruption({
                message:
                  "Durable workflow snapshot stages require an extracted snapshot in the resume token.",
              }),
            );
          }

          const candidateSnapshot = yield* snapshotStore.put(state.context.extractedSnapshot);
          const baselineSnapshot = yield* resolveBaselineSnapshot({
            plan: state.plan,
            candidateSnapshot,
          }).pipe(
            Effect.flatMap((snapshot) =>
              snapshot.id === candidateSnapshot.id
                ? Effect.succeed(snapshot)
                : snapshotStore.put(snapshot),
            ),
          );

          return yield* advanceState(state, step, {
            context: buildResumeContext({
              runId: state.runId,
              plan: state.plan,
              candidateSnapshotId: candidateSnapshot.id,
              baselineSnapshotId: baselineSnapshot.id,
            }),
          });
        }

        case "diff": {
          if (
            state.context.candidateSnapshotId === undefined ||
            state.context.baselineSnapshotId === undefined
          ) {
            return yield* Effect.fail(
              new CheckpointCorruption({
                message:
                  "Durable workflow diff stages require candidate and baseline snapshot ids in the resume token.",
              }),
            );
          }

          const baseline = yield* loadSnapshot(state.context.baselineSnapshotId, "baseline");
          const candidate = yield* loadSnapshot(state.context.candidateSnapshotId, "candidate");
          const diff = yield* diffEngine.compare(baseline, candidate);

          return yield* advanceState(state, step, {
            context: buildResumeContext({
              runId: state.runId,
              plan: state.plan,
              candidateSnapshotId: state.context.candidateSnapshotId,
              baselineSnapshotId: state.context.baselineSnapshotId,
              diff,
            }),
          });
        }

        case "quality": {
          if (
            state.context.diff === undefined ||
            state.context.candidateSnapshotId === undefined ||
            state.context.baselineSnapshotId === undefined
          ) {
            return yield* Effect.fail(
              new CheckpointCorruption({
                message:
                  "Durable workflow quality stages require candidate snapshots and a persisted snapshot diff in the resume token.",
              }),
            );
          }

          const verdict = yield* qualityGate.evaluate(state.context.diff);
          const candidateSnapshotId = state.context.candidateSnapshotId;
          const baselineSnapshotId = state.context.baselineSnapshotId;
          const diff = state.context.diff;

          return yield* advanceState(state, step, {
            context: buildResumeContext({
              runId: state.runId,
              plan: state.plan,
              candidateSnapshotId,
              baselineSnapshotId,
              diff,
              verdict,
            }),
          });
        }

        case "reflect": {
          if (
            state.context.verdict === undefined ||
            state.context.diff === undefined ||
            state.context.candidateSnapshotId === undefined ||
            state.context.baselineSnapshotId === undefined
          ) {
            return yield* Effect.fail(
              new CheckpointCorruption({
                message:
                  "Durable workflow reflection stages require a quality verdict and prior graph state in the resume token.",
              }),
            );
          }

          const verdict = state.context.verdict;
          const candidateSnapshotId = state.context.candidateSnapshotId;
          const baselineSnapshotId = state.context.baselineSnapshotId;
          const diff = state.context.diff;
          const pack = yield* packRegistry.getById(state.plan.packId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new PolicyViolation({
                      message: `Durable workflow could not resolve pack ${state.plan.packId} for reflection.`,
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          );
          yield* reflectionEngine.decide(pack, verdict);

          return yield* advanceState(state, step, {
            context: buildResumeContext({
              runId: state.runId,
              plan: state.plan,
              candidateSnapshotId,
              baselineSnapshotId,
              diff,
              verdict,
            }),
          });
        }
      }
    });

    const executeStepWithClaim = Effect.fn("DurableWorkflowRunner.executeStepWithClaim")(function* (
      state: WorkflowExecutionState,
      step: WorkflowStep,
      sourceCheckpointSequence: number,
    ) {
      const claimId = createWorkClaimId({
        checkpointSequence: sourceCheckpointSequence,
        runId: state.runId,
        runnerInstanceId,
        step,
      });
      const claimDecision = yield* workflowWorkClaimStore.claim(
        makeWorkflowWorkClaimRequest({
          checkpointSequence: sourceCheckpointSequence,
          runId: state.runId,
          runnerInstanceId,
          step,
          plan: state.plan,
        }),
      );

      switch (claimDecision.decision) {
        case "acquired": {
          const executedStep = yield* executeStep(state, step).pipe(
            Effect.match({
              onFailure: (error) => ({ kind: "failure" as const, error }),
              onSuccess: (nextState) => ({ kind: "success" as const, nextState }),
            }),
          );

          if (executedStep.kind === "failure") {
            yield* workflowWorkClaimStore
              .release(
                makeWorkflowWorkClaimReleaseRequest({
                  claimId,
                  releaseReason: readCauseMessage(
                    executedStep.error,
                    `Durable workflow ${step.id} released after step failure.`,
                  ),
                  runId: state.runId,
                  step,
                }),
              )
              .pipe(
                Effect.match({
                  onFailure: () => undefined,
                  onSuccess: () => undefined,
                }),
              );

            return yield* Effect.fail(executedStep.error);
          }

          yield* workflowWorkClaimStore
            .complete(
              makeWorkflowWorkClaimCompletionRequest({
                artifactIds: executedStep.nextState.artifactIds,
                claimId,
                resumeToken: encodeResumeToken(executedStep.nextState.context),
                runId: state.runId,
                step,
              }),
            )
            .pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new DuplicateWorkClaim({
                        message: `Durable workflow step ${step.id} lost its work claim before completion and must be retried.`,
                      }),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            );

          return executedStep.nextState;
        }

        case "alreadyCompleted":
        case "superseded": {
          return yield* restoreClaimedStepState(state, step, claimDecision.record);
        }

        case "alreadyClaimed": {
          return yield* Effect.fail(
            new DuplicateWorkClaim({
              message: `Durable workflow step ${step.id} is already claimed and cannot be duplicated concurrently.`,
            }),
          );
        }
      }
    });

    const runUntilCheckpoint = Effect.fn("DurableWorkflowRunner.runUntilCheckpoint")(function* (
      state: WorkflowExecutionState,
      startingSequence: number,
      control?: {
        readonly operation: WorkflowControlOperation;
        readonly sourceCheckpointId: string;
      },
    ) {
      let nextState = state;
      let executedSinceCheckpoint = 0;

      while (
        nextState.pendingStepIds.length > 0 &&
        executedSinceCheckpoint < nextState.plan.checkpointInterval
      ) {
        const nextStepId = nextState.pendingStepIds[0];
        if (nextStepId === undefined) {
          break;
        }

        const step = yield* resolveStep(nextState.plan, nextStepId);
        const stepResult = yield* executeStepWithClaim(
          nextState,
          step,
          startingSequence + executedSinceCheckpoint,
        ).pipe(
          Effect.match({
            onFailure: (error) => ({ kind: "failure" as const, error }),
            onSuccess: (state) => ({ kind: "success" as const, state }),
          }),
        );

        if (stepResult.kind === "success") {
          nextState = stepResult.state;
          executedSinceCheckpoint += 1;
          continue;
        }

        const error = stepResult.error;
        if (Predicate.isTagged("CheckpointCorruption")(error)) {
          return yield* Effect.fail(error);
        }

        if (Predicate.isTagged("DuplicateWorkClaim")(error)) {
          return yield* Effect.fail(error);
        }

        const workflowFailure = toWorkflowFailure(
          error,
          `Durable workflow ${step.stage} stage failed.`,
        );

        return yield* persistCheckpoint(
          nextState,
          startingSequence + 1,
          "failed",
          workflowFailure.failure,
          control,
        ).pipe(Effect.andThen(Effect.fail(workflowFailure.error)));
      }

      return yield* persistCheckpoint(
        nextState,
        startingSequence + 1,
        nextState.pendingStepIds.length === 0 ? "succeeded" : "running",
        undefined,
        control,
      );
    });

    const buildWorkflowControlResult = Effect.fn(
      "DurableWorkflowRunner.buildWorkflowControlResult",
    )(function* (input: {
      readonly operation: WorkflowControlOperation;
      readonly requestedRunId: string;
      readonly sourceCheckpointId: string;
      readonly checkpoint: Schema.Schema.Type<typeof RunCheckpointSchema>;
    }) {
      return yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(WorkflowControlResultSchema)({
            operation: input.operation,
            requestedRunId: input.requestedRunId,
            resolvedRunId: input.checkpoint.runId,
            sourceCheckpointId: input.sourceCheckpointId,
            checkpoint: input.checkpoint,
          }),
        catch: (cause) =>
          new CheckpointCorruption({
            message: `Failed to encode durable workflow ${input.operation} control result through shared contracts. ${readCauseMessage(cause, "Unknown workflow control result schema failure.")}`,
          }),
      });
    });

    const inspect = Effect.fn("DurableWorkflowRunner.inspect")(function* (runId: string) {
      const record = yield* checkpointStore.latest(runId);

      return yield* Option.match(record, {
        onNone: () => Effect.succeed(Option.none()),
        onSome: ({ checkpoint }) => inspectCheckpoint(checkpoint).pipe(Effect.map(Option.some)),
      });
    });

    const restoreExecutionState = Effect.fn("DurableWorkflowRunner.restoreExecutionState")(
      function* (checkpoint: Schema.Schema.Type<typeof RunCheckpointSchema>) {
        if (checkpoint.resumeToken === undefined) {
          return yield* Effect.fail(
            new CheckpointCorruption({
              message:
                "Durable workflow checkpoints require a resume token for operator control operations.",
            }),
          );
        }

        const context = yield* decodeResumeToken(checkpoint.resumeToken);
        const decodedPlan = yield* decodePlan(context.plan);
        yield* validateCheckpointAgainstPlan(checkpoint, decodedPlan, context.runId);

        return {
          runId: checkpoint.runId,
          plan: decodedPlan,
          completedStepIds: checkpoint.completedStepIds,
          pendingStepIds: checkpoint.pendingStepIds,
          artifactIds: checkpoint.artifactIds,
          context,
          startedAt: checkpoint.stats.startedAt,
        } satisfies WorkflowExecutionState;
      },
    );

    const start = Effect.fn("DurableWorkflowRunner.start")(function* (plan: RunPlan) {
      const decodedPlan = yield* decodePlan(plan);
      const runId = createRunId(decodedPlan);

      return yield* runUntilCheckpoint(
        {
          runId,
          plan: decodedPlan,
          completedStepIds: [],
          pendingStepIds: decodedPlan.steps.map((step) => step.id),
          artifactIds: [],
          context: buildResumeContext({ runId, plan: decodedPlan }),
          startedAt: decodedPlan.createdAt,
        },
        0,
      );
    });

    const startReplay = Effect.fn("DurableWorkflowRunner.startReplay")(function* (input: {
      readonly requestedRunId: string;
      readonly sourceCheckpoint: Schema.Schema.Type<typeof RunCheckpointSchema>;
    }) {
      if (input.sourceCheckpoint.resumeToken === undefined) {
        return yield* Effect.fail(
          new CheckpointCorruption({
            message:
              "Durable workflow checkpoints require a resume token for deterministic replay.",
          }),
        );
      }

      const replayedAt = now();
      const context = yield* decodeResumeToken(input.sourceCheckpoint.resumeToken);
      const decodedPlan = yield* decodePlan(context.plan);
      yield* validateCheckpointAgainstPlan(input.sourceCheckpoint, decodedPlan, context.runId);
      const replayRunId = createReplayRunId({
        runId: input.requestedRunId,
        checkpointSequence: input.sourceCheckpoint.sequence,
        replayedAt,
      });

      return yield* runUntilCheckpoint(
        {
          runId: replayRunId,
          plan: decodedPlan,
          completedStepIds: [],
          pendingStepIds: decodedPlan.steps.map((step) => step.id),
          artifactIds: [],
          context: buildResumeContext({
            runId: replayRunId,
            plan: decodedPlan,
          }),
          startedAt: replayedAt.toISOString(),
        },
        0,
      ).pipe(Effect.flatMap(decodeCheckpoint));
    });

    const resumeFromCheckpoint = Effect.fn("DurableWorkflowRunner.resumeFromCheckpoint")(function* (
      checkpoint: Schema.Schema.Type<typeof RunCheckpointSchema>,
      operation: "resume" | "retry",
    ) {
      if (checkpoint.stats.outcome === "cancelled") {
        const operationName = operation === "retry" ? "retried" : "resumed";
        return yield* Effect.fail(
          new PolicyViolation({
            message: `Durable workflow ${checkpoint.runId} was cancelled and cannot be ${operationName}.`,
          }),
        );
      }

      if (operation === "resume" && checkpoint.stats.outcome === "failed") {
        return yield* Effect.fail(
          new PolicyViolation({
            message:
              "Failed durable workflow checkpoints require explicit retryRun control instead of resume.",
          }),
        );
      }

      if (operation === "retry") {
        if (checkpoint.stats.outcome !== "failed") {
          return yield* Effect.fail(
            new PolicyViolation({
              message:
                "Controlled durable workflow retry requires the latest checkpoint to be failed.",
            }),
          );
        }

        if (checkpoint.failure?.retryable !== true) {
          return yield* Effect.fail(
            new PolicyViolation({
              message: "Controlled durable workflow retry requires a retryable failure envelope.",
            }),
          );
        }
      }

      if (checkpoint.pendingStepIds.length === 0) {
        return Schema.encodeSync(RunCheckpointSchema)(checkpoint);
      }

      const state = yield* restoreExecutionState(checkpoint);
      return yield* runUntilCheckpoint(
        state,
        checkpoint.sequence,
        operation === "retry"
          ? {
              operation: "retry",
              sourceCheckpointId: checkpoint.id,
            }
          : undefined,
      );
    });

    const resume = Effect.fn("DurableWorkflowRunner.resume")(function* (
      checkpoint: Schema.Codec.Encoded<typeof RunCheckpointSchema>,
    ) {
      const decodedCheckpoint = yield* decodeCheckpoint(checkpoint);
      return yield* resumeFromCheckpoint(decodedCheckpoint, "resume");
    });

    const cancelRun = Effect.fn("DurableWorkflowRunner.cancelRun")(function* (runId: string) {
      const latestRecord = yield* findLatestCheckpointRecord(runId);
      return yield* Option.match(latestRecord, {
        onNone: () => Effect.succeed(Option.none()),
        onSome: ({ checkpoint }) =>
          Effect.gen(function* () {
            if (checkpoint.stats.outcome === "cancelled") {
              const auditableCheckpoint =
                checkpoint.control === undefined
                  ? yield* Effect.try({
                      try: () =>
                        Schema.decodeUnknownSync(RunCheckpointSchema)({
                          ...Schema.encodeSync(RunCheckpointSchema)(checkpoint),
                          control: {
                            operation: "cancel",
                            sourceCheckpointId: checkpoint.id,
                            requestedAt: checkpoint.storedAt,
                          },
                        }),
                      catch: (cause) =>
                        new CheckpointCorruption({
                          message: `Failed to synthesize durable workflow cancel audit metadata for an existing cancelled checkpoint. ${readCauseMessage(cause, "Unknown synthetic cancel audit schema failure.")}`,
                        }),
                    })
                  : checkpoint;

              return yield* buildWorkflowControlResult({
                operation: "cancel",
                requestedRunId: auditableCheckpoint.runId,
                sourceCheckpointId:
                  auditableCheckpoint.control?.sourceCheckpointId ?? checkpoint.id,
                checkpoint: auditableCheckpoint,
              }).pipe(Effect.map(Option.some));
            }

            if (checkpoint.pendingStepIds.length === 0) {
              return yield* Effect.fail(
                new PolicyViolation({
                  message: `Durable workflow ${checkpoint.runId} has no pending work to cancel.`,
                }),
              );
            }

            const state = yield* restoreExecutionState(checkpoint);
            const cancelledCheckpoint = yield* persistCheckpoint(
              state,
              checkpoint.sequence + 1,
              "cancelled",
              undefined,
              {
                operation: "cancel",
                sourceCheckpointId: checkpoint.id,
              },
            ).pipe(Effect.flatMap(decodeCheckpoint));

            return yield* buildWorkflowControlResult({
              operation: "cancel",
              requestedRunId: checkpoint.runId,
              sourceCheckpointId: checkpoint.id,
              checkpoint: cancelledCheckpoint,
            }).pipe(Effect.map(Option.some));
          }),
      });
    });

    const deferRun = Effect.fn("DurableWorkflowRunner.deferRun")(function* (runId: string) {
      const latestRecord = yield* findLatestCheckpointRecord(runId);
      return yield* Option.match(latestRecord, {
        onNone: () => Effect.succeed(Option.none()),
        onSome: ({ checkpoint }) =>
          Effect.gen(function* () {
            if (
              checkpoint.control?.operation === "defer" &&
              checkpoint.stats.outcome === "running"
            ) {
              return yield* buildWorkflowControlResult({
                operation: "defer",
                requestedRunId: checkpoint.runId,
                sourceCheckpointId: checkpoint.control.sourceCheckpointId,
                checkpoint,
              }).pipe(Effect.map(Option.some));
            }

            if (checkpoint.stats.outcome !== "running") {
              return yield* Effect.fail(
                new PolicyViolation({
                  message:
                    "Durable workflow defer control only applies to running checkpoints with pending work.",
                }),
              );
            }

            if (checkpoint.pendingStepIds.length === 0) {
              return yield* Effect.fail(
                new PolicyViolation({
                  message:
                    "Durable workflow defer control requires pending work on the latest checkpoint.",
                }),
              );
            }

            const state = yield* restoreExecutionState(checkpoint);
            const deferredCheckpoint = yield* persistCheckpoint(
              state,
              checkpoint.sequence + 1,
              "running",
              undefined,
              {
                operation: "defer",
                sourceCheckpointId: checkpoint.id,
              },
            ).pipe(Effect.flatMap(decodeCheckpoint));

            return yield* buildWorkflowControlResult({
              operation: "defer",
              requestedRunId: checkpoint.runId,
              sourceCheckpointId: checkpoint.id,
              checkpoint: deferredCheckpoint,
            }).pipe(Effect.map(Option.some));
          }),
      });
    });

    const replayRun = Effect.fn("DurableWorkflowRunner.replayRun")(function* (runId: string) {
      const latestRecord = yield* findLatestCheckpointRecord(runId);
      return yield* Option.match(latestRecord, {
        onNone: () => Effect.succeed(Option.none()),
        onSome: ({ checkpoint }) =>
          startReplay({
            requestedRunId: checkpoint.runId,
            sourceCheckpoint: checkpoint,
          }).pipe(
            Effect.flatMap((replayedCheckpoint) =>
              buildWorkflowControlResult({
                operation: "replay",
                requestedRunId: checkpoint.runId,
                sourceCheckpointId: checkpoint.id,
                checkpoint: replayedCheckpoint,
              }),
            ),
            Effect.map(Option.some),
          ),
      });
    });

    const resumeRun = Effect.fn("DurableWorkflowRunner.resumeRun")(function* (runId: string) {
      const latestRecord = yield* findLatestCheckpointRecord(runId);
      return yield* Option.match(latestRecord, {
        onNone: () => Effect.succeed(Option.none()),
        onSome: ({ checkpoint }) =>
          resume(Schema.encodeSync(RunCheckpointSchema)(checkpoint)).pipe(
            Effect.flatMap(decodeCheckpoint),
            Effect.flatMap((resumedCheckpoint) =>
              buildWorkflowControlResult({
                operation: "resume",
                requestedRunId: checkpoint.runId,
                sourceCheckpointId: checkpoint.id,
                checkpoint: resumedCheckpoint,
              }),
            ),
            Effect.map(Option.some),
          ),
      });
    });

    const retryRun = Effect.fn("DurableWorkflowRunner.retryRun")(function* (runId: string) {
      const latestRecord = yield* findLatestCheckpointRecord(runId);
      return yield* Option.match(latestRecord, {
        onNone: () => Effect.succeed(Option.none()),
        onSome: ({ checkpoint }) =>
          resumeFromCheckpoint(checkpoint, "retry").pipe(
            Effect.flatMap(decodeCheckpoint),
            Effect.flatMap((retriedCheckpoint) =>
              buildWorkflowControlResult({
                operation: "retry",
                requestedRunId: checkpoint.runId,
                sourceCheckpointId: checkpoint.id,
                checkpoint: retriedCheckpoint,
              }),
            ),
            Effect.map(Option.some),
          ),
      });
    });

    return WorkflowRunner.of({
      cancelRun,
      deferRun,
      inspect,
      replayRun,
      resume,
      resumeRun,
      retryRun,
      start,
    });
  });
}

export function DurableWorkflowRuntimeLive(options: DurableWorkflowRuntimeOptions = {}) {
  return Layer.effect(WorkflowRunner)(makeDurableWorkflowRunner(options));
}
