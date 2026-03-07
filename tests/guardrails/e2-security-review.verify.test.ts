import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  AssertionFailureSchema,
  runAssertionEngine,
} from "../../libs/foundation/core/src/assertion-engine.ts";
import {
  ExtractionRecipeSchema,
  makeHttpCapturePayloadLoader,
  runExtractorOrchestration,
} from "../../libs/foundation/core/src/extractor-runtime.ts";
import { captureHttpArtifacts } from "../../libs/foundation/core/src/http-access-runtime.ts";
import { RunPlanSchema } from "../../libs/foundation/core/src/run-state.ts";
import { toCoreErrorEnvelope } from "../../libs/foundation/core/src/tagged-errors.ts";

const SECRET_HTML = `
  <html>
    <body>
      <article>
        <span class="api-token">Bearer secret-live-token</span>
      </article>
    </body>
  </html>
`;

describe("E2 security review verification", () => {
  it.effect("keeps assertion failures evidence-rich without echoing secret normalized values", () =>
    Effect.gen(function* () {
      const failure = yield* runAssertionEngine({
        snapshot: {
          id: "snapshot-e2-security-001",
          targetId: "target-e2-security-001",
          observations: [
            {
              field: "apiToken",
              normalizedValue: "Bearer secret-live-token",
              confidence: 0.95,
              evidenceRefs: ["artifact-secret-001"],
            },
          ],
          qualityScore: 0.71,
          createdAt: "2026-03-07T12:15:00.000Z",
        },
        requiredFields: [],
        businessInvariants: [
          {
            kind: "stringOneOf",
            field: "apiToken",
            allowedValues: ["approved"],
          },
        ],
      }).pipe(Effect.flip);

      const encoded = failure.failures.map((issue) =>
        Schema.encodeSync(AssertionFailureSchema)(issue),
      );

      expect(encoded).toEqual([
        {
          kind: "businessInvariantFailure",
          message: "Field apiToken violates allowed-value invariant (approved).",
          context: {
            snapshotId: "snapshot-e2-security-001",
            field: "apiToken",
            evidenceRefs: ["artifact-secret-001"],
          },
        },
      ]);
      expect(JSON.stringify(encoded)).not.toContain("secret-live-token");
    }),
  );

  it.effect("keeps extractor assertion mismatch envelopes free of captured secret values", () =>
    Effect.gen(function* () {
      const plan = Schema.decodeUnknownSync(RunPlanSchema)({
        id: "plan-e2-security-001",
        targetId: "target-e2-security-001",
        packId: "pack-e2-security-001",
        accessPolicyId: "policy-http-001",
        concurrencyBudgetId: "budget-e2-security-001",
        entryUrl: "https://example.com/products/secret",
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
        ],
        createdAt: "2026-03-07T12:20:00.000Z",
      });
      const captureBundle = yield* captureHttpArtifacts(
        plan,
        () =>
          Promise.resolve(
            new Response(SECRET_HTML, {
              status: 200,
              headers: {
                "content-type": "text/html; charset=utf-8",
              },
            }),
          ),
        () => new Date("2026-03-07T12:20:01.000Z"),
        () => 4.5,
      );
      const failure = yield* runExtractorOrchestration(
        {
          plan,
          artifacts: captureBundle.artifacts,
          recipe: Schema.decodeUnknownSync(ExtractionRecipeSchema)({
            packId: "pack-e2-security-001",
            fields: [
              {
                field: "apiToken",
                normalizer: "text",
                selectors: [
                  {
                    path: "apiToken/primary",
                    selector: ".api-token",
                  },
                ],
              },
            ],
            requiredFields: [],
            businessInvariants: [
              {
                kind: "stringOneOf",
                field: "apiToken",
                allowedValues: ["approved"],
              },
            ],
          }),
          createdAt: "2026-03-07T12:20:02.000Z",
        },
        makeHttpCapturePayloadLoader(captureBundle),
      ).pipe(
        Effect.match({
          onFailure: toCoreErrorEnvelope,
          onSuccess: () => null,
        }),
      );

      expect(failure).toEqual({
        code: "extraction_mismatch",
        retryable: false,
        message: "Extraction assertions failed: Field apiToken violates extractor assertions.",
      });
      expect(JSON.stringify(failure)).not.toContain("secret-live-token");
    }),
  );

  it.effect("exports only a redacted parsed-document summary from extractor orchestration", () =>
    Effect.gen(function* () {
      const plan = Schema.decodeUnknownSync(RunPlanSchema)({
        id: "plan-e2-security-002",
        targetId: "target-e2-security-002",
        packId: "pack-e2-security-002",
        accessPolicyId: "policy-http-001",
        concurrencyBudgetId: "budget-e2-security-002",
        entryUrl: "https://example.com/products/secret",
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
        ],
        createdAt: "2026-03-07T12:25:00.000Z",
      });
      const captureBundle = yield* captureHttpArtifacts(
        plan,
        () =>
          Promise.resolve(
            new Response(SECRET_HTML, {
              status: 200,
              headers: {
                "content-type": "text/html; charset=utf-8",
              },
            }),
          ),
        () => new Date("2026-03-07T12:25:01.000Z"),
        () => 4.75,
      );
      const orchestration = yield* runExtractorOrchestration(
        {
          plan,
          artifacts: captureBundle.artifacts,
          recipe: Schema.decodeUnknownSync(ExtractionRecipeSchema)({
            packId: "pack-e2-security-002",
            fields: [
              {
                field: "apiToken",
                normalizer: "text",
                selectors: [
                  {
                    path: "apiToken/primary",
                    selector: ".api-token",
                  },
                ],
              },
            ],
            requiredFields: [
              {
                field: "apiToken",
                minimumConfidence: 0.9,
              },
            ],
            businessInvariants: [],
          }),
          createdAt: "2026-03-07T12:25:02.000Z",
        },
        makeHttpCapturePayloadLoader(captureBundle),
      );

      expect(orchestration.documentSummary).toEqual({
        documentId: "plan-e2-security-002-html",
        rootPath: "document",
        nodeCount: 6,
        maxDepth: 4,
        tagNames: ["article", "body", "document", "head", "html", "span"],
      });
      expect(JSON.stringify(orchestration.documentSummary)).not.toContain("secret-live-token");
    }),
  );
});
