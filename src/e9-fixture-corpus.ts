import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import {
  CanonicalIdentifierSchema,
  CanonicalHttpUrlSchema,
} from "@effect-scrapling/foundation-core";
import {
  E9ReferencePackSchema,
  ReferencePackDomainSchema,
  alzaTeslaReferencePack,
  datartTeslaReferencePack,
  tsBohemiaTeslaReferencePack,
} from "./e9-reference-packs.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

const CorpusRawFieldsSchema = Schema.Struct({
  title: NonEmptyStringSchema,
  price: NonEmptyStringSchema,
  availability: NonEmptyStringSchema,
  productIdentifier: NonEmptyStringSchema,
});

export class E9RetailerCorpusCase extends Schema.Class<E9RetailerCorpusCase>(
  "E9RetailerCorpusCase",
)({
  caseId: CanonicalIdentifierSchema,
  retailer: ReferencePackDomainSchema,
  productId: CanonicalIdentifierSchema,
  entryUrl: CanonicalHttpUrlSchema,
  requiresBypass: Schema.Boolean,
  referencePack: E9ReferencePackSchema,
  html: NonEmptyStringSchema,
  expectedRawFields: CorpusRawFieldsSchema,
}) {}

export const E9RetailerCorpusSchema = Schema.Array(E9RetailerCorpusCase).pipe(
  Schema.refine(
    (cases): cases is ReadonlyArray<E9RetailerCorpusCase> =>
      cases.length === 10 &&
      new Set(cases.map(({ caseId }) => caseId)).size === cases.length &&
      new Set(cases.map(({ productId }) => productId)).size === cases.length,
    {
      message: "Expected a deterministic E9 10-product corpus with unique case and product ids.",
    },
  ),
);

export const E9RetailerCorpusCaseSchema = E9RetailerCorpusCase;

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

type Variant = {
  readonly caseId: string;
  readonly productId: string;
  readonly entryUrl: string;
  readonly replacements: ReadonlyArray<readonly [before: string, after: string]>;
  readonly expectedRawFields: Schema.Schema.Type<typeof CorpusRawFieldsSchema>;
};

const alzaVariants = [
  {
    caseId: "case-e9-alza-tesla-s300w",
    productId: "product-e9-alza-s300w",
    entryUrl: "https://www.alza.cz/tesla-smart-air-purifier-s300w-d7911946.htm",
    replacements: [] as const,
    expectedRawFields: {
      title: "Tesla Smart Air Purifier S300W",
      price: "CZK 4 999",
      availability: "In stock",
      productIdentifier: "SKU: TESLA-S300W",
    },
  },
  {
    caseId: "case-e9-alza-tesla-fan-f500",
    productId: "product-e9-alza-f500",
    entryUrl: "https://www.alza.cz/tesla-smart-fan-f500-d7911947.htm",
    replacements: [
      ["TESLA-S300W", "TESLA-F500"],
      ["Tesla Smart Air Purifier S300W", "Tesla Smart Fan F500"],
      ["CZK 4 999", "CZK 2 899"],
      ["In stock", "Limited stock"],
    ] as const,
    expectedRawFields: {
      title: "Tesla Smart Fan F500",
      price: "CZK 2 899",
      availability: "Limited stock",
      productIdentifier: "SKU: TESLA-F500",
    },
  },
  {
    caseId: "case-e9-alza-tesla-heater-h300",
    productId: "product-e9-alza-h300",
    entryUrl: "https://www.alza.cz/tesla-smart-heater-h300-d7911948.htm",
    replacements: [
      ["TESLA-S300W", "TESLA-H300"],
      ["Tesla Smart Air Purifier S300W", "Tesla Smart Heater H300"],
      ["CZK 4 999", "CZK 3 490"],
    ] as const,
    expectedRawFields: {
      title: "Tesla Smart Heater H300",
      price: "CZK 3 490",
      availability: "In stock",
      productIdentifier: "SKU: TESLA-H300",
    },
  },
  {
    caseId: "case-e9-alza-tesla-humidifier-h100",
    productId: "product-e9-alza-h100",
    entryUrl: "https://www.alza.cz/tesla-smart-humidifier-h100-d7911949.htm",
    replacements: [
      ["TESLA-S300W", "TESLA-H100"],
      ["Tesla Smart Air Purifier S300W", "Tesla Smart Humidifier H100"],
      ["CZK 4 999", "CZK 1 990"],
      ["In stock", "Out of stock"],
    ] as const,
    expectedRawFields: {
      title: "Tesla Smart Humidifier H100",
      price: "CZK 1 990",
      availability: "Out of stock",
      productIdentifier: "SKU: TESLA-H100",
    },
  },
] as const satisfies ReadonlyArray<Variant>;

