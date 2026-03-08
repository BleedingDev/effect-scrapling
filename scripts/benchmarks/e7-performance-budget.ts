#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema, SchemaGetter } from "effect";
import { runDefaultBaselineCorpus } from "./e7-baseline-corpus.ts";
import { runDefaultIncumbentComparison } from "./e7-incumbent-comparison.ts";
import {
  PerformanceBudgetArtifactSchema,
  PerformanceBudgetMeasurementsSchema,
  PerformanceBudgetPolicySchema,
  evaluatePerformanceBudget,
  roundToThree,
  summarizeMeasurements,
} from "../../libs/foundation/core/src/performance-gate-runtime.ts";

export const DEFAULT_SAMPLE_SIZE = 3;
export const DEFAULT_WARMUP_ITERATIONS = 1;
const FixedDate = "2026-03-08T16:00:00.000Z";

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

export const PERFORMANCE_BUDGETS = Schema.decodeUnknownSync(PerformanceBudgetPolicySchema)({
  baselineCorpusP95Ms: 500,
  incumbentComparisonP95Ms: 1200,
  heapDeltaKiB: 16_384,
});

export function parseOptions(args: readonly string[]) {
  let artifactPath: string | undefined;
  let baselinePath: string | undefined;
  let sampleSize = DEFAULT_SAMPLE_SIZE;
  let warmupIterations = DEFAULT_WARMUP_ITERATIONS;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const rawValue = args[index + 1];

    if (argument === "--artifact") {
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error("Missing value for argument: --artifact");
      }

      artifactPath = resolve(rawValue);
      index += 1;
      continue;
    }

    if (argument === "--baseline") {
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error("Missing value for argument: --baseline");
      }

      baselinePath = resolve(rawValue);
      index += 1;
      continue;
    }

    if (argument === "--sample-size") {
      sampleSize = Schema.decodeUnknownSync(PositiveIntArgumentSchema)(rawValue);
      index += 1;
      continue;
    }

    if (argument === "--warmup") {
      warmupIterations = Schema.decodeUnknownSync(NonNegativeIntArgumentSchema)(rawValue);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    ...(artifactPath !== undefined ? { artifactPath } : {}),
    ...(baselinePath !== undefined ? { baselinePath } : {}),
    sampleSize,
    warmupIterations,
  };
}

export type BenchmarkOptions = ReturnType<typeof parseOptions>;

export async function measureEffect(
  sampleSize: number,
  warmupIterations: number,
  effectFactory: () => Promise<unknown>,
) {
  for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
    await effectFactory();
  }

  const values = new Array<number>();
  for (let iteration = 0; iteration < sampleSize; iteration += 1) {
    const startedAt = performance.now();
    await effectFactory();
    values.push(performance.now() - startedAt);
  }

  return summarizeMeasurements(values);
}

export async function readBaseline(path: string | undefined) {
  if (path === undefined) {
    return undefined;
  }

  return Schema.decodeUnknownSync(PerformanceBudgetArtifactSchema)(
    JSON.parse(await readFile(path, "utf8")),
  );
}

async function persistArtifact(path: string, artifact: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function runBenchmark(args: readonly string[]) {
  const options = parseOptions(args);
  const baselineCorpusArtifact = await runDefaultBaselineCorpus();
  const profile = {
    caseCount: baselineCorpusArtifact.caseCount,
    packCount: baselineCorpusArtifact.packCount,
  };
  const baseline = await readBaseline(options.baselinePath);

  const startedHeap = process.memoryUsage().heapUsed;
  const measurements = Schema.decodeUnknownSync(PerformanceBudgetMeasurementsSchema)({
    baselineCorpus: await measureEffect(options.sampleSize, options.warmupIterations, () =>
      runDefaultBaselineCorpus(),
    ),
    incumbentComparison: await measureEffect(options.sampleSize, options.warmupIterations, () =>
      runDefaultIncumbentComparison(),
    ),
    heapDeltaKiB: roundToThree(Math.max(0, process.memoryUsage().heapUsed - startedHeap) / 1024),
  });

  const artifact = await Effect.runPromise(
    evaluatePerformanceBudget({
      benchmarkId: "e7-performance-budget",
      generatedAt: FixedDate,
      environment: {
        bun: process.versions.bun,
        platform: process.platform,
        arch: process.arch,
      },
      sampleSize: options.sampleSize,
      warmupIterations: options.warmupIterations,
      profile,
      policy: PERFORMANCE_BUDGETS,
      measurements,
      ...(options.baselinePath === undefined ? {} : { baselinePath: options.baselinePath }),
      ...(baseline === undefined ? {} : { baseline }),
    }),
  );

  if (options.artifactPath !== undefined) {
    await persistArtifact(options.artifactPath, artifact);
  }

  return Schema.decodeUnknownSync(PerformanceBudgetArtifactSchema)(artifact);
}

if (import.meta.main) {
  const artifact = await runBenchmark(process.argv.slice(2));
  console.log(JSON.stringify(artifact, null, 2));
}
