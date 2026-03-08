import { Data, Effect, Option, Schema } from "effect";
import {
  ArtifactMetadataRecordSchema,
  CrawlPlanCompilationRequestSchema,
  PackPromotionDecisionSchema,
  ParserFailure,
  QualityVerdictSchema,
  RunCheckpointSchema,
  SitePackSchema,
  SnapshotDiffSchema,
  SnapshotSchema,
  WorkflowInspectionSnapshotSchema,
  compileCrawlPlan,
  makeInMemoryDurableWorkflowRunner,
} from "effect-scrapling/e5";

const E5_PUBLIC_IMPORT_PATH = "effect-scrapling/e5" as const;
const CREATED_AT = "2026-03-08T09:30:00.000Z";
const PACK_ID = "pack-example-com";
const PACK_VERSION = "2026.03.08";
const ACCESS_POLICY_ID = "policy-http";

export const e5SdkConsumerPrerequisites = [
  "Bun >= 1.3.10",
  'Run from repository root with "bun run example:e5-sdk-consumer".',
  "Import the durable-workflow contract from effect-scrapling/e5.",
  "Compile a crawl plan first, then provide durable workflow dependencies before starting or resuming runs.",
] as const;

export const e5SdkConsumerPitfalls = [
  "Durable workflow runs still require checkpoint, artifact, snapshot, and work-claim persistence even in synthetic tests.",
  "Resume the workflow with the exact encoded checkpoint returned by the runner, not a hand-built approximation.",
  "Step-level extractor failures surface from the public runner as PolicyViolation; inspect the persisted checkpoint for stage-level context.",
  "Import the E5 consumer contract from effect-scrapling/e5 instead of foundation-core private files.",
] as const;

export type E5SdkConsumerExampleResult = {
  readonly importPath: typeof E5_PUBLIC_IMPORT_PATH;
  readonly prerequisites: typeof e5SdkConsumerPrerequisites;
  readonly pitfalls: typeof e5SdkConsumerPitfalls;
  readonly payload: {
    readonly plan: {
      readonly runId: string;
      readonly targetId: string;
      readonly checkpointInterval: number;
      readonly stages: ReadonlyArray<string>;
      readonly rationaleKeys: ReadonlyArray<string>;
    };
    readonly started: unknown;
    readonly resumed: unknown;
    readonly finished: unknown;
    readonly inspection: unknown;
    readonly expectedError: {
      readonly caughtTag: "PolicyViolation";
      readonly message: string;
      readonly persistedStatus: string;
      readonly persistedStage: string;
      readonly checkpointCount: number;
    };
  };
};

class E5SdkConsumerInvariantViolation extends Data.TaggedError("E5SdkConsumerInvariantViolation")<{
  readonly message: string;
}> {}

function buildPack() {
  return Schema.decodeUnknownSync(SitePackSchema)({
    id: PACK_ID,
    domainPattern: "*.example.com",
    state: "shadow",
    accessPolicyId: ACCESS_POLICY_ID,
    version: "2026.03.08",
  });
}

function buildCompilerInput(targetId: string) {
  return Schema.decodeUnknownSync(CrawlPlanCompilationRequestSchema)({
    createdAt: CREATED_AT,
    defaults: {
      checkpointInterval: 2,
    },
    entries: [
      {
        target: {
          id: targetId,
          tenantId: "tenant-main",
          domain: "example.com",
          kind: "productPage",
          canonicalKey: "catalog/product-0001",
          seedUrls: ["https://example.com/products/0001"],
          accessPolicyId: ACCESS_POLICY_ID,
          packId: PACK_ID,
          priority: 42,
        },
        pack: buildPack(),
        accessPolicy: {
          id: ACCESS_POLICY_ID,
          mode: "http",
          perDomainConcurrency: 2,
          globalConcurrency: 8,
          timeoutMs: 15_000,
          maxRetries: 1,
          render: "never",
        },
      },
    ],
  });
}

function makeArtifactRecord(runId: string, targetId: string) {
  return Schema.decodeUnknownSync(ArtifactMetadataRecordSchema)({
    id: `artifact-record-${targetId}`,
    runId,
    artifactId: `artifact-${targetId}`,
    kind: "html",
    visibility: "redacted",
    locator: {
      namespace: `artifacts/${targetId}`,
      key: "captures/html",
    },
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    sizeBytes: 512,
    mediaType: "text/html",
    storedAt: CREATED_AT,
  });
}

function makeSnapshot(targetId: string, artifactId: string) {
  return Schema.decodeUnknownSync(SnapshotSchema)({
    id: `snapshot-${targetId}`,
    targetId,
    observations: [
      {
        field: "price",
        normalizedValue: {
          amount: 199.99,
          currency: "CZK",
        },
        confidence: 0.97,
        evidenceRefs: [artifactId],
      },
    ],
    qualityScore: 0.94,
    createdAt: CREATED_AT,
  });
}

function makeDiff(snapshotId: string) {
  return Schema.decodeUnknownSync(SnapshotDiffSchema)({
    id: `diff-${snapshotId}`,
    baselineSnapshotId: `baseline-${snapshotId}`,
    candidateSnapshotId: snapshotId,
    metrics: {
      fieldRecallDelta: 0.02,
      falsePositiveDelta: -0.01,
      driftDelta: -0.03,
      latencyDeltaMs: -40,
      memoryDelta: -8,
    },
    createdAt: CREATED_AT,
  });
}

