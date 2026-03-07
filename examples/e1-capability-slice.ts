import { Effect, Layer, Option, Schema } from "effect";
import {
  AccessPlanner,
  AccessPolicySchema,
  ArtifactExporter,
  ArtifactMetadataRecordSchema,
  BrowserAccess,
  CaptureStore,
  DiffEngine,
  Extractor,
  HttpAccess,
  PackPromotionDecisionSchema,
  PackRegistry,
  PolicyViolation,
  QualityGate,
  QualityVerdictSchema,
  ReflectionEngine,
  RunCheckpointSchema,
  RunPlanSchema,
  RunExecutionConfigSchema,
  RunStatsSchema,
  SitePackSchema,
  SnapshotDiffSchema,
  SnapshotSchema,
  SnapshotStore,
  StorageLocatorSchema,
  TargetProfileSchema,
  TargetRegistry,
  WorkflowInspectionSnapshotSchema,
  WorkflowRunner,
  resolveRunExecutionConfig,
  toCoreErrorEnvelope,
} from "@effect-scrapling/foundation-core";

export const capabilitySlicePrerequisites = [
  "Bun >= 1.3.10",
  "Use the public @effect-scrapling/foundation-core contract only.",
  'Run from repository root with "bun run example:e1-capability-slice".',
] as const;

export const capabilitySlicePitfalls = [
  "Do not replace layer-provided services with singleton imports.",
  "Do not bypass schema decode for config, run state, or quality payloads.",
  "Treat the emitted evidence object as transport data, not as mutable in-memory state.",
] as const;

const targetProfile = Schema.decodeUnknownSync(TargetProfileSchema)({
  id: "target-product-001",
  tenantId: "tenant-main",
  domain: "example.com",
  kind: "productPage",
  canonicalKey: "catalog/product-001",
  seedUrls: ["https://example.com/products/001"],
  accessPolicyId: "policy-default",
  packId: "pack-example-com",
  priority: 10,
});

const sitePack = Schema.decodeUnknownSync(SitePackSchema)({
  id: "pack-example-com",
  domainPattern: "*.example.com",
  state: "shadow",
  accessPolicyId: "policy-default",
  version: "2026.03.06",
});

const accessPolicy = Schema.decodeUnknownSync(AccessPolicySchema)({
  id: "policy-default",
  mode: "http",
  perDomainConcurrency: 8,
  globalConcurrency: 64,
  timeoutMs: 30_000,
  maxRetries: 2,
  render: "never",
});

const resolvedConfig = resolveRunExecutionConfig({
  defaults: {
    targetId: targetProfile.id,
    packId: sitePack.id,
    accessPolicyId: accessPolicy.id,
    entryUrl: "https://example.com/catalog",
    mode: "http",
    render: "never",
    perDomainConcurrency: 2,
    globalConcurrency: 8,
    timeoutMs: 10_000,
    maxRetries: 1,
    checkpointInterval: 10,
    artifactNamespace: "artifacts/default",
    checkpointNamespace: "checkpoints/default",
  },
  sitePack: {
    artifactNamespace: "artifacts/site-pack",
  },
  targetProfile: {
    entryUrl: "https://example.com/products/001",
    perDomainConcurrency: 4,
  },
  run: {
    mode: "browser",
    render: "always",
    timeoutMs: 30_000,
  },
});

const plan = Schema.decodeUnknownSync(RunPlanSchema)({
  id: "run-plan-001",
  targetId: targetProfile.id,
  packId: sitePack.id,
  accessPolicyId: accessPolicy.id,
  concurrencyBudgetId: "budget-run-001",
  entryUrl: "https://example.com/products/001",
  maxAttempts: 3,
  timeoutMs: 30_000,
  checkpointInterval: 2,
  steps: [
    {
      id: "step-capture-001",
      stage: "capture",
      requiresBrowser: false,
      artifactKind: "html",
    },
    {
      id: "step-extract-001",
      stage: "extract",
      requiresBrowser: false,
    },
    {
      id: "step-snapshot-001",
      stage: "snapshot",
      requiresBrowser: false,
    },
  ],
  createdAt: "2026-03-06T10:00:00.000Z",
});

const artifact = Schema.decodeUnknownSync(ArtifactMetadataRecordSchema)({
  id: "artifact-record-001",
  runId: "run-001",
  artifactId: "artifact-html-001",
  kind: "html",
  visibility: "redacted",
  locator: {
    namespace: "artifacts/example-com",
    key: "run-001/html-001",
  },
  sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  sizeBytes: 1024,
  mediaType: "text/html",
  storedAt: "2026-03-06T10:02:00.000Z",
});

const snapshot = Schema.decodeUnknownSync(SnapshotSchema)({
  id: "snapshot-001",
  targetId: targetProfile.id,
  observations: [
    {
      field: "price",
      normalizedValue: {
        amount: 19.99,
        currency: "USD",
      },
      confidence: 0.95,
      evidenceRefs: [artifact.artifactId],
    },
  ],
  qualityScore: 0.91,
  createdAt: "2026-03-06T10:03:00.000Z",
});

