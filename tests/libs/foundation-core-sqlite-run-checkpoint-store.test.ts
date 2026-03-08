import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Layer, Option, Ref, Schema } from "effect";
import {
  ArtifactMetadataRecordSchema,
  ArtifactMetadataStore,
  CheckpointRecordSchema,
  RunCheckpointStore,
  checkpointPayloadSha256,
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
  RunPlanSchema,
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

const CREATED_AT = "2026-03-08T04:00:00.000Z";

const pack = Schema.decodeUnknownSync(SitePackSchema)({
  id: "pack-example-com",
  domainPattern: "*.example.com",
  state: "shadow",
  accessPolicyId: "policy-browser",
  version: "2026.03.08",
});

const storedRunPlan = Schema.decodeUnknownSync(RunPlanSchema)({
  id: "plan-sqlite-001",
  targetId: "target-sqlite-001",
  packId: pack.id,
  accessPolicyId: "policy-browser",
  concurrencyBudgetId: "budget-sqlite-001",
  entryUrl: "https://example.com/products/sqlite-001",
  maxAttempts: 2,
  timeoutMs: 20_000,
  checkpointInterval: 2,
  steps: [
    {
      id: "step-capture",
      stage: "capture",
      requiresBrowser: true,
      artifactKind: "renderedDom",
    },
    {
      id: "step-extract",
      stage: "extract",
      requiresBrowser: false,
    },
    {
      id: "step-snapshot",
      stage: "snapshot",
      requiresBrowser: false,
    },
    {
      id: "step-diff",
      stage: "diff",
      requiresBrowser: false,
    },
    {
      id: "step-quality",
      stage: "quality",
      requiresBrowser: false,
    },
    {
      id: "step-reflect",
      stage: "reflect",
      requiresBrowser: false,
    },
  ],
  createdAt: CREATED_AT,
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
          id: "target-sqlite-001",
          tenantId: "tenant-main",
          domain: "example.com",
          kind: "productPage",
          canonicalKey: "products/sqlite-001",
          seedUrls: ["https://example.com/products/sqlite-001"],
          accessPolicyId: "policy-browser",
          packId: pack.id,
          priority: 100,
        },
        pack,
        accessPolicy: {
          id: "policy-browser",
          mode: "browser",
          perDomainConcurrency: 2,
          globalConcurrency: 4,
          timeoutMs: 20_000,
          maxRetries: 2,
          render: "always",
        },
      },
    ],
  });
}

function makeArtifact(plan: Schema.Schema.Type<typeof RunPlanSchema>) {
  return Schema.decodeUnknownSync(ArtifactMetadataRecordSchema)({
    id: `artifact-record-${plan.targetId}`,
    runId: plan.id,
    artifactId: `artifact-${plan.targetId}`,
    kind: "renderedDom",
    visibility: "redacted",
    locator: {
      namespace: `artifacts/${plan.targetId}`,
      key: `${plan.id}/capture.html`,
    },
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    sizeBytes: 2048,
    mediaType: "text/html",
    storedAt: CREATED_AT,
  });
}

function makeSnapshot(plan: Schema.Schema.Type<typeof RunPlanSchema>, artifactId: string) {
  return Schema.decodeUnknownSync(SnapshotSchema)({
    id: `snapshot-${plan.targetId}`,
    targetId: plan.targetId,
    observations: [
      {
        field: "price",
        normalizedValue: {
          amount: 1499.99,
          currency: "CZK",
        },
        confidence: 0.98,
        evidenceRefs: [artifactId],
      },
    ],
    qualityScore: 0.97,
    createdAt: CREATED_AT,
  });
}

