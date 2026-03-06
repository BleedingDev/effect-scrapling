import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { ArtifactMetadataRecordSchema } from "../../libs/foundation/core/src/config-storage.ts";
import {
  EvidenceManifestSchema,
  generateEvidenceManifest,
} from "../../libs/foundation/core/src/evidence-manifest.ts";
import { parseDeterministicHtml } from "../../libs/foundation/core/src/extraction-parser.ts";
import { SnapshotSchema } from "../../libs/foundation/core/src/observation-snapshot.ts";
import { resolveSelectorPrecedence } from "../../libs/foundation/core/src/selector-engine.ts";

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

function makeArtifactRecord(
  artifactId: string,
  kind: "html" | "screenshot",
  key: string,
  mediaType: string,
) {
  return Schema.decodeUnknownSync(ArtifactMetadataRecordSchema)({
    id: `${artifactId}-record`,
    runId: "run-evidence-001",
    artifactId,
    kind,
    visibility: kind === "html" ? "raw" : "redacted",
    locator: {
      namespace: "captures/target-product-001",
      key,
    },
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    sizeBytes: 1024,
    mediaType,
    storedAt: "2026-03-06T11:00:00.000Z",
  });
}

describe("foundation-core evidence manifest", () => {
  it.effect("binds snapshot observations to evidence artifacts and selector traces", () =>
    Effect.gen(function* () {
      const document = yield* parseDeterministicHtml({
        documentId: "document-evidence-001",
        html: PRODUCT_HTML,
      });
      const priceResolution = yield* resolveSelectorPrecedence({
        document,
        candidates: [
          {
            path: "price/primary",
            selector: "[data-testid='price']",
          },
          {
            path: "price/fallback",
            selector: ".price-fallback",
          },
        ],
      });
      const availabilityResolution = yield* resolveSelectorPrecedence({
        document,
        candidates: [
          {
            path: "availability/primary",
            selector: ".availability",
          },
        ],
      });
      const htmlArtifact = makeArtifactRecord(
        "artifact-html-001",
        "html",
        "run-001/body.html",
        "text/html",
      );
      const screenshotArtifact = makeArtifactRecord(
        "artifact-screenshot-001",
        "screenshot",
        "run-001/page.png",
        "image/png",
      );
      const snapshot = Schema.decodeUnknownSync(SnapshotSchema)({
        id: "snapshot-evidence-001",
        targetId: "target-product-001",
        observations: [
          {
            field: "price",
            normalizedValue: {
              amount: 19.99,
              currency: "USD",
            },
            confidence: 0.98,
            evidenceRefs: [htmlArtifact.artifactId, screenshotArtifact.artifactId],
          },
          {
            field: "availability",
            normalizedValue: "inStock",
            confidence: 0.94,
            evidenceRefs: [htmlArtifact.artifactId],
          },
        ],
        qualityScore: 0.96,
        createdAt: "2026-03-06T11:05:00.000Z",
      });

      const manifest = yield* generateEvidenceManifest({
        snapshot,
        document,
        artifacts: [htmlArtifact, screenshotArtifact],
        fieldBindings: [
          {
            field: "price",
            selectorResolutions: [priceResolution],
          },
          {
            field: "availability",
            selectorResolutions: [availabilityResolution],
          },
        ],
      });

      expect(Schema.encodeSync(EvidenceManifestSchema)(manifest)).toEqual({
        id: "snapshot-evidence-001-evidence-manifest",
        snapshotId: "snapshot-evidence-001",
        targetId: "target-product-001",
        documentId: "document-evidence-001",
        createdAt: "2026-03-06T11:05:00.000Z",
        observations: [
          {
            observationIndex: 0,
            field: "price",
            observation: {
              field: "price",
              normalizedValue: {
                amount: 19.99,
                currency: "USD",
              },
              confidence: 0.98,
              evidenceRefs: ["artifact-html-001", "artifact-screenshot-001"],
            },
            artifacts: [
              Schema.encodeSync(ArtifactMetadataRecordSchema)(htmlArtifact),
              Schema.encodeSync(ArtifactMetadataRecordSchema)(screenshotArtifact),
            ],
            selectorTraces: [
              {
                documentId: "document-evidence-001",
                rootPath: "document",
                resolution: {
                  selectorPath: "price/primary",
                  selector: "[data-testid='price']",
                  values: ["$19.99"],
                  matchedCount: 1,
                  candidateOrder: ["price/primary", "price/fallback"],
                },
              },
            ],
          },
          {
            observationIndex: 1,
            field: "availability",
            observation: {
              field: "availability",
              normalizedValue: "inStock",
              confidence: 0.94,
              evidenceRefs: ["artifact-html-001"],
            },
            artifacts: [Schema.encodeSync(ArtifactMetadataRecordSchema)(htmlArtifact)],
            selectorTraces: [
              {
                documentId: "document-evidence-001",
                rootPath: "document",
                resolution: {
                  selectorPath: "availability/primary",
                  selector: ".availability",
                  values: ["In stock"],
                  matchedCount: 1,
                  candidateOrder: ["availability/primary"],
                },
              },
            ],
          },
        ],
      });
    }),
  );

  it.effect(
    "fails when an observation references an artifact that is not available to the manifest",
    () =>
      Effect.gen(function* () {
        const document = yield* parseDeterministicHtml({
          documentId: "document-evidence-001",
          html: PRODUCT_HTML,
        });
        const priceResolution = yield* resolveSelectorPrecedence({
          document,
          candidates: [
            {
              path: "price/primary",
              selector: "[data-testid='price']",
            },
          ],
        });
        const htmlArtifact = makeArtifactRecord(
          "artifact-html-001",
          "html",
          "run-001/body.html",
          "text/html",
        );
        const snapshot = Schema.decodeUnknownSync(SnapshotSchema)({
          id: "snapshot-evidence-002",
          targetId: "target-product-001",
          observations: [
            {
              field: "price",
              normalizedValue: {
                amount: 19.99,
                currency: "USD",
              },
              confidence: 0.98,
              evidenceRefs: [htmlArtifact.artifactId, "artifact-screenshot-missing"],
            },
          ],
          qualityScore: 0.92,
          createdAt: "2026-03-06T11:10:00.000Z",
        });

        const failure = yield* generateEvidenceManifest({
          snapshot,
          document,
          artifacts: [htmlArtifact],
          fieldBindings: [
            {
              field: "price",
              selectorResolutions: [priceResolution],
            },
          ],
        }).pipe(Effect.flip);

        expect(failure.message).toBe(
          "Observation field price references missing evidence artifacts: artifact-screenshot-missing",
        );
      }),
  );

  it.effect("fails when an emitted observation does not have a selector trace binding", () =>
    Effect.gen(function* () {
      const document = yield* parseDeterministicHtml({
        documentId: "document-evidence-001",
        html: PRODUCT_HTML,
      });
      const htmlArtifact = makeArtifactRecord(
        "artifact-html-001",
        "html",
        "run-001/body.html",
        "text/html",
      );
      const snapshot = Schema.decodeUnknownSync(SnapshotSchema)({
        id: "snapshot-evidence-003",
        targetId: "target-product-001",
        observations: [
          {
            field: "availability",
            normalizedValue: "inStock",
            confidence: 0.94,
            evidenceRefs: [htmlArtifact.artifactId],
          },
        ],
        qualityScore: 0.9,
        createdAt: "2026-03-06T11:15:00.000Z",
      });

      const failure = yield* generateEvidenceManifest({
        snapshot,
        document,
        artifacts: [htmlArtifact],
        fieldBindings: [],
      }).pipe(Effect.flip);

      expect(failure.message).toBe(
        "Observation field availability does not have a selector trace binding.",
      );
    }),
  );
});
