#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema, SchemaGetter } from "effect";
import {
  type BrowserAccessEngine,
  BrowserAccessLive,
} from "../../libs/foundation/core/src/browser-access-runtime.ts";
import {
  BrowserCrashTelemetrySchema,
  BrowserLeakAlarmSchema,
  BrowserLeakPolicySchema,
  BrowserLeakSnapshotSchema,
  makeInMemoryBrowserLeakDetector,
} from "../../libs/foundation/core/src/browser-leak-detection.ts";
import { RunPlanSchema } from "../../libs/foundation/core/src/run-state.ts";
import { BrowserAccess } from "../../libs/foundation/core/src/service-topology.ts";

export const DEFAULT_CONCURRENCY = 6;
export const DEFAULT_ROUNDS = 8;
export const DEFAULT_WARMUP_ITERATIONS = 1;
export const FIXED_DATE = "2026-03-07T00:00:00.000Z";

const CAPTURE_KINDS = ["renderedDom", "screenshot", "networkSummary", "timings"] as const;
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
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

export const BenchmarkSummarySchema = Schema.Struct({
  samples: Schema.Int.check(Schema.isGreaterThan(0)),
  minMs: Schema.Finite,
  meanMs: Schema.Finite,
  p95Ms: Schema.Finite,
  maxMs: Schema.Finite,
});

export const BrowserSoakLoadArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e4-browser-soak-load"),
  generatedAt: Schema.String,
  environment: Schema.Struct({
    bun: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
  }),
  rounds: Schema.Int.check(Schema.isGreaterThan(0)),
  concurrency: Schema.Int.check(Schema.isGreaterThan(0)),
  warmupIterations: NonNegativeIntSchema,
  measurements: Schema.Struct({
    roundDurationMs: BenchmarkSummarySchema,
  }),
  captures: Schema.Struct({
    totalRuns: Schema.Int.check(Schema.isGreaterThan(0)),
    totalArtifacts: Schema.Int.check(Schema.isGreaterThan(0)),
    artifactKinds: Schema.Array(Schema.String),
  }),
  peaks: Schema.Struct({
    openBrowsers: NonNegativeIntSchema,
    openContexts: NonNegativeIntSchema,
    openPages: NonNegativeIntSchema,
  }),
  finalSnapshot: BrowserLeakSnapshotSchema,
  alarms: Schema.Array(BrowserLeakAlarmSchema),
  crashTelemetry: Schema.Array(BrowserCrashTelemetrySchema),
  violations: Schema.Array(Schema.String),
  status: Schema.Literals(["pass", "fail"] as const),
});

export type BrowserSoakLoadArtifact = Schema.Schema.Type<typeof BrowserSoakLoadArtifactSchema>;
type BrowserLeakPolicyEncoded = Schema.Codec.Encoded<typeof BrowserLeakPolicySchema>;
type SyntheticLifecycleState = {
  readonly launches: { current: number };
  readonly currentOpenBrowsers: { current: number };
  readonly currentOpenContexts: { current: number };
  readonly currentOpenPages: { current: number };
  readonly peakOpenBrowsers: { current: number };
  readonly peakOpenContexts: { current: number };
  readonly peakOpenPages: { current: number };
};
type SoakLoadOptions = {
  readonly rounds: number;
  readonly concurrency: number;
  readonly warmupIterations: number;
  readonly policy?: Partial<BrowserLeakPolicyEncoded>;
};

