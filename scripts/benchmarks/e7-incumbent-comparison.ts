#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { BaselineCorpusArtifactSchema } from "../../libs/foundation/core/src/baseline-corpus-runtime.ts";
import {
  IncumbentComparisonArtifactSchema,
  runIncumbentComparison,
} from "../../libs/foundation/core/src/incumbent-comparison-runtime.ts";
import { runDefaultBaselineCorpus } from "./e7-baseline-corpus.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

export const IncumbentComparisonCliOptionsSchema = Schema.Struct({
  artifactPath: Schema.optional(NonEmptyStringSchema),
  incumbentPath: Schema.optional(NonEmptyStringSchema),
  candidatePath: Schema.optional(NonEmptyStringSchema),
});

type IncumbentComparisonCliOptions = Schema.Schema.Type<typeof IncumbentComparisonCliOptionsSchema>;
type IncumbentComparisonCliDependencies = {
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
  let incumbentPath: string | undefined;
  let candidatePath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const rawValue = args[index + 1];

    if (argument === "--artifact" || argument === "--incumbent" || argument === "--candidate") {
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error(`Missing value for argument: ${argument}`);
      }

      const decodedValue = Schema.decodeUnknownSync(NonEmptyStringSchema)(rawValue);
      if (argument === "--artifact") {
        artifactPath = decodedValue;
      } else if (argument === "--incumbent") {
        incumbentPath = decodedValue;
      } else {
        candidatePath = decodedValue;
      }

      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if ((incumbentPath === undefined) !== (candidatePath === undefined)) {
    throw new Error("Expected --incumbent and --candidate to be provided together.");
  }

  return Schema.decodeUnknownSync(IncumbentComparisonCliOptionsSchema)({
    artifactPath,
    incumbentPath,
    candidatePath,
  });
}

async function persistArtifact(artifactPath: string, artifact: unknown) {
  const resolvedPath = resolve(artifactPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return resolvedPath;
}

async function readArtifact(path: string) {
  return Schema.decodeUnknownSync(BaselineCorpusArtifactSchema)(
    JSON.parse(await readFile(resolve(path), "utf8")),
  );
}

async function readArtifacts(options: IncumbentComparisonCliOptions) {
  if (options.incumbentPath !== undefined && options.candidatePath !== undefined) {
    return {
      incumbent: await readArtifact(options.incumbentPath),
      candidate: await readArtifact(options.candidatePath),
    };
  }

  return {
    incumbent: await runDefaultBaselineCorpus(),
    candidate: await runDefaultBaselineCorpus(),
  };
}

export async function runDefaultIncumbentComparison(options: IncumbentComparisonCliOptions = {}) {
  const { incumbent, candidate } = await readArtifacts(options);
  const artifact = await Effect.runPromise(
    runIncumbentComparison({
      id: "comparison-retail-smoke",
      createdAt: "2026-03-08T15:00:00.000Z",
      incumbent,
      candidate,
    }),
  );

  if (options.artifactPath !== undefined) {
    await persistArtifact(options.artifactPath, artifact);
  }

  return Schema.decodeUnknownSync(IncumbentComparisonArtifactSchema)(artifact);
}

export async function runIncumbentComparisonCli(
  args: readonly string[],
  dependencies: IncumbentComparisonCliDependencies = {},
) {
  const setExitCode =
    dependencies.setExitCode ?? ((code: number) => void (process.exitCode = code));
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));

  try {
    const options = parseOptions(args);
    const artifact = await runDefaultIncumbentComparison(options);
    writeLine(JSON.stringify(artifact, null, 2));
    return artifact;
  } catch (cause) {
    setExitCode(1);
    throw new Error(readCauseMessage(cause, "Failed to run the E7 incumbent comparison harness."));
  }
}

if (import.meta.main) {
  await runIncumbentComparisonCli(process.argv.slice(2));
}
