import { Schema } from "effect";
import { ExtractionRecipeSchema } from "@effect-scrapling/foundation-core/extractor-runtime";
import { SitePackDslSchema } from "@effect-scrapling/foundation-core/site-pack";

const ReferencePackDomainSchema = Schema.Literals(["alza", "datart", "tsbohemia"] as const);

export const E9ReferencePackSchema = Schema.Struct({
  domain: ReferencePackDomainSchema,
  definition: SitePackDslSchema,
  recipe: ExtractionRecipeSchema,
});

export const E9ReferencePackCatalogSchema = Schema.Array(E9ReferencePackSchema).pipe(
  Schema.refine(
    (packs): packs is ReadonlyArray<Schema.Schema.Type<typeof E9ReferencePackSchema>> =>
      packs.length > 0 &&
      new Set(packs.map(({ domain }) => domain)).size === packs.length &&
      new Set(packs.map(({ definition }) => definition.pack.id)).size === packs.length &&
      packs.every(({ definition, recipe }) => definition.pack.id === recipe.packId),
    {
      message:
        "Expected E9 reference packs with unique domains, unique pack ids, and aligned recipe pack ids.",
    },
  ),
);

const DefaultFallbackPolicy = {
  maxFallbackCount: 1,
  fallbackConfidenceImpact: 0.12,
  maxConfidenceImpact: 0.24,
} as const;

function makeReferencePack(input: unknown) {
  return Schema.decodeUnknownSync(E9ReferencePackSchema)(input);
}