function delay(milliseconds: number) {
  return new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

function createClock(startAtIso: string) {
  let offset = 0;

  return () => {
    const nextDate = new Date(Date.parse(startAtIso) + offset);
    offset += 1;
    return nextDate;
  };
}

function createSyntheticLifecycleState(): SyntheticLifecycleState {
  return {
    launches: { current: 0 },
    currentOpenBrowsers: { current: 0 },
    currentOpenContexts: { current: 0 },
    currentOpenPages: { current: 0 },
    peakOpenBrowsers: { current: 0 },
    peakOpenContexts: { current: 0 },
    peakOpenPages: { current: 0 },
  };
}

function noteOpen(counter: { current: number }, peak: { current: number }) {
  counter.current += 1;
  peak.current = Math.max(peak.current, counter.current);
}

function noteClose(counter: { current: number }) {
  counter.current -= 1;
}

function createSyntheticBrowserAccessEngine(state: SyntheticLifecycleState): BrowserAccessEngine {
  let contextSequence = 0;
  let pageSequence = 0;

  return {
    chromium: {
      launch: async () => {
        state.launches.current += 1;
        const browserId = `browser-${state.launches.current}`;
        noteOpen(state.currentOpenBrowsers, state.peakOpenBrowsers);

        return {
          newContext: async () => {
            contextSequence += 1;
            const contextId = `${browserId}/context-${contextSequence}`;
            noteOpen(state.currentOpenContexts, state.peakOpenContexts);

            return {
              newPage: async () => {
                pageSequence += 1;
                const pageId = `${contextId}/page-${pageSequence}`;
                noteOpen(state.currentOpenPages, state.peakOpenPages);

                return {
                  goto: async () => {
                    await delay(2);
                    return undefined;
                  },
                  content: async () => {
                    await delay(2);
                    return `<html><body><main>${browserId}:${pageId}</main></body></html>`;
                  },
                  screenshot: async () => {
                    await delay(2);
                    return Uint8Array.from([state.launches.current, 4, 2]);
                  },
                  evaluate: async () => {
                    await delay(2);
                    return {
                      navigation: [],
                      resources: [],
                    };
                  },
                  close: async () => {
                    noteClose(state.currentOpenPages);
                  },
                };
              },
              close: async () => {
                noteClose(state.currentOpenContexts);
              },
            };
          },
          close: async () => {
            noteClose(state.currentOpenBrowsers);
          },
        };
      },
    },
  };
}

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
  let rounds = DEFAULT_ROUNDS;
  let concurrency = DEFAULT_CONCURRENCY;
  let warmupIterations = DEFAULT_WARMUP_ITERATIONS;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--artifact") {
      artifactPath = args[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--rounds") {
      rounds = decodePositiveIntegerOption(args[index + 1], DEFAULT_ROUNDS);
      index += 1;
      continue;
    }

    if (argument === "--concurrency") {
      concurrency = decodePositiveIntegerOption(args[index + 1], DEFAULT_CONCURRENCY);
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
    rounds,
    concurrency,
    warmupIterations,
  };
}

