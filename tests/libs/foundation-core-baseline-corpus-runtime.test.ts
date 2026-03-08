import { describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import {
  BaselineCorpusArtifactSchema,
  BaselineCorpusInputSchema,
  runBaselineCorpus,
} from "../../libs/foundation/core/src/baseline-corpus-runtime.ts";
import {
  ExtractionRecipeSchema,
  type RequiredFieldAssertion,
} from "../../libs/foundation/core/src/extractor-runtime.ts";
import { captureHttpArtifacts } from "../../libs/foundation/core/src/http-access-runtime.ts";
import { RunPlanSchema } from "../../libs/foundation/core/src/run-state.ts";
import { SitePackSchema } from "../../libs/foundation/core/src/site-pack.ts";

function makePack(input: { readonly id: string; readonly accessPolicyId: string }) {
  return Schema.decodeUnknownSync(SitePackSchema)({
    id: input.id,
    tenantId: "tenant-main",
    domainPattern: "*.example.com",
    state: "shadow",
    accessPolicyId: input.accessPolicyId,
    version: "2026.03.08",
  });
}

function makeRecipe(input: {
  readonly packId: string;
  readonly titleSelector: string;
  readonly priceSelector: string;
}) {
  const requiredFields: ReadonlyArray<RequiredFieldAssertion> = [
    { field: "title" },
    { field: "price" },
  ];

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
    requiredFields,
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
    createdAt: "2026-03-08T14:00:00.000Z",
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

async function makeBundle(plan: Schema.Schema.Type<typeof RunPlanSchema>, html: string) {
  return await Effect.runPromise(
    captureHttpArtifacts(
      plan,
      async () =>
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      () => new Date("2026-03-08T14:00:00.000Z"),
      () => 10,
    ),
  );
}

async function makeCorpusFixture() {
  const catalogPack = makePack({
    id: "pack-catalog-example-com",
    accessPolicyId: "policy-catalog",
  });
  const offersPack = makePack({
    id: "pack-offers-example-com",
    accessPolicyId: "policy-offers",
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
  const catalogBundle = await makeBundle(
    catalogPlan,
    "<html><body><h1>Catalog Widget</h1><span data-price='USD 1299.00'>USD 1299.00</span></body></html>",
  );
  const offersBundle = await makeBundle(
    offersPlan,
    "<html><body><h1>Offers Widget</h1><span data-price='USD 899.00'>USD 899.00</span></body></html>",
  );

  return Schema.decodeUnknownSync(BaselineCorpusInputSchema)({
    id: "corpus-retail-smoke",
    createdAt: "2026-03-08T14:05:00.000Z",
    cases: [
      {
        caseId: "case-offers-example-com",
        pack: offersPack,
        plan: offersPlan,
        recipe: makeRecipe({
          packId: offersPack.id,
          titleSelector: "h1",
          priceSelector: "[data-price]",
        }),
        captureBundle: offersBundle,
      },
      {
        caseId: "case-catalog-example-com",
        pack: catalogPack,
        plan: catalogPlan,
        recipe: makeRecipe({
          packId: catalogPack.id,
          titleSelector: "h1",
          priceSelector: "[data-price]",
        }),
        captureBundle: catalogBundle,
      },
    ],
  });
}

describe("foundation-core baseline corpus runtime", () => {
  it("runs deterministic baseline corpus cases and emits sorted reproducible outputs", async () => {
    const corpus = await makeCorpusFixture();
    const artifact = await Effect.runPromise(runBaselineCorpus(corpus));

    expect(Schema.is(BaselineCorpusArtifactSchema)(artifact)).toBe(true);
    expect(artifact.caseCount).toBe(2);
    expect(artifact.packCount).toBe(2);
    expect(artifact.results.map(({ caseId }) => caseId)).toEqual([
      "case-catalog-example-com",
      "case-offers-example-com",
    ]);
    expect(artifact.results[0]?.canonicalSnapshot.snapshotId).toBe(
      "run-catalog-example-com-snapshot",
    );
    expect(artifact.results[1]?.orchestration.assertionReport.assertedFields).toEqual([
      "title",
      "price",
    ]);
  });

  it("rejects corpus cases whose pack, recipe, and run-plan ids drift", async () => {
    const corpus = await makeCorpusFixture();
    const invalid = {
      ...corpus,
      cases: [
        {
          ...corpus.cases[0],
          recipe: makeRecipe({
            packId: "pack-mismatch",
            titleSelector: "h1",
            priceSelector: "[data-price]",
          }),
        },
      ],
    };

    await expect(Effect.runPromise(runBaselineCorpus(invalid))).rejects.toThrow(
      "aligned pack/plan/recipe ids",
    );
  });
});