const datartVariants = [
  {
    caseId: "case-e9-datart-tesla-s200b",
    productId: "product-e9-datart-s200b",
    entryUrl: "https://www.datart.cz/cisticka-vzduchu-tesla-smart-air-purifier-s200b-cerna.html",
    replacements: [] as const,
    expectedRawFields: {
      title: "Tesla Smart Air Purifier S200B",
      price: "CZK 3 699",
      availability: "Limited stock",
      productIdentifier: "SKU: TESLA-S200B",
    },
  },
  {
    caseId: "case-e9-datart-tesla-ar300",
    productId: "product-e9-datart-ar300",
    entryUrl: "https://www.datart.cz/cisticka-vzduchu-tesla-smart-ar300-bila.html",
    replacements: [
      ["TESLA-S200B", "TESLA-AR300"],
      ["Tesla Smart Air Purifier S200B", "Tesla Smart Air Purifier AR300"],
      ["CZK 3 699", "CZK 5 290"],
      ["3 699 Kč", "5 290 Kč"],
      ["Limited stock", "In stock"],
    ] as const,
    expectedRawFields: {
      title: "Tesla Smart Air Purifier AR300",
      price: "CZK 5 290",
      availability: "In stock",
      productIdentifier: "SKU: TESLA-AR300",
    },
  },
  {
    caseId: "case-e9-datart-tesla-dehumidifier-d400",
    productId: "product-e9-datart-d400",
    entryUrl: "https://www.datart.cz/odvlhcovac-tesla-smart-dehumidifier-d400.html",
    replacements: [
      ["TESLA-S200B", "TESLA-D400"],
      ["Tesla Smart Air Purifier S200B", "Tesla Smart Dehumidifier D400"],
      ["CZK 3 699", "CZK 6 790"],
      ["3 699 Kč", "6 790 Kč"],
      ["Limited stock", "Out of stock"],
    ] as const,
    expectedRawFields: {
      title: "Tesla Smart Dehumidifier D400",
      price: "CZK 6 790",
      availability: "Out of stock",
      productIdentifier: "SKU: TESLA-D400",
    },
  },
] as const satisfies ReadonlyArray<Variant>;

const tsBohemiaVariants = [
  {
    caseId: "case-e9-tsbohemia-tesla-te300",
    productId: "product-e9-tsbohemia-te300",
    entryUrl: "https://www.tsbohemia.cz/tesla-te-300_d341842",
    replacements: [] as const,
    expectedRawFields: {
      title: "Tesla TE-300",
      price: "CZK 8 490",
      availability: "In stock",
      productIdentifier: "SKU: TESLA-TE300",
    },
  },
  {
    caseId: "case-e9-tsbohemia-tesla-te310",
    productId: "product-e9-tsbohemia-te310",
    entryUrl: "https://www.tsbohemia.cz/tesla-te-310_d341843",
    replacements: [
      ["TESLA-TE300", "TESLA-TE310"],
      ["Tesla TE-300", "Tesla TE-310"],
      ["CZK 8 490", "CZK 8 990"],
      ["8 490 Kč", "8 990 Kč"],
      ["In stock", "Limited stock"],
    ] as const,
    expectedRawFields: {
      title: "Tesla TE-310",
      price: "CZK 8 990",
      availability: "Limited stock",
      productIdentifier: "SKU: TESLA-TE310",
    },
  },
  {
    caseId: "case-e9-tsbohemia-tesla-te320",
    productId: "product-e9-tsbohemia-te320",
    entryUrl: "https://www.tsbohemia.cz/tesla-te-320_d341844",
    replacements: [
      ["TESLA-TE300", "TESLA-TE320"],
      ["Tesla TE-300", "Tesla TE-320"],
      ["CZK 8 490", "CZK 9 490"],
      ["8 490 Kč", "9 490 Kč"],
      ["In stock", "Out of stock"],
    ] as const,
    expectedRawFields: {
      title: "Tesla TE-320",
      price: "CZK 9 490",
      availability: "Out of stock",
      productIdentifier: "SKU: TESLA-TE320",
    },
  },
] as const satisfies ReadonlyArray<Variant>;

async function loadFixture(path: string) {
  return readFile(join(REPO_ROOT, path), "utf8");
}

function replaceExactly(html: string, before: string, after: string) {
  const parts = html.split(before);
  if (parts.length < 2) {
    throw new Error(`Expected fixture token "${before}" to exist before mutation.`);
  }

  return parts.join(after);
}

function materializeVariantHtml(baseHtml: string, replacements: Variant["replacements"]) {
  return replacements.reduce(
    (currentHtml, [before, after]) => replaceExactly(currentHtml, before, after),
    baseHtml,
  );
}

function buildCase(
  retailer: Schema.Schema.Type<typeof ReferencePackDomainSchema>,
  referencePack: unknown,
  baseHtml: string,
  variant: Variant,
) {
  return Schema.decodeUnknownSync(E9RetailerCorpusCaseSchema)({
    caseId: variant.caseId,
    retailer,
    productId: variant.productId,
    entryUrl: variant.entryUrl,
    requiresBypass: true,
    referencePack,
    html: materializeVariantHtml(baseHtml, variant.replacements),
    expectedRawFields: variant.expectedRawFields,
  });
}

export async function createDefaultE9RetailerCorpus() {
  const [alzaHtml, datartHtml, tsBohemiaHtml] = await Promise.all([
    loadFixture("tests/fixtures/e9-alza-tesla.html"),
    loadFixture("tests/fixtures/e9-datart-tesla.html"),
    loadFixture("tests/fixtures/e9-tsbohemia-tesla.html"),
  ]);

  return Schema.decodeUnknownSync(E9RetailerCorpusSchema)([
    ...alzaVariants.map((variant) => buildCase("alza", alzaTeslaReferencePack, alzaHtml, variant)),
    ...datartVariants.map((variant) =>
      buildCase("datart", datartTeslaReferencePack, datartHtml, variant),
    ),
    ...tsBohemiaVariants.map((variant) =>
      buildCase("tsbohemia", tsBohemiaTeslaReferencePack, tsBohemiaHtml, variant),
    ),
  ]);
}

export function createDefaultE9RetailerCorpusEffect() {
  return Effect.promise(() => createDefaultE9RetailerCorpus());
}
