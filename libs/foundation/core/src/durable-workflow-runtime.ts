import { createHash } from "node:crypto";
import { Effect, Layer, Option, Predicate, Schema } from "effect";
import {
  ArtifactMetadataRecordSchema,
  ArtifactMetadataStore,
  CheckpointRecordSchema,
  RunCheckpointStore,
  StorageLocatorSchema,
} from "./config-storage.ts";
import { QualityVerdictSchema, SnapshotDiffSchema } from "./diff-verdict.ts";
import { SnapshotSchema } from "./observation-snapshot.ts";
import { RunCheckpointSchema, RunOutcomeSchema, RunPlanSchema, type RunPlan } from "./run-state.ts";
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
import { CheckpointCorruption, PolicyViolation, ProviderUnavailable } from "./tagged-errors.ts";

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
  readonly resolveBaselineSnapshot?: DurableWorkflowBaselineResolver;
};

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  if (typeof value === "object" && value !== null) {
    if (Object.prototype.toString.call(value) === "[object Date]") {
      return JSON.stringify(value);
    }

    return `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(Reflect.get(value, key))}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function checkpointSha256(checkpoint: Schema.Codec.Encoded<typeof RunCheckpointSchema>) {
  return createHash("sha256").update(stableSerialize(checkpoint), "utf8").digest("hex");
}

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
): PolicyViolation | ProviderUnavailable {
  if (Predicate.isTagged("ProviderUnavailable")(cause) && hasFailureMessage(cause)) {
    return new ProviderUnavailable({ message: cause.message });
  }

  if (Predicate.isTagged("TimeoutError")(cause) && hasFailureMessage(cause)) {
    return new ProviderUnavailable({ message: cause.message });
  }

  if (Predicate.isTagged("RenderCrashError")(cause) && hasFailureMessage(cause)) {
    return new ProviderUnavailable({ message: cause.message });
  }

  if (Predicate.isTagged("PolicyViolation")(cause) && hasFailureMessage(cause)) {
    return new PolicyViolation({ message: cause.message });
  }

  if (Predicate.isTagged("ExtractionMismatch")(cause) && hasFailureMessage(cause)) {
    return new PolicyViolation({ message: cause.message });
  }

  if (Predicate.isTagged("ParserFailure")(cause) && hasFailureMessage(cause)) {
    return new PolicyViolation({ message: cause.message });
  }

  if (Predicate.isTagged("DriftDetected")(cause) && hasFailureMessage(cause)) {
    return new PolicyViolation({ message: cause.message });
  }

  return new ProviderUnavailable({ message: readCauseMessage(cause, fallback) });
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
  readonly plan: RunPlan;
  readonly extractedSnapshot?: Snapshot;
  readonly candidateSnapshotId?: string;
  readonly baselineSnapshotId?: string;
  readonly diff?: SnapshotDiff;
  readonly verdict?: QualityVerdict;
}) {
  return Schema.decodeUnknownSync(WorkflowResumeContextSchema)({
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
  return stableSerialize(Schema.encodeSync(WorkflowResumeContextSchema)(context));
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
  createRunId: (plan: RunPlan) => string,
) {
  return Effect.gen(function* () {
    const combinedStepIds = [...checkpoint.completedStepIds, ...checkpoint.pendingStepIds];
    const plannedStepIds = plan.steps.map((step) => step.id);

    if (
      checkpoint.runId !== createRunId(plan) ||
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
  const resolveBaselineSnapshot: DurableWorkflowBaselineResolver =
    options.resolveBaselineSnapshot ?? ((input) => Effect.succeed(input.candidateSnapshot));

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

    const persistCheckpoint = Effect.fn("DurableWorkflowRunner.persistCheckpoint")(function* (
      state: WorkflowExecutionState,
      sequence: number,
      outcome: Schema.Schema.Type<typeof RunOutcomeSchema>,
    ) {
      const storedAt = now().toISOString();
      const stageStep = yield* resolveCheckpointStage(
        state.plan,
        state.completedStepIds,
        state.pendingStepIds,
      );
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
      const record = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(CheckpointRecordSchema)({
            id: checkpoint.id,
            runId: checkpoint.runId,
            planId: checkpoint.planId,
            locator: Schema.decodeUnknownSync(StorageLocatorSchema)({
              namespace: `checkpoints/${state.plan.targetId}`,
              key: `${state.runId}/${formatSequence(sequence)}.json`,
            }),
            checkpoint,
            sha256: checkpointSha256(encodedCheckpoint),
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
          const capturedArtifacts = yield* step.requiresBrowser
            ? browserAccess.capture(state.plan)
            : httpAccess.capture(state.plan);
          const persistedArtifacts = sortArtifacts(yield* captureStore.persist(capturedArtifacts));
          yield* Effect.forEach(persistedArtifacts, (artifact) =>
            artifactMetadataStore.put(artifact),
          );

          return yield* advanceState(state, step, {
            artifactIds: persistedArtifacts.map((artifact) => artifact.artifactId),
            context: buildResumeContext({
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

    const runUntilCheckpoint = Effect.fn("DurableWorkflowRunner.runUntilCheckpoint")(function* (
      state: WorkflowExecutionState,
      startingSequence: number,
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
        nextState = yield* Effect.matchEffect(executeStep(nextState, step), {
          onFailure: (error) => {
            if (Predicate.isTagged("CheckpointCorruption")(error)) {
              return Effect.fail(error);
            }

            const normalizedError = toWorkflowFailure(
              error,
              `Durable workflow ${step.stage} stage failed.`,
            );

            return persistCheckpoint(nextState, startingSequence + 1, "failed").pipe(
              Effect.andThen(Effect.fail(normalizedError)),
            );
          },
          onSuccess: Effect.succeed,
        });
        executedSinceCheckpoint += 1;
      }

      return yield* persistCheckpoint(
        nextState,
        startingSequence + 1,
        nextState.pendingStepIds.length === 0 ? "succeeded" : "running",
      );
    });

    const inspect = Effect.fn("DurableWorkflowRunner.inspect")(function* (runId: string) {
      return yield* checkpointStore
        .latest(runId)
        .pipe(Effect.map(Option.map((record) => record.checkpoint.stats)));
    });

    const start = Effect.fn("DurableWorkflowRunner.start")(function* (plan: RunPlan) {
      const decodedPlan = yield* decodePlan(plan);

      return yield* runUntilCheckpoint(
        {
          runId: createRunId(decodedPlan),
          plan: decodedPlan,
          completedStepIds: [],
          pendingStepIds: decodedPlan.steps.map((step) => step.id),
          artifactIds: [],
          context: buildResumeContext({ plan: decodedPlan }),
          startedAt: decodedPlan.createdAt,
        },
        0,
      );
    });

    const resume = Effect.fn("DurableWorkflowRunner.resume")(function* (
      checkpoint: Schema.Codec.Encoded<typeof RunCheckpointSchema>,
    ) {
      const decodedCheckpoint = yield* decodeCheckpoint(checkpoint);
      if (decodedCheckpoint.resumeToken === undefined) {
        return yield* Effect.fail(
          new CheckpointCorruption({
            message: "Durable workflow checkpoints require a resume token for restart and replay.",
          }),
        );
      }

      const context = yield* decodeResumeToken(decodedCheckpoint.resumeToken);
      const decodedPlan = yield* decodePlan(context.plan);
      yield* validateCheckpointAgainstPlan(decodedCheckpoint, decodedPlan, createRunId);

      if (decodedCheckpoint.pendingStepIds.length === 0) {
        return Schema.encodeSync(RunCheckpointSchema)(decodedCheckpoint);
      }

      return yield* runUntilCheckpoint(
        {
          runId: decodedCheckpoint.runId,
          plan: decodedPlan,
          completedStepIds: decodedCheckpoint.completedStepIds,
          pendingStepIds: decodedCheckpoint.pendingStepIds,
          artifactIds: decodedCheckpoint.artifactIds,
          context,
          startedAt: decodedCheckpoint.stats.startedAt,
        },
        decodedCheckpoint.sequence,
      );
    });

    return WorkflowRunner.of({
      inspect,
      resume,
      start,
    });
  });
}

export function DurableWorkflowRuntimeLive(options: DurableWorkflowRuntimeOptions = {}) {
  return Layer.effect(WorkflowRunner)(makeDurableWorkflowRunner(options));
}