function makeVerdict(diffId: string) {
  return Schema.decodeUnknownSync(QualityVerdictSchema)({
    id: `verdict-${diffId}`,
    packId: PACK_ID,
    snapshotDiffId: diffId,
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
  });
}

function makeDecision(verdictId: string) {
  return Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
    id: `decision-${verdictId}`,
    packId: PACK_ID,
    sourceVersion: PACK_VERSION,
    fromState: "shadow",
    toState: "active",
    triggerVerdictId: verdictId,
    action: "active",
    createdAt: CREATED_AT,
  });
}

export function runE5SdkConsumerExample(): Effect.Effect<E5SdkConsumerExampleResult, never, never> {
  return Effect.gen(function* () {
    const pack = buildPack();
    const compiled = yield* compileCrawlPlan(buildCompilerInput("target-product-0001"));
    const runner = yield* makeInMemoryDurableWorkflowRunner({
      pack,
      now: (() => {
        let tick = 0;
        return () => new Date(Date.parse(CREATED_AT) + tick++ * 1_000);
      })(),
      httpCapture: (plan) => Effect.succeed([makeArtifactRecord(plan.id, plan.targetId)]),
      extract: (plan, artifacts) =>
        Effect.succeed(makeSnapshot(plan.targetId, artifacts[0]!.artifactId)),
      compare: (_baseline, candidate) => Effect.succeed(makeDiff(candidate.id)),
      evaluate: (diff) => Effect.succeed(makeVerdict(diff.id)),
      decide: (_pack, verdict) => Effect.succeed(makeDecision(verdict.id)),
      resolveBaselineSnapshot: ({ candidateSnapshot }) => Effect.succeed(candidateSnapshot),
    });

    const startedEncoded = yield* runner.start(compiled.plan);
    const resumedEncoded = yield* runner.resume(startedEncoded);
    const finishedEncoded = yield* runner.resume(resumedEncoded);
    const started = Schema.decodeUnknownSync(RunCheckpointSchema)(startedEncoded);
    const resumed = Schema.decodeUnknownSync(RunCheckpointSchema)(resumedEncoded);
    const finished = Schema.decodeUnknownSync(RunCheckpointSchema)(finishedEncoded);
    const inspection = yield* runner.inspect(compiled.plan.id).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new E5SdkConsumerInvariantViolation({
                message: "Expected durable workflow inspection to resolve.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

    const failingRunner = yield* makeInMemoryDurableWorkflowRunner({
      pack,
      now: (() => {
        let tick = 0;
        return () => new Date(Date.parse(CREATED_AT) + tick++ * 1_000);
      })(),
      httpCapture: (plan) => Effect.succeed([makeArtifactRecord(plan.id, plan.targetId)]),
      extract: () => Effect.fail(new ParserFailure({ message: "Synthetic extractor failure" })),
      compare: (_baseline, candidate) => Effect.succeed(makeDiff(candidate.id)),
      evaluate: (diff) => Effect.succeed(makeVerdict(diff.id)),
      decide: (_pack, verdict) => Effect.succeed(makeDecision(verdict.id)),
      resolveBaselineSnapshot: ({ candidateSnapshot }) => Effect.succeed(candidateSnapshot),
    });

    const expectedError = yield* failingRunner.start(compiled.plan).pipe(
      Effect.flatMap(() =>
        Effect.fail(
          new E5SdkConsumerInvariantViolation({
            message: "Expected PolicyViolation for the synthetic extractor failure.",
          }),
        ),
      ),
      Effect.catchTag("PolicyViolation", ({ message }) =>
        failingRunner.inspect(compiled.plan.id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new E5SdkConsumerInvariantViolation({
                    message: "Expected persisted failed inspection after extractor failure.",
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
          Effect.map((failedInspection) => ({
            caughtTag: "PolicyViolation" as const,
            message,
            persistedStatus: failedInspection.status,
            persistedStage: failedInspection.stage,
            checkpointCount: failedInspection.progress.checkpointCount,
          })),
        ),
      ),
    );

    return {
      importPath: E5_PUBLIC_IMPORT_PATH,
      prerequisites: e5SdkConsumerPrerequisites,
      pitfalls: e5SdkConsumerPitfalls,
      payload: {
        plan: {
          runId: compiled.plan.id,
          targetId: compiled.plan.targetId,
          checkpointInterval: compiled.plan.checkpointInterval,
          stages: compiled.plan.steps.map((step) => step.stage),
          rationaleKeys: compiled.rationale.map(({ key }) => key),
        },
        started: Schema.encodeSync(RunCheckpointSchema)(started),
        resumed: Schema.encodeSync(RunCheckpointSchema)(resumed),
        finished: Schema.encodeSync(RunCheckpointSchema)(finished),
        inspection: Schema.encodeSync(WorkflowInspectionSnapshotSchema)(inspection),
        expectedError,
      },
    } satisfies E5SdkConsumerExampleResult;
  }).pipe(Effect.orDie);
}

if (import.meta.main) {
  const payload = await Effect.runPromise(runE5SdkConsumerExample());
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
