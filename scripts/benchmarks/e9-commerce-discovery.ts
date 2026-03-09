#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Schema } from "effect";
import {
  E9CommerceDiscoveryArtifactSchema,
  runE9CommerceDiscoveryBenchmark,
} from "../../src/e9-commerce-benchmark.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const PositiveIntFromStringSchema = Schema.FiniteFromString.check(Schema.isInt()).check(
  Schema.isGreaterThan(0),
);

export const E9CommerceDiscoveryCliOptionsSchema = Schema.Struct({
  artifactPath: Schema.optional(NonEmptyStringSchema),
  targetPagesPerSite: Schema.optional(PositiveIntSchema),
  siteCatalogPath: Schema.optional(NonEmptyStringSchema),
  siteConcurrency: Schema.optional(PositiveIntSchema),
  httpOnly: Schema.optional(Schema.Boolean),
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
  let targetPagesPerSite: number | undefined;
  let siteCatalogPath: string | undefined;
  let siteConcurrency: number | undefined;
  let httpOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      argument === "--artifact" ||
      argument === "--pages-per-site" ||
      argument === "--site-catalog" ||
      argument === "--site-concurrency"
    ) {
      const rawValue = args[index + 1];
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error(`Missing value for argument: ${argument}`);
      }

      if (argument === "--artifact") {
        artifactPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(rawValue);
      } else if (argument === "--pages-per-site") {
        targetPagesPerSite = Schema.decodeUnknownSync(PositiveIntFromStringSchema)(rawValue);
      } else if (argument === "--site-concurrency") {
        siteConcurrency = Schema.decodeUnknownSync(PositiveIntFromStringSchema)(rawValue);
      } else {
        siteCatalogPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(rawValue);
      }

      index += 1;
      continue;
    }

    if (argument === "--http-only") {
      httpOnly = true;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return Schema.decodeUnknownSync(E9CommerceDiscoveryCliOptionsSchema)({
    artifactPath,
    targetPagesPerSite,
    siteCatalogPath,
    siteConcurrency,
    httpOnly,
  });
}

async function persistArtifact(artifactPath: string, artifact: unknown) {
  const resolvedPath = resolve(artifactPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function runDefaultE9CommerceDiscovery(
  options: Schema.Schema.Type<typeof E9CommerceDiscoveryCliOptionsSchema> = {},
) {
  const artifact = await runE9CommerceDiscoveryBenchmark(
    options.siteCatalogPath === undefined &&
      options.targetPagesPerSite === undefined &&
      options.siteConcurrency === undefined
      ? {}
      : {
          ...(options.targetPagesPerSite === undefined
            ? {}
            : { targetPagesPerSite: options.targetPagesPerSite }),
          ...(options.siteCatalogPath === undefined
            ? {}
            : { siteCatalogPath: options.siteCatalogPath }),
          ...(options.siteConcurrency === undefined
            ? {}
            : { siteConcurrency: options.siteConcurrency }),
          ...(options.httpOnly ? { httpOnly: true } : {}),
        },
  );

  if (options.artifactPath !== undefined) {
    await persistArtifact(options.artifactPath, artifact);
  }

  return Schema.decodeUnknownSync(E9CommerceDiscoveryArtifactSchema)(artifact);
}

export async function runE9CommerceDiscoveryCli(
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
    const artifact = await runDefaultE9CommerceDiscovery(options);
    writeLine(JSON.stringify(artifact, null, 2));
    return artifact;
  } catch (cause) {
    setExitCode(1);
    throw new Error(readCauseMessage(cause, "Failed to run the E9 commerce discovery benchmark."));
  }
}

if (import.meta.main) {
  await runE9CommerceDiscoveryCli(process.argv.slice(2));
}
