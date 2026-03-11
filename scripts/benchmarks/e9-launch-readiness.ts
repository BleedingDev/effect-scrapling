#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Schema } from "effect";
import {
  E9LaunchReadinessArtifactSchema,
  runE9LaunchReadiness,
} from "../../src/e9-launch-readiness.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

export const E9LaunchReadinessCliOptionsSchema = Schema.Struct({
  artifactPath: Schema.optional(NonEmptyStringSchema),
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

  return Schema.decodeUnknownSync(E9LaunchReadinessCliOptionsSchema)({
    artifactPath,
  });
}

async function persistArtifact(artifactPath: string, artifact: unknown) {
  const resolvedPath = resolve(artifactPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return resolvedPath;
}

export async function runDefaultE9LaunchReadiness(
  options: {
    readonly artifactPath?: string | undefined;
  } = {},
) {
  const artifact = await runE9LaunchReadiness();
  if (options.artifactPath !== undefined) {
    await persistArtifact(options.artifactPath, artifact);
  }

  return Schema.decodeUnknownSync(E9LaunchReadinessArtifactSchema)(artifact);
}

export async function runE9LaunchReadinessCli(
  args: readonly string[],
  dependencies: {
    readonly setExitCode?: (code: number) => void;
    readonly writeLine?: (line: string) => void;
  } = {},
) {
  const setExitCode = dependencies.setExitCode ?? ((_code: number) => undefined);
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));

  try {
    const options = parseOptions(args);
    const artifact = await runDefaultE9LaunchReadiness(options);
    writeLine(JSON.stringify(artifact, null, 2));
    return artifact;
  } catch (cause) {
    setExitCode(1);
    throw new Error(readCauseMessage(cause, "Failed to run the E9 launch readiness replay."));
  }
}

if (import.meta.main) {
  await runE9LaunchReadinessCli(process.argv.slice(2));
}