const diff = Schema.decodeUnknownSync(SnapshotDiffSchema)({
  id: "diff-pack-example-com-001",
  baselineSnapshotId: "snapshot-000",
  candidateSnapshotId: snapshot.id,
  metrics: {
    fieldRecallDelta: 0.03,
    falsePositiveDelta: -0.01,
    driftDelta: -0.02,
    latencyDeltaMs: -50,
    memoryDelta: -12,
  },
  createdAt: "2026-03-06T10:04:00.000Z",
});

const verdict = Schema.decodeUnknownSync(QualityVerdictSchema)({
  id: "verdict-pack-example-com-001",
  packId: sitePack.id,
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
  createdAt: "2026-03-06T10:05:00.000Z",
});

const decision = Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
  id: "decision-pack-example-com-001",
  packId: sitePack.id,
  fromState: "draft",
  toState: "shadow",
  triggerVerdictId: verdict.id,
  action: "promote-shadow",
  createdAt: "2026-03-06T10:06:00.000Z",
});

const checkpoint = Schema.decodeUnknownSync(RunCheckpointSchema)({
  id: "checkpoint-001",
  runId: "run-001",
  planId: plan.id,
  sequence: 1,
  stage: "extract",
  nextStepId: "step-extract-001",
  completedStepIds: ["step-capture-001"],
  pendingStepIds: ["step-extract-001", "step-snapshot-001"],
  artifactIds: [artifact.artifactId],
  stats: {
    runId: "run-001",
    plannedSteps: 3,
    completedSteps: 1,
    checkpointCount: 1,
    artifactCount: 1,
    outcome: "running",
    startedAt: "2026-03-06T10:00:00.000Z",
    updatedAt: "2026-03-06T10:02:00.000Z",
  },
  storedAt: "2026-03-06T10:02:00.000Z",
});

const inspection = Schema.decodeUnknownSync(WorkflowInspectionSnapshotSchema)({
  runId: "run-001",
  planId: plan.id,
  targetId: targetProfile.id,
  packId: sitePack.id,
  accessPolicyId: accessPolicy.id,
  concurrencyBudgetId: plan.concurrencyBudgetId,
  entryUrl: plan.entryUrl,
  status: "running",
  stage: "extract",
  nextStepId: "step-extract-001",
  startedAt: checkpoint.stats.startedAt,
  updatedAt: checkpoint.stats.updatedAt,
  storedAt: checkpoint.storedAt,
  stats: checkpoint.stats,
  progress: {
    plannedSteps: 3,
    completedSteps: 1,
    pendingSteps: 2,
    checkpointCount: 1,
    artifactCount: 1,
    completionRatio: 1 / 3,
    completedStepIds: ["step-capture-001"],
    pendingStepIds: ["step-extract-001", "step-snapshot-001"],
  },
  budget: {
    maxAttempts: 3,
    configuredTimeoutMs: 30_000,
    elapsedMs: 120_000,
    remainingTimeoutMs: 0,
    timeoutUtilization: 1,
    checkpointInterval: 2,
    stepsUntilNextCheckpoint: 2,
  },
});

const exportedLocator = Schema.decodeUnknownSync(StorageLocatorSchema)({
  namespace: "exports/example-com",
  key: "run-001/html-001",
});

function provideServices() {
  return Layer.mergeAll(
    Layer.succeed(TargetRegistry)(
      TargetRegistry.of({
        getById: (targetId) =>
          Effect.succeed(
            targetId === targetProfile.id ? Option.some(targetProfile) : Option.none(),
          ),
      }),
    ),
    Layer.succeed(PackRegistry)(
      PackRegistry.of({
        getByDomain: (domain) =>
          Effect.succeed(domain === targetProfile.domain ? Option.some(sitePack) : Option.none()),
        getById: (packId) =>
          Effect.succeed(packId === sitePack.id ? Option.some(sitePack) : Option.none()),
      }),
    ),
    Layer.succeed(AccessPlanner)(
      AccessPlanner.of({
        plan: () => Effect.succeed(plan),
      }),
    ),
    Layer.succeed(HttpAccess)(
      HttpAccess.of({
        capture: () => Effect.succeed([artifact]),
      }),
    ),
    Layer.succeed(BrowserAccess)(
      BrowserAccess.of({
        capture: () => Effect.succeed([artifact]),
      }),
    ),
    Layer.succeed(CaptureStore)(
      CaptureStore.of({
        persist: (artifacts) => Effect.succeed(artifacts),
      }),
    ),
    Layer.succeed(Extractor)(
      Extractor.of({
        extract: () => Effect.succeed(snapshot),
      }),
    ),
    Layer.succeed(SnapshotStore)(
      SnapshotStore.of({
        getById: () => Effect.succeed(Option.some(snapshot)),
        put: () => Effect.succeed(snapshot),
      }),
    ),
    Layer.succeed(DiffEngine)(
      DiffEngine.of({
        compare: () => Effect.succeed(diff),
      }),
    ),
    Layer.succeed(QualityGate)(
      QualityGate.of({
        evaluate: () => Effect.succeed(verdict),
      }),
    ),
    Layer.succeed(ReflectionEngine)(
      ReflectionEngine.of({
        decide: () => Effect.succeed(Schema.encodeSync(PackPromotionDecisionSchema)(decision)),
      }),
    ),
    Layer.succeed(WorkflowRunner)(
      WorkflowRunner.of({
        inspect: () => Effect.succeed(Option.some(inspection)),
        resume: () => Effect.succeed(Schema.encodeSync(RunCheckpointSchema)(checkpoint)),
        start: () => Effect.succeed(Schema.encodeSync(RunCheckpointSchema)(checkpoint)),
      }),
    ),
    Layer.succeed(ArtifactExporter)(
      ArtifactExporter.of({
        exportArtifact: () => Effect.succeed(exportedLocator),
      }),
    ),
  );
}

