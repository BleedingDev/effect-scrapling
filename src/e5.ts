import { Effect, Layer, Option, Ref, Schema } from "effect";
import {
  ArtifactMetadataRecordSchema,
  ArtifactMetadataStore,
  BrowserAccess,
  CaptureStore,
  CheckpointRecordSchema,
  CrawlPlanCompilationRequestSchema,
  DiffEngine,
  DriftDetected,
  DurableWorkflowRuntimeLive,
  ExtractionMismatch,
  Extractor,
  HttpAccess,
  PackPromotionDecisionSchema,
  PackRegistry,
  ParserFailure,
  PolicyViolation,
  ProviderUnavailable,
  QualityGate,
  QualityVerdictSchema,
  RunCheckpointSchema,
  RunCheckpointStore,
  RunPlanSchema,
  SnapshotDiffSchema,
  SnapshotSchema,
  SnapshotStore,
  SitePackSchema,
  TimeoutError,
  WorkflowInspectionSnapshotSchema,
  WorkflowRunner,
  RenderCrashError,
  ReflectionEngine,
  WorkflowWorkClaimStore,
  compileCrawlPlan,
  makeInMemoryWorkflowWorkClaimStore,
} from "@effect-scrapling/foundation-core";

type ArtifactMetadataRecord = Schema.Schema.Type<typeof ArtifactMetadataRecordSchema>;
type CheckpointRecord = Schema.Schema.Type<typeof CheckpointRecordSchema>;
type RunPlan = Schema.Schema.Type<typeof RunPlanSchema>;
type SitePack = Schema.Schema.Type<typeof SitePackSchema>;
type Snapshot = Schema.Schema.Type<typeof SnapshotSchema>;
type SnapshotDiff = Schema.Schema.Type<typeof SnapshotDiffSchema>;
type QualityVerdict = Schema.Schema.Type<typeof QualityVerdictSchema>;
type PackPromotionDecision = Schema.Schema.Type<typeof PackPromotionDecisionSchema>;

export type InMemoryDurableWorkflowBaselineResolver = (input: {
  readonly plan: RunPlan;
  readonly candidateSnapshot: Snapshot;
}) => Effect.Effect<Snapshot, PolicyViolation | ProviderUnavailable>;

export type DurableWorkflowRunnerService = ReturnType<typeof WorkflowRunner.of>;

export type InMemoryDurableWorkflowRunnerOptions = {
  readonly pack: SitePack;
  readonly now?: () => Date;
  readonly httpCapture: (
    plan: RunPlan,
  ) => Effect.Effect<
    ReadonlyArray<ArtifactMetadataRecord>,
    PolicyViolation | ProviderUnavailable | TimeoutError
  >;
  readonly browserCapture?: (
    plan: RunPlan,
  ) => Effect.Effect<
    ReadonlyArray<ArtifactMetadataRecord>,
    PolicyViolation | ProviderUnavailable | RenderCrashError | TimeoutError
  >;
  readonly persistCapture?: (
    artifacts: ReadonlyArray<ArtifactMetadataRecord>,
  ) => Effect.Effect<ReadonlyArray<ArtifactMetadataRecord>, ProviderUnavailable>;
  readonly extract: (
    plan: RunPlan,
    artifacts: ReadonlyArray<ArtifactMetadataRecord>,
  ) => Effect.Effect<Snapshot, ExtractionMismatch | ParserFailure>;
  readonly compare: (
    baseline: Snapshot,
    candidate: Snapshot,
  ) => Effect.Effect<SnapshotDiff, DriftDetected>;
  readonly evaluate: (
    diff: SnapshotDiff,
  ) => Effect.Effect<QualityVerdict, DriftDetected | PolicyViolation>;
  readonly decide: (
    pack: SitePack,
    verdict: QualityVerdict,
  ) => Effect.Effect<PackPromotionDecision, DriftDetected | PolicyViolation>;
  readonly resolveBaselineSnapshot?: InMemoryDurableWorkflowBaselineResolver;
};

function matchesDomainPattern(pattern: string, domain: string) {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return domain === suffix || domain.endsWith(`.${suffix}`);
  }

  return domain === pattern;
}

function makeInMemoryArtifactMetadataStore() {
  return Effect.gen(function* () {
    const records = yield* Ref.make(new Map<string, ArtifactMetadataRecord>());

    return ArtifactMetadataStore.of({
      getById: (artifactId) =>
        Ref.get(records).pipe(
          Effect.map((stored) => {
            const record = stored.get(artifactId);
            return record === undefined ? Option.none() : Option.some(record);
          }),
        ),
      listByRun: (runId) =>
        Ref.get(records).pipe(
          Effect.map((stored) => [...stored.values()].filter((record) => record.runId === runId)),
        ),
      put: (record) =>
        Ref.update(records, (stored) => {
          const next = new Map(stored);
          next.set(record.artifactId, record);
          return next;
        }).pipe(Effect.as(record)),
    });
  });
}

