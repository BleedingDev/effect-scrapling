import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Layer, Option, Schema } from "effect";
import {
  AccessPlanner,
  AccessPolicySchema,
  ArtifactExporter,
  ArtifactMetadataRecordSchema,
  BrowserAccess,
  CaptureStore,
  CheckpointRecordSchema,
  DiffEngine,
  Extractor,
  HttpAccess,
  PackPromotionDecisionSchema,
  PackRegistry,
  QualityVerdictSchema,
  QualityGate,
  ReflectionEngine,
  RunCheckpointSchema,
  RunExecutionConfigSchema,
  RunPlanSchema,
  RunStatsSchema,
  SnapshotDiffSchema,
  SnapshotSchema,
  SnapshotStore,
  StorageLocatorSchema,
  TargetProfileSchema,
  TargetRegistry,
  WorkflowRunner,
  resolveRunExecutionConfig,
  SitePackSchema,
} from "../../libs/foundation/core/src";

describe("foundation-core workflow state", () => {
  it("roundtrips run plans, run stats, and checkpoints through durable schema contracts", () => {
    const runPlan = Schema.decodeUnknownSync(RunPlanSchema)({
      id: "run-plan-001",
      targetId: "target-product-001",
      packId: "pack-example-com",
      accessPolicyId: "policy-default",
      concurrencyBudgetId: "budget-run-001",
      entryUrl: "https://example.com/products/001",
      maxAttempts: 3,
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

    const runStats = Schema.decodeUnknownSync(RunStatsSchema)({
      runId: "run-001",
      plannedSteps: 3,
      completedSteps: 1,
      checkpointCount: 1,
      artifactCount: 2,
      outcome: "running",
      startedAt: "2026-03-06T10:00:00.000Z",
      updatedAt: "2026-03-06T10:01:00.000Z",
    });

    const runCheckpoint = Schema.decodeUnknownSync(RunCheckpointSchema)({
      id: "checkpoint-001",
      runId: "run-001",
      planId: "run-plan-001",
      sequence: 1,
      stage: "extract",
      nextStepId: "step-extract-001",
      completedStepIds: ["step-capture-001"],
      pendingStepIds: ["step-extract-001", "step-snapshot-001"],
      artifactIds: ["artifact-html-001", "artifact-request-001"],
      resumeToken: "resume-token-001",
      stats: runStats,
      storedAt: "2026-03-06T10:01:00.000Z",
    });

    expect(Schema.encodeSync(RunPlanSchema)(runPlan)).toEqual({
      id: "run-plan-001",
      targetId: "target-product-001",
      packId: "pack-example-com",
      accessPolicyId: "policy-default",
      concurrencyBudgetId: "budget-run-001",
      entryUrl: "https://example.com/products/001",
      maxAttempts: 3,
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
    expect(Schema.encodeSync(RunStatsSchema)(runStats)).toEqual({
      runId: "run-001",
      plannedSteps: 3,
      completedSteps: 1,
      checkpointCount: 1,
      artifactCount: 2,
      outcome: "running",
      startedAt: "2026-03-06T10:00:00.000Z",
      updatedAt: "2026-03-06T10:01:00.000Z",
    });
    expect(Schema.encodeSync(RunCheckpointSchema)(runCheckpoint)).toEqual({
      id: "checkpoint-001",
      runId: "run-001",
      planId: "run-plan-001",
      sequence: 1,
      stage: "extract",
      nextStepId: "step-extract-001",
      completedStepIds: ["step-capture-001"],
      pendingStepIds: ["step-extract-001", "step-snapshot-001"],
      artifactIds: ["artifact-html-001", "artifact-request-001"],
      resumeToken: "resume-token-001",
      stats: {
        runId: "run-001",
        plannedSteps: 3,
        completedSteps: 1,
        checkpointCount: 1,
        artifactCount: 2,
        outcome: "running",
        startedAt: "2026-03-06T10:00:00.000Z",
        updatedAt: "2026-03-06T10:01:00.000Z",
      },
      storedAt: "2026-03-06T10:01:00.000Z",
    });
  });

  it("rejects duplicate run stages, impossible stats, and inconsistent checkpoint queues", () => {
    expect(() =>
      Schema.decodeUnknownSync(RunPlanSchema)({
        id: "run-plan-001",
        targetId: "target-product-001",
        packId: "pack-example-com",
        accessPolicyId: "policy-default",
        concurrencyBudgetId: "budget-run-001",
        entryUrl: "https://example.com/products/001",
        maxAttempts: 3,
        checkpointInterval: 2,
        steps: [
          {
            id: "step-capture-001",
            stage: "capture",
            requiresBrowser: false,
          },
          {
            id: "step-capture-002",
            stage: "capture",
            requiresBrowser: true,
          },
        ],
        createdAt: "2026-03-06T10:00:00.000Z",
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(RunStatsSchema)({
        runId: "run-001",
        plannedSteps: 3,
        completedSteps: 2,
        checkpointCount: 1,
        artifactCount: 2,
        outcome: "succeeded",
        startedAt: "2026-03-06T10:00:00.000Z",
        updatedAt: "2026-03-06T10:01:00.000Z",
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(RunCheckpointSchema)({
        id: "checkpoint-001",
        runId: "run-001",
        planId: "run-plan-001",
        sequence: 1,
        stage: "extract",
        nextStepId: "step-diff-001",
        completedStepIds: ["step-capture-001", "step-extract-001"],
        pendingStepIds: ["step-extract-001"],
        artifactIds: ["artifact-html-001"],
        stats: {
          runId: "run-001",
          plannedSteps: 3,
          completedSteps: 2,
          checkpointCount: 1,
          artifactCount: 1,
          outcome: "running",
          startedAt: "2026-03-06T10:00:00.000Z",
          updatedAt: "2026-03-06T10:01:00.000Z",
        },
        storedAt: "2026-03-06T10:01:00.000Z",
      }),
    ).toThrow();
  });
});

describe("foundation-core config and storage contracts", () => {
  it("resolves execution config using deterministic precedence defaults < sitePack < targetProfile < run", () => {
    const resolved = resolveRunExecutionConfig({
      defaults: {
        targetId: "target-product-001",
        packId: "pack-example-com",
        accessPolicyId: "policy-default",
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
        render: "onDemand",
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

    expect(Schema.encodeSync(RunExecutionConfigSchema)(resolved)).toEqual({
      targetId: "target-product-001",
      packId: "pack-example-com",
      accessPolicyId: "policy-default",
      entryUrl: "https://example.com/products/001",
      mode: "browser",
      render: "always",
      perDomainConcurrency: 4,
      globalConcurrency: 8,
      timeoutMs: 30_000,
      maxRetries: 1,
      checkpointInterval: 10,
      artifactNamespace: "artifacts/site-pack",
      checkpointNamespace: "checkpoints/default",
    });
  });

  it("roundtrips backend-agnostic storage locators, artifact metadata, and checkpoint records", () => {
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
      sizeBytes: 2048,
      mediaType: "text/html",
      storedAt: "2026-03-06T10:02:00.000Z",
    });

    const checkpointRecord = Schema.decodeUnknownSync(CheckpointRecordSchema)({
      id: "checkpoint-record-001",
      runId: "run-001",
      planId: "run-plan-001",
      locator: {
        namespace: "checkpoints/example-com",
        key: "run-001/latest",
      },
      checkpoint: {
        id: "checkpoint-001",
        runId: "run-001",
        planId: "run-plan-001",
        sequence: 1,
        stage: "extract",
        nextStepId: "step-extract-001",
        completedStepIds: ["step-capture-001"],
        pendingStepIds: ["step-extract-001", "step-snapshot-001"],
        artifactIds: ["artifact-html-001"],
        stats: {
          runId: "run-001",
          plannedSteps: 3,
          completedSteps: 1,
          checkpointCount: 1,
          artifactCount: 1,
          outcome: "running",
          startedAt: "2026-03-06T10:00:00.000Z",
          updatedAt: "2026-03-06T10:01:00.000Z",
        },
        storedAt: "2026-03-06T10:01:00.000Z",
      },
      sha256: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      encoding: "json",
      compression: "gzip",
      storedAt: "2026-03-06T10:02:00.000Z",
    });

    expect(Schema.encodeSync(StorageLocatorSchema)(artifact.locator)).toEqual({
      namespace: "artifacts/example-com",
      key: "run-001/html-001",
    });
    expect(Schema.encodeSync(ArtifactMetadataRecordSchema)(artifact)).toEqual({
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
      sizeBytes: 2048,
      mediaType: "text/html",
      storedAt: "2026-03-06T10:02:00.000Z",
    });
    expect(Schema.encodeSync(CheckpointRecordSchema)(checkpointRecord)).toEqual({
      id: "checkpoint-record-001",
      runId: "run-001",
      planId: "run-plan-001",
      locator: {
        namespace: "checkpoints/example-com",
        key: "run-001/latest",
      },
      checkpoint: {
        id: "checkpoint-001",
        runId: "run-001",
        planId: "run-plan-001",
        sequence: 1,
        stage: "extract",
        nextStepId: "step-extract-001",
        completedStepIds: ["step-capture-001"],
        pendingStepIds: ["step-extract-001", "step-snapshot-001"],
        artifactIds: ["artifact-html-001"],
        stats: {
          runId: "run-001",
          plannedSteps: 3,
          completedSteps: 1,
          checkpointCount: 1,
          artifactCount: 1,
          outcome: "running",
          startedAt: "2026-03-06T10:00:00.000Z",
          updatedAt: "2026-03-06T10:01:00.000Z",
        },
        storedAt: "2026-03-06T10:01:00.000Z",
      },
      sha256: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      encoding: "json",
      compression: "gzip",
      storedAt: "2026-03-06T10:02:00.000Z",
    });
  });
});

describe("foundation-core service topology", () => {
  it("resolves architecture services through layer composition without singleton imports", async () => {
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
    const runPlan = Schema.decodeUnknownSync(RunPlanSchema)({
      id: "run-plan-001",
      targetId: targetProfile.id,
      packId: sitePack.id,
      accessPolicyId: accessPolicy.id,
      concurrencyBudgetId: "budget-run-001",
      entryUrl: "https://example.com/products/001",
      maxAttempts: 3,
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
    const promotionDecision = Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
      id: "decision-pack-example-com-001",
      packId: sitePack.id,
      fromState: "draft",
      toState: "shadow",
      triggerVerdictId: "verdict-pack-example-com-001",
      action: "promote-shadow",
      createdAt: "2026-03-06T10:06:00.000Z",
    });
    const checkpoint = Schema.decodeUnknownSync(RunCheckpointSchema)({
      id: "checkpoint-001",
      runId: "run-001",
      planId: runPlan.id,
      sequence: 1,
      stage: "extract",
      nextStepId: "step-extract-001",
      completedStepIds: ["step-capture-001"],
      pendingStepIds: ["step-extract-001"],
      artifactIds: [artifact.artifactId],
      stats: {
        runId: "run-001",
        plannedSteps: 2,
        completedSteps: 1,
        checkpointCount: 1,
        artifactCount: 1,
        outcome: "running",
        startedAt: "2026-03-06T10:00:00.000Z",
        updatedAt: "2026-03-06T10:02:00.000Z",
      },
      storedAt: "2026-03-06T10:02:00.000Z",
    });
    const exportedLocator = Schema.decodeUnknownSync(StorageLocatorSchema)({
      namespace: "exports/example-com",
      key: "run-001/html-001",
    });

    const mainLayer = Layer.mergeAll(
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
          plan: () => Effect.succeed(runPlan),
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
          decide: () =>
            Effect.succeed(Schema.encodeSync(PackPromotionDecisionSchema)(promotionDecision)),
        }),
      ),
      Layer.succeed(WorkflowRunner)(
        WorkflowRunner.of({
          inspect: () =>
            Effect.succeed(
              Option.some(
                Schema.decodeUnknownSync(RunStatsSchema)({
                  runId: "run-001",
                  plannedSteps: 2,
                  completedSteps: 1,
                  checkpointCount: 1,
                  artifactCount: 1,
                  outcome: "running",
                  startedAt: "2026-03-06T10:00:00.000Z",
                  updatedAt: "2026-03-06T10:02:00.000Z",
                }),
              ),
            ),
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

    const result = await Effect.runPromise(
      Effect.gen(function* () {
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

        const target = yield* targetRegistry.getById(targetProfile.id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new Error("Expected target registry layer to resolve the target profile"),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
        const pack = yield* packRegistry.getById(sitePack.id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new Error("Expected pack registry layer to resolve the site pack")),
              onSome: Effect.succeed,
            }),
          ),
        );

        const plan = yield* planner.plan(target, pack, accessPolicy);
        const capturedHttpArtifacts = yield* httpAccess.capture(plan);
        const capturedBrowserArtifacts = yield* browserAccess.capture(plan);
        const persistedArtifacts = yield* captureStore.persist([
          ...capturedHttpArtifacts,
          ...capturedBrowserArtifacts,
        ]);
        const candidateSnapshot = yield* extractor.extract(plan, persistedArtifacts);
        const persistedSnapshot = yield* snapshotStore.put(candidateSnapshot);
        const diffResult = yield* diffEngine.compare(snapshot, persistedSnapshot);
        const evaluatedVerdict = yield* qualityGate.evaluate(diffResult);
        const decision = yield* reflectionEngine.decide(pack, evaluatedVerdict);
        const startedCheckpoint = yield* workflowRunner.start(plan);
        const inspectedStats = yield* workflowRunner.inspect(checkpoint.runId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new Error("Expected workflow runner layer to resolve run stats")),
              onSome: Effect.succeed,
            }),
          ),
        );
        const resumedCheckpoint = yield* workflowRunner.resume(startedCheckpoint);
        const exportedArtifact = persistedArtifacts[0];
        if (!exportedArtifact) {
          return yield* Effect.fail(
            new Error("Expected at least one persisted artifact before export"),
          );
        }

        const exported = yield* artifactExporter.exportArtifact(exportedArtifact);

        return {
          decision,
          exported,
          inspectedStats,
          resumedCheckpoint,
        };
      }).pipe(Effect.provide(mainLayer)),
    );

    expect(result.decision).toEqual(
      Schema.encodeSync(PackPromotionDecisionSchema)(promotionDecision),
    );
    expect(result.exported).toEqual(exportedLocator);
    expect(Schema.encodeSync(RunStatsSchema)(result.inspectedStats)).toEqual({
      runId: "run-001",
      plannedSteps: 2,
      completedSteps: 1,
      checkpointCount: 1,
      artifactCount: 1,
      outcome: "running",
      startedAt: "2026-03-06T10:00:00.000Z",
      updatedAt: "2026-03-06T10:02:00.000Z",
    });
    expect(result.resumedCheckpoint).toEqual(Schema.encodeSync(RunCheckpointSchema)(checkpoint));
  });
});