export function runE1CapabilitySlice() {
  return Effect.gen(function* () {
    const targetRegistry = yield* TargetRegistry;
    const packRegistry = yield* PackRegistry;
    const planner = yield* AccessPlanner;
    const httpAccess = yield* HttpAccess;
    const browserAccess = yield* BrowserAccess;
    const captureStore = yield* CaptureStore;
    const extractor = yield* Extractor;
    const snapshotStore = yield* SnapshotStore;
    const diffEngine = yield* DiffEngine;
    const qualityGate = yield* QualityGate;
    const reflectionEngine = yield* ReflectionEngine;
    const workflowRunner = yield* WorkflowRunner;
    const artifactExporter = yield* ArtifactExporter;

    const resolvedTarget = yield* targetRegistry.getById(targetProfile.id).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die(new Error("Expected target profile to resolve")),
          onSome: Effect.succeed,
        }),
      ),
    );
    const resolvedPack = yield* packRegistry.getById(sitePack.id).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die(new Error("Expected site pack to resolve")),
          onSome: Effect.succeed,
        }),
      ),
    );

    const resolvedPlan = yield* planner.plan(resolvedTarget, resolvedPack, accessPolicy);
    const capturedArtifacts = yield* Effect.all([
      httpAccess.capture(resolvedPlan),
      browserAccess.capture(resolvedPlan),
    ]).pipe(
      Effect.map(([httpArtifacts, browserArtifacts]) => [...httpArtifacts, ...browserArtifacts]),
    );
    const persistedArtifacts = yield* captureStore.persist(capturedArtifacts);
    const extractedSnapshot = yield* extractor.extract(resolvedPlan, persistedArtifacts);
    const persistedSnapshot = yield* snapshotStore.put(extractedSnapshot);
    const computedDiff = yield* diffEngine.compare(snapshot, persistedSnapshot);
    const evaluatedVerdict = yield* qualityGate.evaluate(computedDiff);
    const promotionDecision = yield* reflectionEngine.decide(resolvedPack, evaluatedVerdict);
    const startedCheckpoint = yield* workflowRunner.start(resolvedPlan);
    const resumedCheckpoint = yield* workflowRunner.resume(startedCheckpoint);
    const inspectedRun = yield* workflowRunner.inspect(checkpoint.runId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die(new Error("Expected workflow inspection to resolve")),
          onSome: Effect.succeed,
        }),
      ),
    );
    const firstArtifact = persistedArtifacts[0];
    if (!firstArtifact) {
      return yield* Effect.die(new Error("Expected persisted artifacts"));
    }
    const exported = yield* artifactExporter.exportArtifact(firstArtifact);

    return {
      importPath: "@effect-scrapling/foundation-core",
      prerequisites: capabilitySlicePrerequisites,
      pitfalls: capabilitySlicePitfalls,
      resolvedConfig: Schema.encodeSync(RunExecutionConfigSchema)(resolvedConfig),
      plan: Schema.encodeSync(RunPlanSchema)(resolvedPlan),
      checkpoint: resumedCheckpoint,
      stats: Schema.encodeSync(RunStatsSchema)(inspectedRun.stats),
      inspection: Schema.encodeSync(WorkflowInspectionSnapshotSchema)(inspectedRun),
      artifacts: persistedArtifacts.map((item) =>
        Schema.encodeSync(ArtifactMetadataRecordSchema)(item),
      ),
      snapshot: Schema.encodeSync(SnapshotSchema)(persistedSnapshot),
      diff: Schema.encodeSync(SnapshotDiffSchema)(computedDiff),
      verdict: Schema.encodeSync(QualityVerdictSchema)(evaluatedVerdict),
      decision: promotionDecision,
      exportedLocator: Schema.encodeSync(StorageLocatorSchema)(exported),
      errorEnvelope: toCoreErrorEnvelope(
        new PolicyViolation({ message: "Policy violations remain machine readable" }),
      ),
    };
  }).pipe(Effect.provide(provideServices()));
}

if (import.meta.main) {
  const payload = await Effect.runPromise(runE1CapabilitySlice());
  console.log(JSON.stringify(payload, null, 2));
}
