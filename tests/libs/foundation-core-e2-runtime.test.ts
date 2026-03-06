import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  ParsedHtmlDocumentSchema,
  parseDeterministicHtml,
} from "../../libs/foundation/core/src/extraction-parser.ts";
import {
  resolveSelectorPrecedence,
  SelectorResolutionSchema,
} from "../../libs/foundation/core/src/selector-engine.ts";

const PRODUCT_HTML = `
  <html>
    <body>
      <article data-sku="sku-001">
        <h1 class="product-title"> Example Product </h1>
        <div class="pricing">
          <span data-testid="price"> $19.99 </span>
          <span class="price-fallback"> USD 19.99 </span>
        </div>
      </article>
    </body>
  </html>
`;

describe("foundation-core extraction runtime", () => {
  it.effect("parses stable tree output for repeated HTML input", () =>
    Effect.gen(function* () {
      const first = yield* parseDeterministicHtml({
        documentId: "document-001",
        html: PRODUCT_HTML,
      });
      const second = yield* parseDeterministicHtml({
        documentId: "document-001",
        html: PRODUCT_HTML,
      });

      expect(Schema.encodeSync(ParsedHtmlDocumentSchema)(first)).toEqual(
        Schema.encodeSync(ParsedHtmlDocumentSchema)(second),
      );
      expect(first.rootPath).toBe("document");
      expect(first.nodes[0]?.tagName).toBe("document");
      expect(
        first.nodes.some((node) => node.tagName === "h1" && node.textContent === "Example Product"),
      ).toBe(true);
      expect(
        first.nodes.some(
          (node) => node.attributes["data-testid"] === "price" && node.textContent === "$19.99",
        ),
      ).toBe(true);
    }),
  );

  it.effect("resolves selectors in configured order and records the chosen selector path", () =>
    Effect.gen(function* () {
      const document = yield* parseDeterministicHtml({
        documentId: "document-001",
        html: PRODUCT_HTML,
      });
      const resolution = yield* resolveSelectorPrecedence({
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

      expect(Schema.encodeSync(SelectorResolutionSchema)(resolution)).toEqual({
        selectorPath: "price/primary",
        selector: "[data-testid='price']",
        values: ["$19.99"],
        matchedCount: 1,
        candidateOrder: ["price/primary", "price/fallback"],
      });
    }),
  );

  it.effect("fails deterministically when no selector candidate matches", () =>
    Effect.gen(function* () {
      const document = yield* parseDeterministicHtml({
        documentId: "document-001",
        html: PRODUCT_HTML,
      });
      const failureMessage = yield* resolveSelectorPrecedence({
        document,
        candidates: [
          {
            path: "price/missing",
            selector: ".does-not-exist",
          },
        ],
      }).pipe(
        Effect.match({
          onFailure: ({ message }) => message,
          onSuccess: () => "unexpected-success",
        }),
      );

      expect(failureMessage).not.toBe("unexpected-success");
      expect(failureMessage).toContain("price/missing");
    }),
  );
});
