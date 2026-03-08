import { Database } from "bun:sqlite";
import { describe, expect, it } from "@effect-native/bun-test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Layer, Option, Ref, Schema } from "effect";
import {
  ArtifactMetadataRecordSchema,
  ArtifactMetadataStore,
  CheckpointRecordSchema,
  RunCheckpointStore,
} from "../../libs/foundation/core/src/config-storage.ts";
import {
  CrawlPlanCompilerInputSchema,
  compileCrawlPlans,
} from "../../libs/foundation/core/src/crawl-plan-runtime.ts";
import { DurableWorkflowRuntimeLive } from "../../libs/foundation/core/src/durable-workflow-runtime.ts";
import {
  PackPromotionDecisionSchema,
  QualityVerdictSchema,
  SnapshotDiffSchema,
} from "../../libs/foundation/core/src/diff-verdict.ts";
import { SnapshotSchema } from "../../libs/foundation/core/src/observation-snapshot.ts";
import {
  RunCheckpointSchema,
  WorkflowControlResultSchema,
  WorkflowInspectionSnapshotSchema,
} from "../../libs/foundation/core/src/run-state.ts";
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
} from "../../libs/foundation/core/src/service-topology.ts";
import { SitePackSchema } from "../../libs/foundation/core/src/site-pack.ts";
import { SqliteRunCheckpointStoreLive } from "../../libs/foundation/core/src/sqlite-run-checkpoint-store.ts";
import { SqliteWorkflowWorkClaimStoreLive } from "../../libs/foundation/core/src/sqlite-workflow-work-claim-store.ts";
import { ParserFailure, TimeoutError } from "../../libs/foundation/core/src/tagged-errors.ts";
import {
  WorkflowWorkClaimStore,
  makeInMemoryWorkflowWorkClaimStore,
} from "../../libs/foundation/core/src/workflow-work-claim-store.ts";

const CREATED_AT = "2026-03-07T12:30:00.000Z";

const pack = Schema.decodeUnknownSync(SitePackSchema)({
  id: "pack-example-com",
  domainPattern: "*.example.com",
  state: "shadow",
  accessPolicyId: "policy-hybrid",
  version: "2026.03.07",
});

function makeCompilerInput() {
  return Schema.decodeUnknownSync(CrawlPlanCompilerInputSchema)({
    createdAt: CREATED_AT,
    defaults: {
      checkpointInterval: 2,
    },
    entries: [
      {
        target: {
          id: "target-search-001",
          tenantId: "tenant-main",
          domain: "example.com",
          kind: "searchResult",
          canonicalKey: "search/effect-runtime",
          seedUrls: ["https://example.com/search?q=effect-runtime"],
          accessPolicyId: "policy-hybrid",
          packId: pack.id,
          priority: 90,
        },
        pack,
        accessPolicy: {
          id: "policy-hybrid",
          mode: "hybrid",
          perDomainConcurrency: 4,
          globalConcurrency: 16,
          timeoutMs: 20_000,
          maxRetries: 2,
          render: "onDemand",
        },
      },
    ],
  });
}

function makeArtifact(targetId: string) {
  return Schema.decodeUnknownSync(ArtifactMetadataRecordSchema)({
    id: `artifact-record-${targetId}`,
    runId: `plan-${targetId}`,
    artifactId: `artifact-${targetId}`,
    kind: "renderedDom",
    visibility: "redacted",
    locator: {
      namespace: `artifacts/${targetId}`,
      key: `captures/${targetId}`,
    },
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    sizeBytes: 1024,
    mediaType: "text/html",
    storedAt: CREATED_AT,
  });
}

function makeSnapshot(targetId: string, artifactId: string, snapshotId: string) {
  return Schema.decodeUnknownSync(SnapshotSchema)({
    id: snapshotId,
    targetId,
    observations: [
      {
        field: "price",
        normalizedValue: {
          amount: 499.99,
          currency: "CZK",
        },
        confidence: 0.96,
        evidenceRefs: [artifactId],
      },
    ],
    qualityScore: 0.93,
    createdAt: CREATED_AT,
  });
}

type WorkflowWorkClaimStoreService = ReturnType<typeof WorkflowWorkClaimStore.of>;

function makeWorkflowHarnessBase(options?: {
  readonly browserTimeoutOnFirstCapture?: boolean;
  readonly captureBlocker?: Deferred.Deferred<void>;
  readonly extractorFailureMessage?: string;
  readonly runnerInstanceId?: string;
  readonly workflowWorkClaimStoreFactory?: () => Effect.Effect<WorkflowWorkClaimStoreService>;
}) {
  return Effect.gen(function* () {
    let nowTick = 0;
    const browserCallsRef = yield* Ref.make([] as ReadonlyArray<string>);
    const browserAttemptRef = yield* Ref.make(0);
    const httpCallsRef = yield* Ref.make([] as ReadonlyArray<string>);
    const snapshotStoreRef = yield* Ref.make(
      new Map<string, Schema.Schema.Type<typeof SnapshotSchema>>(),
    );
    const reflectionCallsRef = yield* Ref.make([] as ReadonlyArray<string>);
    const workflowWorkClaimStore = yield* (
      options?.workflowWorkClaimStoreFactory?.() ?? makeInMemoryWorkflowWorkClaimStore()
    );

    const supportLayer = Layer.mergeAll(
      Layer.succeed(HttpAccess)(
        HttpAccess.of({
          capture: (plan) =>
            Ref.update(httpCallsRef, (calls) => [...calls, plan.targetId]).pipe(
              Effect.andThen(
                options?.captureBlocker === undefined
                  ? Effect.void
                  : Deferred.await(options.captureBlocker),
              ),
              Effect.as([makeArtifact(plan.targetId)]),
            ),
        }),
      ),
      Layer.succeed(BrowserAccess)(
        BrowserAccess.of({
          capture: (plan) =>
            Effect.gen(function* () {
              const attemptNumber = (yield* Ref.get(browserAttemptRef)) + 1;
              yield* Ref.set(browserAttemptRef, attemptNumber);
              yield* Ref.update(browserCallsRef, (calls) => [...calls, plan.targetId]);

              if (attemptNumber === 1 && options?.browserTimeoutOnFirstCapture === true) {
                return yield* Effect.fail(
                  new TimeoutError({
                    message: "Synthetic access timeout for controlled retry.",
                  }),
                );
              }

              if (options?.captureBlocker !== undefined) {
                yield* Deferred.await(options.captureBlocker);
              }

              return [makeArtifact(plan.targetId)];
            }),
        }),
      ),
      Layer.succeed(CaptureStore)(
        CaptureStore.of({
          persist: (artifacts) => Effect.succeed(artifacts),
        }),
      ),
      Layer.succeed(Extractor)(
        Extractor.of({
          extract: (plan, artifacts) =>
            options?.extractorFailureMessage === undefined
              ? Effect.succeed(
                  makeSnapshot(
                    plan.targetId,
                    artifacts[0]!.artifactId,
                    `snapshot-${plan.targetId}`,
                  ),
                )
              : Effect.fail(
                  new ParserFailure({
                    message: options.extractorFailureMessage,
                  }),
                ),
        }),
      ),
      Layer.succeed(SnapshotStore)(
        SnapshotStore.of({
          getById: (snapshotId) =>
            Ref.get(snapshotStoreRef).pipe(
              Effect.map((snapshots) => {
                const snapshot = snapshots.get(snapshotId);
                return snapshot === undefined ? Option.none() : Option.some(snapshot);
              }),
            ),
          put: (snapshot) =>
            Ref.update(snapshotStoreRef, (snapshots) => {
              const next = new Map(snapshots);
              next.set(snapshot.id, snapshot);
              return next;
            }).pipe(Effect.as(snapshot)),
        }),
      ),
      Layer.succeed(DiffEngine)(
        DiffEngine.of({
          compare: (baseline, candidate) =>
            Effect.succeed(
              Schema.decodeUnknownSync(SnapshotDiffSchema)({
                id: `diff-${candidate.id}`,
                baselineSnapshotId: baseline.id,
                candidateSnapshotId: candidate.id,
                metrics: {
                  fieldRecallDelta: 0.02,
                  falsePositiveDelta: -0.01,
                  driftDelta: -0.03,
                  latencyDeltaMs: -40,
                  memoryDelta: -8,
                },
                createdAt: CREATED_AT,
              }),
            ),
        }),
      ),
      Layer.succeed(QualityGate)(
        QualityGate.of({
          evaluate: (diff) =>
            Effect.succeed(
              Schema.decodeUnknownSync(QualityVerdictSchema)({
                id: `verdict-${diff.id}`,
                packId: pack.id,
                snapshotDiffId: diff.id,
                action: "promote-shadow",
                gates: [
                  { name: "requiredFieldCoverage", status: "pass" },
                  { name: "falsePositiveRate", status: "pass" },
                  { name: "incumbentComparison", status: "pass" },
                  { name: "replayDeterminism", status: "pass" },
                  { name: "workflowResume", status: "pass" },
                  { name: "soakStability", status: "pass" },
                  { name: "securityRedaction", status: "pass" },
                ],
                createdAt: CREATED_AT,
              }),
            ),
        }),
      ),
      Layer.succeed(PackRegistry)(
        PackRegistry.of({
          getByDomain: (_domain) => Effect.succeed(Option.some(pack)),
          getById: (packId) =>
            Effect.succeed(packId === pack.id ? Option.some(pack) : Option.none()),
        }),
      ),
      Layer.succeed(ReflectionEngine)(
        ReflectionEngine.of({
          decide: (_pack, verdict) =>
            Ref.update(reflectionCallsRef, (calls) => [...calls, verdict.id]).pipe(
              Effect.as(
                Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
                  id: `decision-${verdict.id}`,
                  packId: pack.id,
                  fromState: "shadow",
                  toState: "active",
                  triggerVerdictId: verdict.id,
                  action: "active",
                  createdAt: CREATED_AT,
                }),
              ),
            ),
        }),
      ),
      Layer.succeed(WorkflowWorkClaimStore)(workflowWorkClaimStore),
    );

    return {
      browserCallsRef,
      httpCallsRef,
      makeLayer: <E, R>(
        storageLayer: Layer.Layer<ArtifactMetadataStore | RunCheckpointStore, E, R>,
      ) => {
        const baseLayer = Layer.mergeAll(supportLayer, storageLayer);
        const runtimeLayer = DurableWorkflowRuntimeLive({
          now: () => new Date(Date.parse(CREATED_AT) + nowTick++ * 1_000),
          ...(options?.runnerInstanceId === undefined
            ? {}
            : { runnerInstanceId: options.runnerInstanceId }),
          resolveBaselineSnapshot: ({ candidateSnapshot }) =>
            Effect.succeed(
              makeSnapshot(
                candidateSnapshot.targetId,
                candidateSnapshot.observations[0]!.evidenceRefs[0]!,
                `baseline-${candidateSnapshot.targetId}`,
              ),
            ),
        }).pipe(Layer.provide(baseLayer));

        return Layer.mergeAll(baseLayer, runtimeLayer);
      },
      reflectionCallsRef,
    };
  });
}