export function percentile95(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

export function roundToThree(value: number) {
  return Number.parseFloat(value.toFixed(3));
}

export function summarizeMeasurements(values: readonly number[]) {
  return Schema.decodeUnknownSync(BenchmarkSummarySchema)({
    samples: values.length,
    minMs: roundToThree(Math.min(...values)),
    meanMs: roundToThree(values.reduce((total, value) => total + value, 0) / values.length),
    p95Ms: roundToThree(percentile95(values)),
    maxMs: roundToThree(Math.max(...values)),
  });
}

function createBrowserPlan(round: number, slot: number) {
  const planId = `plan-browser-soak-${round}-${slot}`;

  return Schema.decodeUnknownSync(RunPlanSchema)({
    id: planId,
    targetId: `target-product-${slot}`,
    packId: "pack-example-com",
    accessPolicyId: "policy-browser",
    concurrencyBudgetId: "budget-browser-soak",
    entryUrl: `https://example.com/products/${round}-${slot}`,
    maxAttempts: 2,
    timeoutMs: 30_000,
    checkpointInterval: 2,
    steps: [
      {
        id: `${planId}-capture`,
        stage: "capture",
        requiresBrowser: true,
        artifactKind: "renderedDom",
      },
      {
        id: `${planId}-extract`,
        stage: "extract",
        requiresBrowser: false,
      },
    ],
    createdAt: FIXED_DATE,
  });
}

function collectViolations(options: {
  readonly rounds: number;
  readonly concurrency: number;
  readonly state: SyntheticLifecycleState;
  readonly alarms: ReadonlyArray<Schema.Schema.Type<typeof BrowserLeakAlarmSchema>>;
  readonly crashTelemetry: ReadonlyArray<Schema.Schema.Type<typeof BrowserCrashTelemetrySchema>>;
  readonly finalSnapshot: Schema.Schema.Type<typeof BrowserLeakSnapshotSchema>;
  readonly totalArtifacts: number;
  readonly artifactKinds: ReadonlyArray<string>;
}) {
  const violations = new Array<string>();
  const expectedRuns = options.rounds * options.concurrency;
  const expectedArtifacts = expectedRuns * CAPTURE_KINDS.length;

  if (options.finalSnapshot.openBrowsers !== 0) {
    violations.push(`Expected zero open browsers, received ${options.finalSnapshot.openBrowsers}.`);
  }

  if (options.finalSnapshot.openContexts !== 0) {
    violations.push(`Expected zero open contexts, received ${options.finalSnapshot.openContexts}.`);
  }

  if (options.finalSnapshot.openPages !== 0) {
    violations.push(`Expected zero open pages, received ${options.finalSnapshot.openPages}.`);
  }

  if (options.alarms.length > 0) {
    violations.push(`Expected zero leak alarms, received ${options.alarms.length}.`);
  }

  if (options.crashTelemetry.length > 0) {
    violations.push(
      `Expected zero crash telemetry entries during soak/load, received ${options.crashTelemetry.length}.`,
    );
  }

  if (options.state.peakOpenBrowsers.current > 1) {
    violations.push(
      `Expected at most one open browser per scoped round, received ${options.state.peakOpenBrowsers.current}.`,
    );
  }

  if (options.state.peakOpenContexts.current > options.concurrency) {
    violations.push(
      `Expected at most ${options.concurrency} open contexts, received ${options.state.peakOpenContexts.current}.`,
    );
  }

  if (options.state.peakOpenPages.current > options.concurrency) {
    violations.push(
      `Expected at most ${options.concurrency} open pages, received ${options.state.peakOpenPages.current}.`,
    );
  }

  if (options.totalArtifacts !== expectedArtifacts) {
    violations.push(
      `Expected ${expectedArtifacts} artifacts across ${expectedRuns} captures, received ${options.totalArtifacts}.`,
    );
  }

  if (options.artifactKinds.join(",") !== [...CAPTURE_KINDS].join(",")) {
    violations.push(
      `Expected artifact kinds ${CAPTURE_KINDS.join(",")}, received ${options.artifactKinds.join(",")}.`,
    );
  }

  return violations;
}

async function measureRounds(
  rounds: number,
  warmupIterations: number,
  effectFactory: (
    round: number,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<{ kind: string }>>, unknown>,
) {
  for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
    await Effect.runPromise(effectFactory(-1 - iteration));
  }

  const durations = new Array<number>();
  const artifacts = new Array<ReadonlyArray<ReadonlyArray<{ kind: string }>>>();

  for (let round = 0; round < rounds; round += 1) {
    const startedAt = performance.now();
    const roundArtifacts = await Effect.runPromise(effectFactory(round));
    durations.push(performance.now() - startedAt);
    artifacts.push(roundArtifacts);
  }

  return {
    artifacts,
    measurements: summarizeMeasurements(durations),
  };
}

export async function runSoakLoadSuite(options: Partial<SoakLoadOptions> = {}) {
  const rounds = options.rounds ?? DEFAULT_ROUNDS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const warmupIterations = options.warmupIterations ?? DEFAULT_WARMUP_ITERATIONS;
  const state = createSyntheticLifecycleState();
  const engine = createSyntheticBrowserAccessEngine(state);
  const clock = createClock(FIXED_DATE);
  const detector = await Effect.runPromise(
    makeInMemoryBrowserLeakDetector(
      {
        maxOpenBrowsers: 1,
        maxOpenContexts: concurrency,
        maxOpenPages: concurrency,
        consecutiveViolationThreshold: 1,
        sampleIntervalMs: 100,
        ...options.policy,
      },
      clock,
    ),
  );

  const { artifacts, measurements } = await measureRounds(rounds, warmupIterations, (round) =>
    Effect.scoped(
      Effect.gen(function* () {
        const access = yield* BrowserAccess;
        return yield* Effect.all(
          Array.from({ length: concurrency }, (_, slot) =>
            access.capture(createBrowserPlan(round, slot)),
          ),
          { concurrency: "unbounded" },
        );
      }).pipe(
        Effect.provide(
          BrowserAccessLive({
            detector,
            engine,
            now: clock,
          }),
        ),
      ),
    ),
  );

  const finalSnapshot = await Effect.runPromise(detector.inspect);
  const alarms = await Effect.runPromise(detector.readAlarms);
  const crashTelemetry = await Effect.runPromise(detector.readCrashTelemetry);
  const flattenedArtifacts = artifacts.flat(2);
  const artifactKinds = CAPTURE_KINDS.filter((kind) =>
    flattenedArtifacts.some((artifact) => artifact.kind === kind),
  );
  const violations = collectViolations({
    rounds,
    concurrency,
    state,
    alarms,
    crashTelemetry,
    finalSnapshot,
    totalArtifacts: flattenedArtifacts.length,
    artifactKinds,
  });

  return Schema.decodeUnknownSync(BrowserSoakLoadArtifactSchema)({
    benchmark: "e4-browser-soak-load",
    generatedAt: clock().toISOString(),
    environment: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    rounds,
    concurrency,
    warmupIterations,
    measurements: {
      roundDurationMs: measurements,
    },
    captures: {
      totalRuns: rounds * concurrency,
      totalArtifacts: flattenedArtifacts.length,
      artifactKinds,
    },
    peaks: {
      openBrowsers: state.peakOpenBrowsers.current,
      openContexts: state.peakOpenContexts.current,
      openPages: state.peakOpenPages.current,
    },
    finalSnapshot,
    alarms,
    crashTelemetry,
    violations,
    status: violations.length === 0 ? "pass" : "fail",
  });
}

export async function runBenchmark(args: readonly string[]) {
  const options = parseOptions(args);
  const artifact = await runSoakLoadSuite(options);

  if (options.artifactPath !== undefined) {
    await mkdir(dirname(options.artifactPath), { recursive: true });
    await writeFile(options.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  }

  return artifact;
}

if (import.meta.main) {
  try {
    const artifact = await runBenchmark(Bun.argv.slice(2));
    console.log(JSON.stringify(artifact, null, 2));
    if (artifact.status !== "pass") {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
