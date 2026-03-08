import { describe, expect, it } from "@effect-native/bun-test";
import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema } from "effect";
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
import { SnapshotSchema } from "../../libs/foundation/core/src/observation-snapshot.ts";
import { RunCheckpointSchema, RunPlanSchema } from "../../libs/foundation/core/src/run-state.ts";
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
import {
  createWorkflowBudgetRegistrations,
  makeInMemoryWorkflowBudgetScheduler,
} from "../../libs/foundation/core/src/workflow-budget-runtime.ts";

const CREATED_AT = "2026-03-08T05:00:00.000Z";

const pack = Schema.decodeUnknownSync(SitePackSchema)({
  id: "pack-example-com",
  domainPattern: "*.example.com",
  state: "shadow",
  accessPolicyId: "policy-browser",
  version: "2026.03.08",
});

function makeCompilerInput(input: {
  readonly entries: ReadonlyArray<{
    readonly domain: string;
    readonly entryUrl: string;
    readonly targetId: string;
  }>;
  readonly globalConcurrency: number;
  readonly perDomainConcurrency: number;
}) {
  return Schema.decodeUnknownSync(CrawlPlanCompilerInputSchema)({
    createdAt: CREATED_AT,
    defaults: {
      checkpointInterval: 2,
    },
    entries: input.entries.map(({ domain, entryUrl, targetId }, index) => ({
      target: {
        id: targetId,
        tenantId: "tenant-main",
        domain,
        kind: "productPage",
        canonicalKey: `products/${targetId}`,
        seedUrls: [entryUrl],
        accessPolicyId: "policy-browser",
        packId: pack.id,
        priority: 100 - index,
      },
      pack,
      accessPolicy: {
        id: "policy-browser",
        mode: "browser",
        perDomainConcurrency: input.perDomainConcurrency,
        globalConcurrency: input.globalConcurrency,
        timeoutMs: 20_000,
        maxRetries: 1,
        render: "always",
      },
    })),
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

describe("foundation-core workflow budget runtime", () => {
  it.effect("coalesces equivalent workflow budgets into shared global and per-domain pools", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const compiledPlans = yield* compileCrawlPlans(
          makeCompilerInput({
            entries: [
              {
                targetId: "target-primary",
                domain: "example.com",
                entryUrl: "https://example.com/products/primary",
              },
              {
                targetId: "target-shop",
                domain: "shop.example.com",
                entryUrl: "https://shop.example.com/products/shop",
              },
            ],
            globalConcurrency: 2,
            perDomainConcurrency: 1,
          }),
        );
        const firstPlan = compiledPlans[0]?.plan;
        const secondPlan = compiledPlans[1]?.plan;

        if (firstPlan === undefined || secondPlan === undefined) {
          throw new Error("Expected compiled plans for workflow budget scheduling.");
        }

        const scheduler = yield* makeInMemoryWorkflowBudgetScheduler(
          createWorkflowBudgetRegistrations(compiledPlans),
          () => new Date(CREATED_AT),
        );
        const releaseFirst = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const globalProbePlan = Schema.decodeUnknownSync(RunPlanSchema)({
          ...Schema.encodeSync(RunPlanSchema)(firstPlan),
          id: "plan-target-cdn-pack-example-com",
          targetId: "target-cdn",
          entryUrl: "https://cdn.example.com/products/cdn",
        });

        const firstFiber = yield* scheduler
          .withPermit(firstPlan, Deferred.await(releaseFirst))
          .pipe(Effect.forkScoped);
        const secondFiber = yield* scheduler
          .withPermit(secondPlan, Deferred.await(releaseSecond))
          .pipe(Effect.forkScoped);

        yield* Effect.yieldNow;

        const domainFailure = yield* Effect.flip(scheduler.withPermit(firstPlan, Effect.void));
        const globalFailure = yield* Effect.flip(
          scheduler.withPermit(globalProbePlan, Effect.void),
        );

        expect(domainFailure.message).toContain("denied access");
        expect(globalFailure.message).toContain("denied access");

        const snapshot = yield* scheduler.inspect(firstPlan);
        expect(snapshot.globalInUse).toBe(2);
        expect(snapshot.domains).toEqual([
          {
            domain: "example.com",
            capacity: 1,
            available: 0,
            inUse: 1,
          },
          {
            domain: "shop.example.com",
            capacity: 1,
            available: 0,
            inUse: 1,
          },
        ]);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Fiber.join(firstFiber);
        yield* Fiber.join(secondFiber);

        const releasedSnapshot = yield* scheduler.inspect(firstPlan);
        expect(releasedSnapshot.globalInUse).toBe(0);
        expect(releasedSnapshot.domains.every(({ inUse }) => inUse === 0)).toBe(true);

        const events = yield* scheduler.events();
        expect(events.map(({ kind }) => kind)).toEqual([
          "acquired",
          "acquired",
          "rejected",
          "rejected",
          "released",
          "released",
        ]);
      }),
    ),
  );

  it.effect(
    "enforces workflow budgets at durable capture boundaries and persists retryable failures",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const compiledPlans = yield* compileCrawlPlans(
            makeCompilerInput({
              entries: [
                {
                  targetId: "target-primary",
                  domain: "example.com",
                  entryUrl: "https://example.com/products/primary",
                },
                {
                  targetId: "target-secondary",
                  domain: "example.com",
                  entryUrl: "https://example.com/products/secondary",
                },
              ],
              globalConcurrency: 1,
              perDomainConcurrency: 1,
            }),
          );
          const firstCompiledPlan = compiledPlans[0];
          const secondCompiledPlan = compiledPlans[1];

          if (firstCompiledPlan === undefined || secondCompiledPlan === undefined) {
            throw new Error("Expected compiled plans for workflow budget runtime integration.");
          }

          const scheduler = yield* makeInMemoryWorkflowBudgetScheduler(
            createWorkflowBudgetRegistrations(compiledPlans),
            () => new Date(CREATED_AT),
          );
          const captureCallsRef = yield* Ref.make([] as ReadonlyArray<string>);
          const checkpointStoreRef = yield* Ref.make(
            [] as ReadonlyArray<Schema.Schema.Type<typeof CheckpointRecordSchema>>,
          );
          const artifactStoreRef = yield* Ref.make(
            new Map<string, Schema.Schema.Type<typeof ArtifactMetadataRecordSchema>>(),
          );
          const snapshotStoreRef = yield* Ref.make(
            new Map<string, Schema.Schema.Type<typeof SnapshotSchema>>(),
          );
          const releaseCapture = yield* Deferred.make<void>();

          const baseLayer = Layer.mergeAll(
            Layer.succeed(HttpAccess)(
              HttpAccess.of({
                capture: (plan) => Effect.succeed([makeArtifact(plan)]),
              }),
            ),
            Layer.succeed(BrowserAccess)(
              BrowserAccess.of({
                capture: (plan) =>
                  Effect.gen(function* () {
                    yield* Ref.update(captureCallsRef, (calls) => [...calls, plan.targetId]);
                    yield* Deferred.await(releaseCapture);
                    return [makeArtifact(plan)] as const;
                  }),
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
                compare: () => Effect.die("DiffEngine should not run before the first checkpoint."),
              }),
            ),
            Layer.succeed(QualityGate)(
              QualityGate.of({
                evaluate: () =>
                  Effect.die("QualityGate should not run before the first checkpoint."),
              }),
            ),
            Layer.succeed(PackRegistry)(
              PackRegistry.of({
                getByDomain: () => Effect.succeed(Option.some(pack)),
                getById: () => Effect.succeed(Option.some(pack)),
              }),
            ),
            Layer.succeed(ReflectionEngine)(
              ReflectionEngine.of({
                decide: () =>
                  Effect.die("ReflectionEngine should not run before the first checkpoint."),
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
                        .sort(
                          (left, right) => right.checkpoint.sequence - left.checkpoint.sequence,
                        )[0];
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
          const runtimeLayer = Layer.mergeAll(
            baseLayer,
            DurableWorkflowRuntimeLive({
              now: () => new Date(CREATED_AT),
              withWorkflowBudgetPermit: ({ effect, plan }) => scheduler.withPermit(plan, effect),
            }).pipe(Layer.provide(baseLayer)),
          );

          const firstFiber = yield* Effect.gen(function* () {
            const workflowRunner = yield* WorkflowRunner;
            return yield* workflowRunner.start(firstCompiledPlan.plan);
          }).pipe(Effect.provide(runtimeLayer), Effect.forkScoped);

          yield* Effect.yieldNow;

          const secondFailure = yield* Effect.gen(function* () {
            const workflowRunner = yield* WorkflowRunner;
            return yield* Effect.flip(workflowRunner.start(secondCompiledPlan.plan));
          }).pipe(Effect.provide(runtimeLayer));

          expect(secondFailure.message).toContain("denied access");
          expect(yield* Ref.get(captureCallsRef)).toEqual([firstCompiledPlan.plan.targetId]);

          const failedRecord = (yield* Ref.get(checkpointStoreRef)).find(
            (record) => record.runId === secondCompiledPlan.plan.id,
          );
          expect(failedRecord?.checkpoint.stats.outcome).toBe("failed");
          expect(failedRecord?.checkpoint.failure).toEqual({
            code: "provider_unavailable",
            retryable: true,
            message: secondFailure.message,
          });

          yield* Deferred.succeed(releaseCapture, undefined);

          const firstCheckpoint = Schema.decodeUnknownSync(RunCheckpointSchema)(
            yield* Fiber.join(firstFiber),
          );
          expect(firstCheckpoint.sequence).toBe(1);
          expect(firstCheckpoint.stage).toBe("snapshot");

          const events = yield* scheduler.events();
          expect(events.map(({ kind }) => kind)).toEqual(["acquired", "rejected", "released"]);
        }),
      ),
  );
});
