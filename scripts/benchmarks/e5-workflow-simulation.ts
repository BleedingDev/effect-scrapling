#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { DurableWorkflowRuntimeLive } from "../../libs/foundation/core/src/durable-workflow-runtime.ts";
import {
  PackPromotionDecisionSchema,
  QualityVerdictSchema,
  SnapshotDiffSchema,
} from "../../libs/foundation/core/src/diff-verdict.ts";
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
import { TargetProfileSchema } from "../../libs/foundation/core/src/target-profile.ts";

const CREATED_AT = "2026-03-07T14:00:00.000Z";
const EXPECTED_CHECKPOINT_STAGE_FINGERPRINT = "snapshot>quality>reflect";

export const DEFAULT_TARGET_COUNT = 100;
export const DEFAULT_OBSERVATIONS_PER_TARGET = 2_000;
export const DEFAULT_SAMPLE_SIZE = 2;
export const DEFAULT_WARMUP_ITERATIONS = 1;
export const SIMULATION_CONCURRENCY = 8;

const PositiveIntFromString = Schema.FiniteFromString.check(Schema.isInt()).check(
  Schema.isGreaterThan(0),
);
const NonNegativeIntFromString = Schema.FiniteFromString.check(Schema.isInt()).check(
  Schema.isGreaterThanOrEqualTo(0),
);
const PositiveIntArgumentSchema = Schema.Trim.pipe(
  Schema.check(Schema.isPattern(/^\d+$/u)),
  Schema.decodeTo(PositiveIntFromString, {
    decode: SchemaGetter.passthrough(),
    encode: SchemaGetter.String(),
  }),
);
const NonNegativeIntArgumentSchema = Schema.Trim.pipe(
  Schema.check(Schema.isPattern(/^\d+$/u)),
  Schema.decodeTo(NonNegativeIntFromString, {
    decode: SchemaGetter.passthrough(),
    encode: SchemaGetter.String(),
  }),
);

export const PERFORMANCE_BUDGETS = {
  workflowDurationP95Ms: 10_000,
  observationsPerSecondMin: 20_000,
  checkpointsPerSecondMin: 60,
} as const;

export const BenchmarkSummarySchema = Schema.Struct({
  samples: Schema.Int.check(Schema.isGreaterThan(0)),
  min: Schema.Finite,
  mean: Schema.Finite,
  p95: Schema.Finite,
  max: Schema.Finite,
});

export const SimulationProfileSchema = Schema.Struct({
  targetCount: Schema.Int.check(Schema.isGreaterThan(0)),
  observationsPerTarget: Schema.Int.check(Schema.isGreaterThan(0)),
  totalObservations: Schema.Int.check(Schema.isGreaterThan(0)),
});

export const SimulationMeasurementSchema = Schema.Struct({
  durationMs: Schema.Finite.check(Schema.isGreaterThan(0)),
  observationsPerSecond: Schema.Finite.check(Schema.isGreaterThan(0)),
  checkpointsPerSecond: Schema.Finite.check(Schema.isGreaterThan(0)),
  checkpointCount: Schema.Int.check(Schema.isGreaterThan(0)),
  stageFingerprint: Schema.Trim.check(Schema.isNonEmpty()),
  totalObservations: Schema.Int.check(Schema.isGreaterThan(0)),
});

export const BenchmarkArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e5-workflow-simulation"),
  generatedAt: Schema.String,
  environment: Schema.Struct({
    bun: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
  }),
  sampleSize: Schema.Int.check(Schema.isGreaterThan(0)),
  warmupIterations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  profile: SimulationProfileSchema,
  budgets: Schema.Struct({
    workflowDurationP95Ms: Schema.Int.check(Schema.isGreaterThan(0)),
    observationsPerSecondMin: Schema.Int.check(Schema.isGreaterThan(0)),
    checkpointsPerSecondMin: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  measurements: Schema.Struct({
    workflowDurationMs: BenchmarkSummarySchema,
    observationsPerSecond: BenchmarkSummarySchema,
    checkpointsPerSecond: BenchmarkSummarySchema,
  }),
  stability: Schema.Struct({
    expectedCheckpointCount: Schema.Int.check(Schema.isGreaterThan(0)),
    observedCheckpointCount: Schema.Int.check(Schema.isGreaterThan(0)),
    consistentCheckpointCount: Schema.Boolean,
    expectedStageFingerprint: Schema.Trim.check(Schema.isNonEmpty()),
    observedStageFingerprint: Schema.Trim.check(Schema.isNonEmpty()),
    consistentStageFingerprint: Schema.Boolean,
  }),
  comparison: Schema.Struct({
    baselinePath: Schema.NullOr(Schema.String),
    deltas: Schema.Struct({
      workflowDurationP95Ms: Schema.NullOr(Schema.Finite),
      observationsPerSecondMean: Schema.NullOr(Schema.Finite),
      checkpointsPerSecondMean: Schema.NullOr(Schema.Finite),
    }),
  }),
  violations: Schema.Array(Schema.String),
  status: Schema.Literals(["pass", "fail"] as const),
});

