import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Match, Schema } from "effect";
import {
  ExtractorOrchestrationResultSchema,
  ExtractionRecipeSchema,
  makeExtractor,
  makeHttpCapturePayloadLoader,
  runExtractorOrchestration,
} from "../../libs/foundation/core/src/extractor-runtime.ts";
import { captureHttpArtifacts } from "../../libs/foundation/core/src/http-access-runtime.ts";
import { RunPlanSchema } from "../../libs/foundation/core/src/run-state.ts";

const PRODUCT_HTML = `
  <html>
    <body>
      <article data-sku="sku-001">
        <h1 class="product-title"> Example Product </h1>
        <div class="pricing">
          <span data-testid="price"> $19.99 </span>
          <span class="price-fallback"> USD 19.99 </span>
        </div>
        <span class="availability"> In stock </span>
      </article>
    </body>
  </html>
`;

describe("foundation-core extractor runtime", () => {
  it.effect("extracts a deterministic snapshot from captured HTML artifacts end to end", () =>
    Effect.gen(function* () {
      const plan = Schema.decodeUnknownSync(RunPlanSchema)({
        id: "plan-product-001",
        targetId: "target-product-001",
        packId: "pack-product-001",
        accessPolicyId: "policy-http-001",
        concurrencyBudgetId: "budget-product-001",
        entryUrl: "https://example.com/products/sku-001",
        maxAttempts: 1,
        timeoutMs: 1_000,
        checkpointInterval: 1,
        steps: [
          {
            id: "step-capture",
            stage: "capture",
            requiresBrowser: false,
            artifactKind: "html",
          },
          {
            id: "step-extract",
            stage: "extract",
            requiresBrowser: false,
          },
          {
            id: "step-snapshot",
            stage: "snapshot",
            requiresBrowser: false,
          },
        ],
        createdAt: "2026-03-06T12:00:00.000Z",
      });
      const captureBundle = yield* captureHttpArtifacts(
        plan,
        () =>
          Promise.resolve(
            new Response(PRODUCT_HTML, {
              status: 200,
              headers: {
                "content-type": "text/html; charset=utf-8",
              },
            }),
          ),
        () => new Date("2026-03-06T12:00:05.000Z"),
        () => 12.5,
      );
      const payloadLoader = makeHttpCapturePayloadLoader(captureBundle);
      const recipe = Schema.decodeUnknownSync(ExtractionRecipeSchema)({
        packId: "pack-product-001",
        fields: [
          {
            field: "title",
            normalizer: "text",
            selectors: [
              {
                path: "title/primary",
                selector: ".product-title",
              },
            ],
          },
          {
            field: "price",
            normalizer: "price",
            selectors: [
              {
                path: "price/primary",
                selector: "[data-testid='price']",
              },
              {
                path: "price/fallback",
                selector: ".price-fallback",
              },
            ],
          },
          {
            field: "availability",
            normalizer: "availability",
            selectors: [
              {
                path: "availability/primary",
                selector: ".availability",
              },
            ],
          },
        ],
        requiredFields: [
          {
            field: "title",
            minimumConfidence: 0.9,
          },
          {
            field: "price",
            minimumConfidence: 0.9,
          },
          {
            field: "availability",
            minimumConfidence: 0.9,
          },
        ],
        businessInvariants: [
          {
            kind: "numericRange",
            field: "price",
            minimum: 10,
            maximum: 25,
          },
          {
            kind: "stringOneOf",
            field: "availability",
            allowedValues: ["inStock"],
          },
        ],
      });

      const orchestration = yield* runExtractorOrchestration(
        {
          plan,
          artifacts: captureBundle.artifacts,
          recipe,
          createdAt: "2026-03-06T12:00:06.000Z",
        },
        payloadLoader,
      );
      const encodedOrchestration = Schema.encodeSync(ExtractorOrchestrationResultSchema)(
        orchestration,
      );

      expect(encodedOrchestration.documentArtifactId).toBe("plan-product-001-html");
      expect(
        encodedOrchestration.selectorResolutions.map(({ selectorPath }) => selectorPath),
      ).toEqual(["title/primary", "price/primary", "availability/primary"]);
      expect(encodedOrchestration.snapshotAssembly).toEqual({
        snapshot: {
          id: "plan-product-001-snapshot",
          targetId: "target-product-001",
          observations: [
            {
              field: "availability",
              normalizedValue: "inStock",
              confidence: 0.96,
              evidenceRefs: ["plan-product-001-html"],
            },
            {
              field: "price",
              normalizedValue: {
                amount: 19.99,
                currency: "USD",
              },
              confidence: 0.96,
              evidenceRefs: ["plan-product-001-html"],
            },
            {
              field: "title",
              normalizedValue: "Example Product",
              confidence: 0.96,
              evidenceRefs: ["plan-product-001-html"],
            },
          ],
          qualityScore: 0.878,
          createdAt: "2026-03-06T12:00:06.000Z",
        },
        qualityScoreInputs: {
          sourceObservationCount: 3,
          assembledObservationCount: 3,
          duplicateObservationCount: 0,
          uniqueFieldCount: 3,
          conflictingFieldCount: 0,
          uniqueEvidenceRefCount: 1,
          multiEvidenceObservationCount: 0,
          averageEvidenceRefsPerObservation: 1,
          averageConfidence: 0.96,
          minimumConfidence: 0.96,
          evidenceStrengthScore: 0.5,
          conflictFreeScore: 1,
          uniquenessScore: 1,
        },
        qualityScoreBreakdown: {
          confidenceContribution: 0.528,
          evidenceStrengthContribution: 0.1,
          conflictFreeContribution: 0.15,
          uniquenessContribution: 0.1,
        },
      });
      expect(encodedOrchestration.assertionReport).toEqual({
        snapshotId: "plan-product-001-snapshot",
        evaluatedRuleCount: 5,
        assertedFields: ["title", "price", "availability"],
      });
      expect(encodedOrchestration.evidenceManifest.observations).toHaveLength(3);
      expect(encodedOrchestration.evidenceManifest.observations[1]?.artifacts[0]?.artifactId).toBe(
        "plan-product-001-html",
      );

      const extractor = makeExtractor(
        [recipe],
        payloadLoader,
        () => new Date("2026-03-06T12:00:06.000Z"),
      );
      const extractedSnapshot = yield* extractor.extract(plan, captureBundle.artifacts);

      expect(extractedSnapshot).toEqual(orchestration.snapshotAssembly.snapshot);
    }),
  );

  it.effect("propagates selector fallback confidence into extracted observations", () =>
    Effect.gen(function* () {
      const plan = Schema.decodeUnknownSync(RunPlanSchema)({
        id: "plan-product-003",
        targetId: "target-product-003",
        packId: "pack-product-003",
        accessPolicyId: "policy-http-001",
        concurrencyBudgetId: "budget-product-003",
        entryUrl: "https://example.com/products/sku-003",
        maxAttempts: 1,
        timeoutMs: 1_000,
        checkpointInterval: 1,
        steps: [
          {
            id: "step-capture",
            stage: "capture",
            requiresBrowser: false,
            artifactKind: "html",
          },
        ],
        createdAt: "2026-03-06T12:20:00.000Z",
      });
      const captureBundle = yield* captureHttpArtifacts(
        plan,
        () =>
          Promise.resolve(
            new Response(PRODUCT_HTML, {
              status: 200,
              headers: {
                "content-type": "text/html; charset=utf-8",
              },
            }),
          ),
        () => new Date("2026-03-06T12:20:05.000Z"),
        () => 12.5,
      );
      const orchestration = yield* runExtractorOrchestration(
        {
          plan,
          artifacts: captureBundle.artifacts,
          recipe: Schema.decodeUnknownSync(ExtractionRecipeSchema)({
            packId: "pack-product-003",
            fields: [
              {
                field: "price",
                normalizer: "price",
                fallbackPolicy: {
                  maxFallbackCount: 2,
                  fallbackConfidenceImpact: 0.2,
                  maxConfidenceImpact: 0.5,
                },
                selectors: [
                  {
                    path: "price/primary",
                    selector: ".missing-price",
                  },
                  {
                    path: "price/fallback",
                    selector: ".price-fallback",
                  },
                ],
              },
            ],
            requiredFields: [
              {
                field: "price",
                minimumConfidence: 0.7,
              },
            ],
            businessInvariants: [
              {
                kind: "numericRange",
                field: "price",
                minimum: 10,
                maximum: 25,
              },
            ],
          }),
          createdAt: "2026-03-06T12:20:06.000Z",
        },
        makeHttpCapturePayloadLoader(captureBundle),
      );
      const priceObservation = orchestration.snapshotAssembly.snapshot.observations[0];

      expect(priceObservation).toEqual({
        field: "price",
        normalizedValue: {
          amount: 19.99,
          currency: "USD",
        },
        confidence: 0.8,
        evidenceRefs: ["plan-product-003-html"],
      });
      expect(orchestration.selectorResolutions[0]?.confidence).toBe(0.8);
      expect(orchestration.selectorResolutions[0]?.confidenceImpact).toBe(0.2);
    }),
  );

  it.effect("emits a typed extraction mismatch when captured data violates assertions", () =>
    Effect.gen(function* () {
      const plan = Schema.decodeUnknownSync(RunPlanSchema)({
        id: "plan-product-002",
        targetId: "target-product-002",
        packId: "pack-product-002",
        accessPolicyId: "policy-http-001",
        concurrencyBudgetId: "budget-product-002",
        entryUrl: "https://example.com/products/sku-002",
        maxAttempts: 1,
        timeoutMs: 1_000,
        checkpointInterval: 1,
        steps: [
          {
            id: "step-capture",
            stage: "capture",
            requiresBrowser: false,
            artifactKind: "html",
          },
          {
            id: "step-extract",
            stage: "extract",
            requiresBrowser: false,
          },
          {
            id: "step-snapshot",
            stage: "snapshot",
            requiresBrowser: false,
          },
        ],
        createdAt: "2026-03-06T12:10:00.000Z",
      });
      const captureBundle = yield* captureHttpArtifacts(
        plan,
        () =>
          Promise.resolve(
            new Response(PRODUCT_HTML.replace("In stock", "Sold out"), {
              status: 200,
              headers: {
                "content-type": "text/html; charset=utf-8",
              },
            }),
          ),
        () => new Date("2026-03-06T12:10:05.000Z"),
        () => 9.25,
      );
      const extractor = makeExtractor(
        [
          Schema.decodeUnknownSync(ExtractionRecipeSchema)({
            packId: "pack-product-002",
            fields: [
              {
                field: "price",
                normalizer: "price",
                selectors: [
                  {
                    path: "price/primary",
                    selector: "[data-testid='price']",
                  },
                ],
              },
              {
                field: "availability",
                normalizer: "availability",
                selectors: [
                  {
                    path: "availability/primary",
                    selector: ".availability",
                  },
                ],
              },
            ],
            requiredFields: [
              {
                field: "price",
                minimumConfidence: 0.9,
              },
              {
                field: "availability",
                minimumConfidence: 0.9,
              },
            ],
            businessInvariants: [
              {
                kind: "stringOneOf",
                field: "availability",
                allowedValues: ["inStock"],
              },
            ],
          }),
        ],
        makeHttpCapturePayloadLoader(captureBundle),
        () => new Date("2026-03-06T12:10:06.000Z"),
      );

      const failureMessage = yield* extractor.extract(plan, captureBundle.artifacts).pipe(
        Effect.match({
          onSuccess: () => "unexpected-success",
          onFailure: (failure) =>
            Match.value(failure).pipe(
              Match.tag("ExtractionMismatch", ({ message }) => message),
              Match.tag("ParserFailure", ({ message }) => `parser:${message}`),
              Match.exhaustive,
            ),
        }),
      );

      expect(failureMessage).toBe(
        "Extraction assertions failed: Field availability normalized value outOfStock is outside the allowed set inStock.",
      );
    }),
  );
});