function makeTestLayer(options?: {
  readonly browserTimeoutOnFirstCapture?: boolean;
  readonly captureBlocker?: Deferred.Deferred<void>;
  readonly checkpointStoreRef?: Ref.Ref<
    ReadonlyArray<Schema.Schema.Type<typeof CheckpointRecordSchema>>
  >;
  readonly extractorFailureMessage?: string;
  readonly runnerInstanceId?: string;
  readonly workflowWorkClaimStoreFactory?: () => Effect.Effect<WorkflowWorkClaimStoreService>;
}) {
  return Effect.gen(function* () {
    const harness = yield* makeWorkflowHarnessBase(options);
    const artifactStoreRef = yield* Ref.make(
      new Map<string, Schema.Schema.Type<typeof ArtifactMetadataRecordSchema>>(),
    );
    const checkpointStoreRef =
      options?.checkpointStoreRef ??
      (yield* Ref.make([] as ReadonlyArray<Schema.Schema.Type<typeof CheckpointRecordSchema>>));
    const storageLayer = Layer.mergeAll(
      Layer.succeed(ArtifactMetadataStore)(
        ArtifactMetadataStore.of({
          getById: (artifactId) =>
            Ref.get(artifactStoreRef).pipe(
              Effect.map((records) => {
                const record = records.get(artifactId);
                return record === undefined ? Option.none() : Option.some(record);
              }),
            ),
          listByRun: (runId) =>
            Ref.get(artifactStoreRef).pipe(
              Effect.map((records) =>
                [...records.values()].filter((record) => record.runId === runId),
              ),
            ),
          put: (record) =>
            Ref.update(artifactStoreRef, (records) => {
              const next = new Map(records);
              next.set(record.artifactId, record);
              return next;
            }).pipe(Effect.as(record)),
        }),
      ),
      Layer.succeed(RunCheckpointStore)(
        RunCheckpointStore.of({
          getById: (checkpointId) =>
            Ref.get(checkpointStoreRef).pipe(
              Effect.map((records) => {
                const record = records.find((candidate) => candidate.id === checkpointId);
                return record === undefined ? Option.none() : Option.some(record);
              }),
            ),
          latest: (runId) =>
            Ref.get(checkpointStoreRef).pipe(
              Effect.map((records) => {
                const latestRecord = [...records]
                  .filter((record) => record.runId === runId)
                  .sort((left, right) => right.checkpoint.sequence - left.checkpoint.sequence)[0];
                return latestRecord === undefined ? Option.none() : Option.some(latestRecord);
              }),
            ),
          put: (record) =>
            Ref.update(checkpointStoreRef, (records) => [...records, record]).pipe(
              Effect.as(record),
            ),
        }),
      ),
    );

    return {
      artifactStoreRef,
      browserCallsRef: harness.browserCallsRef,
      checkpointStoreRef,
      httpCallsRef: harness.httpCallsRef,
      layer: harness.makeLayer(storageLayer),
      reflectionCallsRef: harness.reflectionCallsRef,
    };
  });
}

function makeSqliteTestLayer(
  databaseFilename: string,
  options?: {
    readonly browserTimeoutOnFirstCapture?: boolean;
    readonly extractorFailureMessage?: string;
  },
) {
  return Effect.gen(function* () {
    const harness = yield* makeWorkflowHarnessBase(options);
    const artifactStoreRef = yield* Ref.make(
      new Map<string, Schema.Schema.Type<typeof ArtifactMetadataRecordSchema>>(),
    );
    const storageLayer = Layer.mergeAll(
      Layer.succeed(ArtifactMetadataStore)(
        ArtifactMetadataStore.of({
          getById: (artifactId) =>
            Ref.get(artifactStoreRef).pipe(
              Effect.map((records) => {
                const record = records.get(artifactId);
                return record === undefined ? Option.none() : Option.some(record);
              }),
            ),
          listByRun: (runId) =>
            Ref.get(artifactStoreRef).pipe(
              Effect.map((records) =>
                [...records.values()].filter((record) => record.runId === runId),
              ),
            ),
          put: (record) =>
            Ref.update(artifactStoreRef, (records) => {
              const next = new Map(records);
              next.set(record.artifactId, record);
              return next;
            }).pipe(Effect.as(record)),
        }),
      ),
      SqliteRunCheckpointStoreLive({ filename: databaseFilename }),
      SqliteWorkflowWorkClaimStoreLive({ filename: `${databaseFilename}.claims` }),
    );

    return {
      browserCallsRef: harness.browserCallsRef,
      httpCallsRef: harness.httpCallsRef,
      layer: harness.makeLayer(storageLayer),
      reflectionCallsRef: harness.reflectionCallsRef,
    };
  });
}

