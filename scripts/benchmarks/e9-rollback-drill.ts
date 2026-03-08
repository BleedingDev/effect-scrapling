#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Schema } from "effect";
import { E9RollbackDrillArtifactSchema, runE9RollbackDrill } from "../../src/e9-rollback-drill.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const DEFAULT_ARTIFACT_PATH = resolve(REPO_ROOT, "docs/artifacts/e9-rollback-drill-artifact.json");

export function parseOptions(args: readonly string[]) {
  let artifactPath: string | undefined;

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

    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    artifactPath: artifactPath ?? DEFAULT_ARTIFACT_PATH,
  };
}

export async function runDefaultE9RollbackDrill(args: readonly string[] = []) {
  const options = parseOptions(args);
  const artifact = await runE9RollbackDrill();
  const encoded = Schema.encodeSync(E9RollbackDrillArtifactSchema)(artifact);
  await mkdir(dirname(options.artifactPath), { recursive: true });
  await writeFile(options.artifactPath, `${JSON.stringify(encoded, null, 2)}\n`, "utf8");
  return encoded;
}

if (import.meta.main) {
  const artifact = await runDefaultE9RollbackDrill(process.argv.slice(2));
  console.log(JSON.stringify(artifact, null, 2));
}
