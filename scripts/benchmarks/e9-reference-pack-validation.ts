#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema } from "effect";
import {
  E9ReferencePackValidationArtifactSchema,
  E9ReferencePackValidationInputSchema,
  runE9ReferencePackValidation,
} from "../../src/e9-reference-pack-validation.ts";
import {
  alzaTeslaReferencePack,
  datartTeslaReferencePack,
  tsBohemiaTeslaReferencePack,
} from "../../src/e9-reference-packs.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const DEFAULT_ARTIFACT_PATH = resolve(
  REPO_ROOT,
  "docs/artifacts/e9-reference-pack-validation-artifact.json",
);
const GENERATED_AT = "2026-03-08T18:45:00.000Z";

async function readFixture(relativePath: string) {
  return readFile(resolve(REPO_ROOT, relativePath), "utf8");
}

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

async function buildInput() {
  const [alzaHtml, datartHtml, tsBohemiaHtml] = await Promise.all([
    readFixture("tests/fixtures/e9-alza-tesla.html"),
    readFixture("tests/fixtures/e9-datart-tesla.html"),
    readFixture("tests/fixtures/e9-tsbohemia-tesla.html"),
  ]);

  return Schema.decodeUnknownSync(E9ReferencePackValidationInputSchema)({
    validationId: "validation-e9-reference-packs",
    generatedAt: GENERATED_AT,
    cases: [
      {
        domain: "alza",
        referencePack: alzaTeslaReferencePack,
        entryUrl: "https://www.alza.cz/tesla-smart-air-purifier-s300w-d7911946.htm",
        html: alzaHtml,
        previousActiveVersion: "2026.03.06",
        nextActiveVersion: "2026.03.08",
      },
      {
        domain: "datart",
        referencePack: datartTeslaReferencePack,
        entryUrl:
          "https://www.datart.cz/cisticka-vzduchu-tesla-smart-air-purifier-s200b-cerna.html",
        html: datartHtml,
        previousActiveVersion: "2026.03.06",
        nextActiveVersion: "2026.03.08",
      },
      {
        domain: "tsbohemia",
        referencePack: tsBohemiaTeslaReferencePack,
        entryUrl: "https://www.tsbohemia.cz/tesla-te-300_d341842",
        html: tsBohemiaHtml,
        previousActiveVersion: "2026.03.06",
        nextActiveVersion: "2026.03.08",
      },
    ],
  });
}

const artifactPath = parseArtifactPath(process.argv.slice(2));
const input = await buildInput();
const artifact = await Effect.runPromise(runE9ReferencePackValidation(input));
const encodedArtifact = Schema.encodeSync(E9ReferencePackValidationArtifactSchema)(artifact);

await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(`${artifactPath}`, `${JSON.stringify(encodedArtifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify(encodedArtifact, null, 2));
