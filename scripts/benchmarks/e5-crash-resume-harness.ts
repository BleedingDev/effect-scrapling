#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Layer, Option, Ref, Schema, SchemaGetter } from "effect";
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
import {
  DurableWorkflowRuntimeLive,
  WorkflowResumeContextSchema,
} from "../../libs/foundation/core/src/durable-workflow-runtime.ts";
import {
  PackPromotionDecisionSchema,
  QualityVerdictSchema,
  SnapshotDiffSchema,
} from "../../libs/foundation/core/src/diff-verdict.ts";
import { SnapshotSchema } from "../../libs/foundation/core/src/observation-snapshot.ts";
import {
  RunCheckpointSchema,
  RunPlanSchema,
  RunStageSchema,
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
import {
  SimulationProfileSchema,
  createSimulationCompilerInput,
} from "./e5-workflow-simulation.ts";

const CREATED_AT = "2026-03-07T14:00:00.000Z";
const DEFAULT_TARGET_COUNT = 4;
const DEFAULT_OBSERVATIONS_PER_TARGET = 25;
const DEFAULT_CRASH_AFTER_SEQUENCES = [1, 2] as const;

const PositiveCountSchema = Schema.Int.check(Schema.isGreaterThan(0));
const PositiveIntFromString = Schema.FiniteFromString.check(Schema.isInt()).check(
  Schema.isGreaterThan(0),
);
const PositiveIntArgumentSchema = Schema.Trim.pipe(
  Schema.check(Schema.isPattern(/^\d+$/u)),
  Schema.decodeTo(PositiveIntFromString, {
    decode: SchemaGetter.passthrough(),
    encode: SchemaGetter.String(),
  }),
);

const CrashAfterSequenceSchema = Schema.Int.pipe(
  Schema.refine((value): value is 1 | 2 => value === 1 || value === 2, {
    message: "Expected a crash-after sequence of 1 or 2.",
  }),
);
const CrashAfterSequenceFromString = Schema.FiniteFromString.check(Schema.isInt()).pipe(
  Schema.refine((value): value is 1 | 2 => value === 1 || value === 2, {
    message: "Expected a crash-after sequence of 1 or 2.",
  }),
);
const CrashAfterSequenceArgumentSchema = Schema.Trim.pipe(
  Schema.check(Schema.isPattern(/^[12]$/u)),
  Schema.decodeTo(CrashAfterSequenceFromString, {
    decode: SchemaGetter.passthrough(),
    encode: SchemaGetter.String(),
  }),
);
const CrashAfterSequenceListSchema = Schema.Array(CrashAfterSequenceSchema).pipe(
  Schema.refine(
    (values): values is ReadonlyArray<1 | 2> => new Set(values).size === values.length,
    {
      message: "Expected crash-after sequences without duplicates.",
    },
  ),
);

export const CrashResumeOptionsSchema = Schema.Struct({
  targetCount: PositiveCountSchema,
  observationsPerTarget: PositiveCountSchema,
  crashAfterSequences: CrashAfterSequenceListSchema,
  artifactPath: Schema.optional(Schema.String),
});

export const CrashResumeRunSummarySchema = Schema.Struct({
  runId: Schema.String,
  checkpointCount: PositiveCountSchema,
  stageFingerprint: Schema.String,
  finalCheckpointId: Schema.String,
  finalSequence: PositiveCountSchema,
  finalStage: RunStageSchema,
  finalOutcome: Schema.Literal("succeeded"),
  totalObservations: PositiveCountSchema,
  inspection: WorkflowInspectionSnapshotSchema,
});

export const CrashResumeSampleSchema = Schema.Struct({
  profile: SimulationProfileSchema,
  crashAfterSequences: CrashAfterSequenceListSchema,
  restartCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  baseline: Schema.Array(CrashResumeRunSummarySchema),
  recovered: Schema.Array(CrashResumeRunSummarySchema),
  matchedOutputs: Schema.Boolean,
});

export const CrashResumeArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e5-crash-resume-harness"),
  generatedAt: Schema.String,
  sample: CrashResumeSampleSchema,
  status: Schema.Literals(["pass", "fail"] as const),
});