export type BenchmarkArtifact = Schema.Schema.Type<typeof BenchmarkArtifactSchema>;
type SimulationProfile = Schema.Schema.Type<typeof SimulationProfileSchema>;
type SimulationMeasurement = Schema.Schema.Type<typeof SimulationMeasurementSchema>;

const pack = Schema.decodeUnknownSync(SitePackSchema)({
  id: "pack-example-com",
  domainPattern: "*.example.com",
  state: "shadow",
  accessPolicyId: "policy-browser",
  version: "2026.03.07",
});

const accessPolicy = {
  id: "policy-browser",
  mode: "browser",
  perDomainConcurrency: 8,
  globalConcurrency: 32,
  timeoutMs: 20_000,
  maxRetries: 2,
  render: "always",
} as const;

function decodePositiveIntegerOption(rawValue: string | undefined, fallback: number) {
  if (rawValue === undefined) {
    return fallback;
  }

  return Schema.decodeUnknownSync(PositiveIntArgumentSchema)(rawValue);
}

function decodeNonNegativeIntegerOption(rawValue: string | undefined, fallback: number) {
  if (rawValue === undefined) {
    return fallback;
  }

  return Schema.decodeUnknownSync(NonNegativeIntArgumentSchema)(rawValue);
}

export function parseOptions(args: readonly string[]) {
  let artifactPath: string | undefined;
  let baselinePath: string | undefined;
  let targetCount = DEFAULT_TARGET_COUNT;
  let observationsPerTarget = DEFAULT_OBSERVATIONS_PER_TARGET;
  let sampleSize = DEFAULT_SAMPLE_SIZE;
  let warmupIterations = DEFAULT_WARMUP_ITERATIONS;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--artifact") {
      artifactPath = args[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--baseline") {
      baselinePath = args[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--targets") {
      targetCount = decodePositiveIntegerOption(args[index + 1], DEFAULT_TARGET_COUNT);
      index += 1;
      continue;
    }

    if (argument === "--observations-per-target") {
      observationsPerTarget = decodePositiveIntegerOption(
        args[index + 1],
        DEFAULT_OBSERVATIONS_PER_TARGET,
      );
      index += 1;
      continue;
    }

    if (argument === "--sample-size") {
      sampleSize = decodePositiveIntegerOption(args[index + 1], DEFAULT_SAMPLE_SIZE);
      index += 1;
      continue;
    }

    if (argument === "--warmup") {
      warmupIterations = decodeNonNegativeIntegerOption(args[index + 1], DEFAULT_WARMUP_ITERATIONS);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    ...(artifactPath !== undefined ? { artifactPath: resolve(artifactPath) } : {}),
    ...(baselinePath !== undefined ? { baselinePath: resolve(baselinePath) } : {}),
    targetCount,
    observationsPerTarget,
    sampleSize,
    warmupIterations,
  };
}

function percentile95(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

export function roundToThree(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

export function summarizeMeasurements(values: readonly number[]) {
  return Schema.decodeUnknownSync(BenchmarkSummarySchema)({
    samples: values.length,
    min: roundToThree(Math.min(...values)),
    mean: roundToThree(values.reduce((total, value) => total + value, 0) / values.length),
    p95: roundToThree(percentile95(values)),
    max: roundToThree(Math.max(...values)),
  });
}

function createProfile(options: ReturnType<typeof parseOptions>) {
  return Schema.decodeUnknownSync(SimulationProfileSchema)({
    targetCount: options.targetCount,
    observationsPerTarget: options.observationsPerTarget,
    totalObservations: options.targetCount * options.observationsPerTarget,
  });
}

function makeTarget(index: number) {
  const suffix = index.toString().padStart(4, "0");
  return Schema.decodeUnknownSync(TargetProfileSchema)({
    id: `target-product-${suffix}`,
    tenantId: "tenant-main",
    domain: "example.com",
    kind: "productPage",
    canonicalKey: `catalog/product-${suffix}`,
    seedUrls: [`https://example.com/products/${suffix}`],
    accessPolicyId: pack.accessPolicyId,
    packId: pack.id,
    priority: 100 - index,
  });
}

function makeCompilerInput(profile: SimulationProfile) {
  return Schema.decodeUnknownSync(CrawlPlanCompilerInputSchema)({
    createdAt: CREATED_AT,
    defaults: {
      checkpointInterval: 2,
    },
    entries: Array.from({ length: profile.targetCount }, (_, index) => ({
      target: makeTarget(index + 1),
      pack,
      accessPolicy,
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

function makeRuntimeLayer(profile: SimulationProfile) {
  return Effect.gen(function* () {
    let nowTick = 0;
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
      checkpointStoreRef,
      layer: Layer.mergeAll(
        baseLayer,
        DurableWorkflowRuntimeLive({
          now: () => new Date(Date.parse(CREATED_AT) + nowTick++ * 1_000),
        }).pipe(Layer.provide(baseLayer)),
      ),
      snapshotStoreRef,
    };
  });
}

function fingerprintCheckpoints(
  checkpointRecords: ReadonlyArray<Schema.Schema.Type<typeof CheckpointRecordSchema>>,
) {
  const fingerprints = new Set(
    checkpointRecords
      .reduce((grouped, record) => {
        const existing = grouped.get(record.runId) ?? [];
        existing.push(record.checkpoint);
        grouped.set(record.runId, existing);
        return grouped;
      }, new Map<string, Array<Schema.Schema.Type<typeof RunCheckpointSchema>>>())
      .values()
      .map((checkpoints) =>
        checkpoints
          .sort((left, right) => left.sequence - right.sequence)
          .map(({ stage }) => stage)
          .join(">"),
      ),
  );

  return fingerprints.size === 1
    ? ([...fingerprints][0] ?? EXPECTED_CHECKPOINT_STAGE_FINGERPRINT)
    : [...fingerprints].sort().join("|");
}

export function runSimulationSample(profile: SimulationProfile) {
  return Effect.gen(function* () {
    const compiledPlans = yield* compileCrawlPlans(makeCompilerInput(profile));
    const harness = yield* makeRuntimeLayer(profile);

    const startedAt = performance.now();
    yield* Effect.gen(function* () {
      const workflowRunner = yield* WorkflowRunner;
      yield* Effect.forEach(
        compiledPlans,
        (compiledPlan) =>
          Effect.gen(function* () {
            const started = yield* workflowRunner.start(compiledPlan.plan);
            const resumed = yield* workflowRunner.resume(started);
            yield* workflowRunner.resume(resumed);
          }),
        { concurrency: SIMULATION_CONCURRENCY },
      );
    }).pipe(Effect.provide(harness.layer));
    const durationMs = performance.now() - startedAt;

    const checkpointRecords = yield* Ref.get(harness.checkpointStoreRef);
    const snapshots = yield* Ref.get(harness.snapshotStoreRef);
    const totalObservations = [...snapshots.values()].reduce(
      (total, snapshot) => total + snapshot.observations.length,
      0,
    );
    const checkpointCount = checkpointRecords.length;
    const stageFingerprint = fingerprintCheckpoints(checkpointRecords);
    const measuredDurationMs = Math.max(durationMs, 0.001);

    return Schema.decodeUnknownSync(SimulationMeasurementSchema)({
      durationMs: roundToThree(measuredDurationMs),
      observationsPerSecond: roundToThree((totalObservations / measuredDurationMs) * 1_000),
      checkpointsPerSecond: roundToThree((checkpointCount / measuredDurationMs) * 1_000),
      checkpointCount,
      stageFingerprint,
      totalObservations,
    });
  });
}

async function readBaseline(path: string | undefined) {
  if (path === undefined) {
    return undefined;
  }

  const baseline = await readFile(path, "utf8");
  return Schema.decodeUnknownSync(BenchmarkArtifactSchema)(JSON.parse(baseline));
}

function createViolations(artifact: Pick<BenchmarkArtifact, "measurements" | "stability">) {
  const violations = new Array<string>();

  if (artifact.measurements.workflowDurationMs.p95 > PERFORMANCE_BUDGETS.workflowDurationP95Ms) {
    violations.push(
      `workflow duration p95 ${artifact.measurements.workflowDurationMs.p95}ms exceeded budget ${PERFORMANCE_BUDGETS.workflowDurationP95Ms}ms`,
    );
  }

  if (
    artifact.measurements.observationsPerSecond.mean < PERFORMANCE_BUDGETS.observationsPerSecondMin
  ) {
    violations.push(
      `observation throughput ${artifact.measurements.observationsPerSecond.mean}/s fell below budget ${PERFORMANCE_BUDGETS.observationsPerSecondMin}/s`,
    );
  }

  if (
    artifact.measurements.checkpointsPerSecond.mean < PERFORMANCE_BUDGETS.checkpointsPerSecondMin
  ) {
    violations.push(
      `checkpoint throughput ${artifact.measurements.checkpointsPerSecond.mean}/s fell below budget ${PERFORMANCE_BUDGETS.checkpointsPerSecondMin}/s`,
    );
  }

  if (artifact.stability.observedCheckpointCount !== artifact.stability.expectedCheckpointCount) {
    violations.push(
      `checkpoint count ${artifact.stability.observedCheckpointCount} did not match expected ${artifact.stability.expectedCheckpointCount}`,
    );
  }

  if (!artifact.stability.consistentCheckpointCount) {
    violations.push("checkpoint count varied across repeated simulation samples");
  }

  if (artifact.stability.observedStageFingerprint !== artifact.stability.expectedStageFingerprint) {
    violations.push(
      `checkpoint stage fingerprint ${artifact.stability.observedStageFingerprint} did not match expected ${artifact.stability.expectedStageFingerprint}`,
    );
  }

  if (!artifact.stability.consistentStageFingerprint) {
    violations.push("checkpoint stage fingerprint varied across repeated simulation samples");
  }

  return violations;
}

export function buildArtifact(
  options: ReturnType<typeof parseOptions>,
  profile: SimulationProfile,
  samples: ReadonlyArray<SimulationMeasurement>,
  baseline: BenchmarkArtifact | undefined,
) {
  const expectedCheckpointCount = profile.targetCount * 3;
  const firstSample = samples[0];
  if (firstSample === undefined) {
    throw new Error("Expected at least one simulation sample.");
  }
  const checkpointCounts = new Set(samples.map(({ checkpointCount }) => checkpointCount));
  const stageFingerprints = new Set(samples.map(({ stageFingerprint }) => stageFingerprint));

  const body = {
    sampleSize: options.sampleSize,
    warmupIterations: options.warmupIterations,
    profile,
    budgets: PERFORMANCE_BUDGETS,
    measurements: {
      workflowDurationMs: summarizeMeasurements(samples.map(({ durationMs }) => durationMs)),
      observationsPerSecond: summarizeMeasurements(
        samples.map(({ observationsPerSecond }) => observationsPerSecond),
      ),
      checkpointsPerSecond: summarizeMeasurements(
        samples.map(({ checkpointsPerSecond }) => checkpointsPerSecond),
      ),
    },
    stability: {
      expectedCheckpointCount,
      observedCheckpointCount: firstSample.checkpointCount,
      consistentCheckpointCount: checkpointCounts.size === 1,
      expectedStageFingerprint: EXPECTED_CHECKPOINT_STAGE_FINGERPRINT,
      observedStageFingerprint: firstSample.stageFingerprint,
      consistentStageFingerprint: stageFingerprints.size === 1,
    },
    comparison: {
      baselinePath: options.baselinePath ?? null,
      deltas: {
        workflowDurationP95Ms: baseline
          ? roundToThree(
              summarizeMeasurements(samples.map(({ durationMs }) => durationMs)).p95 -
                baseline.measurements.workflowDurationMs.p95,
            )
          : null,
        observationsPerSecondMean: baseline
          ? roundToThree(
              summarizeMeasurements(
                samples.map(({ observationsPerSecond }) => observationsPerSecond),
              ).mean - baseline.measurements.observationsPerSecond.mean,
            )
          : null,
        checkpointsPerSecondMean: baseline
          ? roundToThree(
              summarizeMeasurements(samples.map(({ checkpointsPerSecond }) => checkpointsPerSecond))
                .mean - baseline.measurements.checkpointsPerSecond.mean,
            )
          : null,
      },
    },
  };
  const violations = createViolations(body);

  return Schema.decodeUnknownSync(BenchmarkArtifactSchema)({
    benchmark: "e5-workflow-simulation",
    generatedAt: new Date().toISOString(),
    environment: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    ...body,
    violations,
    status: violations.length === 0 ? "pass" : "fail",
  });
}

export async function runBenchmark(args: readonly string[]) {
  const options = parseOptions(args);
  const profile = createProfile(options);
  const baseline = await readBaseline(options.baselinePath);

  for (let iteration = 0; iteration < options.warmupIterations; iteration += 1) {
    await Effect.runPromise(runSimulationSample(profile).pipe(Effect.orDie));
  }

  const measurements = new Array<SimulationMeasurement>();
  for (let iteration = 0; iteration < options.sampleSize; iteration += 1) {
    measurements.push(await Effect.runPromise(runSimulationSample(profile).pipe(Effect.orDie)));
  }

  const artifact = buildArtifact(options, profile, measurements, baseline);
  if (options.artifactPath !== undefined) {
    await mkdir(dirname(options.artifactPath), { recursive: true });
    await writeFile(options.artifactPath, JSON.stringify(artifact, null, 2));
  }

  return artifact;
}

if (import.meta.main) {
  const artifact = await runBenchmark(process.argv.slice(2));

  console.log(JSON.stringify(artifact, null, 2));

  if (artifact.status === "fail") {
    process.exitCode = 1;
  }
}
