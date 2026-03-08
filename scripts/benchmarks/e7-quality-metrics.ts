#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema } from "effect";
import {
  QualityMetricsArtifactSchema,
  evaluateQualityMetrics,
} from "../../libs/foundation/core/src/quality-metrics-runtime.ts";
import { runDefaultBaselineCorpus } from "./e7-baseline-corpus.ts";
import { runDefaultIncumbentComparison } from "./e7-incumbent-comparison.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

export const QualityMetricsCliOptionsSchema = Schema.Struct({
  artifactPath: Schema.optional(NonEmptyStringSchema),
});

type QualityMetricsCliOptions = Schema.Schema.Type<typeof QualityMetricsCliOptionsSchema>;
type QualityMetricsCliDependencies = {
  readonly setExitCode?: (code: number) => void;
  readonly writeLine?: (line: string) => void;
};

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

export function parseOptions(args: readonly string[]) {
  let artifactPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--artifact") {
      const rawValue = args[index + 1];
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error("Missing value for argument: --artifact");
      }

      artifactPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(rawValue);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return Schema.decodeUnknownSync(QualityMetricsCliOptionsSchema)({
    artifactPath,
  });
}

async function persistArtifact(artifactPath: string, artifact: unknown) {
  const resolvedPath = resolve(artifactPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return resolvedPath;
}

export async function runDefaultQualityMetrics(options: QualityMetricsCliOptions = {}) {
  const baseline = await runDefaultBaselineCorpus();
  const comparison = await runDefaultIncumbentComparison();
  const artifact = await Effect.runPromise(
    evaluateQualityMetrics({
      metricsId: "metrics-e7-quality",
      generatedAt: "2026-03-08T21:00:00.000Z",
      baseline,
      comparison,
    }),
  );

  if (options.artifactPath !== undefined) {
    await persistArtifact(options.artifactPath, artifact);
  }

  return Schema.decodeUnknownSync(QualityMetricsArtifactSchema)(artifact);
}

export async function runQualityMetricsCli(
  args: readonly string[],
  dependencies: QualityMetricsCliDependencies = {},
) {
  const setExitCode =
    dependencies.setExitCode ?? ((code: number) => void (process.exitCode = code));
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));

  try {
    const options = parseOptions(args);
    const artifact = await runDefaultQualityMetrics(options);
    writeLine(JSON.stringify(artifact, null, 2));
    return artifact;
  } catch (cause) {
    setExitCode(1);
    throw new Error(readCauseMessage(cause, "Failed to run the E7 quality metrics harness."));
  }
}

if (import.meta.main) {
  await runQualityMetricsCli(process.argv.slice(2));
}
