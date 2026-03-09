#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Schema } from "effect";
import {
  E9CommerceCorpusFreezeArtifactSchema,
  runE9CommerceCorpusFreeze,
} from "../../src/e9-corpus-freeze.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const PositiveIntFromStringSchema = Schema.FiniteFromString.check(Schema.isInt()).check(
  Schema.isGreaterThan(0),
);

export const E9CommerceCorpusFreezeCliOptionsSchema = Schema.Struct({
  artifactPath: Schema.optional(NonEmptyStringSchema),
  sourceArtifactPath: NonEmptyStringSchema,
  targetPageCount: Schema.optional(PositiveIntSchema),
  minimumSiteCount: Schema.optional(PositiveIntSchema),
});

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
  let sourceArtifactPath: string | undefined;
  let targetPageCount: number | undefined;
  let minimumSiteCount: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      argument === "--artifact" ||
      argument === "--source-artifact" ||
      argument === "--target-pages" ||
      argument === "--minimum-sites"
    ) {
      const rawValue = args[index + 1];
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error(`Missing value for argument: ${argument}`);
      }

      if (argument === "--artifact") {
        artifactPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(rawValue);
      } else if (argument === "--source-artifact") {
        sourceArtifactPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(rawValue);
      } else if (argument === "--target-pages") {
        targetPageCount = Schema.decodeUnknownSync(PositiveIntFromStringSchema)(rawValue);
      } else {
        minimumSiteCount = Schema.decodeUnknownSync(PositiveIntFromStringSchema)(rawValue);
      }

      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return Schema.decodeUnknownSync(E9CommerceCorpusFreezeCliOptionsSchema)({
    artifactPath,
    sourceArtifactPath,
    targetPageCount,
    minimumSiteCount,
  });
}

async function persistArtifact(path: string, artifact: unknown) {
  const resolvedPath = resolve(path);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function runDefaultE9CommerceCorpusFreeze(
  options: Schema.Schema.Type<typeof E9CommerceCorpusFreezeCliOptionsSchema>,
) {
  const artifact = await runE9CommerceCorpusFreeze({
    sourceArtifactPath: options.sourceArtifactPath,
    ...(options.targetPageCount === undefined ? {} : { targetPageCount: options.targetPageCount }),
    ...(options.minimumSiteCount === undefined
      ? {}
      : { minimumSiteCount: options.minimumSiteCount }),
  });

  if (options.artifactPath !== undefined) {
    await persistArtifact(options.artifactPath, artifact);
  }

  return Schema.decodeUnknownSync(E9CommerceCorpusFreezeArtifactSchema)(artifact);
}

export async function runE9CommerceCorpusFreezeCli(
  args: readonly string[],
  dependencies: {
    readonly setExitCode?: (code: number) => void;
    readonly writeLine?: (line: string) => void;
  } = {},
) {
  const setExitCode =
    dependencies.setExitCode ?? ((code: number) => void (process.exitCode = code));
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));

  try {
    const options = parseOptions(args);
    const artifact = await runDefaultE9CommerceCorpusFreeze(options);
    writeLine(JSON.stringify(artifact, null, 2));
    return artifact;
  } catch (cause) {
    setExitCode(1);
    throw new Error(readCauseMessage(cause, "Failed to freeze the E9 commerce corpus."));
  }
}

if (import.meta.main) {
  await runE9CommerceCorpusFreezeCli(process.argv.slice(2));
}