function makeInMemoryRunCheckpointStore() {
  return Effect.gen(function* () {
    const records = yield* Ref.make([] as ReadonlyArray<CheckpointRecord>);

    return RunCheckpointStore.of({
      getById: (checkpointId) =>
        Ref.get(records).pipe(
          Effect.map((stored) => {
            const record = stored.find((candidate) => candidate.id === checkpointId);
            return record === undefined ? Option.none() : Option.some(record);
          }),
        ),
      latest: (runId) =>
        Ref.get(records).pipe(
          Effect.map((stored) => {
            const latestRecord = [...stored]
              .filter((record) => record.runId === runId)
              .sort(
                (left, right) =>
                  right.checkpoint.sequence - left.checkpoint.sequence ||
                  right.storedAt.localeCompare(left.storedAt) ||
                  right.id.localeCompare(left.id),
              )[0];

            return latestRecord === undefined ? Option.none() : Option.some(latestRecord);
          }),
        ),
      put: (record) => Ref.update(records, (stored) => [...stored, record]).pipe(Effect.as(record)),
    });
  });
}

export function makeInMemoryDurableWorkflowRunner(
  options: InMemoryDurableWorkflowRunnerOptions,
): Effect.Effect<DurableWorkflowRunnerService, PolicyViolation, never> {
  return Effect.gen(function* () {
    const pack = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(SitePackSchema)(options.pack),
      catch: () =>
        new PolicyViolation({
          message: "Failed to decode the E5 site pack through the public schema contract.",
        }),
    });
    const now = options.now ?? (() => new Date());
    const artifactMetadataStore = yield* makeInMemoryArtifactMetadataStore();
    const runCheckpointStore = yield* makeInMemoryRunCheckpointStore();
    const workflowWorkClaimStore = yield* makeInMemoryWorkflowWorkClaimStore(now);
    const snapshots = yield* Ref.make(new Map<string, Snapshot>());

    const baseLayer = Layer.mergeAll(
      Layer.succeed(HttpAccess)(
        HttpAccess.of({
          capture: options.httpCapture,
        }),
      ),
      Layer.succeed(BrowserAccess)(
        BrowserAccess.of({
          capture:
            options.browserCapture ??
            ((plan) =>
              Effect.fail(
                new PolicyViolation({
                  message: `Browser capture was not configured for durable workflow plan ${plan.id}.`,
                }),
              )),
        }),
      ),
      Layer.succeed(CaptureStore)(
        CaptureStore.of({
          persist: options.persistCapture ?? ((artifacts) => Effect.succeed(artifacts)),
        }),
      ),
      Layer.succeed(Extractor)(
        Extractor.of({
          extract: options.extract,
        }),
      ),
      Layer.succeed(SnapshotStore)(
        SnapshotStore.of({
          getById: (snapshotId) =>
            Ref.get(snapshots).pipe(
              Effect.map((stored) => {
                const snapshot = stored.get(snapshotId);
                return snapshot === undefined ? Option.none() : Option.some(snapshot);
              }),
            ),
          put: (snapshot) =>
            Ref.update(snapshots, (stored) => {
              const next = new Map(stored);
              next.set(snapshot.id, snapshot);
              return next;
            }).pipe(Effect.as(snapshot)),
        }),
      ),
      Layer.succeed(DiffEngine)(
        DiffEngine.of({
          compare: options.compare,
        }),
      ),
      Layer.succeed(QualityGate)(
        QualityGate.of({
          evaluate: options.evaluate,
        }),
      ),
      Layer.succeed(PackRegistry)(
        PackRegistry.of({
          getByDomain: (domain) =>
            Effect.succeed(
              matchesDomainPattern(pack.domainPattern, domain) ? Option.some(pack) : Option.none(),
            ),
          getById: (packId) =>
            Effect.succeed(packId === pack.id ? Option.some(pack) : Option.none()),
        }),
      ),
      Layer.succeed(ReflectionEngine)(
        ReflectionEngine.of({
          decide: options.decide,
        }),
      ),
      Layer.succeed(ArtifactMetadataStore)(artifactMetadataStore),
      Layer.succeed(RunCheckpointStore)(runCheckpointStore),
      Layer.succeed(WorkflowWorkClaimStore)(workflowWorkClaimStore),
    );

    return yield* Effect.gen(function* () {
      return yield* WorkflowRunner;
    }).pipe(
      Effect.provide(
        DurableWorkflowRuntimeLive({
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.resolveBaselineSnapshot === undefined
            ? {}
            : { resolveBaselineSnapshot: options.resolveBaselineSnapshot }),
        }).pipe(Layer.provide(baseLayer)),
      ),
    );
  });
}

export {
  ArtifactMetadataRecordSchema,
  CrawlPlanCompilationRequestSchema,
  PackPromotionDecisionSchema,
  ParserFailure,
  PolicyViolation,
  QualityVerdictSchema,
  RunCheckpointSchema,
  SitePackSchema,
  SnapshotDiffSchema,
  SnapshotSchema,
  WorkflowInspectionSnapshotSchema,
  compileCrawlPlan,
};
