import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import { SitePackDslSchema } from "../../libs/foundation/core/src/site-pack.ts";

const validSitePackDsl = {
  pack: {
    id: "pack-shop-example-com",
    tenantId: "tenant-main",
    domainPattern: "*.example.com",
    state: "shadow",
    accessPolicyId: "policy-default",
    version: "2026.03.08",
  },
  selectors: [
    {
      field: "title",
      candidates: [
        {
          path: "product/title/primary",
          selector: "h1.product-title",
        },
      ],
      fallbackPolicy: {
        maxFallbackCount: 0,
        fallbackConfidenceImpact: 0,
        maxConfidenceImpact: 0,
      },
    },
    {
      field: "price",
      candidates: [
        {
          path: "product/price/primary",
          selector: "[data-testid='price']",
        },
        {
          path: "product/price/fallback",
          selector: ".price-box",
        },
      ],
      fallbackPolicy: {
        maxFallbackCount: 1,
        fallbackConfidenceImpact: 0.15,
        maxConfidenceImpact: 0.45,
      },
    },
  ],
  assertions: {
    requiredFields: [
      {
        field: "title",
        minimumConfidence: 0.8,
      },
      {
        field: "price",
      },
    ],
    businessInvariants: [
      {
        kind: "numericRange",
        field: "price",
        minimum: 0,
      },
    ],
  },
  policy: {
    targetKinds: ["productPage"],
    mode: "http",
    render: "never",
  },
  metadata: {
    tenantId: "tenant-main",
    owners: ["team-catalog"],
    labels: ["retail", "cz"],
  },
} as const;

describe("foundation-core site pack DSL", () => {
  it("decodes a complete pack definition with selectors assertions policy and metadata", () => {
    const decoded = Schema.decodeUnknownSync(SitePackDslSchema)(validSitePackDsl);

    expect(decoded.pack.tenantId).toBe("tenant-main");
    expect(decoded.selectors).toHaveLength(2);
    expect(decoded.assertions.requiredFields).toHaveLength(2);
    expect(decoded.policy.targetKinds).toEqual(["productPage"]);
    expect(decoded.metadata.owners).toEqual(["team-catalog"]);
  });

  it("rejects duplicate selector fields and reused candidate paths", () => {
    expect(() =>
      Schema.decodeUnknownSync(SitePackDslSchema)({
        ...validSitePackDsl,
        selectors: [
          validSitePackDsl.selectors[0],
          {
            field: "title",
            candidates: [
              {
                path: "product/title/primary",
                selector: ".another-title",
              },
            ],
            fallbackPolicy: {
              maxFallbackCount: 0,
              fallbackConfidenceImpact: 0,
              maxConfidenceImpact: 0,
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects reused candidate paths even when the selector field changes", () => {
    expect(() =>
      Schema.decodeUnknownSync(SitePackDslSchema)({
        ...validSitePackDsl,
        selectors: [
          validSitePackDsl.selectors[0],
          {
            field: "availability",
            candidates: [
              {
                path: "product/title/primary",
                selector: "[data-availability]",
              },
            ],
            fallbackPolicy: {
              maxFallbackCount: 0,
              fallbackConfidenceImpact: 0,
              maxConfidenceImpact: 0,
            },
          },
        ],
        assertions: {
          requiredFields: [
            {
              field: "title",
              minimumConfidence: 0.8,
            },
            {
              field: "availability",
            },
          ],
          businessInvariants: [],
        },
      }),
    ).toThrow();
  });

  it("rejects assertions that reference undeclared selector fields", () => {
    expect(() =>
      Schema.decodeUnknownSync(SitePackDslSchema)({
        ...validSitePackDsl,
        assertions: {
          requiredFields: [
            {
              field: "availability",
            },
          ],
          businessInvariants: [],
        },
      }),
    ).toThrow();
  });

  it("rejects unsafe domain patterns and whitespace in pack versions", () => {
    expect(() =>
      Schema.decodeUnknownSync(SitePackDslSchema)({
        ...validSitePackDsl,
        pack: {
          ...validSitePackDsl.pack,
          domainPattern: "https://shop.example.com",
        },
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(SitePackDslSchema)({
        ...validSitePackDsl,
        pack: {
          ...validSitePackDsl.pack,
          version: "2026.03.08 rc1",
        },
      }),
    ).toThrow();
  });

  it("rejects tenant drift and unsafe access/render combinations", () => {
    expect(() =>
      Schema.decodeUnknownSync(SitePackDslSchema)({
        ...validSitePackDsl,
        metadata: {
          ...validSitePackDsl.metadata,
          tenantId: "tenant-other",
        },
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(SitePackDslSchema)({
        ...validSitePackDsl,
        policy: {
          targetKinds: ["productPage"],
          mode: "browser",
          render: "never",
        },
      }),
    ).toThrow();
  });
});