function withSqliteDatabaseFile<A, E, R>(
  use: (databaseFilename: string) => Effect.Effect<A, E, R>,
) {
  return Effect.scoped(
    Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "foundation-core-durable-workflow-"))),
      (directory) =>
        Effect.sync(() => {
          rmSync(directory, { force: true, recursive: true });
        }),
    ).pipe(Effect.flatMap((directory) => use(join(directory, "durable-workflow.sqlite")))),
  );
}

function corruptLatestSqliteCheckpoint(databaseFilename: string, runId: string) {
  return Effect.sync(() => {
    const database = new Database(databaseFilename, {
      create: true,
      readwrite: true,
      strict: true,
    });
    try {
      const row = database
        .query<{ readonly id: string; readonly payload_json: string }, [string]>(`
          SELECT id, payload_json
          FROM workflow_checkpoint_records
          WHERE run_id = ?
          ORDER BY checkpoint_sequence DESC, stored_at DESC, id DESC
          LIMIT 1
        `)
        .get(runId);

      if (row === null || row === undefined) {
        throw new Error(`Expected a persisted SQLite checkpoint for run ${runId}.`);
      }

      const payload = JSON.parse(row.payload_json) as {
        readonly checkpoint: {
          readonly resumeToken?: string;
        };
      };
      const nextPayload = {
        ...payload,
        checkpoint: {
          ...payload.checkpoint,
          resumeToken: "{not-json",
        },
      };

      database
        .query("UPDATE workflow_checkpoint_records SET payload_json = ? WHERE id = ?")
        .run(JSON.stringify(nextPayload), row.id);
    } finally {
      database.close();
    }
  });
}

function mutateLatestInMemoryCheckpoint(
  checkpointStoreRef: Ref.Ref<ReadonlyArray<Schema.Schema.Type<typeof CheckpointRecordSchema>>>,
  runId: string,
  mutateCheckpoint: (checkpoint: Schema.Codec.Encoded<typeof RunCheckpointSchema>) => unknown,
) {
  return Ref.update(checkpointStoreRef, (records) => {
    const latestSequence = records
      .filter((record) => record.runId === runId)
      .reduce(
        (currentLatestSequence, record) =>
          Math.max(currentLatestSequence, record.checkpoint.sequence),
        0,
      );

    return records.map((record) =>
      record.runId === runId && record.checkpoint.sequence === latestSequence
        ? Schema.decodeUnknownSync(CheckpointRecordSchema)({
            ...Schema.encodeSync(CheckpointRecordSchema)(record),
            checkpoint: mutateCheckpoint(Schema.encodeSync(RunCheckpointSchema)(record.checkpoint)),
          })
        : record,
    );
  });
}