function makeCheckpointRecord(sequence: number) {
  const checkpoint = Schema.decodeUnknownSync(RunCheckpointSchema)({
    id: `checkpoint-run-sqlite-001-${sequence.toString().padStart(4, "0")}`,
    runId: "run-sqlite-001",
    planId: "plan-sqlite-001",
    sequence,
    stage: sequence === 1 ? "snapshot" : "quality",
    ...(sequence === 1 ? { nextStepId: "step-snapshot" } : { nextStepId: "step-quality" }),
    completedStepIds:
      sequence === 1
        ? ["step-capture", "step-extract"]
        : ["step-capture", "step-extract", "step-snapshot", "step-diff"],
    pendingStepIds:
      sequence === 1
        ? ["step-snapshot", "step-diff", "step-quality", "step-reflect"]
        : ["step-quality", "step-reflect"],
    artifactIds: ["artifact-target-sqlite-001"],
    resumeToken: JSON.stringify({
      runId: "run-sqlite-001",
      plan: Schema.encodeSync(RunPlanSchema)(storedRunPlan),
      extractedSnapshot: {
        id: "snapshot-target-sqlite-001",
        targetId: "target-sqlite-001",
        observations: [
          {
            field: "price",
            normalizedValue: {
              amount: 1499.99,
              currency: "CZK",
            },
            confidence: 0.98,
            evidenceRefs: ["artifact-target-sqlite-001"],
          },
        ],
        qualityScore: 0.97,
        createdAt: CREATED_AT,
      },
    }),
    stats: {
      runId: "run-sqlite-001",
      plannedSteps: 6,
      completedSteps: sequence === 1 ? 2 : 4,
      checkpointCount: sequence,
      artifactCount: 1,
      outcome: "running",
      startedAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    storedAt: CREATED_AT,
  });

  return Schema.decodeUnknownSync(CheckpointRecordSchema)({
    id: checkpoint.id,
    runId: checkpoint.runId,
    planId: checkpoint.planId,
    locator: {
      namespace: "checkpoints/target-sqlite-001",
      key: `run-sqlite-001/${sequence.toString().padStart(4, "0")}.json`,
    },
    checkpoint,
    sha256: checkpointPayloadSha256(Schema.encodeSync(RunCheckpointSchema)(checkpoint)),
    encoding: "json",
    compression: "none",
    storedAt: CREATED_AT,
  });
}

function makeSqliteWorkflowLayer(filename: string) {
  return Effect.gen(function* () {
    let nowTick = 0;
    const artifactStoreRef = yield* Ref.make(
      new Map<string, Schema.Schema.Type<typeof ArtifactMetadataRecordSchema>>(),
    );
    const snapshotStoreRef = yield* Ref.make(
      new Map<string, Schema.Schema.Type<typeof SnapshotSchema>>(),
    );

    const baseLayer = Layer.mergeAll(
      Layer.succeed(HttpAccess)(
        HttpAccess.of({
          capture: (plan) => Effect.succeed([makeArtifact(plan)]),
        }),
      ),
      Layer.succeed(BrowserAccess)(
        BrowserAccess.of({
          capture: (plan) => Effect.succeed([makeArtifact(plan)]),
        }),
      ),
      Layer.succeed(CaptureStore)(
        CaptureStore.of({
          persist: (artifacts) => Effect.succeed(artifacts),
        }),
      ),
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
      Layer.succeed(Extractor)(
        Extractor.of({
          extract: (plan, artifacts) =>
            Effect.succeed(makeSnapshot(plan, artifacts[0]!.artifactId)),
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
                  fieldRecallDelta: 0.01,
                  falsePositiveDelta: -0.01,
                  driftDelta: -0.01,
                  latencyDeltaMs: -25,
                  memoryDelta: -4,
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
          getByDomain: () => Effect.succeed(Option.some(pack)),
          getById: (packId) =>
            Effect.succeed(packId === pack.id ? Option.some(pack) : Option.none()),
        }),
      ),
      Layer.succeed(ReflectionEngine)(
        ReflectionEngine.of({
          decide: (_pack, verdict) =>
            Effect.succeed(
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
        }),
      ),
      SqliteRunCheckpointStoreLive({ filename }),
    );

    return Layer.mergeAll(
      baseLayer,
      DurableWorkflowRuntimeLive({
        now: () => new Date(Date.parse(CREATED_AT) + nowTick++ * 1_000),
        resolveBaselineSnapshot: ({ candidateSnapshot }) =>
          Effect.succeed(
            Schema.decodeUnknownSync(SnapshotSchema)({
              id: `baseline-${candidateSnapshot.id}`,
              targetId: candidateSnapshot.targetId,
              observations: candidateSnapshot.observations,
              qualityScore: candidateSnapshot.qualityScore,
              createdAt: CREATED_AT,
            }),
          ),
      }).pipe(Layer.provide(baseLayer)),
    );
  });
}

describe("foundation-core sqlite run checkpoint store", () => {
  it.effect("persists checkpoint records across reopened SQLite handles", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "checkpoint-sqlite-")));
      const filename = join(directory, "run-checkpoints.sqlite");
      const firstRecord = makeCheckpointRecord(1);
      const secondRecord = makeCheckpointRecord(2);

      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* RunCheckpointStore;
            yield* store.put(firstRecord);
            yield* store.put(secondRecord);
          }).pipe(Effect.provide(SqliteRunCheckpointStoreLive({ filename }))),
        );

        const persisted = yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* RunCheckpointStore;
            const latest = yield* store.latest(firstRecord.runId);
            const byId = yield* store.getById(firstRecord.id);

            return { byId, latest };
          }).pipe(Effect.provide(SqliteRunCheckpointStoreLive({ filename }))),
        );

        expect(Option.getOrUndefined(persisted.byId)).toEqual(firstRecord);
        expect(Option.getOrUndefined(persisted.latest)).toEqual(secondRecord);
      } finally {
        yield* Effect.promise(() => rm(directory, { force: true, recursive: true }));
      }
    }),
  );

  it.effect(
    "resumes a durable workflow from the latest persisted SQLite checkpoint after rebuilding the runtime layer",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "workflow-sqlite-")));
        const filename = join(directory, "workflow-checkpoints.sqlite");
        const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
        const compiledPlan = compiledPlans[0];

        if (compiledPlan === undefined) {
          throw new Error("Expected a compiled crawl plan.");
        }

        try {
          const firstLayer = yield* makeSqliteWorkflowLayer(filename);
          const started = yield* Effect.gen(function* () {
            const workflowRunner = yield* WorkflowRunner;
            return Schema.decodeUnknownSync(RunCheckpointSchema)(
              yield* workflowRunner.start(compiledPlan.plan),
            );
          }).pipe(Effect.provide(firstLayer));

          expect(started.sequence).toBe(1);
          expect(started.stage).toBe("snapshot");

          const secondLayer = yield* makeSqliteWorkflowLayer(filename);
          const resumedAfterRestart = yield* Effect.gen(function* () {
            const workflowRunner = yield* WorkflowRunner;
            return yield* workflowRunner.resumeRun(compiledPlan.plan.id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(new Error("Expected sqlite-backed resumeRun to resolve.")),
                  onSome: Effect.succeed,
                }),
              ),
            );
          }).pipe(Effect.provide(secondLayer));

          expect(resumedAfterRestart.sourceCheckpointId).toBe(started.id);
          expect(resumedAfterRestart.checkpoint.sequence).toBe(2);
          expect(resumedAfterRestart.resolvedRunId).toBe(compiledPlan.plan.id);

          const finished = yield* Effect.gen(function* () {
            const workflowRunner = yield* WorkflowRunner;
            return yield* workflowRunner.resumeRun(compiledPlan.plan.id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(new Error("Expected sqlite-backed final resumeRun to resolve.")),
                  onSome: Effect.succeed,
                }),
              ),
            );
          }).pipe(Effect.provide(secondLayer));
          const inspected = yield* Effect.gen(function* () {
            const workflowRunner = yield* WorkflowRunner;
            return yield* workflowRunner.inspect(compiledPlan.plan.id).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(new Error("Expected sqlite-backed inspection to resolve.")),
                  onSome: Effect.succeed,
                }),
              ),
            );
          }).pipe(Effect.provide(secondLayer));

          expect(finished.checkpoint.sequence).toBe(3);
          expect(finished.checkpoint.stats.outcome).toBe("succeeded");
          expect(inspected).toEqual(
            expect.objectContaining(
              Schema.decodeUnknownSync(WorkflowInspectionSnapshotSchema)({
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
                updatedAt: inspected.updatedAt,
                storedAt: inspected.storedAt,
                stats: {
                  runId: compiledPlan.plan.id,
                  plannedSteps: compiledPlan.plan.steps.length,
                  completedSteps: compiledPlan.plan.steps.length,
                  checkpointCount: 3,
                  artifactCount: 1,
                  outcome: "succeeded",
                  startedAt: CREATED_AT,
                  updatedAt: inspected.stats.updatedAt,
                },
                progress: {
                  plannedSteps: compiledPlan.plan.steps.length,
                  completedSteps: compiledPlan.plan.steps.length,
                  pendingSteps: 0,
                  checkpointCount: 3,
                  artifactCount: 1,
                  completionRatio: 1,
                  completedStepIds: inspected.progress.completedStepIds,
                  pendingStepIds: [],
                },
                budget: {
                  maxAttempts: inspected.budget.maxAttempts,
                  configuredTimeoutMs: compiledPlan.plan.timeoutMs,
                  elapsedMs: inspected.budget.elapsedMs,
                  remainingTimeoutMs: inspected.budget.remainingTimeoutMs,
                  timeoutUtilization: inspected.budget.timeoutUtilization,
                  checkpointInterval: compiledPlan.plan.checkpointInterval,
                  stepsUntilNextCheckpoint: 0,
                },
              }),
            ),
          );
          expect(inspected.budget.remainingTimeoutMs).toBeLessThan(compiledPlan.plan.timeoutMs);
          expect(Date.parse(inspected.updatedAt) >= Date.parse(CREATED_AT)).toBe(true);
        } finally {
          yield* Effect.promise(() => rm(directory, { force: true, recursive: true }));
        }
      }),
  );

  it.effect(
    "fails restore deterministically when every persisted SQLite checkpoint is corrupted",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "checkpoint-sqlite-")),
        );
        const filename = join(directory, "run-checkpoints.sqlite");
        const firstRecord = makeCheckpointRecord(1);
        const secondRecord = makeCheckpointRecord(2);

        try {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const store = yield* RunCheckpointStore;
              yield* store.put(firstRecord);
              yield* store.put(secondRecord);
            }).pipe(Effect.provide(SqliteRunCheckpointStoreLive({ filename }))),
          );

          const database = new Database(filename, { readonly: false, strict: true });
          try {
            database
              .query(
                "update workflow_checkpoint_records set checkpoint_sha256 = ? where run_id = ?",
              )
              .run(
                "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                firstRecord.runId,
              );
          } finally {
            database.close();
          }

          const failure = yield* Effect.scoped(
            Effect.gen(function* () {
              const store = yield* RunCheckpointStore;
              return yield* Effect.flip(store.latest(firstRecord.runId));
            }).pipe(Effect.provide(SqliteRunCheckpointStoreLive({ filename }))),
          );

          expect(failure.message).toContain(
            "Failed to restore a valid durable workflow checkpoint",
          );
        } finally {
          yield* Effect.promise(() => rm(directory, { force: true, recursive: true }));
        }
      }),
  );
});
