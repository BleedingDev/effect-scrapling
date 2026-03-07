import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Layer, Option, Ref, Schema } from "effect";
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
import { RunCheckpointSchema } from "../../libs/foundation/core/src/run-state.ts";
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

function makeTestLayer() {
  return Effect.gen(function* () {
    let nowTick = 0;
    const browserCallsRef = yield* Ref.make([] as ReadonlyArray<string>);
    const httpCallsRef = yield* Ref.make([] as ReadonlyArray<string>);
    const artifactStoreRef = yield* Ref.make(
      new Map<string, Schema.Schema.Type<typeof ArtifactMetadataRecordSchema>>(),
    );
    const checkpointStoreRef = yield* Ref.make(
      [] as ReadonlyArray<Schema.Schema.Type<typeof CheckpointRecordSchema>>,
    );
    const snapshotStoreRef = yield* Ref.make(
      new Map<string, Schema.Schema.Type<typeof SnapshotSchema>>(),
    );
    const reflectionCallsRef = yield* Ref.make([] as ReadonlyArray<string>);

    const baseLayer = Layer.mergeAll(
      Layer.succeed(HttpAccess)(
        HttpAccess.of({
          capture: (plan) =>
            Ref.update(httpCallsRef, (calls) => [...calls, plan.targetId]).pipe(
              Effect.as([makeArtifact(plan.targetId)]),
            ),
        }),
      ),
      Layer.succeed(BrowserAccess)(
        BrowserAccess.of({
          capture: (plan) =>
            Ref.update(browserCallsRef, (calls) => [...calls, plan.targetId]).pipe(
              Effect.as([makeArtifact(plan.targetId)]),
            ),
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
            Effect.succeed(
              makeSnapshot(plan.targetId, artifacts[0]!.artifactId, `snapshot-${plan.targetId}`),
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
    const runtimeLayer = DurableWorkflowRuntimeLive({
      now: () => new Date(Date.parse(CREATED_AT) + nowTick++ * 1_000),
      resolveBaselineSnapshot: ({ candidateSnapshot }) =>
        Effect.succeed(
          makeSnapshot(
            candidateSnapshot.targetId,
            candidateSnapshot.observations[0]!.evidenceRefs[0]!,
            `baseline-${candidateSnapshot.targetId}`,
          ),
        ),
    }).pipe(Layer.provide(baseLayer));

    return {
      artifactStoreRef,
      browserCallsRef,
      checkpointStoreRef,
      httpCallsRef,
      layer: Layer.mergeAll(baseLayer, runtimeLayer),
      reflectionCallsRef,
    };
  });
}

describe("foundation-core durable workflow runtime", () => {
  it.effect(
    "starts and resumes through the full durable workflow with deterministic checkpoints",
    () =>
      Effect.gen(function* () {
        const compiledPlans = yield* compileCrawlPlans(makeCompilerInput());
        const compiledPlan = compiledPlans[0];
        if (compiledPlan === undefined) {
          throw new Error("Expected a compiled crawl plan.");
        }
        const harness = yield* makeTestLayer();
        const { finished, inspected, resumed, started } = yield* Effect.gen(function* () {
          const workflowRunner = yield* WorkflowRunner;
          const startedEncoded = yield* workflowRunner.start(compiledPlan.plan);
          const resumedEncoded = yield* workflowRunner.resume(startedEncoded);
          const finishedEncoded = yield* workflowRunner.resume(resumedEncoded);

          return {
            finished: Schema.decodeUnknownSync(RunCheckpointSchema)(finishedEncoded),
            inspected: yield* workflowRunner.inspect(compiledPlan.plan.id),
            resumed: Schema.decodeUnknownSync(RunCheckpointSchema)(resumedEncoded),
            started: Schema.decodeUnknownSync(RunCheckpointSchema)(startedEncoded),
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

        expect(resumed.sequence).toBe(2);
        expect(resumed.stage).toBe("quality");
        expect(resumed.completedStepIds).toEqual([
          "step-capture",
          "step-extract",
          "step-snapshot",
          "step-diff",
        ]);
        expect(resumed.pendingStepIds).toEqual(["step-quality", "step-reflect"]);

        expect(finished.sequence).toBe(3);
        expect(finished.stage).toBe("reflect");
        expect(finished.pendingStepIds).toEqual([]);
        expect(finished.stats.outcome).toBe("succeeded");
        expect(finished.stats.completedSteps).toBe(6);

        expect(Option.isSome(inspected)).toBe(true);
        if (Option.isSome(inspected)) {
          expect(inspected.value.checkpointCount).toBe(3);
          expect(inspected.value.completedSteps).toBe(6);
        }

        expect(yield* Ref.get(harness.browserCallsRef)).toEqual(["target-search-001"]);
        expect(yield* Ref.get(harness.httpCallsRef)).toEqual([]);
        expect((yield* Ref.get(harness.artifactStoreRef)).size).toBe(1);
        expect(yield* Ref.get(harness.checkpointStoreRef)).toHaveLength(3);
        expect(yield* Ref.get(harness.reflectionCallsRef)).toEqual([
          "verdict-diff-snapshot-target-search-001",
        ]);
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
});