describe("foundation-core durable workflow runtime", () => {
  it.effect(
    "starts and operates through explicit resume and replay commands with stable identifiers",
    () =>
      Effect.gen(function* () {
        const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
        const compiledPlan = compiledPlans[0];
        if (compiledPlan === undefined) {
          throw new Error("Expected a compiled crawl plan.");
        }
        const harness = yield* makeTestLayer();
        const {
          finished,
          finishedResume,
          inspected,
          replayInspection,
          replayedStarted,
          resumed,
          resumedRun,
          started,
          startedInspection,
        } = yield* Effect.gen(function* () {
          const workflowRunner = yield* WorkflowRunner;
          const startedEncoded = yield* workflowRunner.start(compiledPlan.plan);
          const started = Schema.decodeUnknownSync(RunCheckpointSchema)(startedEncoded);
          const startedInspection = yield* workflowRunner.inspect(compiledPlan.plan.id);
          const replayedStarted = yield* workflowRunner.replayRun(compiledPlan.plan.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new Error("Expected durable workflow replayRun to resolve a run")),
                onSome: Effect.succeed,
              }),
            ),
          );
          const replayInspection = yield* workflowRunner
            .inspect(replayedStarted.resolvedRunId)
            .pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new Error("Expected replayed durable workflow inspection to resolve"),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            );
          const resumedRun = yield* workflowRunner.resumeRun(compiledPlan.plan.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new Error("Expected durable workflow resumeRun to resolve a run")),
                onSome: Effect.succeed,
              }),
            ),
          );
          const finishedResume = yield* workflowRunner.resumeRun(compiledPlan.plan.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new Error("Expected second durable workflow resumeRun to resolve")),
                onSome: Effect.succeed,
              }),
            ),
          );

          return {
            finished: finishedResume.checkpoint,
            finishedResume,
            inspected: yield* workflowRunner.inspect(compiledPlan.plan.id),
            replayedStarted,
            replayInspection,
            resumed: resumedRun.checkpoint,
            resumedRun,
            started,
            startedInspection,
          };
        }).pipe(Effect.provide(harness.layer));

        expect(started.sequence).toBe(1);
        expect(started.stage).toBe("snapshot");
        expect(started.completedStepIds).toEqual(["step-capture", "step-extract"]);
        expect(started.pendingStepIds).toEqual([
          "step-snapshot",
          "step-diff",
          "step-quality",
          "step-reflect",
        ]);

        const replayedStartedEncoded = Schema.encodeSync(WorkflowControlResultSchema)(
          replayedStarted,
        );
        expect(replayedStartedEncoded.operation).toBe("replay");
        expect(replayedStartedEncoded.requestedRunId).toBe(compiledPlan.plan.id);
        expect(replayedStartedEncoded.sourceCheckpointId).toBe(started.id);
        expect(replayedStartedEncoded.resolvedRunId).not.toBe(compiledPlan.plan.id);
        expect(
          replayedStartedEncoded.resolvedRunId.startsWith(`${compiledPlan.plan.id}-replay-`),
        ).toBe(true);
        expect(replayedStartedEncoded.checkpoint.runId).toBe(replayedStartedEncoded.resolvedRunId);
        expect(replayedStartedEncoded.checkpoint.sequence).toBe(1);
        expect(replayedStartedEncoded.checkpoint.stage).toBe("snapshot");
        expect(replayedStartedEncoded.checkpoint.completedStepIds).toEqual([
          "step-capture",
          "step-extract",
        ]);
        expect(replayedStartedEncoded.checkpoint.pendingStepIds).toEqual([
          "step-snapshot",
          "step-diff",
          "step-quality",
          "step-reflect",
        ]);
        expect(Schema.encodeSync(WorkflowInspectionSnapshotSchema)(replayInspection)).toMatchObject(
          {
            runId: replayedStartedEncoded.resolvedRunId,
            status: "running",
            stage: "snapshot",
            nextStepId: "step-snapshot",
          },
        );

        expect(Option.isSome(startedInspection)).toBe(true);
        if (Option.isSome(startedInspection)) {
          expect(
            Schema.encodeSync(WorkflowInspectionSnapshotSchema)(startedInspection.value),
          ).toEqual({
            runId: compiledPlan.plan.id,
            planId: compiledPlan.plan.id,
            targetId: compiledPlan.plan.targetId,
            packId: compiledPlan.plan.packId,
            accessPolicyId: compiledPlan.plan.accessPolicyId,
            concurrencyBudgetId: compiledPlan.plan.concurrencyBudgetId,
            entryUrl: compiledPlan.plan.entryUrl,
            status: "running",
            stage: "snapshot",
            nextStepId: "step-snapshot",
            startedAt: CREATED_AT,
            updatedAt: CREATED_AT,
            storedAt: CREATED_AT,
            stats: {
              runId: compiledPlan.plan.id,
              plannedSteps: 6,
              completedSteps: 2,
              checkpointCount: 1,
              artifactCount: 1,
              outcome: "running",
              startedAt: CREATED_AT,
              updatedAt: CREATED_AT,
            },
            progress: {
              plannedSteps: 6,
              completedSteps: 2,
              pendingSteps: 4,
              checkpointCount: 1,
              artifactCount: 1,
              completionRatio: 2 / 6,
              completedStepIds: ["step-capture", "step-extract"],
              pendingStepIds: ["step-snapshot", "step-diff", "step-quality", "step-reflect"],
            },
            budget: {
              maxAttempts: 3,
              configuredTimeoutMs: 20_000,
              elapsedMs: 0,
              remainingTimeoutMs: 20_000,
              timeoutUtilization: 0,
              checkpointInterval: 2,
              stepsUntilNextCheckpoint: 2,
            },
          });
        }

        expect(resumed.sequence).toBe(2);
        expect(resumed.stage).toBe("quality");
        expect(resumed.completedStepIds).toEqual([
          "step-capture",
          "step-extract",
          "step-snapshot",
          "step-diff",
        ]);
        expect(resumed.pendingStepIds).toEqual(["step-quality", "step-reflect"]);

        const resumedRunEncoded = Schema.encodeSync(WorkflowControlResultSchema)(resumedRun);
        expect(resumedRunEncoded.operation).toBe("resume");
        expect(resumedRunEncoded.requestedRunId).toBe(compiledPlan.plan.id);
        expect(resumedRunEncoded.resolvedRunId).toBe(compiledPlan.plan.id);
        expect(resumedRunEncoded.sourceCheckpointId).toBe(started.id);
        expect(resumedRunEncoded.checkpoint).toEqual(
          Schema.encodeSync(RunCheckpointSchema)(resumed),
        );

        expect(finished.sequence).toBe(3);
        expect(finished.stage).toBe("reflect");
        expect(finished.pendingStepIds).toEqual([]);
        expect(finished.stats.outcome).toBe("succeeded");
        expect(finished.stats.completedSteps).toBe(6);

        const finishedResumeEncoded = Schema.encodeSync(WorkflowControlResultSchema)(
          finishedResume,
        );
        expect(finishedResumeEncoded.operation).toBe("resume");
        expect(finishedResumeEncoded.requestedRunId).toBe(compiledPlan.plan.id);
        expect(finishedResumeEncoded.resolvedRunId).toBe(compiledPlan.plan.id);
        expect(finishedResumeEncoded.sourceCheckpointId).toBe(resumed.id);
        expect(finishedResumeEncoded.checkpoint).toEqual(
          Schema.encodeSync(RunCheckpointSchema)(finished),
        );

        expect(Option.isSome(inspected)).toBe(true);
        if (Option.isSome(inspected)) {
          expect(Schema.encodeSync(WorkflowInspectionSnapshotSchema)(inspected.value)).toEqual({
            runId: compiledPlan.plan.id,
            planId: compiledPlan.plan.id,
            targetId: compiledPlan.plan.targetId,
            packId: compiledPlan.plan.packId,
            accessPolicyId: compiledPlan.plan.accessPolicyId,
            concurrencyBudgetId: compiledPlan.plan.concurrencyBudgetId,
            entryUrl: compiledPlan.plan.entryUrl,
            status: "succeeded",
            stage: "reflect",
            startedAt: CREATED_AT,
            updatedAt: "2026-03-07T12:30:04.000Z",
            storedAt: "2026-03-07T12:30:04.000Z",
            stats: {
              runId: compiledPlan.plan.id,
              plannedSteps: 6,
              completedSteps: 6,
              checkpointCount: 3,
              artifactCount: 1,
              outcome: "succeeded",
              startedAt: CREATED_AT,
              updatedAt: "2026-03-07T12:30:04.000Z",
            },
            progress: {
              plannedSteps: 6,
              completedSteps: 6,
              pendingSteps: 0,
              checkpointCount: 3,
              artifactCount: 1,
              completionRatio: 1,
              completedStepIds: [
                "step-capture",
                "step-extract",
                "step-snapshot",
                "step-diff",
                "step-quality",
                "step-reflect",
              ],
              pendingStepIds: [],
            },
            budget: {
              maxAttempts: 3,
              configuredTimeoutMs: 20_000,
              elapsedMs: 4_000,
              remainingTimeoutMs: 16_000,
              timeoutUtilization: 0.2,
              checkpointInterval: 2,
              stepsUntilNextCheckpoint: 0,
            },
          });
        }

        expect(yield* Ref.get(harness.browserCallsRef)).toEqual([
          "target-search-001",
          "target-search-001",
        ]);
        expect(yield* Ref.get(harness.httpCallsRef)).toEqual([]);
        expect((yield* Ref.get(harness.artifactStoreRef)).size).toBe(1);
        expect(yield* Ref.get(harness.checkpointStoreRef)).toHaveLength(4);
        expect(yield* Ref.get(harness.reflectionCallsRef)).toEqual([
          "verdict-diff-snapshot-target-search-001",
        ]);
      }),
  );

  it.effect("returns none for explicit workflow control operations on unknown run ids", () =>
    Effect.gen(function* () {
      const harness = yield* makeTestLayer();
      const { cancelled, deferred, replayed, resumed, retried } = yield* Effect.gen(function* () {
        const workflowRunner = yield* WorkflowRunner;
        return {
          cancelled: yield* workflowRunner.cancelRun("run-missing"),
          deferred: yield* workflowRunner.deferRun("run-missing"),
          replayed: yield* workflowRunner.replayRun("run-missing"),
          resumed: yield* workflowRunner.resumeRun("run-missing"),
          retried: yield* workflowRunner.retryRun("run-missing"),
        };
      }).pipe(Effect.provide(harness.layer));

      expect(Option.isNone(cancelled)).toBe(true);
      expect(Option.isNone(deferred)).toBe(true);
      expect(Option.isNone(replayed)).toBe(true);
      expect(Option.isNone(resumed)).toBe(true);
      expect(Option.isNone(retried)).toBe(true);
    }),
  );

  it.effect("rejects resume when a durable workflow checkpoint drifts from graph ordering", () =>
    Effect.gen(function* () {
      const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
      const compiledPlan = compiledPlans[0];
      if (compiledPlan === undefined) {
        throw new Error("Expected a compiled crawl plan.");
      }
      const harness = yield* makeTestLayer();
      const failure = yield* Effect.gen(function* () {
        const workflowRunner = yield* WorkflowRunner;
        const startedEncoded = yield* workflowRunner.start(compiledPlan.plan);

        return yield* Effect.flip(
          workflowRunner.resume({
            ...startedEncoded,
            stage: "diff",
            nextStepId: "step-diff",
            pendingStepIds: ["step-diff", "step-snapshot", "step-quality", "step-reflect"],
          }),
        );
      }).pipe(Effect.provide(harness.layer));

      expect(failure.message).toContain("no longer matches the encoded plan ordering");
    }),
  );

  it.effect(
    "rejects inspect and replay when a durable workflow checkpoint drifts from graph ordering",
    () =>
      Effect.gen(function* () {
        const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
        const compiledPlan = compiledPlans[0];
        if (compiledPlan === undefined) {
          throw new Error("Expected a compiled crawl plan.");
        }
        const harness = yield* makeTestLayer();
        const failures = yield* Effect.gen(function* () {
          const workflowRunner = yield* WorkflowRunner;
          const startedEncoded = yield* workflowRunner.start(compiledPlan.plan);
          const started = Schema.decodeUnknownSync(RunCheckpointSchema)(startedEncoded);

          yield* Ref.update(harness.checkpointStoreRef, (records) =>
            records.map((record) =>
              record.runId === started.runId
                ? Schema.decodeUnknownSync(CheckpointRecordSchema)({
                    ...Schema.encodeSync(CheckpointRecordSchema)(record),
                    checkpoint: {
                      ...Schema.encodeSync(RunCheckpointSchema)(record.checkpoint),
                      stage: "diff",
                      nextStepId: "step-diff",
                      pendingStepIds: [
                        "step-diff",
                        "step-snapshot",
                        "step-quality",
                        "step-reflect",
                      ],
                    },
                  })
                : record,
            ),
          );

          return {
            inspected: yield* Effect.flip(workflowRunner.inspect(started.runId)),
            replayed: yield* Effect.flip(workflowRunner.replayRun(started.runId)),
          };
        }).pipe(Effect.provide(harness.layer));

        expect(failures.inspected.message).toContain("no longer matches the encoded plan ordering");
        expect(failures.replayed.message).toContain("no longer matches the encoded plan ordering");
      }),
  );

  it.effect("rejects explicit resume and replay operations for malformed run identifiers", () =>
    Effect.gen(function* () {
      const harness = yield* makeTestLayer();
      const failures = yield* Effect.gen(function* () {
        const workflowRunner = yield* WorkflowRunner;
        return {
          replayed: yield* Effect.flip(workflowRunner.replayRun("run invalid")),
          resumed: yield* Effect.flip(workflowRunner.resumeRun("run invalid")),
        };
      }).pipe(Effect.provide(harness.layer));

      expect(failures.replayed.message).toContain("run identifier");
      expect(failures.resumed.message).toContain("run identifier");
    }),
  );

  it.effect(
    "rejects cancel, replay, and resume operations when the latest checkpoint token is corrupted",
    () =>
      Effect.gen(function* () {
        const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
        const compiledPlan = compiledPlans[0];
        if (compiledPlan === undefined) {
          throw new Error("Expected a compiled crawl plan.");
        }
        const harness = yield* makeTestLayer();
        const failures = yield* Effect.gen(function* () {
          const workflowRunner = yield* WorkflowRunner;
          const startedEncoded = yield* workflowRunner.start(compiledPlan.plan);
          const started = Schema.decodeUnknownSync(RunCheckpointSchema)(startedEncoded);

          yield* mutateLatestInMemoryCheckpoint(
            harness.checkpointStoreRef,
            started.runId,
            (checkpoint) => ({
              ...checkpoint,
              resumeToken: "{not-json",
            }),
          );

          return {
            cancelled: yield* Effect.flip(workflowRunner.cancelRun(started.runId)),
            replayed: yield* Effect.flip(workflowRunner.replayRun(started.runId)),
            resumed: yield* Effect.flip(workflowRunner.resumeRun(started.runId)),
          };
        }).pipe(Effect.provide(harness.layer));

        expect(failures.cancelled.message).toContain(
          "Failed to decode durable workflow resume token",
        );
        expect(failures.replayed.message).toContain(
          "Failed to decode durable workflow resume token",
        );
        expect(failures.resumed.message).toContain(
          "Failed to decode durable workflow resume token",
        );
      }),
  );

  it.effect(
    "rejects cancel, replay, and resume operations when the latest checkpoint token is missing",
    () =>
      Effect.gen(function* () {
        const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
        const compiledPlan = compiledPlans[0];
        if (compiledPlan === undefined) {
          throw new Error("Expected a compiled crawl plan.");
        }
        const harness = yield* makeTestLayer();
        const failures = yield* Effect.gen(function* () {
          const workflowRunner = yield* WorkflowRunner;
          const startedEncoded = yield* workflowRunner.start(compiledPlan.plan);
          const started = Schema.decodeUnknownSync(RunCheckpointSchema)(startedEncoded);

          yield* mutateLatestInMemoryCheckpoint(
            harness.checkpointStoreRef,
            started.runId,
            (checkpoint) => {
              const { resumeToken: _resumeToken, ...checkpointWithoutResumeToken } = checkpoint;
              return checkpointWithoutResumeToken;
            },
          );

          return {
            cancelled: yield* Effect.flip(workflowRunner.cancelRun(started.runId)),
            replayed: yield* Effect.flip(workflowRunner.replayRun(started.runId)),
            resumed: yield* Effect.flip(workflowRunner.resumeRun(started.runId)),
          };
        }).pipe(Effect.provide(harness.layer));

        expect(failures.cancelled.message).toContain(
          "require a resume token for operator control operations",
        );
        expect(failures.replayed.message).toContain(
          "require a resume token for deterministic replay",
        );
        expect(failures.resumed.message).toContain(
          "require a resume token for operator control operations",
        );
      }),
  );

  it.effect("rejects resume attempts when the checkpoint token is missing", () =>
    Effect.gen(function* () {
      const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
      const compiledPlan = compiledPlans[0];
      if (compiledPlan === undefined) {
        throw new Error("Expected a compiled crawl plan.");
      }
      const harness = yield* makeTestLayer();
      const failure = yield* Effect.gen(function* () {
        const workflowRunner = yield* WorkflowRunner;
        const startedEncoded = yield* workflowRunner.start(compiledPlan.plan);
        const { resumeToken: _resumeToken, ...corruptedCheckpoint } = startedEncoded;

        return yield* Effect.flip(workflowRunner.resume(corruptedCheckpoint));
      }).pipe(Effect.provide(harness.layer));

      expect(failure.message).toContain("require a resume token");
    }),
  );

  it.effect("returns none when operators inspect an unknown run id", () =>
    Effect.gen(function* () {
      const harness = yield* makeTestLayer();
      const inspected = yield* Effect.gen(function* () {
        const workflowRunner = yield* WorkflowRunner;
        return yield* workflowRunner.inspect("run-missing");
      }).pipe(Effect.provide(harness.layer));

      expect(Option.isNone(inspected)).toBe(true);
    }),
  );

  it.effect("rejects inspection when the latest checkpoint resume token is corrupted", () =>
    Effect.gen(function* () {
      const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
      const compiledPlan = compiledPlans[0];
      if (compiledPlan === undefined) {
        throw new Error("Expected a compiled crawl plan.");
      }
      const harness = yield* makeTestLayer();
      const failure = yield* Effect.gen(function* () {
        const workflowRunner = yield* WorkflowRunner;
        const startedEncoded = yield* workflowRunner.start(compiledPlan.plan);
        const started = Schema.decodeUnknownSync(RunCheckpointSchema)(startedEncoded);

        yield* Ref.update(harness.checkpointStoreRef, (records) =>
          records.map((record) =>
            record.runId === started.runId
              ? Schema.decodeUnknownSync(CheckpointRecordSchema)({
                  ...Schema.encodeSync(CheckpointRecordSchema)(record),
                  checkpoint: {
                    ...Schema.encodeSync(RunCheckpointSchema)(record.checkpoint),
                    resumeToken: "{not-json",
                  },
                })
              : record,
          ),
        );

        return yield* Effect.flip(workflowRunner.inspect(started.runId));
      }).pipe(Effect.provide(harness.layer));

      expect(failure.message).toContain("Failed to decode durable workflow resume token");
    }),
  );

  it.effect(
    "fails SQLite-backed resume across runtime restarts when the latest checkpoint is corrupted",
    () =>
      withSqliteDatabaseFile((databaseFilename) =>
        Effect.gen(function* () {
          const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
          const compiledPlan = compiledPlans[0];
          if (compiledPlan === undefined) {
            throw new Error("Expected a compiled crawl plan.");
          }

          const startedHarness = yield* makeSqliteTestLayer(databaseFilename);
          const started = yield* Effect.gen(function* () {
            const workflowRunner = yield* WorkflowRunner;
            const checkpoint = yield* workflowRunner.start(compiledPlan.plan);
            return Schema.decodeUnknownSync(RunCheckpointSchema)(checkpoint);
          }).pipe(Effect.provide(startedHarness.layer));

          expect(started.sequence).toBe(1);
          expect(started.stage).toBe("snapshot");
          expect(yield* Ref.get(startedHarness.browserCallsRef)).toEqual(["target-search-001"]);

          const resumedHarness = yield* makeSqliteTestLayer(databaseFilename);
          const resumed = yield* Effect.gen(function* () {
            const workflowRunner = yield* WorkflowRunner;
            return yield* workflowRunner.resumeRun(compiledPlan.plan.id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new Error("Expected SQLite-backed durable workflow resumeRun to resolve"),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            );
          }).pipe(Effect.provide(resumedHarness.layer));

          expect(Schema.encodeSync(WorkflowControlResultSchema)(resumed)).toMatchObject({
            operation: "resume",
            sourceCheckpointId: started.id,
            requestedRunId: compiledPlan.plan.id,
            resolvedRunId: compiledPlan.plan.id,
            checkpoint: {
              sequence: 2,
              stage: "quality",
            },
          });
          expect(yield* Ref.get(resumedHarness.browserCallsRef)).toEqual([]);

          yield* corruptLatestSqliteCheckpoint(databaseFilename, compiledPlan.plan.id);

          const recoveredHarness = yield* makeSqliteTestLayer(databaseFilename);
          const recoveryFailure = yield* Effect.gen(function* () {
            const workflowRunner = yield* WorkflowRunner;
            return yield* Effect.flip(workflowRunner.resumeRun(compiledPlan.plan.id));
          }).pipe(Effect.provide(recoveredHarness.layer));

          expect(recoveryFailure.message).toContain(
            "Failed to restore the latest durable workflow checkpoint",
          );
          expect(yield* Ref.get(recoveredHarness.browserCallsRef)).toEqual([]);
        }),
      ),
  );

  it.effect(
    "persists deterministic failure inspection snapshots for operators and SDK clients",
    () =>
      Effect.gen(function* () {
        const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
        const compiledPlan = compiledPlans[0];
        if (compiledPlan === undefined) {
          throw new Error("Expected a compiled crawl plan.");
        }
        const harness = yield* makeTestLayer({
          extractorFailureMessage: "Synthetic extractor failure for inspection replay.",
        });
        const { failure, inspected } = yield* Effect.gen(function* () {
          const workflowRunner = yield* WorkflowRunner;
          const startFailure = yield* Effect.flip(workflowRunner.start(compiledPlan.plan));
          const inspection = yield* workflowRunner.inspect(compiledPlan.plan.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new Error("Expected failed workflow inspection to resolve")),
                onSome: Effect.succeed,
              }),
            ),
          );

          return {
            failure: startFailure,
            inspected: inspection,
          };
        }).pipe(Effect.provide(harness.layer));

        expect(failure.message).toContain("Synthetic extractor failure");
        expect(Schema.encodeSync(WorkflowInspectionSnapshotSchema)(inspected)).toEqual({
          runId: compiledPlan.plan.id,
          planId: compiledPlan.plan.id,
          targetId: compiledPlan.plan.targetId,
          packId: compiledPlan.plan.packId,
          accessPolicyId: compiledPlan.plan.accessPolicyId,
          concurrencyBudgetId: compiledPlan.plan.concurrencyBudgetId,
          entryUrl: compiledPlan.plan.entryUrl,
          status: "failed",
          stage: "extract",
          nextStepId: "step-extract",
          startedAt: CREATED_AT,
          updatedAt: CREATED_AT,
          storedAt: CREATED_AT,
          stats: {
            runId: compiledPlan.plan.id,
            plannedSteps: 6,
            completedSteps: 1,
            checkpointCount: 1,
            artifactCount: 1,
            outcome: "failed",
            startedAt: CREATED_AT,
            updatedAt: CREATED_AT,
          },
          progress: {
            plannedSteps: 6,
            completedSteps: 1,
            pendingSteps: 5,
            checkpointCount: 1,
            artifactCount: 1,
            completionRatio: 1 / 6,
            completedStepIds: ["step-capture"],
            pendingStepIds: [
              "step-extract",
              "step-snapshot",
              "step-diff",
              "step-quality",
              "step-reflect",
            ],
          },
          budget: {
            maxAttempts: 3,
            configuredTimeoutMs: 20_000,
            elapsedMs: 0,
            remainingTimeoutMs: 20_000,
            timeoutUtilization: 0,
            checkpointInterval: 2,
            stepsUntilNextCheckpoint: 2,
          },
          error: {
            code: "parser_failure",
            retryable: false,
            message: "Synthetic extractor failure for inspection replay.",
          },
        });
      }),
  );

  it.effect("fails when a workflow step loses its work claim before completion", () =>
    Effect.gen(function* () {
      const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
      const compiledPlan = compiledPlans[0];
      if (compiledPlan === undefined) {
        throw new Error("Expected a compiled crawl plan.");
      }

      const harness = yield* makeTestLayer({
        workflowWorkClaimStoreFactory: () =>
          makeInMemoryWorkflowWorkClaimStore().pipe(
            Effect.map((workflowWorkClaimStore) =>
              WorkflowWorkClaimStore.of({
                ...workflowWorkClaimStore,
                complete: () => Effect.succeed(Option.none()),
              }),
            ),
          ),
      });
      const { checkpoints, inspection, startFailure } = yield* Effect.gen(function* () {
        const workflowRunner = yield* WorkflowRunner;
        const startFailure = yield* Effect.flip(workflowRunner.start(compiledPlan.plan));
        const checkpoints = yield* Ref.get(harness.checkpointStoreRef);
        const inspection = yield* workflowRunner.inspect(compiledPlan.plan.id);

        return {
          checkpoints,
          inspection,
          startFailure,
        };
      }).pipe(Effect.provide(harness.layer));

      expect(startFailure.message).toContain("lost its work claim before completion");
      expect(checkpoints).toHaveLength(0);
      expect(inspection).toEqual(Option.none());
    }),
  );

  it.effect(
    "rejects a concurrent duplicate runner while another runtime still holds the step claim",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
          const compiledPlan = compiledPlans[0];
          if (compiledPlan === undefined) {
            throw new Error("Expected a compiled crawl plan.");
          }

          const captureBlocker = yield* Deferred.make<void>();
          const sharedCheckpointStoreRef = yield* Ref.make(
            [] as ReadonlyArray<Schema.Schema.Type<typeof CheckpointRecordSchema>>,
          );
          const sharedClaimStore = yield* makeInMemoryWorkflowWorkClaimStore();
          const runnerA = yield* makeTestLayer({
            captureBlocker,
            checkpointStoreRef: sharedCheckpointStoreRef,
            runnerInstanceId: "runner-a",
            workflowWorkClaimStoreFactory: () => Effect.succeed(sharedClaimStore),
          });
          const runnerB = yield* makeTestLayer({
            checkpointStoreRef: sharedCheckpointStoreRef,
            runnerInstanceId: "runner-b",
            workflowWorkClaimStoreFactory: () => Effect.succeed(sharedClaimStore),
          });

          yield* Effect.gen(function* () {
            const workflowRunner = yield* WorkflowRunner;
            return yield* workflowRunner.start(compiledPlan.plan);
          }).pipe(Effect.provide(runnerA.layer), Effect.asVoid, Effect.forkScoped);

          yield* Effect.yieldNow;

          const duplicateFailure = yield* Effect.gen(function* () {
            const workflowRunner = yield* WorkflowRunner;
            return yield* Effect.flip(workflowRunner.start(compiledPlan.plan));
          }).pipe(Effect.provide(runnerB.layer));

          expect(duplicateFailure.message).toContain("already claimed");

          yield* Deferred.succeed(captureBlocker, undefined);
          const checkpoints = yield* (function awaitCheckpoint(
            attemptsRemaining: number,
          ): Effect.Effect<
            ReadonlyArray<Schema.Schema.Type<typeof CheckpointRecordSchema>>,
            Error
          > {
            return Effect.gen(function* () {
              const records = yield* Ref.get(runnerA.checkpointStoreRef);
              if (records.length > 0) {
                return records;
              }

              if (attemptsRemaining === 0) {
                return yield* Effect.fail(
                  new Error("Expected the claimed workflow runner to persist a checkpoint."),
                );
              }

              yield* Effect.yieldNow;
              return yield* awaitCheckpoint(attemptsRemaining - 1);
            });
          })(10);
          expect(Schema.encodeSync(RunCheckpointSchema)(checkpoints[0]!.checkpoint)).toMatchObject({
            id: `checkpoint-${compiledPlan.plan.id}-0001`,
            runId: compiledPlan.plan.id,
            sequence: 1,
            stage: "snapshot",
            nextStepId: "step-snapshot",
          });
          expect(checkpoints).toHaveLength(1);
          expect(yield* Ref.get(runnerA.browserCallsRef)).toEqual([compiledPlan.plan.targetId]);
          expect(yield* Ref.get(runnerB.browserCallsRef)).toEqual([]);
        }),
      ),
  );

  it.effect(
    "defers a running workflow without advancing steps and keeps the control auditable",
    () =>
      Effect.gen(function* () {
        const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
        const compiledPlan = compiledPlans[0];
        if (compiledPlan === undefined) {
          throw new Error("Expected a compiled crawl plan.");
        }
        const startedCheckpointId = `checkpoint-${compiledPlan.plan.id}-0001`;
        const harness = yield* makeTestLayer();
        const { deferred, deferredInspection, resumed } = yield* Effect.gen(function* () {
          const workflowRunner = yield* WorkflowRunner;
          const startedEncoded = yield* workflowRunner.start(compiledPlan.plan);
          const started = Schema.decodeUnknownSync(RunCheckpointSchema)(startedEncoded);
          const deferred = yield* workflowRunner.deferRun(compiledPlan.plan.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new Error("Expected deferRun to resolve a run")),
                onSome: Effect.succeed,
              }),
            ),
          );
          const deferredInspection = yield* workflowRunner.inspect(compiledPlan.plan.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new Error("Expected deferred workflow inspection to resolve")),
                onSome: Effect.succeed,
              }),
            ),
          );
          const resumed = yield* workflowRunner.resumeRun(compiledPlan.plan.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new Error("Expected resumeRun after defer to resolve")),
                onSome: Effect.succeed,
              }),
            ),
          );

          expect(started.id).toBe(startedCheckpointId);
          return {
            deferred,
            deferredInspection,
            resumed,
          };
        }).pipe(Effect.provide(harness.layer));

        const deferredEncoded = Schema.encodeSync(WorkflowControlResultSchema)(deferred);
        expect(deferredEncoded.operation).toBe("defer");
        expect(deferredEncoded.requestedRunId).toBe(compiledPlan.plan.id);
        expect(deferredEncoded.resolvedRunId).toBe(compiledPlan.plan.id);
        expect(deferredEncoded.sourceCheckpointId).toBe(startedCheckpointId);
        expect(deferredEncoded.checkpoint.sequence).toBe(2);
        expect(deferredEncoded.checkpoint.stage).toBe("snapshot");
        expect(deferredEncoded.checkpoint.completedStepIds).toEqual([
          "step-capture",
          "step-extract",
        ]);
        expect(deferredEncoded.checkpoint.pendingStepIds).toEqual([
          "step-snapshot",
          "step-diff",
          "step-quality",
          "step-reflect",
        ]);
        expect(deferredEncoded.checkpoint.control).toEqual({
          operation: "defer",
          sourceCheckpointId: startedCheckpointId,
          requestedAt: "2026-03-07T12:30:01.000Z",
        });
        expect(
          Schema.encodeSync(WorkflowInspectionSnapshotSchema)(deferredInspection),
        ).toMatchObject({
          runId: compiledPlan.plan.id,
          status: "running",
          stage: "snapshot",
          nextStepId: "step-snapshot",
          control: {
            operation: "defer",
            sourceCheckpointId: startedCheckpointId,
            requestedAt: "2026-03-07T12:30:01.000Z",
          },
        });

        const resumedEncoded = Schema.encodeSync(WorkflowControlResultSchema)(resumed);
        expect(resumedEncoded.operation).toBe("resume");
        expect(resumedEncoded.sourceCheckpointId).toBe(deferredEncoded.checkpoint.id);
        expect(resumedEncoded.checkpoint.sequence).toBe(3);
        expect(resumedEncoded.checkpoint.stage).toBe("quality");
        expect(resumedEncoded.checkpoint.control).toBeUndefined();
        expect(yield* Ref.get(harness.checkpointStoreRef)).toHaveLength(3);
      }),
  );

  it.effect("keeps deferred workflows idempotent under repeated defer requests", () =>
    Effect.gen(function* () {
      const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
      const compiledPlan = compiledPlans[0];
      if (compiledPlan === undefined) {
        throw new Error("Expected a compiled crawl plan.");
      }

      const harness = yield* makeTestLayer();
      const { firstDeferred, secondDeferred, inspection, afterFirstDefer, afterSecondDefer } =
        yield* Effect.gen(function* () {
          const workflowRunner = yield* WorkflowRunner;
          yield* workflowRunner.start(compiledPlan.plan);
          const firstDeferred = yield* workflowRunner.deferRun(compiledPlan.plan.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new Error("Expected first deferRun to resolve")),
                onSome: Effect.succeed,
              }),
            ),
          );
          const afterFirstDefer = yield* Ref.get(harness.checkpointStoreRef);
          const secondDeferred = yield* workflowRunner.deferRun(compiledPlan.plan.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new Error("Expected second deferRun to resolve")),
                onSome: Effect.succeed,
              }),
            ),
          );
          const afterSecondDefer = yield* Ref.get(harness.checkpointStoreRef);
          const inspection = yield* workflowRunner.inspect(compiledPlan.plan.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new Error("Expected deferred workflow inspection to resolve")),
                onSome: Effect.succeed,
              }),
            ),
          );

          return {
            firstDeferred,
            secondDeferred,
            inspection,
            afterFirstDefer,
            afterSecondDefer,
          };
        }).pipe(Effect.provide(harness.layer));

      const firstEncoded = Schema.encodeSync(WorkflowControlResultSchema)(firstDeferred);
      const secondEncoded = Schema.encodeSync(WorkflowControlResultSchema)(secondDeferred);

      expect(firstEncoded).toEqual(secondEncoded);
      expect(firstEncoded.operation).toBe("defer");
      expect(firstEncoded.checkpoint.sequence).toBe(2);
      expect(afterFirstDefer).toHaveLength(2);
      expect(afterSecondDefer).toHaveLength(2);
      expect(Schema.encodeSync(WorkflowInspectionSnapshotSchema)(inspection)).toMatchObject({
        runId: compiledPlan.plan.id,
        status: "running",
        stage: "snapshot",
        control: {
          operation: "defer",
          sourceCheckpointId: firstEncoded.sourceCheckpointId,
          requestedAt: "2026-03-07T12:30:01.000Z",
        },
      });
    }),
  );

  it.effect("cancels a workflow and rejects later resume attempts", () =>
    Effect.gen(function* () {
      const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
      const compiledPlan = compiledPlans[0];
      if (compiledPlan === undefined) {
        throw new Error("Expected a compiled crawl plan.");
      }
      const startedCheckpointId = `checkpoint-${compiledPlan.plan.id}-0001`;
      const harness = yield* makeTestLayer();
      const { cancelled, inspection, resumeFailure } = yield* Effect.gen(function* () {
        const workflowRunner = yield* WorkflowRunner;
        yield* workflowRunner.start(compiledPlan.plan);
        const cancelled = yield* workflowRunner.cancelRun(compiledPlan.plan.id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new Error("Expected cancelRun to resolve a run")),
              onSome: Effect.succeed,
            }),
          ),
        );
        const inspection = yield* workflowRunner.inspect(compiledPlan.plan.id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new Error("Expected cancelled workflow inspection to resolve")),
              onSome: Effect.succeed,
            }),
          ),
        );

        return {
          cancelled,
          inspection,
          resumeFailure: yield* Effect.flip(workflowRunner.resumeRun(compiledPlan.plan.id)),
        };
      }).pipe(Effect.provide(harness.layer));

      const cancelledEncoded = Schema.encodeSync(WorkflowControlResultSchema)(cancelled);
      expect(cancelledEncoded.operation).toBe("cancel");
      expect(cancelledEncoded.sourceCheckpointId).toBe(startedCheckpointId);
      expect(cancelledEncoded.checkpoint.stats.outcome).toBe("cancelled");
      expect(cancelledEncoded.checkpoint.control).toEqual({
        operation: "cancel",
        sourceCheckpointId: startedCheckpointId,
        requestedAt: "2026-03-07T12:30:01.000Z",
      });
      expect(Schema.encodeSync(WorkflowInspectionSnapshotSchema)(inspection)).toMatchObject({
        runId: compiledPlan.plan.id,
        status: "cancelled",
        stage: "snapshot",
        control: {
          operation: "cancel",
          sourceCheckpointId: startedCheckpointId,
          requestedAt: "2026-03-07T12:30:01.000Z",
        },
      });
      expect(resumeFailure.message).toContain("was cancelled and cannot be resumed");
    }),
  );

  it.effect("returns an auditable control result for legacy cancelled checkpoints", () =>
    Effect.gen(function* () {
      const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
      const compiledPlan = compiledPlans[0];
      if (compiledPlan === undefined) {
        throw new Error("Expected a compiled crawl plan.");
      }
      const startedCheckpointId = `checkpoint-${compiledPlan.plan.id}-0001`;
      const harness = yield* makeTestLayer();
      const cancelled = yield* Effect.gen(function* () {
        const workflowRunner = yield* WorkflowRunner;
        yield* workflowRunner.start(compiledPlan.plan);
        yield* Ref.update(harness.checkpointStoreRef, (records) =>
          records.map((record) =>
            record.runId === compiledPlan.plan.id
              ? Schema.decodeUnknownSync(CheckpointRecordSchema)({
                  ...Schema.encodeSync(CheckpointRecordSchema)(record),
                  checkpoint: {
                    ...Schema.encodeSync(RunCheckpointSchema)(record.checkpoint),
                    stats: {
                      ...Schema.encodeSync(RunCheckpointSchema)(record.checkpoint).stats,
                      outcome: "cancelled",
                    },
                  },
                })
              : record,
          ),
        );

        return yield* workflowRunner.cancelRun(compiledPlan.plan.id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new Error("Expected cancelRun to resolve a legacy cancelled run")),
              onSome: Effect.succeed,
            }),
          ),
        );
      }).pipe(Effect.provide(harness.layer));

      expect(Schema.encodeSync(WorkflowControlResultSchema)(cancelled)).toMatchObject({
        operation: "cancel",
        requestedRunId: compiledPlan.plan.id,
        resolvedRunId: compiledPlan.plan.id,
        sourceCheckpointId: startedCheckpointId,
        checkpoint: {
          stats: {
            outcome: "cancelled",
          },
          control: {
            operation: "cancel",
            sourceCheckpointId: startedCheckpointId,
            requestedAt: CREATED_AT,
          },
        },
      });
    }),
  );

  it.effect("retries only retryable failed workflows through the control surface", () =>
    Effect.gen(function* () {
      const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
      const compiledPlan = compiledPlans[0];
      if (compiledPlan === undefined) {
        throw new Error("Expected a compiled crawl plan.");
      }
      const startedCheckpointId = `checkpoint-${compiledPlan.plan.id}-0001`;

      const retryableHarness = yield* makeTestLayer({
        browserTimeoutOnFirstCapture: true,
      });
      const retryable = yield* Effect.gen(function* () {
        const workflowRunner = yield* WorkflowRunner;
        const startFailure = yield* Effect.flip(workflowRunner.start(compiledPlan.plan));
        const retried = yield* workflowRunner.retryRun(compiledPlan.plan.id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new Error("Expected retryRun to resolve a run")),
              onSome: Effect.succeed,
            }),
          ),
        );
        const inspection = yield* workflowRunner.inspect(compiledPlan.plan.id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new Error("Expected retried workflow inspection to resolve")),
              onSome: Effect.succeed,
            }),
          ),
        );
        return {
          inspection,
          retried,
          startFailure,
        };
      }).pipe(Effect.provide(retryableHarness.layer));

      expect(retryable.startFailure.message).toContain("Synthetic access timeout");
      expect(Schema.encodeSync(WorkflowControlResultSchema)(retryable.retried)).toMatchObject({
        operation: "retry",
        requestedRunId: compiledPlan.plan.id,
        resolvedRunId: compiledPlan.plan.id,
        sourceCheckpointId: startedCheckpointId,
        checkpoint: {
          sequence: 2,
          stage: "snapshot",
          control: {
            operation: "retry",
            sourceCheckpointId: startedCheckpointId,
            requestedAt: "2026-03-07T12:30:01.000Z",
          },
        },
      });
      expect(
        Schema.encodeSync(WorkflowInspectionSnapshotSchema)(retryable.inspection),
      ).toMatchObject({
        runId: compiledPlan.plan.id,
        status: "running",
        stage: "snapshot",
        control: {
          operation: "retry",
        },
      });

      const nonRetryableHarness = yield* makeTestLayer({
        extractorFailureMessage: "Synthetic extractor failure for inspection replay.",
      });
      const nonRetryableFailure = yield* Effect.gen(function* () {
        const workflowRunner = yield* WorkflowRunner;
        yield* Effect.flip(workflowRunner.start(compiledPlan.plan));
        return yield* Effect.flip(workflowRunner.retryRun(compiledPlan.plan.id));
      }).pipe(Effect.provide(nonRetryableHarness.layer));

      expect(nonRetryableFailure.message).toContain("requires a retryable failure envelope");
    }),
  );

  it.effect("rejects resumeRun on failed workflows and preserves the failed checkpoint", () =>
    Effect.gen(function* () {
      const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
      const compiledPlan = compiledPlans[0];
      if (compiledPlan === undefined) {
        throw new Error("Expected a compiled crawl plan.");
      }

      const harness = yield* makeTestLayer({
        browserTimeoutOnFirstCapture: true,
      });
      const { startFailure, resumeFailure, inspection, checkpoints } = yield* Effect.gen(
        function* () {
          const workflowRunner = yield* WorkflowRunner;
          const startFailure = yield* Effect.flip(workflowRunner.start(compiledPlan.plan));
          const resumeFailure = yield* Effect.flip(workflowRunner.resumeRun(compiledPlan.plan.id));
          const inspection = yield* workflowRunner.inspect(compiledPlan.plan.id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new Error("Expected failed workflow inspection to resolve")),
                onSome: Effect.succeed,
              }),
            ),
          );

          return {
            startFailure,
            resumeFailure,
            inspection,
            checkpoints: yield* Ref.get(harness.checkpointStoreRef),
          };
        },
      ).pipe(Effect.provide(harness.layer));

      expect(startFailure.message).toContain("Synthetic access timeout for controlled retry.");
      expect(resumeFailure.message).toContain(
        "require explicit retryRun control instead of resume",
      );
      expect(checkpoints).toHaveLength(1);
      expect(Schema.encodeSync(WorkflowInspectionSnapshotSchema)(inspection)).toMatchObject({
        runId: compiledPlan.plan.id,
        status: "failed",
        stage: "capture",
        error: {
          retryable: true,
          message: "Synthetic access timeout for controlled retry.",
        },
      });
    }),
  );
});