type SimulationProfile = Schema.Schema.Type<typeof SimulationProfileSchema>;
type CrashResumeRunSummary = Schema.Schema.Type<typeof CrashResumeRunSummarySchema>;
type CrashResumeSample = Schema.Schema.Type<typeof CrashResumeSampleSchema>;
type RunCrashResumeSample = (
  profile: SimulationProfile,
  crashAfterSequences: ReadonlyArray<1 | 2>,
) => Effect.Effect<CrashResumeSample>;
type CrashResumeHarnessDependencies = {
  readonly runSample?: RunCrashResumeSample;
};
type CrashResumeHarnessCliDependencies = CrashResumeHarnessDependencies & {
  readonly setExitCode?: (code: number) => void;
  readonly writeLine?: (line: string) => void;
};

function readOptionValue(args: readonly string[], index: number, option: string) {
  const rawValue = args[index + 1];

  if (rawValue === undefined || rawValue.startsWith("--")) {
    throw new Error(`Missing value for argument: ${option}`);
  }

  return rawValue;
}

export function parseOptions(args: readonly string[]) {
  let artifactPath: string | undefined;
  let targetCount = DEFAULT_TARGET_COUNT;
  let observationsPerTarget = DEFAULT_OBSERVATIONS_PER_TARGET;
  const crashAfterSequences = new Array<1 | 2>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--artifact") {
      artifactPath = resolve(readOptionValue(args, index, argument));
      index += 1;
      continue;
    }

    if (argument === "--targets") {
      targetCount = Schema.decodeUnknownSync(PositiveIntArgumentSchema)(
        readOptionValue(args, index, argument),
      );
      index += 1;
      continue;
    }

    if (argument === "--observations-per-target") {
      observationsPerTarget = Schema.decodeUnknownSync(PositiveIntArgumentSchema)(
        readOptionValue(args, index, argument),
      );
      index += 1;
      continue;
    }

    if (argument === "--crash-after-sequence") {
      crashAfterSequences.push(
        Schema.decodeUnknownSync(CrashAfterSequenceArgumentSchema)(
          readOptionValue(args, index, argument),
        ) as 1 | 2,
      );
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return Schema.decodeUnknownSync(CrashResumeOptionsSchema)({
    targetCount,
    observationsPerTarget,
    crashAfterSequences:
      crashAfterSequences.length === 0
        ? DEFAULT_CRASH_AFTER_SEQUENCES
        : [...crashAfterSequences].sort((left, right) => left - right),
    ...(artifactPath === undefined ? {} : { artifactPath }),
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
      key: `captures/${plan.targetId}.html`,
    },
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    sizeBytes: 4_096,
    mediaType: "text/html",
    storedAt: CREATED_AT,
  });
}

function makeSnapshot(
  plan: Schema.Schema.Type<typeof RunPlanSchema>,
  artifactId: string,
  observationsPerTarget: number,
) {
  return Schema.decodeUnknownSync(SnapshotSchema)({
    id: `snapshot-${plan.targetId}`,
    targetId: plan.targetId,
    observations: Array.from({ length: observationsPerTarget }, (_unused, index) => ({
      field: `field-${index.toString().padStart(4, "0")}`,
      normalizedValue: `${plan.targetId}-${index}`,
      confidence: 0.99,
      evidenceRefs: [artifactId],
    })),
    qualityScore: 0.99,
    createdAt: CREATED_AT,
  });
}

function fingerprintCheckpoints(
  checkpoints: ReadonlyArray<Schema.Schema.Type<typeof RunCheckpointSchema>>,
) {
  return checkpoints.map(({ stage }) => stage).join(">");
}

