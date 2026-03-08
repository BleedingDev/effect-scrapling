import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";
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

const REPO_ROOT = join(import.meta.dir, "..", "..");
const GENERATED_AT = "2026-03-08T18:45:00.000Z";

async function loadFixture(path: string) {
  return readFile(join(REPO_ROOT, path), "utf8");
}

function buildInput(
  overrides: Partial<Schema.Schema.Type<typeof E9ReferencePackValidationInputSchema>> = {},
) {
  return Effect.promise(async () =>
    Schema.decodeUnknownSync(E9ReferencePackValidationInputSchema)({
      validationId: "validation-e9-reference-packs",
      generatedAt: GENERATED_AT,
      cases: [
        {
          domain: "alza",
          referencePack: alzaTeslaReferencePack,
          entryUrl: "https://www.alza.cz/tesla-smart-air-purifier-s300w-d7911946.htm",
          html: await loadFixture("tests/fixtures/e9-alza-tesla.html"),
          previousActiveVersion: "2026.03.06",
          nextActiveVersion: "2026.03.08",
        },
        {
          domain: "datart",
          referencePack: datartTeslaReferencePack,
          entryUrl:
            "https://www.datart.cz/cisticka-vzduchu-tesla-smart-air-purifier-s200b-cerna.html",
          html: await loadFixture("tests/fixtures/e9-datart-tesla.html"),
          previousActiveVersion: "2026.03.06",
          nextActiveVersion: "2026.03.08",
        },
        {
          domain: "tsbohemia",
          referencePack: tsBohemiaTeslaReferencePack,
          entryUrl: "https://www.tsbohemia.cz/tesla-te-300_d341842",
          html: await loadFixture("tests/fixtures/e9-tsbohemia-tesla.html"),
          previousActiveVersion: "2026.03.06",
          nextActiveVersion: "2026.03.08",
        },
      ],
      ...overrides,
    }),
  );
}

describe("E9 reference pack validation", () => {
  it.effect("validates Alza, Datart, and TS Bohemia packs through shadow and active gates", () =>
    Effect.gen(function* () {
      const input = yield* buildInput();
      const artifact = yield* runE9ReferencePackValidation(input);
      const encoded = Schema.encodeSync(E9ReferencePackValidationArtifactSchema)(artifact);

      expect(encoded.caseCount).toBe(3);
      expect(encoded.status).toBe("pass");

      for (const result of encoded.results) {
        expect(result.shadowValidation.qualityVerdict.action).toBe("active");
        expect(result.activeValidation.qualityVerdict.action).toBe("active");
        expect(result.extractedSnapshot.observations.map(({ field }) => field)).toEqual([
          "availability",
          "price",
          "productIdentifier",
          "title",
        ]);
        expect(result.governanceResult.activeArtifact?.definition.pack.state).toBe("active");
      }
    }),
  );

  it.effect("fails deterministically when the Alza title field disappears from the fixture", () =>
    Effect.gen(function* () {
      const input = yield* buildInput();
      const alzaCase = input.cases[0];
      if (alzaCase === undefined) {
        throw new Error("Expected the Alza validation case to exist.");
      }

      const failingInput = Schema.decodeUnknownSync(E9ReferencePackValidationInputSchema)({
        ...input,
        cases: [
          {
            ...alzaCase,
            html: alzaCase.html.replace(/<h1[\s\S]*?<\/h1>/u, ""),
          },
        ],
      });
      const error = yield* Effect.flip(runE9ReferencePackValidation(failingInput));

      expect(error.message).toContain("No selector candidates matched");
      expect(error.message).toContain("alza/title/primary");
    }),
  );

  it.effect("fails deterministically when the Datart price field disappears from the fixture", () =>
    Effect.gen(function* () {
      const input = yield* buildInput();
      const datartCase = input.cases[1];
      if (datartCase === undefined) {
        throw new Error("Expected the Datart validation case to exist.");
      }

      const failingInput = Schema.decodeUnknownSync(E9ReferencePackValidationInputSchema)({
        ...input,
        cases: [
          {
            ...datartCase,
            html: datartCase.html
              .replace(/<span data-testid="price-main">[\s\S]*?<\/span>/u, "")
              .replace(/<span class="price-vatin__amount">[\s\S]*?<\/span>/u, ""),
          },
        ],
      });
      const error = yield* Effect.flip(runE9ReferencePackValidation(failingInput));

      expect(error.message).toContain("No selector candidates matched");
      expect(error.message).toContain("datart/price/primary");
    }),
  );

  it.effect(
    "fails deterministically when the TS Bohemia product identifier disappears from the fixture",
    () =>
      Effect.gen(function* () {
        const input = yield* buildInput();
        const tsBohemiaCase = input.cases[2];
        if (tsBohemiaCase === undefined) {
          throw new Error("Expected the TS Bohemia validation case to exist.");
        }

        const failingInput = Schema.decodeUnknownSync(E9ReferencePackValidationInputSchema)({
          ...input,
          cases: [
            {
              ...tsBohemiaCase,
              html: tsBohemiaCase.html
                .replace(/ data-sku="SKU: TESLA-TE300"/u, "")
                .replace(/<span data-testid="product-code">[\s\S]*?<\/span>/u, ""),
            },
          ],
        });
        const error = yield* Effect.flip(runE9ReferencePackValidation(failingInput));

        expect(error.message).toContain("No selector candidates matched");
        expect(error.message).toContain("tsbohemia/product-identifier/primary");
      }),
  );
});
