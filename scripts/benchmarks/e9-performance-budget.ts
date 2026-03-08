#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Schema, SchemaGetter } from "effect";
import {
  E9PerformanceBudgetArtifactSchema,
  runE9PerformanceBudget,
} from "../../src/e9-performance-budget.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const DEFAULT_ARTIFACT_PATH = resolve(
  REPO_ROOT,
  "docs/artifacts/e9-performance-budget-scorecard.json",
);
const DEFAULT_BASELINE_PATH = resolve(
  REPO_ROOT,
  "docs/artifacts/e9-performance-budget-baseline.json",
);
const GENERATED_AT = "2026-03-08T22:55:00.000Z";

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

export function parseOptions(args: readonly string[]) {
  let artifactPath = DEFAULT_ARTIFACT_PATH;
  let baselinePath = DEFAULT_BASELINE_PATH;
  let sampleSize = 1;
  let warmupIterations = 0;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const rawValue = args[index + 1];

    if (argument === "--artifact") {
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error("Missing value for argument: --artifact");
      }

      artifactPath = resolve(REPO_ROOT, rawValue);
      index += 1;
      continue;
    }

    if (argument === "--baseline") {
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error("Missing value for argument: --baseline");
      }

      baselinePath = resolve(REPO_ROOT, rawValue);
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
    artifactPath,
    baselinePath,
    sampleSize,
    warmupIterations,
  };
}

async function persist(path: string, artifact: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function runDefaultE9PerformanceBudget(args: readonly string[] = []) {
  const options = parseOptions(args);
  const baseline = (await Bun.file(options.baselinePath).exists())
    ? Schema.decodeUnknownSync(E9PerformanceBudgetArtifactSchema)(
        JSON.parse(await readFile(options.baselinePath, "utf8")),
      )
    : undefined;
  const artifact = await runE9PerformanceBudget({
    benchmarkId: "e9-performance-budget",
    generatedAt: GENERATED_AT,
    sampleSize: options.sampleSize,
    warmupIterations: options.warmupIterations,
    baselinePath: options.baselinePath,
    ...(baseline === undefined ? {} : { baseline }),
  });
  const encoded = Schema.encodeSync(E9PerformanceBudgetArtifactSchema)(artifact);
  await persist(options.artifactPath, encoded);
  return encoded;
}

if (import.meta.main) {
  const artifact = await runDefaultE9PerformanceBudget(process.argv.slice(2));
  console.log(JSON.stringify(artifact, null, 2));
}