function makeCrashResumeHarness(profile: SimulationProfile) {
  return Effect.gen(function* () {
    let nowTick = 0;
    const compilerInput = createSimulationCompilerInput(profile);
    const firstEntry = compilerInput.entries[0];

    if (firstEntry === undefined) {
      return yield* Effect.fail(new Error("Expected at least one simulation compiler entry."));
    }

    const pack = firstEntry.pack;
    const artifactStoreRef = yield* Ref.make(
      new Map<string, Schema.Schema.Type<typeof ArtifactMetadataRecordSchema>>(),
    );
    const checkpointStoreRef = yield* Ref.make(
      [] as ReadonlyArray<Schema.Schema.Type<typeof CheckpointRecordSchema>>,
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
            Effect.succeed(
              makeSnapshot(plan, artifacts[0]!.artifactId, profile.observationsPerTarget),
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
              Schema.encodeSync(PackPromotionDecisionSchema)({
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
      compilerInput,
      checkpointStoreRef,
      makeLayer: () =>
        Layer.mergeAll(
          baseLayer,
          DurableWorkflowRuntimeLive({
            now: () => new Date(Date.parse(CREATED_AT) + nowTick++ * 1_000),
          }).pipe(Layer.provide(baseLayer)),
        ),
      snapshotStoreRef,
    };
  });
}

function findLatestCheckpoint(
  records: ReadonlyArray<Schema.Schema.Type<typeof CheckpointRecordSchema>>,
  runId: string,
) {
  return [...records]
    .filter((record) => record.runId === runId)
    .sort((left, right) => right.checkpoint.sequence - left.checkpoint.sequence)[0]?.checkpoint;
}

function collectRunSummary(
  harness: {
    readonly checkpointStoreRef: Ref.Ref<
      ReadonlyArray<Schema.Schema.Type<typeof CheckpointRecordSchema>>
    >;
    readonly snapshotStoreRef: Ref.Ref<Map<string, Schema.Schema.Type<typeof SnapshotSchema>>>;
    readonly makeLayer: () => Layer.Layer<WorkflowRunner>;
  },
  runId: string,
) {
  return Effect.gen(function* () {
    const checkpoints = (yield* Ref.get(harness.checkpointStoreRef))
      .filter((record) => record.runId === runId)
      .sort((left, right) => left.checkpoint.sequence - right.checkpoint.sequence)
      .map((record) => record.checkpoint);
    const latestCheckpoint = checkpoints[checkpoints.length - 1];

    if (latestCheckpoint === undefined) {
      return yield* Effect.fail(new Error(`Expected persisted checkpoints for ${runId}.`));
    }

    const inspection = yield* Effect.gen(function* () {
      const workflowRunner = yield* WorkflowRunner;
      return yield* workflowRunner.inspect(runId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new Error(`Expected workflow inspection for ${runId}.`)),
            onSome: Effect.succeed,
          }),
        ),
      );
    }).pipe(Effect.provide(harness.makeLayer()));

    const resumeContext =
      latestCheckpoint.resumeToken === undefined
        ? undefined
        : Schema.decodeUnknownSync(WorkflowResumeContextSchema)(
            JSON.parse(latestCheckpoint.resumeToken),
          );
    const candidateSnapshotId = resumeContext?.candidateSnapshotId;
    const candidateSnapshot =
      candidateSnapshotId === undefined
        ? undefined
        : (yield* Ref.get(harness.snapshotStoreRef)).get(candidateSnapshotId);

    if (candidateSnapshot === undefined) {
      return yield* Effect.fail(
        new Error(`Expected candidate snapshot ${candidateSnapshotId ?? "unknown"} for ${runId}.`),
      );
    }

    return Schema.decodeUnknownSync(CrashResumeRunSummarySchema)({
      runId,
      checkpointCount: checkpoints.length,
      stageFingerprint: fingerprintCheckpoints(checkpoints),
      finalCheckpointId: latestCheckpoint.id,
      finalSequence: latestCheckpoint.sequence,
      finalStage: latestCheckpoint.stage,
      finalOutcome: latestCheckpoint.stats.outcome,
      totalObservations: candidateSnapshot.observations.length,
      inspection,
    });
  });
}

