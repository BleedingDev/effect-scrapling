#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema } from "effect";
import {
  BaselineCorpusArtifactSchema,
  BaselineCorpusInputSchema,
  runBaselineCorpus,
} from "../../libs/foundation/core/src/baseline-corpus-runtime.ts";
import { ExtractionRecipeSchema } from "../../libs/foundation/core/src/extractor-runtime.ts";
import { captureHttpArtifacts } from "../../libs/foundation/core/src/http-access-runtime.ts";
import { RunPlanSchema } from "../../libs/foundation/core/src/run-state.ts";
import { SitePackSchema } from "../../libs/foundation/core/src/site-pack.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

export const BaselineCorpusCliOptionsSchema = Schema.Struct({
  artifactPath: Schema.optional(NonEmptyStringSchema),
});

type BaselineCorpusCliOptions = Schema.Schema.Type<typeof BaselineCorpusCliOptionsSchema>;
type BaselineCorpusCliDependencies = {
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

function makePack(input: {
  readonly id: string;
  readonly accessPolicyId: string;
  readonly version: string;
}) {
  return Schema.decodeUnknownSync(SitePackSchema)({
    id: input.id,
    tenantId: "tenant-main",
    domainPattern: "*.example.com",
    state: "shadow",
    accessPolicyId: input.accessPolicyId,
    version: input.version,
  });
}

function makeRecipe(input: {
  readonly packId: string;
  readonly titleSelector: string;
  readonly priceSelector: string;
}) {
  return Schema.decodeUnknownSync(ExtractionRecipeSchema)({
    packId: input.packId,
    fields: [
      {
        field: "title",
        selectors: [{ path: "title/primary", selector: input.titleSelector }],
        fallbackPolicy: {
          maxFallbackCount: 0,
          fallbackConfidenceImpact: 0,
          maxConfidenceImpact: 0,
        },
        normalizer: "text",
        confidence: 0.98,
      },
      {
        field: "price",
        selectors: [{ path: "price/primary", selector: input.priceSelector }],
        fallbackPolicy: {
          maxFallbackCount: 0,
          fallbackConfidenceImpact: 0,
          maxConfidenceImpact: 0,
        },
        normalizer: "price",
        confidence: 0.96,
      },
    ],
    requiredFields: [{ field: "title" }, { field: "price" }],
    businessInvariants: [],
  });
}

function makePlan(input: {
  readonly id: string;
  readonly targetId: string;
  readonly packId: string;
  readonly accessPolicyId: string;
  readonly entryUrl: string;
}) {
  return Schema.decodeUnknownSync(RunPlanSchema)({
    id: input.id,
    targetId: input.targetId,
    packId: input.packId,
    accessPolicyId: input.accessPolicyId,
    concurrencyBudgetId: `${input.targetId}-budget`,
    entryUrl: input.entryUrl,
    maxAttempts: 1,
    timeoutMs: 5_000,
    checkpointInterval: 1,
    createdAt: "2026-03-08T14:20:00.000Z",
    steps: [
      {
        id: `${input.id}-capture`,
        stage: "capture",
        requiresBrowser: false,
        artifactKind: "html",
      },
      {
        id: `${input.id}-extract`,
        stage: "extract",
        requiresBrowser: false,
      },
      {
        id: `${input.id}-snapshot`,
        stage: "snapshot",
        requiresBrowser: false,
      },
    ],
  });
}

function makeFetchResponse(html: string) {
  return async () =>
    new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
}

async function makeBundle(plan: Schema.Schema.Type<typeof RunPlanSchema>, html: string) {
  return await Effect.runPromise(
    captureHttpArtifacts(
      plan,
      makeFetchResponse(html),
      () => new Date("2026-03-08T14:20:00.000Z"),
      () => 10,
    ),
  );
}

export async function createDefaultBaselineCorpus() {
  const catalogPack = makePack({
    id: "pack-catalog-example-com",
    accessPolicyId: "policy-catalog",
    version: "2026.03.08",
  });
  const offersPack = makePack({
    id: "pack-offers-example-com",
    accessPolicyId: "policy-offers",
    version: "2026.03.08",
  });
  const catalogPlan = makePlan({
    id: "run-catalog-example-com",
    targetId: "target-catalog-example-com",
    packId: catalogPack.id,
    accessPolicyId: catalogPack.accessPolicyId,
    entryUrl: "https://catalog.example.com/products/widget-1",
  });
  const offersPlan = makePlan({
    id: "run-offers-example-com",
    targetId: "target-offers-example-com",
    packId: offersPack.id,
    accessPolicyId: offersPack.accessPolicyId,
    entryUrl: "https://offers.example.com/products/widget-2",
  });

  return Schema.decodeUnknownSync(BaselineCorpusInputSchema)({
    id: "corpus-retail-smoke",
    createdAt: "2026-03-08T14:25:00.000Z",
    cases: [
      {
        caseId: "case-catalog-example-com",
        pack: catalogPack,
        plan: catalogPlan,
        recipe: makeRecipe({
          packId: catalogPack.id,
          titleSelector: "h1",
          priceSelector: "[data-price]",
        }),
        captureBundle: await makeBundle(
          catalogPlan,
          "<html><body><h1>Catalog Widget</h1><span data-price='USD 1299.00'>USD 1299.00</span></body></html>",
        ),
      },
      {
        caseId: "case-offers-example-com",
        pack: offersPack,
        plan: offersPlan,
        recipe: makeRecipe({
          packId: offersPack.id,
          titleSelector: "h1",
          priceSelector: "[data-price]",
        }),
        captureBundle: await makeBundle(
          offersPlan,
          "<html><body><h1>Offers Widget</h1><span data-price='USD 899.00'>USD 899.00</span></body></html>",
        ),
      },
    ],
  });
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

  return Schema.decodeUnknownSync(BaselineCorpusCliOptionsSchema)({
    artifactPath,
  });
}

async function persistArtifact(artifactPath: string, artifact: unknown) {
  const resolvedPath = resolve(artifactPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return resolvedPath;
}

export async function runDefaultBaselineCorpus(options: BaselineCorpusCliOptions = {}) {
  const corpus = await createDefaultBaselineCorpus();
  const artifact = await Effect.runPromise(runBaselineCorpus(corpus));

  if (options.artifactPath !== undefined) {
    await persistArtifact(options.artifactPath, artifact);
  }

  return Schema.decodeUnknownSync(BaselineCorpusArtifactSchema)(artifact);
}

export async function runBaselineCorpusCli(
  args: readonly string[],
  dependencies: BaselineCorpusCliDependencies = {},
) {
  const setExitCode =
    dependencies.setExitCode ?? ((code: number) => void (process.exitCode = code));
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));

  try {
    const options = parseOptions(args);
    const artifact = await runDefaultBaselineCorpus(options);
    writeLine(JSON.stringify(artifact, null, 2));
    return artifact;
  } catch (cause) {
    setExitCode(1);
    throw new Error(readCauseMessage(cause, "Failed to run the E7 baseline corpus harness."));
  }
}

if (import.meta.main) {
  await runBaselineCorpusCli(process.argv.slice(2));
}
