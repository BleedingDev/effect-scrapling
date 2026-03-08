#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema } from "effect";
import {
  E8ArtifactExportEnvelopeSchema,
  E8BenchmarkRunEnvelopeSchema,
  runArtifactExportOperation,
  runBenchmarkOperation,
} from "../../src/e8.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const CliModeSchema = Schema.Literals(["run", "export"] as const);

export const E8BenchmarkCliOptionsSchema = Schema.Struct({
  mode: CliModeSchema,
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
  const [modeArgument, ...rest] = args;
  const mode = Schema.decodeUnknownSync(CliModeSchema)(modeArgument);
  let artifactPath: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--artifact") {
      const rawValue = rest[index + 1];
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error("Missing value for argument: --artifact");
      }

      artifactPath = resolve(Schema.decodeUnknownSync(NonEmptyStringSchema)(rawValue));
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return Schema.decodeUnknownSync(E8BenchmarkCliOptionsSchema)({
    mode,
    artifactPath,
  });
}

async function persistArtifact(path: string, artifact: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function runE8BenchmarkCli(args: readonly string[]) {
  const options = parseOptions(args);
  if (options.mode === "run") {
    const envelope = await Effect.runPromise(runBenchmarkOperation());
    const decoded = Schema.decodeUnknownSync(E8BenchmarkRunEnvelopeSchema)(envelope);
    if (options.artifactPath !== undefined) {
      await persistArtifact(options.artifactPath, decoded);
    }
    return decoded;
  }

  const envelope = await Effect.runPromise(runArtifactExportOperation());
  const decoded = Schema.decodeUnknownSync(E8ArtifactExportEnvelopeSchema)(envelope);
  if (options.artifactPath !== undefined) {
    await persistArtifact(options.artifactPath, decoded.data.artifact);
  }
  return decoded;
}

if (import.meta.main) {
  try {
    const payload = await runE8BenchmarkCli(process.argv.slice(2));
    console.log(JSON.stringify(payload, null, 2));
  } catch (cause) {
    process.exitCode = 1;
    throw new Error(readCauseMessage(cause, "Failed to run the E8 benchmark/export CLI."));
  }
}