function runWorkflowUntilCompletion(input: {
  readonly crashAfterSequences: ReadonlyArray<1 | 2>;
  readonly harness: {
    readonly checkpointStoreRef: Ref.Ref<
      ReadonlyArray<Schema.Schema.Type<typeof CheckpointRecordSchema>>
    >;
    readonly makeLayer: () => Layer.Layer<WorkflowRunner>;
  };
  readonly plan: Schema.Schema.Type<typeof RunPlanSchema>;
}) {
  return Effect.gen(function* () {
    let restartCount = 0;
    let currentLayer = input.harness.makeLayer();
    let checkpoint = yield* Effect.gen(function* () {
      const workflowRunner = yield* WorkflowRunner;
      return yield* workflowRunner.start(input.plan);
    }).pipe(
      Effect.provide(currentLayer),
      Effect.map(Schema.decodeUnknownSync(RunCheckpointSchema)),
    );

    while (checkpoint.pendingStepIds.length > 0) {
      if (input.crashAfterSequences.includes(checkpoint.sequence as 1 | 2)) {
        restartCount += 1;
        currentLayer = input.harness.makeLayer();
      }

      checkpoint = yield* Effect.gen(function* () {
        const workflowRunner = yield* WorkflowRunner;
        return yield* workflowRunner.resume(Schema.encodeSync(RunCheckpointSchema)(checkpoint));
      }).pipe(
        Effect.provide(currentLayer),
        Effect.map(Schema.decodeUnknownSync(RunCheckpointSchema)),
      );
    }

    const persistedCheckpoint = findLatestCheckpoint(
      yield* Ref.get(input.harness.checkpointStoreRef),
      input.plan.id,
    );

    if (persistedCheckpoint === undefined) {
      return yield* Effect.fail(
        new Error(`Expected persisted durable workflow checkpoint for ${input.plan.id}.`),
      );
    }

    return {
      restartCount,
      finalCheckpoint: persistedCheckpoint,
    } as const;
  });
}

function toComparableSummary(summary: CrashResumeRunSummary) {
  return {
    checkpointCount: summary.checkpointCount,
    stageFingerprint: summary.stageFingerprint,
    finalCheckpointId: summary.finalCheckpointId,
    finalSequence: summary.finalSequence,
    finalStage: summary.finalStage,
    finalOutcome: summary.finalOutcome,
    totalObservations: summary.totalObservations,
    inspection: Schema.encodeSync(WorkflowInspectionSnapshotSchema)(summary.inspection),
  };
}

function crashResumeOutputsMatch(
  baseline: ReadonlyArray<CrashResumeRunSummary>,
  recovered: ReadonlyArray<CrashResumeRunSummary>,
) {
  return (
    JSON.stringify(baseline.map(toComparableSummary)) ===
    JSON.stringify(recovered.map(toComparableSummary))
  );
}

function createCrashResumeArtifact(input: {
  readonly baseline: ReadonlyArray<CrashResumeRunSummary>;
  readonly crashAfterSequences: ReadonlyArray<1 | 2>;
  readonly generatedAt: string;
  readonly profile: SimulationProfile;
  readonly recovered: ReadonlyArray<CrashResumeRunSummary>;
  readonly restartCount: number;
}) {
  const sample = Schema.decodeUnknownSync(CrashResumeSampleSchema)({
    profile: input.profile,
    crashAfterSequences: input.crashAfterSequences,
    restartCount: input.restartCount,
    baseline: input.baseline,
    recovered: input.recovered,
    matchedOutputs: crashResumeOutputsMatch(input.baseline, input.recovered),
  });

  return Schema.decodeUnknownSync(CrashResumeArtifactSchema)({
    benchmark: "e5-crash-resume-harness",
    generatedAt: input.generatedAt,
    sample,
    status: sample.matchedOutputs ? "pass" : "fail",
  });
}

