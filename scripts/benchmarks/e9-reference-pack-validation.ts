#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema } from "effect";
import {
  DEFAULT_E9_REFERENCE_PACK_VALIDATION_GENERATED_AT,
  E9ReferencePackValidationArtifactSchema,
  createDefaultE9ReferencePackValidationInput,
  runE9ReferencePackValidation,
} from "../../src/e9-reference-pack-validation.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const DEFAULT_ARTIFACT_PATH = resolve(
  REPO_ROOT,
  "docs/artifacts/e9-reference-pack-validation-artifact.json",
);

function parseArtifactPath(arguments_: ReadonlyArray<string>) {
  const artifactFlagIndex = arguments_.indexOf("--artifact");
  if (artifactFlagIndex === -1) {
    return DEFAULT_ARTIFACT_PATH;
  }

  const artifactPath = arguments_[artifactFlagIndex + 1];
  if (artifactPath === undefined || artifactPath.trim() === "") {
    throw new Error("Expected a non-empty path after --artifact.");
  }

  return resolve(REPO_ROOT, artifactPath);
}

const artifactPath = parseArtifactPath(process.argv.slice(2));
const input = await createDefaultE9ReferencePackValidationInput(
  DEFAULT_E9_REFERENCE_PACK_VALIDATION_GENERATED_AT,
);
const artifact = await Effect.runPromise(runE9ReferencePackValidation(input));
const encodedArtifact = Schema.encodeSync(E9ReferencePackValidationArtifactSchema)(artifact);

await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(`${artifactPath}`, `${JSON.stringify(encodedArtifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify(encodedArtifact, null, 2));