export const alzaTeslaReferencePack = makeReferencePack({
  domain: "alza",
  definition: {
    pack: {
      id: "pack-alza-cz-tesla-electronics",
      tenantId: "tenant-reference-packs",
      domainPattern: "*.alza.cz",
      state: "shadow",
      accessPolicyId: "policy-alza-http",
      version: "2026.03.07",
    },
    selectors: [
      {
        field: "title",
        candidates: [
          {
            path: "alza/title/primary",
            selector: "[data-testid='product-title']",
          },
          {
            path: "alza/title/fallback",
            selector: "h1[itemprop='name']",
          },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
      },
      {
        field: "price",
        candidates: [
          {
            path: "alza/price/primary",
            selector: "[data-testid='price-with-vat']",
          },
          {
            path: "alza/price/fallback",
            selector: ".price-box__price",
          },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
      },
      {
        field: "availability",
        candidates: [
          {
            path: "alza/availability/primary",
            selector: "[data-testid='delivery-info']",
          },
          {
            path: "alza/availability/fallback",
            selector: ".availability-label",
          },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
      },
      {
        field: "productIdentifier",
        candidates: [
          {
            path: "alza/product-identifier/primary",
            selector: "[data-testid='product-code']",
          },
          {
            path: "alza/product-identifier/fallback",
            selector: "[data-sku]",
          },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
      },
    ],
    assertions: {
      requiredFields: [
        { field: "title", minimumConfidence: 0.85 },
        { field: "price", minimumConfidence: 0.85 },
        { field: "availability", minimumConfidence: 0.85 },
        { field: "productIdentifier", minimumConfidence: 0.85 },
      ],
      businessInvariants: [
        {
          kind: "numericRange",
          field: "price",
          minimum: 500,
          maximum: 40000,
        },
        {
          kind: "stringOneOf",
          field: "availability",
          allowedValues: ["inStock", "limitedAvailability", "outOfStock"],
        },
      ],
    },
    policy: {
      targetKinds: ["productPage"],
      mode: "http",
      render: "never",
    },
    metadata: {
      tenantId: "tenant-reference-packs",
      owners: ["team-reference-packs"],
      labels: ["tesla", "alza"],
    },
  },
  recipe: {
    packId: "pack-alza-cz-tesla-electronics",
    fields: [
      {
        field: "title",
        normalizer: "text",
        selectors: [
          { path: "alza/title/primary", selector: "[data-testid='product-title']" },
          { path: "alza/title/fallback", selector: "h1[itemprop='name']" },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
        confidence: 0.96,
      },
      {
        field: "price",
        normalizer: "price",
        selectors: [
          { path: "alza/price/primary", selector: "[data-testid='price-with-vat']" },
          { path: "alza/price/fallback", selector: ".price-box__price" },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
        confidence: 0.96,
      },
      {
        field: "availability",
        normalizer: "availability",
        selectors: [
          { path: "alza/availability/primary", selector: "[data-testid='delivery-info']" },
          { path: "alza/availability/fallback", selector: ".availability-label" },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
        confidence: 0.94,
      },
      {
        field: "productIdentifier",
        normalizer: "productIdentifier",
        selectors: [
          { path: "alza/product-identifier/primary", selector: "[data-testid='product-code']" },
          { path: "alza/product-identifier/fallback", selector: "[data-sku]" },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
        confidence: 0.95,
      },
    ],
    requiredFields: [
      { field: "title", minimumConfidence: 0.85 },
      { field: "price", minimumConfidence: 0.85 },
      { field: "availability", minimumConfidence: 0.85 },
      { field: "productIdentifier", minimumConfidence: 0.85 },
    ],
    businessInvariants: [
      {
        kind: "numericRange",
        field: "price",
        minimum: 500,
        maximum: 40000,
      },
      {
        kind: "stringOneOf",
        field: "availability",
        allowedValues: ["inStock", "limitedAvailability", "outOfStock"],
      },
    ],
  },
});

export const datartTeslaReferencePack = makeReferencePack({
  domain: "datart",
  definition: {
    pack: {
      id: "pack-datart-cz-tesla-electronics",
      tenantId: "tenant-reference-packs",
      domainPattern: "*.datart.cz",
      state: "shadow",
      accessPolicyId: "policy-datart-http",
      version: "2026.03.07",
    },
    selectors: [
      {
        field: "title",
        candidates: [
          {
            path: "datart/title/primary",
            selector: ".pdp-product-detail__title",
          },
          {
            path: "datart/title/fallback",
            selector: "h1[data-testid='product-name']",
          },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
      },
      {
        field: "price",
        candidates: [
          {
            path: "datart/price/primary",
            selector: "[data-testid='price-main']",
          },
          {
            path: "datart/price/fallback",
            selector: ".price-vatin__amount",
          },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
      },
      {
        field: "availability",
        candidates: [
          {
            path: "datart/availability/primary",
            selector: "[data-testid='availability-status']",
          },
          {
            path: "datart/availability/fallback",
            selector: ".availability-label",
          },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
      },
      {
        field: "productIdentifier",
        candidates: [
          {
            path: "datart/product-identifier/primary",
            selector: "[data-testid='product-code']",
          },
          {
            path: "datart/product-identifier/fallback",
            selector: "[data-sku]",
          },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
      },
    ],
    assertions: {
      requiredFields: [
        { field: "title", minimumConfidence: 0.85 },
        { field: "price", minimumConfidence: 0.85 },
        { field: "availability", minimumConfidence: 0.85 },
        { field: "productIdentifier", minimumConfidence: 0.85 },
      ],
      businessInvariants: [
        {
          kind: "numericRange",
          field: "price",
          minimum: 500,
          maximum: 40000,
        },
        {
          kind: "stringOneOf",
          field: "availability",
          allowedValues: ["inStock", "limitedAvailability", "outOfStock"],
        },
      ],
    },
    policy: {
      targetKinds: ["productPage"],
      mode: "http",
      render: "never",
    },
    metadata: {
      tenantId: "tenant-reference-packs",
      owners: ["team-reference-packs"],
      labels: ["tesla", "datart"],
    },
  },
  recipe: {
    packId: "pack-datart-cz-tesla-electronics",
    fields: [
      {
        field: "title",
        normalizer: "text",
        selectors: [
          { path: "datart/title/primary", selector: ".pdp-product-detail__title" },
          { path: "datart/title/fallback", selector: "h1[data-testid='product-name']" },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
        confidence: 0.96,
      },
      {
        field: "price",
        normalizer: "price",
        selectors: [
          { path: "datart/price/primary", selector: "[data-testid='price-main']" },
          { path: "datart/price/fallback", selector: ".price-vatin__amount" },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
        confidence: 0.96,
      },
      {
        field: "availability",
        normalizer: "availability",
        selectors: [
          {
            path: "datart/availability/primary",
            selector: "[data-testid='availability-status']",
          },
          { path: "datart/availability/fallback", selector: ".availability-label" },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
        confidence: 0.94,
      },
      {
        field: "productIdentifier",
        normalizer: "productIdentifier",
        selectors: [
          {
            path: "datart/product-identifier/primary",
            selector: "[data-testid='product-code']",
          },
          { path: "datart/product-identifier/fallback", selector: "[data-sku]" },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
        confidence: 0.95,
      },
    ],
    requiredFields: [
      { field: "title", minimumConfidence: 0.85 },
      { field: "price", minimumConfidence: 0.85 },
      { field: "availability", minimumConfidence: 0.85 },
      { field: "productIdentifier", minimumConfidence: 0.85 },
    ],
    businessInvariants: [
      {
        kind: "numericRange",
        field: "price",
        minimum: 500,
        maximum: 40000,
      },
      {
        kind: "stringOneOf",
        field: "availability",
        allowedValues: ["inStock", "limitedAvailability", "outOfStock"],
      },
    ],
  },
});

export const tsBohemiaTeslaReferencePack = makeReferencePack({
  domain: "tsbohemia",
  definition: {
    pack: {
      id: "pack-tsbohemia-cz-tesla-electronics",
      tenantId: "tenant-reference-packs",
      domainPattern: "*.tsbohemia.cz",
      state: "shadow",
      accessPolicyId: "policy-tsbohemia-http",
      version: "2026.03.07",
    },
    selectors: [
      {
        field: "title",
        candidates: [
          {
            path: "tsbohemia/title/primary",
            selector: "h1[itemprop='name']",
          },
          {
            path: "tsbohemia/title/fallback",
            selector: "[data-testid='product-title']",
          },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
      },
      {
        field: "price",
        candidates: [
          {
            path: "tsbohemia/price/primary",
            selector: "[data-testid='price-with-vat']",
          },
          {
            path: "tsbohemia/price/fallback",
            selector: ".price-vat",
          },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
      },
      {
        field: "availability",
        candidates: [
          {
            path: "tsbohemia/availability/primary",
            selector: "[data-testid='availability-state']",
          },
          {
            path: "tsbohemia/availability/fallback",
            selector: ".availability-label",
          },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
      },
      {
        field: "productIdentifier",
        candidates: [
          {
            path: "tsbohemia/product-identifier/primary",
            selector: "[data-testid='product-code']",
          },
          {
            path: "tsbohemia/product-identifier/fallback",
            selector: "[data-sku]",
          },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
      },
    ],
    assertions: {
      requiredFields: [
        { field: "title", minimumConfidence: 0.85 },
        { field: "price", minimumConfidence: 0.85 },
        { field: "availability", minimumConfidence: 0.85 },
        { field: "productIdentifier", minimumConfidence: 0.85 },
      ],
      businessInvariants: [
        {
          kind: "numericRange",
          field: "price",
          minimum: 500,
          maximum: 40000,
        },
        {
          kind: "stringOneOf",
          field: "availability",
          allowedValues: ["inStock", "limitedAvailability", "outOfStock"],
        },
      ],
    },
    policy: {
      targetKinds: ["productPage"],
      mode: "http",
      render: "never",
    },
    metadata: {
      tenantId: "tenant-reference-packs",
      owners: ["team-reference-packs"],
      labels: ["tesla", "tsbohemia"],
    },
  },
  recipe: {
    packId: "pack-tsbohemia-cz-tesla-electronics",
    fields: [
      {
        field: "title",
        normalizer: "text",
        selectors: [
          { path: "tsbohemia/title/primary", selector: "h1[itemprop='name']" },
          {
            path: "tsbohemia/title/fallback",
            selector: "[data-testid='product-title']",
          },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
        confidence: 0.96,
      },
      {
        field: "price",
        normalizer: "price",
        selectors: [
          {
            path: "tsbohemia/price/primary",
            selector: "[data-testid='price-with-vat']",
          },
          { path: "tsbohemia/price/fallback", selector: ".price-vat" },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
        confidence: 0.96,
      },
      {
        field: "availability",
        normalizer: "availability",
        selectors: [
          {
            path: "tsbohemia/availability/primary",
            selector: "[data-testid='availability-state']",
          },
          { path: "tsbohemia/availability/fallback", selector: ".availability-label" },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
        confidence: 0.94,
      },
      {
        field: "productIdentifier",
        normalizer: "productIdentifier",
        selectors: [
          {
            path: "tsbohemia/product-identifier/primary",
            selector: "[data-testid='product-code']",
          },
          { path: "tsbohemia/product-identifier/fallback", selector: "[data-sku]" },
        ],
        fallbackPolicy: DefaultFallbackPolicy,
        confidence: 0.95,
      },
    ],
    requiredFields: [
      { field: "title", minimumConfidence: 0.85 },
      { field: "price", minimumConfidence: 0.85 },
      { field: "availability", minimumConfidence: 0.85 },
      { field: "productIdentifier", minimumConfidence: 0.85 },
    ],
    businessInvariants: [
      {
        kind: "numericRange",
        field: "price",
        minimum: 500,
        maximum: 40000,
      },
      {
        kind: "stringOneOf",
        field: "availability",
        allowedValues: ["inStock", "limitedAvailability", "outOfStock"],
      },
    ],
  },
});

export const e9TeslaReferencePacks = Schema.decodeUnknownSync(E9ReferencePackCatalogSchema)([
  alzaTeslaReferencePack,
  datartTeslaReferencePack,
  tsBohemiaTeslaReferencePack,
]);

export type E9ReferencePack = Schema.Schema.Type<typeof E9ReferencePackSchema>;
export type E9ReferencePackDomain = Schema.Schema.Type<typeof ReferencePackDomainSchema>;

export { ReferencePackDomainSchema };