export function runCrashResumeSample(
  profile: SimulationProfile,
  crashAfterSequences: ReadonlyArray<1 | 2> = DEFAULT_CRASH_AFTER_SEQUENCES,
) {
  return Effect.gen(function* () {
    const baselineHarness = yield* makeCrashResumeHarness(profile);
    const recoveredHarness = yield* makeCrashResumeHarness(profile);
    const compiledPlans = yield* compileCrawlPlans(
      Schema.decodeUnknownSync(CrawlPlanCompilerInputSchema)(baselineHarness.compilerInput),
    );

    yield* Effect.forEach(
      compiledPlans,
      (compiledPlan) =>
        runWorkflowUntilCompletion({
          crashAfterSequences: [],
          harness: baselineHarness,
          plan: compiledPlan.plan,
        }),
      { concurrency: 1 },
    );
    const recoveredRuns = yield* Effect.forEach(
      compiledPlans,
      (compiledPlan) =>
        runWorkflowUntilCompletion({
          crashAfterSequences,
          harness: recoveredHarness,
          plan: compiledPlan.plan,
        }),
      { concurrency: 1 },
    );

    const baseline = yield* Effect.forEach(
      compiledPlans,
      ({ plan }) => collectRunSummary(baselineHarness, plan.id),
      { concurrency: 1 },
    );
    const recovered = yield* Effect.forEach(
      compiledPlans,
      ({ plan }) => collectRunSummary(recoveredHarness, plan.id),
      { concurrency: 1 },
    );

    return Schema.decodeUnknownSync(CrashResumeSampleSchema)({
      profile,
      crashAfterSequences,
      restartCount: recoveredRuns.reduce((total, run) => total + run.restartCount, 0),
      baseline,
      recovered,
      matchedOutputs: crashResumeOutputsMatch(baseline, recovered),
    });
  });
}

function createProfile(options: Schema.Schema.Type<typeof CrashResumeOptionsSchema>) {
  return Schema.decodeUnknownSync(SimulationProfileSchema)({
    targetCount: options.targetCount,
    observationsPerTarget: options.observationsPerTarget,
    totalObservations: options.targetCount * options.observationsPerTarget,
  });
}

export async function runHarness(
  args: readonly string[],
  dependencies: CrashResumeHarnessDependencies = {},
) {
  const options = parseOptions(args);
  const profile = createProfile(options);
  const runSample = dependencies.runSample ?? runCrashResumeSample;
  const sample = await Effect.runPromise(runSample(profile, options.crashAfterSequences));
  const artifact = createCrashResumeArtifact({
    profile,
    crashAfterSequences: options.crashAfterSequences,
    generatedAt: new Date().toISOString(),
    baseline: sample.baseline,
    recovered: sample.recovered,
    restartCount: sample.restartCount,
  });

  if (options.artifactPath !== undefined) {
    await mkdir(dirname(options.artifactPath), { recursive: true });
    await writeFile(options.artifactPath, JSON.stringify(artifact, null, 2));
  }

  return artifact;
}

export async function runHarnessCli(
  args: readonly string[],
  dependencies: CrashResumeHarnessCliDependencies = {},
) {
  const artifact = await runHarness(args, dependencies);
  const writeLine =
    dependencies.writeLine ??
    ((line: string) => {
      console.log(line);
    });
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  writeLine(JSON.stringify(artifact, null, 2));

  if (artifact.status === "fail") {
    setExitCode(1);
  }

  return artifact;
}

if (import.meta.main) {
  await runHarnessCli(process.argv.slice(2));
}
