#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema, SchemaGetter } from "effect";
import {
  QualitySoakArtifactSchema,
  QualitySoakSampleSchema,
  evaluateQualitySoakSuite,
} from "../../libs/foundation/core/src/quality-soak-suite-runtime.ts";
import { runDefaultBaselineCorpus } from "./e7-baseline-corpus.ts";
import { runDefaultIncumbentComparison } from "./e7-incumbent-comparison.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
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

export const DEFAULT_ITERATIONS = 4;
export const DEFAULT_WARMUP_ITERATIONS = 1;

function roundToThree(value: number) {
  return Number(value.toFixed(3));
}

function baselineFingerprint(artifact: Awaited<ReturnType<typeof runDefaultBaselineCorpus>>) {
  return [
    artifact.corpusId,
    artifact.caseCount,
    artifact.packCount,
    ...artifact.results.map(
      ({ caseId, packId, targetId, canonicalSnapshot }) =>
        `${caseId}:${packId}:${targetId}:${canonicalSnapshot.snapshotId}:${canonicalSnapshot.confidenceScore}:${canonicalSnapshot.fields.map(({ field, valueFingerprint }) => `${field}:${valueFingerprint}`).join(",")}`,
    ),
  ].join("|");
}

function comparisonFingerprint(
  artifact: Awaited<ReturnType<typeof runDefaultIncumbentComparison>>,
) {
  return [
    artifact.comparisonId,
    artifact.caseCount,
    artifact.packCount,
    ...artifact.results.map(
      ({ caseId, verdict, snapshotDiff }) =>
        `${caseId}:${verdict}:${snapshotDiff.id}:${snapshotDiff.changes?.length ?? 0}`,
    ),
  ].join("|");
}

export function parseOptions(args: readonly string[]) {
  let artifactPath: string | undefined;
  let iterations = DEFAULT_ITERATIONS;
  let warmupIterations = DEFAULT_WARMUP_ITERATIONS;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const rawValue = args[index + 1];

    if (argument === "--artifact") {
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error("Missing value for argument: --artifact");
      }

      artifactPath = resolve(Schema.decodeUnknownSync(NonEmptyStringSchema)(rawValue));
      index += 1;
      continue;
    }

    if (argument === "--iterations") {
      iterations = Schema.decodeUnknownSync(PositiveIntArgumentSchema)(rawValue);
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
    ...(artifactPath === undefined ? {} : { artifactPath }),
    iterations,
    warmupIterations,
  };
}

async function persistArtifact(path: string, artifact: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

async function collectSample(iteration: number) {
  const startedHeap = process.memoryUsage().heapUsed;
  const baselineStartedAt = performance.now();
  const baseline = await runDefaultBaselineCorpus();
  const baselineCorpusMs = roundToThree(performance.now() - baselineStartedAt);
  const comparisonStartedAt = performance.now();
  const comparison = await runDefaultIncumbentComparison();
  const incumbentComparisonMs = roundToThree(performance.now() - comparisonStartedAt);
  const heapDeltaKiB = roundToThree(
    Math.max(0, process.memoryUsage().heapUsed - startedHeap) / 1024,
  );

  return Schema.decodeUnknownSync(QualitySoakSampleSchema)({
    iteration,
    baselineCorpusMs,
    incumbentComparisonMs,
    heapDeltaKiB,
    baselineFingerprint: baselineFingerprint(baseline),
    comparisonFingerprint: comparisonFingerprint(comparison),
  });
}

export async function runBenchmark(args: readonly string[]) {
  const options = parseOptions(args);

  for (let iteration = 0; iteration < options.warmupIterations; iteration += 1) {
    await collectSample(iteration + 1);
  }

  const samples = new Array<Schema.Schema.Type<typeof QualitySoakSampleSchema>>();
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    samples.push(await collectSample(iteration + 1));
  }

  const artifact = await Effect.runPromise(
    evaluateQualitySoakSuite({
      suiteId: "suite-e7-soak-endurance",
      generatedAt: "2026-03-08T19:45:00.000Z",
      samples,
    }),
  );

  if (options.artifactPath !== undefined) {
    await persistArtifact(options.artifactPath, artifact);
  }

  return Schema.decodeUnknownSync(QualitySoakArtifactSchema)(artifact);
}

if (import.meta.main) {
  const artifact = await runBenchmark(process.argv.slice(2));
  console.log(JSON.stringify(artifact, null, 2));
}
