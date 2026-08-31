import { describe, expect, it } from "@effect-native/bun-test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  buildTeslaPartnerCorpusArtifact,
  classifyTeslaDatasetProductVariant,
  classifyTeslaDatasetVariant,
  collectTeslaExpectationSidecarCoverage,
  collectTeslaDatasetCoverage,
  joinTeslaExpectationSidecarToCorpus,
  loadTeslaExpectationSidecar,
  loadTeslaCompatibleDataset,
  lookupTeslaExpectationByPartnerUrl,
  normalizeTeslaExpectationJoinUrl,
  runTeslaPartnerDatasetBenchmarkCli,
  selectPreferredTeslaDatasetFile,
  TeslaExpectationSidecarLoadResultSchema,
  TeslaCompatibleDatasetSchema,
  TeslaExpectationSidecarSchema,
  TeslaLegacyCompatibleDatasetEnvelopeSchema,
  TeslaObservedFullDatasetEnvelopeSchema,
  TeslaObservedStrictDatasetEnvelopeSchema,
} from "../../scripts/benchmarks/e9-tesla-partner-dataset.ts";
import { E9CommerceCorpusFreezeArtifactSchema } from "../../src/e9-corpus-freeze.ts";
import { type E9BenchmarkSuiteArtifact } from "../../src/e9-benchmark-suite.ts";

const teslaExpectationSidecarFixture = {
  generatedAt: "2026-03-13T09:00:00.000Z",
  products: [
    {
      officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
      officialTitle: "TESLA Sound EB20",
      modelTokens: ["eb20"],
      partnerExpectations: [
        {
          partner: "alza",
          partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm?b=2&a=1",
          strictEligible: true,
          title: {
            value: "TESLA Sound EB20",
            policy: "partner-display",
          },
          price: {
            amount: 799,
            currency: "CZK",
            policy: "range",
            capturedAt: "2026-03-13T08:30:00.000Z",
            minAmount: 749,
            maxAmount: 849,
          },
          description: {
            value: "Bezdratova sluchatka TESLA Sound EB20",
            policy: "semantic-summary",
            capturedAt: "2026-03-13T08:30:00.000Z",
          },
        },
        {
          partner: "datart",
          partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
          strictEligible: false,
          title: {
            value: "TESLA Sound EB20",
            policy: "semantic-identity",
          },
        },
      ],
    },
    {
      officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20-bundle",
      modelTokens: ["eb20", "bundle"],
      partnerExpectations: [
        {
          partner: "mironet",
          partnerUrl: "https://www.mironet.cz/tesla-sound-eb20+dp123456/?utm=1",
          strictEligible: true,
          title: {
            value: "TESLA Sound EB20 Bundle",
            policy: "semantic-identity",
          },
        },
      ],
    },
    {
      officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20-special",
      modelTokens: ["eb20", "special"],
      partnerExpectations: [
        {
          partner: "mironet",
          partnerUrl: "https://mironet.cz/tesla-sound-eb20+dp123456?utm=1",
          strictEligible: true,
          title: {
            value: "TESLA Sound EB20 Special",
            policy: "semantic-identity",
          },
        },
      ],
    },
  ],
} as const;

function makeStubBenchmarkArtifact(
  corpusArtifactPath: string,
  status: E9BenchmarkSuiteArtifact["status"],
): E9BenchmarkSuiteArtifact {
  return {
    benchmark: "e9-benchmark-suite",
    benchmarkId: "e9-benchmark-suite",
    generatedAt: "2026-03-12T12:00:00.000Z",
    corpus: {
      sourceArtifactPath: corpusArtifactPath,
      sourcePageCount: 1,
      sourceSiteCount: 1,
      selectedPageCount: 1,
      selectedSiteCount: 1,
      highFrictionPageCount: 0,
      pageTypeCounts: {
        product: 1,
        listing: 0,
        search: 0,
        offer: 0,
        unknown: 0,
      },
    },
    profiles: {
      available: [],
      unavailable: [],
    },
    httpCorpus: {
      phase: "live-http-corpus",
      pageCount: 1,
      attempts: [],
      sweeps: [],
    },
    browserCorpus: {
      phase: "live-browser-corpus",
      pageCount: 1,
      attempts: [],
      sweeps: [],
    },
    scraplingParity: {
      skipped: true,
      totalWallMs: 0,
    },
    highFrictionCanary: {
      skipped: true,
      totalWallMs: 0,
    },
    status,
  };
}

describe("e9 tesla partner dataset benchmark", () => {
  it("decodes the observed full Tesla dataset envelope", () => {
    const observedFullDataset = {
      generatedAt: "2026-03-12T06:00:00.000Z",
      source: {
        officialCatalog: "https://eshop.tesla-electronics.eu/sitemap?products=true&page=1",
        partnerDiscovery: ["https://search.seznam.cz/"],
        partnerDomains: [
          {
            partner: "alza",
            domain: "www.alza.cz",
          },
        ],
      },
      summary: {
        productCount: 1,
        partnerUrlCount: 1,
        strictProductCount: 1,
        strictPartnerUrlCount: 1,
      },
      products: [
        {
          title: "Bezdratova sluchatka TESLA Sound EB20 (Pearl Pink)",
          officialUrl:
            "https://eshop.tesla-electronics.eu/tesla-sound-eb20-bezdratova-bluetooth-sluchatka-pearl-pink",
          modelTokens: ["eb20"],
          partnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-pearl-pink-d7915352.htm",
            },
          ],
          officialIsAccessory: false,
          strictPartnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-pearl-pink-d7915352.htm",
            },
          ],
          strictEligible: true,
        },
      ],
    } as const;

    expect(
      Schema.decodeUnknownSync(TeslaObservedFullDatasetEnvelopeSchema)(observedFullDataset),
    ).toEqual(observedFullDataset);
    expect(Schema.decodeUnknownSync(TeslaCompatibleDatasetSchema)(observedFullDataset)).toEqual(
      observedFullDataset,
    );
  });

  it("decodes the observed strict Tesla dataset envelope", () => {
    const observedStrictDataset = {
      generatedAt: "2026-03-12T06:00:00.000Z",
      summary: {
        productCount: 1,
        partnerUrlCount: 1,
      },
      products: [
        {
          officialTitle: "Bezdratova sluchatka TESLA Sound EB20 (Pearl Pink)",
          officialUrl:
            "https://eshop.tesla-electronics.eu/tesla-sound-eb20-bezdratova-bluetooth-sluchatka-pearl-pink",
          modelTokens: ["eb20"],
          officialIsAccessory: false,
          partnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-pearl-pink-d7915352.htm",
            },
          ],
        },
      ],
    } as const;

    expect(
      Schema.decodeUnknownSync(TeslaObservedStrictDatasetEnvelopeSchema)(observedStrictDataset),
    ).toEqual(observedStrictDataset);
    expect(Schema.decodeUnknownSync(TeslaCompatibleDatasetSchema)(observedStrictDataset)).toEqual(
      observedStrictDataset,
    );
  });

  it("keeps the legacy-compatible envelope available for wrapper callers", () => {
    const legacyDataset = {
      products: [
        {
          title: "TESLA Sound EB20",
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          partnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
            },
          ],
          strictPartnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
            },
          ],
        },
      ],
    } as const;

    expect(
      Schema.decodeUnknownSync(TeslaLegacyCompatibleDatasetEnvelopeSchema)(legacyDataset),
    ).toEqual(legacyDataset);
    expect(Schema.decodeUnknownSync(TeslaCompatibleDatasetSchema)(legacyDataset)).toEqual(
      legacyDataset,
    );
  });

  it("keeps the top-level legacy product array available for wrapper callers", () => {
    const legacyDatasetArray = [
      {
        officialTitle: "TESLA Sound EB20",
        officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
        partnerMatches: [
          {
            partner: "alza",
            partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
          },
        ],
      },
    ] as const;

    expect(Schema.decodeUnknownSync(TeslaCompatibleDatasetSchema)(legacyDatasetArray)).toEqual(
      legacyDatasetArray,
    );
  });

  it("distinguishes observed full and strict envelope requirements", () => {
    const observedStrictDataset = {
      generatedAt: "2026-03-12T06:00:00.000Z",
      summary: {
        productCount: 1,
        partnerUrlCount: 1,
      },
      products: [
        {
          officialTitle: "Bezdratova sluchatka TESLA Sound EB20 (Pearl Pink)",
          officialUrl:
            "https://eshop.tesla-electronics.eu/tesla-sound-eb20-bezdratova-bluetooth-sluchatka-pearl-pink",
          modelTokens: ["eb20"],
          officialIsAccessory: false,
          partnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-pearl-pink-d7915352.htm",
            },
          ],
        },
      ],
    } as const;
    const observedFullDataset = {
      generatedAt: "2026-03-12T06:00:00.000Z",
      source: {
        officialCatalog: "https://eshop.tesla-electronics.eu/sitemap?products=true&page=1",
        partnerDiscovery: ["https://search.seznam.cz/"],
        partnerDomains: [
          {
            partner: "alza",
            domain: "www.alza.cz",
          },
        ],
      },
      summary: {
        productCount: 1,
        partnerUrlCount: 1,
        strictProductCount: 1,
        strictPartnerUrlCount: 1,
      },
      products: [
        {
          title: "Bezdratova sluchatka TESLA Sound EB20 (Pearl Pink)",
          officialUrl:
            "https://eshop.tesla-electronics.eu/tesla-sound-eb20-bezdratova-bluetooth-sluchatka-pearl-pink",
          modelTokens: ["eb20"],
          partnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-pearl-pink-d7915352.htm",
            },
          ],
          officialIsAccessory: false,
          strictPartnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-pearl-pink-d7915352.htm",
            },
          ],
          strictEligible: true,
        },
      ],
    } as const;

    expect(() =>
      Schema.decodeUnknownSync(TeslaObservedFullDatasetEnvelopeSchema)(observedStrictDataset),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(TeslaObservedStrictDatasetEnvelopeSchema)(observedFullDataset),
    ).toThrow();
  });

  it("fails fast when observed strict datasets are malformed", () => {
    const missingModelTokensDataset = {
      generatedAt: "2026-03-12T06:00:00.000Z",
      summary: {
        productCount: 1,
        partnerUrlCount: 1,
      },
      products: [
        {
          officialTitle: "Bezdratova sluchatka TESLA Sound EB20 (Pearl Pink)",
          officialUrl:
            "https://eshop.tesla-electronics.eu/tesla-sound-eb20-bezdratova-bluetooth-sluchatka-pearl-pink",
          modelTokens: [],
          officialIsAccessory: false,
          partnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-pearl-pink-d7915352.htm",
            },
          ],
        },
      ],
    };

    expect(() =>
      Schema.decodeUnknownSync(TeslaObservedStrictDatasetEnvelopeSchema)(missingModelTokensDataset),
    ).toThrow();
    expect(() => loadTeslaCompatibleDataset(missingModelTokensDataset)).toThrow(
      /observed strict-format fields/u,
    );
  });

  it("fails closed when observed strict top-level metadata is malformed during compatible loading", () => {
    expect(() =>
      loadTeslaCompatibleDataset({
        generatedAt: "2026-03-12T06:00:00.000Z",
        summary: {
          productCount: "1",
          partnerUrlCount: 1,
        },
        products: [
          {
            officialTitle: "TESLA Sound EB20",
            officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
            modelTokens: ["eb20"],
            officialIsAccessory: false,
            partnerMatches: [
              {
                partner: "alza",
                partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
              },
            ],
          },
        ],
      }),
    ).toThrow(/observed strict-format fields/u);
  });

  it("fails closed when strict envelope metadata is present but products only satisfy the legacy-compatible shape", () => {
    expect(() =>
      loadTeslaCompatibleDataset(
        {
          generatedAt: "2026-03-12T06:00:00.000Z",
          summary: {
            productCount: 1,
            partnerUrlCount: 1,
          },
          products: [
            {
              title: "TESLA Sound EB20",
              officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
              partnerMatches: [
                {
                  partner: "alza",
                  partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
                },
              ],
            },
          ],
        },
        { strict: true },
      ),
    ).toThrow(/observed strict-format fields/u);
  });

  it("classifies observed full datasets without migration diagnostics", () => {
    const loaded = loadTeslaCompatibleDataset({
      generatedAt: "2026-03-12T06:00:00.000Z",
      source: {
        officialCatalog: "https://eshop.tesla-electronics.eu/sitemap?products=true&page=1",
        partnerDiscovery: ["https://search.seznam.cz/"],
        partnerDomains: [
          {
            partner: "alza",
            domain: "www.alza.cz",
          },
        ],
      },
      summary: {
        productCount: 1,
        partnerUrlCount: 1,
        strictProductCount: 1,
        strictPartnerUrlCount: 1,
      },
      products: [
        {
          title: "TESLA Sound EB20",
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          modelTokens: ["eb20"],
          partnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
            },
          ],
          officialIsAccessory: false,
          strictPartnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
            },
          ],
          strictEligible: true,
        },
      ],
    });

    expect(loaded.variant).toBe("observed-full-envelope");
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.coverage).toEqual({
      productCount: 1,
      legacyCompatibleProductCount: 0,
      observedFullProductCount: 1,
      observedStrictProductCount: 0,
      identityReadyProductCount: 1,
      strictReadyProductCount: 1,
      partialObservedFullProductCount: 0,
      partialObservedStrictProductCount: 0,
      partnerMatchCount: 1,
      strictPartnerMatchCount: 1,
      titleCount: 1,
      officialTitleCount: 0,
      modelTokensCount: 1,
      officialIsAccessoryCount: 1,
      strictEligibleCount: 1,
    });
  });

  it("treats observed strict datasets as already strict without fallback warnings", () => {
    const loaded = loadTeslaCompatibleDataset(
      {
        generatedAt: "2026-03-12T06:00:00.000Z",
        summary: {
          productCount: 1,
          partnerUrlCount: 1,
        },
        products: [
          {
            officialTitle: "TESLA Sound EB20",
            officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
            modelTokens: ["eb20"],
            officialIsAccessory: false,
            partnerMatches: [
              {
                partner: "alza",
                partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
              },
            ],
          },
        ],
      },
      {
        strict: true,
      },
    );

    expect(loaded.variant).toBe("observed-strict-envelope");
    expect(loaded.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "missing-strict-partner-matches",
    );
    expect(loaded.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "strict-fallback-partner-matches",
    );
    expect(loaded.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "missing-strict-eligibility",
    );
  });

  it("reports migration diagnostics for legacy-compatible datasets", () => {
    const loaded = loadTeslaCompatibleDataset({
      products: [
        {
          title: "TESLA Sound EB20",
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          partnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
            },
          ],
        },
      ],
    });

    expect(loaded.variant).toBe("legacy-envelope");
    expect(loaded.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "legacy-compatible-input",
      "missing-model-tokens",
      "missing-official-accessory-flag",
      "missing-strict-partner-matches",
      "missing-strict-eligibility",
    ]);
    expect(loaded.coverage).toEqual({
      productCount: 1,
      legacyCompatibleProductCount: 1,
      observedFullProductCount: 0,
      observedStrictProductCount: 0,
      identityReadyProductCount: 0,
      strictReadyProductCount: 0,
      partialObservedFullProductCount: 0,
      partialObservedStrictProductCount: 0,
      partnerMatchCount: 1,
      strictPartnerMatchCount: 0,
      titleCount: 1,
      officialTitleCount: 0,
      modelTokensCount: 0,
      officialIsAccessoryCount: 0,
      strictEligibleCount: 0,
    });
  });

  it("fails closed when strict mode would otherwise fall back to partnerMatches", () => {
    expect(() =>
      loadTeslaCompatibleDataset(
        {
          products: [
            {
              title: "TESLA Sound EB20",
              officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
              partnerMatches: [
                {
                  partner: "alza",
                  partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
                },
              ],
            },
          ],
        },
        {
          strict: true,
        },
      ),
    ).toThrow(
      "Strict Tesla dataset benchmarking requires strict-ready partner matches; partnerMatches fallback is not allowed in --strict mode.",
    );
  });

  it("exports deterministic dataset variant and product shape helpers", () => {
    const observedFullDataset = {
      generatedAt: "2026-03-12T06:00:00.000Z",
      source: {
        officialCatalog: "https://eshop.tesla-electronics.eu/sitemap?products=true&page=1",
        partnerDiscovery: ["https://search.seznam.cz/"],
        partnerDomains: [
          {
            partner: "alza",
            domain: "www.alza.cz",
          },
        ],
      },
      summary: {
        productCount: 1,
        partnerUrlCount: 1,
        strictProductCount: 1,
        strictPartnerUrlCount: 1,
      },
      products: [
        {
          title: "TESLA Sound EB20",
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          modelTokens: ["eb20"],
          partnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
            },
          ],
          officialIsAccessory: false,
          strictPartnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
            },
          ],
          strictEligible: true,
        },
      ],
    } as const;

    expect(classifyTeslaDatasetVariant(observedFullDataset)).toBe("observed-full-envelope");
    expect(classifyTeslaDatasetProductVariant(observedFullDataset.products[0])).toBe(
      "observed-full",
    );
  });

  it("summarizes mixed dataset coverage for curation workflows", () => {
    const coverage = collectTeslaDatasetCoverage({
      products: [
        {
          title: "TESLA Sound EB20",
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          partnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
            },
          ],
        },
        {
          title: "TESLA Sound EB20 Premium",
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20-premium",
          modelTokens: ["eb20"],
          partnerMatches: [
            {
              partner: "datart",
              partnerUrl: "https://www.datart.cz/tesla-sound-eb20-premium.html",
            },
          ],
          officialIsAccessory: false,
          strictPartnerMatches: [
            {
              partner: "datart",
              partnerUrl: "https://www.datart.cz/tesla-sound-eb20-premium.html",
            },
          ],
          strictEligible: true,
        },
        {
          officialTitle: "TESLA Sound EB20 Mini",
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20-mini",
          modelTokens: ["eb20", "mini"],
          officialIsAccessory: false,
          partnerMatches: [
            {
              partner: "mironet",
              partnerUrl: "https://www.mironet.cz/tesla-sound-eb20-mini+dp123456/",
            },
          ],
        },
      ],
    });

    expect(coverage).toEqual({
      productCount: 3,
      legacyCompatibleProductCount: 1,
      observedFullProductCount: 1,
      observedStrictProductCount: 1,
      identityReadyProductCount: 2,
      strictReadyProductCount: 1,
      partialObservedFullProductCount: 0,
      partialObservedStrictProductCount: 0,
      partnerMatchCount: 3,
      strictPartnerMatchCount: 1,
      titleCount: 2,
      officialTitleCount: 1,
      modelTokensCount: 2,
      officialIsAccessoryCount: 2,
      strictEligibleCount: 1,
    });
  });

  it("decodes a Tesla expectation sidecar with partner title, price, and description expectations", () => {
    const sidecar = {
      generatedAt: "2026-03-13T08:00:00.000Z",
      sourceDatasetPath: "/tmp/tesla-electronics-partner-dataset-2026-03-12.json",
      freshnessPolicy: {
        priceMaxAgeHours: 72,
        descriptionMaxAgeHours: 24 * 14,
        stalePriceBehavior: "warning",
        staleDescriptionBehavior: "score-only",
        missingPriceCapturedAtBehavior: "warning",
        missingDescriptionCapturedAtBehavior: "score-only",
      },
      products: [
        {
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          officialTitle: "TESLA Sound EB20",
          modelTokens: ["eb20"],
          partnerExpectations: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm?campaign=123#reviews",
              strictEligible: true,
              title: {
                value: "TESLA Sound EB20 Pearl Pink",
                policy: "partner-display",
              },
              price: {
                amount: 799,
                currency: "CZK",
                policy: "range",
                minAmount: 749,
                maxAmount: 849,
                capturedAt: "2026-03-13T08:00:00.000Z",
              },
              description: {
                value: "Bezdratova bluetooth sluchatka TESLA Sound EB20.",
                policy: "semantic-summary",
                capturedAt: "2026-03-13T08:00:00.000Z",
              },
            },
          ],
        },
      ],
    } as const;

    expect(Schema.decodeUnknownSync(TeslaExpectationSidecarSchema)(sidecar)).toEqual(sidecar);
  });

  it("loads sidecars with explicit freshness policy and computes freshness coverage deterministically", () => {
    const loadResult = loadTeslaExpectationSidecar(
      {
        generatedAt: "2026-03-13T08:00:00.000Z",
        freshnessPolicy: {
          priceMaxAgeHours: 48,
          descriptionMaxAgeHours: 24,
        },
        products: [
          {
            officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
            modelTokens: ["eb20"],
            partnerExpectations: [
              {
                partner: "alza",
                partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
                title: {
                  value: "TESLA Sound EB20",
                  policy: "partner-display",
                },
                price: {
                  amount: 799,
                  currency: "CZK",
                  policy: "range",
                  minAmount: 749,
                  maxAmount: 849,
                  capturedAt: "2026-03-11T12:00:00.000Z",
                },
                description: {
                  value: "Bezdratova bluetooth sluchatka TESLA Sound EB20.",
                  policy: "semantic-summary",
                  capturedAt: "2026-03-13T06:00:00.000Z",
                },
              },
              {
                partner: "datart",
                partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
                price: {
                  amount: 799,
                  currency: "CZK",
                  policy: "parse-only",
                },
                description: {
                  value: "Prenosna sluchatka TESLA Sound EB20.",
                  policy: "contains",
                },
              },
            ],
          },
        ],
      },
      {
        evaluatedAt: "2026-03-13T12:00:00.000Z",
      },
    );

    expect(Schema.decodeUnknownSync(TeslaExpectationSidecarLoadResultSchema)(loadResult)).toEqual(
      loadResult,
    );
    expect(loadResult.freshnessPolicy).toEqual({
      priceMaxAgeHours: 48,
      priceExpireAgeHours: 24 * 14,
      descriptionMaxAgeHours: 24,
      descriptionExpireAgeHours: 24 * 90,
      stalePriceBehavior: "warning",
      expiredPriceBehavior: "warning",
      staleDescriptionBehavior: "score-only",
      expiredDescriptionBehavior: "warning",
      missingPriceCapturedAtBehavior: "warning",
      missingDescriptionCapturedAtBehavior: "score-only",
    });
    expect(loadResult.coverage).toEqual({
      productCount: 1,
      productWithModelTokensCount: 1,
      partnerExpectationCount: 2,
      titleExpectationCount: 1,
      priceExpectationCount: 2,
      descriptionExpectationCount: 2,
      ambiguousNormalizedPartnerUrlCount: 0,
      freshPriceExpectationCount: 1,
      stalePriceExpectationCount: 0,
      expiredPriceExpectationCount: 0,
      missingPriceCapturedAtCount: 1,
      futurePriceCapturedAtCount: 0,
      freshDescriptionExpectationCount: 1,
      staleDescriptionExpectationCount: 0,
      expiredDescriptionExpectationCount: 0,
      missingDescriptionCapturedAtCount: 1,
      futureDescriptionCapturedAtCount: 0,
    });
    expect(loadResult.diagnostics).toEqual([
      {
        severity: "warning",
        code: "missing-price-captured-at",
        productIndex: 0,
        expectationIndex: 1,
        officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
        partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
        field: "price.capturedAt",
        message:
          "Tesla partner price truth is missing capturedAt, so freshness cannot be evaluated deterministically.",
      },
    ]);
  });

  it("uses default freshness windows when the sidecar does not specify them", () => {
    const sidecar = Schema.decodeUnknownSync(TeslaExpectationSidecarSchema)({
      generatedAt: "2026-03-13T08:00:00.000Z",
      products: [
        {
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          modelTokens: ["eb20"],
          partnerExpectations: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
              price: {
                amount: 799,
                currency: "CZK",
                policy: "range",
                capturedAt: "2026-03-11T13:00:00.000Z",
                minAmount: 749,
                maxAmount: 849,
              },
              description: {
                value: "Bezdratova bluetooth sluchatka TESLA Sound EB20.",
                policy: "semantic-summary",
                capturedAt: "2026-03-11T13:00:00.000Z",
              },
            },
          ],
        },
      ],
    });

    expect(
      collectTeslaExpectationSidecarCoverage(sidecar, {
        evaluatedAt: "2026-03-13T12:00:00.000Z",
      }),
    ).toEqual({
      productCount: 1,
      productWithModelTokensCount: 1,
      partnerExpectationCount: 1,
      titleExpectationCount: 0,
      priceExpectationCount: 1,
      descriptionExpectationCount: 1,
      ambiguousNormalizedPartnerUrlCount: 0,
      freshPriceExpectationCount: 1,
      stalePriceExpectationCount: 0,
      expiredPriceExpectationCount: 0,
      missingPriceCapturedAtCount: 0,
      futurePriceCapturedAtCount: 0,
      freshDescriptionExpectationCount: 1,
      staleDescriptionExpectationCount: 0,
      expiredDescriptionExpectationCount: 0,
      missingDescriptionCapturedAtCount: 0,
      futureDescriptionCapturedAtCount: 0,
    });
  });

  it("defaults freshness evaluation to sidecar generatedAt so the loader stays deterministic", () => {
    const sidecar = {
      generatedAt: "2026-03-13T08:00:00.000Z",
      freshnessPolicy: {
        priceMaxAgeHours: 24,
      },
      products: [
        {
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          modelTokens: ["eb20"],
          partnerExpectations: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
              price: {
                amount: 799,
                currency: "CZK",
                policy: "range",
                capturedAt: "2026-03-12T12:00:00.000Z",
                minAmount: 749,
                maxAmount: 849,
              },
            },
          ],
        },
      ],
    } as const;

    expect(loadTeslaExpectationSidecar(sidecar).evaluatedAt).toBe("2026-03-13T08:00:00.000Z");
    expect(collectTeslaExpectationSidecarCoverage(sidecar)).toEqual({
      productCount: 1,
      productWithModelTokensCount: 1,
      partnerExpectationCount: 1,
      titleExpectationCount: 0,
      priceExpectationCount: 1,
      descriptionExpectationCount: 0,
      ambiguousNormalizedPartnerUrlCount: 0,
      freshPriceExpectationCount: 1,
      stalePriceExpectationCount: 0,
      expiredPriceExpectationCount: 0,
      missingPriceCapturedAtCount: 0,
      futurePriceCapturedAtCount: 0,
      freshDescriptionExpectationCount: 0,
      staleDescriptionExpectationCount: 0,
      expiredDescriptionExpectationCount: 0,
      missingDescriptionCapturedAtCount: 0,
      futureDescriptionCapturedAtCount: 0,
    });
    expect(
      collectTeslaExpectationSidecarCoverage(sidecar, {
        evaluatedAt: "2026-03-14T12:00:00.000Z",
      }),
    ).toEqual({
      productCount: 1,
      productWithModelTokensCount: 1,
      partnerExpectationCount: 1,
      titleExpectationCount: 0,
      priceExpectationCount: 1,
      descriptionExpectationCount: 0,
      ambiguousNormalizedPartnerUrlCount: 0,
      freshPriceExpectationCount: 0,
      stalePriceExpectationCount: 1,
      expiredPriceExpectationCount: 0,
      missingPriceCapturedAtCount: 0,
      futurePriceCapturedAtCount: 0,
      freshDescriptionExpectationCount: 0,
      staleDescriptionExpectationCount: 0,
      expiredDescriptionExpectationCount: 0,
      missingDescriptionCapturedAtCount: 0,
      futureDescriptionCapturedAtCount: 0,
    });
  });

  it("emits unknown-field and stale-description diagnostics deterministically", () => {
    const loadResult = loadTeslaExpectationSidecar(
      {
        generatedAt: "2026-03-13T08:00:00.000Z",
        unexpectedTopLevel: true,
        freshnessPolicy: {
          descriptionMaxAgeHours: 12,
          staleDescriptionBehavior: "warning",
        },
        products: [
          {
            officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
            modelTokens: ["eb20"],
            unexpectedProductField: "ignored",
            partnerExpectations: [
              {
                partner: "alza",
                partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
                unexpectedExpectationField: "ignored",
                description: {
                  value: "Bezdratova bluetooth sluchatka TESLA Sound EB20.",
                  policy: "semantic-summary",
                  capturedAt: "2026-03-12T10:00:00.000Z",
                },
              },
            ],
          },
        ],
      },
      {
        evaluatedAt: "2026-03-13T12:00:00.000Z",
      },
    );

    expect(loadResult.diagnostics).toEqual([
      {
        severity: "warning",
        code: "unknown-top-level-field",
        field: "unexpectedTopLevel",
        message:
          'Tesla expectation sidecar contains unknown top-level field "unexpectedTopLevel" that is ignored by the loader.',
      },
      {
        severity: "warning",
        code: "unknown-product-field",
        productIndex: 0,
        officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
        field: "unexpectedProductField",
        message:
          'Tesla expectation sidecar product contains unknown field "unexpectedProductField" that is ignored by the loader.',
      },
      {
        severity: "warning",
        code: "unknown-partner-expectation-field",
        productIndex: 0,
        expectationIndex: 0,
        officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
        partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
        field: "unexpectedExpectationField",
        message:
          'Tesla expectation sidecar partner expectation contains unknown field "unexpectedExpectationField" that is ignored by the loader.',
      },
      {
        severity: "warning",
        code: "stale-description-truth",
        productIndex: 0,
        expectationIndex: 0,
        officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
        partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
        field: "description.capturedAt",
        message:
          "Tesla partner description truth is older than the configured freshness window of 12h.",
      },
    ]);
  });

  it("distinguishes expired future and ambiguous truth inputs using the sidecar snapshot time", () => {
    const loadResult = loadTeslaExpectationSidecar({
      generatedAt: "2026-03-13T12:00:00.000Z",
      freshnessPolicy: {
        priceMaxAgeHours: 48,
        priceExpireAgeHours: 96,
        descriptionMaxAgeHours: 24,
        descriptionExpireAgeHours: 72,
        staleDescriptionBehavior: "warning",
      },
      products: [
        {
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          modelTokens: ["eb20"],
          partnerExpectations: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/shared-product.htm?utm_source=campaign",
              price: {
                amount: 799,
                currency: "CZK",
                policy: "range",
                capturedAt: "2026-03-08T12:00:00.000Z",
                minAmount: 749,
                maxAmount: 849,
              },
            },
          ],
        },
        {
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20-special",
          partnerExpectations: [
            {
              partner: "alza",
              partnerUrl: "https://alza.cz/shared-product.htm#details",
              description: {
                value: "TESLA Sound EB20 future description snapshot.",
                policy: "semantic-summary",
                capturedAt: "2026-03-14T12:00:00.000Z",
              },
            },
          ],
        },
      ],
    });

    expect(loadResult.evaluatedAt).toBe("2026-03-13T12:00:00.000Z");
    expect(loadResult.coverage).toEqual({
      productCount: 2,
      productWithModelTokensCount: 1,
      partnerExpectationCount: 2,
      titleExpectationCount: 0,
      priceExpectationCount: 1,
      descriptionExpectationCount: 1,
      ambiguousNormalizedPartnerUrlCount: 1,
      freshPriceExpectationCount: 0,
      stalePriceExpectationCount: 0,
      expiredPriceExpectationCount: 1,
      missingPriceCapturedAtCount: 0,
      futurePriceCapturedAtCount: 0,
      freshDescriptionExpectationCount: 0,
      staleDescriptionExpectationCount: 0,
      expiredDescriptionExpectationCount: 0,
      missingDescriptionCapturedAtCount: 0,
      futureDescriptionCapturedAtCount: 1,
    });
    expect(loadResult.diagnostics).toEqual([
      {
        severity: "warning",
        code: "expired-price-truth",
        productIndex: 0,
        expectationIndex: 0,
        officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
        partnerUrl: "https://www.alza.cz/shared-product.htm?utm_source=campaign",
        field: "price.capturedAt",
        message: "Tesla partner price truth is older than the configured expiry window of 96h.",
      },
      {
        severity: "warning",
        code: "missing-model-tokens",
        productIndex: 1,
        officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20-special",
        field: "modelTokens",
        message:
          "Tesla expectation sidecar product is missing modelTokens, so future identity-aware truth scoring will be weaker.",
      },
      {
        severity: "warning",
        code: "future-description-captured-at",
        productIndex: 1,
        expectationIndex: 0,
        officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20-special",
        partnerUrl: "https://alza.cz/shared-product.htm#details",
        field: "description.capturedAt",
        message:
          "Tesla partner description truth has a capturedAt timestamp in the future relative to the evaluation time.",
      },
      {
        severity: "warning",
        code: "ambiguous-normalized-partner-url",
        productIndex: 0,
        expectationIndex: 0,
        officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
        partnerUrl: "https://www.alza.cz/shared-product.htm?utm_source=campaign",
        normalizedPartnerUrl: "https://alza.cz/shared-product.htm",
        field: "partnerUrl",
        message:
          'Tesla expectation sidecar normalizes multiple partner expectations to "https://alza.cz/shared-product.htm", so corpus joins may become ambiguous.',
      },
      {
        severity: "warning",
        code: "ambiguous-normalized-partner-url",
        productIndex: 1,
        expectationIndex: 0,
        officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20-special",
        partnerUrl: "https://alza.cz/shared-product.htm#details",
        normalizedPartnerUrl: "https://alza.cz/shared-product.htm",
        field: "partnerUrl",
        message:
          'Tesla expectation sidecar normalizes multiple partner expectations to "https://alza.cz/shared-product.htm", so corpus joins may become ambiguous.',
      },
    ]);
  });

  it("promotes freshness violations to error diagnostics when hard-fail behavior is configured", () => {
    const loadResult = loadTeslaExpectationSidecar({
      generatedAt: "2026-03-13T12:00:00.000Z",
      freshnessPolicy: {
        priceMaxAgeHours: 24,
        priceExpireAgeHours: 48,
        stalePriceBehavior: "hard-fail",
        expiredPriceBehavior: "hard-fail",
        missingPriceCapturedAtBehavior: "hard-fail",
      },
      products: [
        {
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          modelTokens: ["eb20"],
          partnerExpectations: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
              price: {
                amount: 799,
                currency: "CZK",
                policy: "range",
                capturedAt: "2026-03-10T12:00:00.000Z",
                minAmount: 749,
                maxAmount: 849,
              },
            },
            {
              partner: "datart",
              partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
              price: {
                amount: 799,
                currency: "CZK",
                policy: "parse-only",
              },
            },
          ],
        },
      ],
    });

    expect(loadResult.diagnostics).toEqual([
      {
        severity: "error",
        code: "expired-price-truth",
        productIndex: 0,
        expectationIndex: 0,
        officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
        partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
        field: "price.capturedAt",
        message: "Tesla partner price truth is older than the configured expiry window of 48h.",
      },
      {
        severity: "error",
        code: "missing-price-captured-at",
        productIndex: 0,
        expectationIndex: 1,
        officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
        partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
        field: "price.capturedAt",
        message:
          "Tesla partner price truth is missing capturedAt, so freshness cannot be evaluated deterministically.",
      },
    ]);
  });

  it("captures the supported Tesla dataset and expectation compatibility matrix deterministically", () => {
    const matrix = {
      datasets: [
        (() => {
          const loaded = loadTeslaCompatibleDataset([
            {
              title: "TESLA Sound EB20",
              officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
              partnerMatches: [
                {
                  partner: "alza",
                  partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
                },
              ],
            },
          ]);

          return {
            case: "legacy-array",
            variant: loaded.variant,
            diagnosticCodes: loaded.diagnostics.map((diagnostic) => diagnostic.code),
            coverage: loaded.coverage,
          };
        })(),
        (() => {
          const loaded = loadTeslaCompatibleDataset({
            generatedAt: "2026-03-12T06:00:00.000Z",
            summary: {
              productCount: 1,
              partnerUrlCount: 1,
            },
            products: [
              {
                officialTitle: "TESLA Sound EB20",
                officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
                modelTokens: ["eb20"],
                officialIsAccessory: false,
                partnerMatches: [
                  {
                    partner: "alza",
                    partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
                  },
                ],
              },
            ],
          });

          return {
            case: "observed-strict-envelope",
            variant: loaded.variant,
            diagnosticCodes: loaded.diagnostics.map((diagnostic) => diagnostic.code),
            coverage: loaded.coverage,
          };
        })(),
        (() => {
          const loaded = loadTeslaCompatibleDataset({
            generatedAt: "2026-03-12T06:00:00.000Z",
            source: {
              officialCatalog: "https://eshop.tesla-electronics.eu/sitemap?products=true&page=1",
              partnerDiscovery: ["https://search.seznam.cz/"],
              partnerDomains: [
                {
                  partner: "alza",
                  domain: "www.alza.cz",
                },
              ],
            },
            summary: {
              productCount: 1,
              partnerUrlCount: 1,
              strictProductCount: 1,
              strictPartnerUrlCount: 1,
            },
            products: [
              {
                title: "TESLA Sound EB20",
                officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
                modelTokens: ["eb20"],
                partnerMatches: [
                  {
                    partner: "alza",
                    partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
                  },
                ],
                officialIsAccessory: false,
              },
            ],
          });

          return {
            case: "partial-observed-full-product",
            variant: loaded.variant,
            diagnosticCodes: loaded.diagnostics.map((diagnostic) => diagnostic.code),
            coverage: loaded.coverage,
          };
        })(),
      ],
      sidecars: [
        (() => {
          const loaded = loadTeslaExpectationSidecar({
            generatedAt: "2026-03-13T12:00:00.000Z",
            products: [
              {
                officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
                modelTokens: ["eb20"],
                partnerExpectations: [
                  {
                    partner: "alza",
                    partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
                    price: {
                      amount: 799,
                      currency: "CZK",
                      policy: "range",
                      capturedAt: "2026-03-13T11:00:00.000Z",
                      minAmount: 749,
                      maxAmount: 849,
                    },
                    description: {
                      value: "Bezdratova bluetooth sluchatka TESLA Sound EB20.",
                      policy: "semantic-summary",
                      capturedAt: "2026-03-12T12:00:00.000Z",
                    },
                  },
                ],
              },
            ],
          });

          return {
            case: "fresh-sidecar-defaults",
            evaluatedAt: loaded.evaluatedAt,
            diagnosticCodes: loaded.diagnostics.map((diagnostic) => diagnostic.code),
            coverage: loaded.coverage,
          };
        })(),
        (() => {
          const loaded = loadTeslaExpectationSidecar({
            generatedAt: "2026-03-13T12:00:00.000Z",
            freshnessPolicy: {
              priceMaxAgeHours: 48,
              priceExpireAgeHours: 96,
              descriptionMaxAgeHours: 24,
              descriptionExpireAgeHours: 72,
              staleDescriptionBehavior: "warning",
            },
            products: [
              {
                officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
                modelTokens: ["eb20"],
                partnerExpectations: [
                  {
                    partner: "alza",
                    partnerUrl: "https://www.alza.cz/shared-product.htm?utm_source=campaign",
                    price: {
                      amount: 799,
                      currency: "CZK",
                      policy: "range",
                      capturedAt: "2026-03-08T12:00:00.000Z",
                      minAmount: 749,
                      maxAmount: 849,
                    },
                  },
                ],
              },
              {
                officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20-special",
                partnerExpectations: [
                  {
                    partner: "alza",
                    partnerUrl: "https://alza.cz/shared-product.htm#details",
                    description: {
                      value: "TESLA Sound EB20 future description snapshot.",
                      policy: "semantic-summary",
                      capturedAt: "2026-03-14T12:00:00.000Z",
                    },
                  },
                ],
              },
            ],
          });

          return {
            case: "expired-future-ambiguous-sidecar",
            evaluatedAt: loaded.evaluatedAt,
            diagnosticCodes: loaded.diagnostics.map((diagnostic) => diagnostic.code),
            coverage: loaded.coverage,
          };
        })(),
        (() => {
          const loaded = loadTeslaExpectationSidecar({
            generatedAt: "2026-03-13T12:00:00.000Z",
            products: [
              {
                officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
                modelTokens: ["eb20"],
                partnerExpectations: [
                  {
                    partner: "datart",
                    partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
                    description: {
                      value: "Bezdratova bluetooth sluchatka TESLA Sound EB20.",
                      policy: "semantic-summary",
                    },
                  },
                ],
              },
            ],
          });

          return {
            case: "score-only-missing-description-captured-at",
            evaluatedAt: loaded.evaluatedAt,
            diagnosticCodes: loaded.diagnostics.map((diagnostic) => diagnostic.code),
            coverage: loaded.coverage,
          };
        })(),
      ],
    };

    expect(matrix).toEqual({
      datasets: [
        {
          case: "legacy-array",
          variant: "legacy-array",
          diagnosticCodes: [
            "legacy-compatible-input",
            "missing-model-tokens",
            "missing-official-accessory-flag",
            "missing-strict-partner-matches",
            "missing-strict-eligibility",
          ],
          coverage: {
            productCount: 1,
            legacyCompatibleProductCount: 1,
            observedFullProductCount: 0,
            observedStrictProductCount: 0,
            identityReadyProductCount: 0,
            strictReadyProductCount: 0,
            partialObservedFullProductCount: 0,
            partialObservedStrictProductCount: 0,
            partnerMatchCount: 1,
            strictPartnerMatchCount: 0,
            titleCount: 1,
            officialTitleCount: 0,
            modelTokensCount: 0,
            officialIsAccessoryCount: 0,
            strictEligibleCount: 0,
          },
        },
        {
          case: "observed-strict-envelope",
          variant: "observed-strict-envelope",
          diagnosticCodes: [],
          coverage: {
            productCount: 1,
            legacyCompatibleProductCount: 0,
            observedFullProductCount: 0,
            observedStrictProductCount: 1,
            identityReadyProductCount: 1,
            strictReadyProductCount: 0,
            partialObservedFullProductCount: 0,
            partialObservedStrictProductCount: 0,
            partnerMatchCount: 1,
            strictPartnerMatchCount: 0,
            titleCount: 0,
            officialTitleCount: 1,
            modelTokensCount: 1,
            officialIsAccessoryCount: 1,
            strictEligibleCount: 0,
          },
        },
        {
          case: "partial-observed-full-product",
          variant: "observed-full-envelope",
          diagnosticCodes: [
            "partial-observed-full-product",
            "missing-strict-partner-matches",
            "missing-strict-eligibility",
          ],
          coverage: {
            productCount: 1,
            legacyCompatibleProductCount: 1,
            observedFullProductCount: 0,
            observedStrictProductCount: 0,
            identityReadyProductCount: 0,
            strictReadyProductCount: 0,
            partialObservedFullProductCount: 1,
            partialObservedStrictProductCount: 0,
            partnerMatchCount: 1,
            strictPartnerMatchCount: 0,
            titleCount: 1,
            officialTitleCount: 0,
            modelTokensCount: 0,
            officialIsAccessoryCount: 0,
            strictEligibleCount: 0,
          },
        },
      ],
      sidecars: [
        {
          case: "fresh-sidecar-defaults",
          evaluatedAt: "2026-03-13T12:00:00.000Z",
          diagnosticCodes: [],
          coverage: {
            productCount: 1,
            productWithModelTokensCount: 1,
            partnerExpectationCount: 1,
            titleExpectationCount: 0,
            priceExpectationCount: 1,
            descriptionExpectationCount: 1,
            ambiguousNormalizedPartnerUrlCount: 0,
            freshPriceExpectationCount: 1,
            stalePriceExpectationCount: 0,
            expiredPriceExpectationCount: 0,
            missingPriceCapturedAtCount: 0,
            futurePriceCapturedAtCount: 0,
            freshDescriptionExpectationCount: 1,
            staleDescriptionExpectationCount: 0,
            expiredDescriptionExpectationCount: 0,
            missingDescriptionCapturedAtCount: 0,
            futureDescriptionCapturedAtCount: 0,
          },
        },
        {
          case: "expired-future-ambiguous-sidecar",
          evaluatedAt: "2026-03-13T12:00:00.000Z",
          diagnosticCodes: [
            "expired-price-truth",
            "missing-model-tokens",
            "future-description-captured-at",
            "ambiguous-normalized-partner-url",
            "ambiguous-normalized-partner-url",
          ],
          coverage: {
            productCount: 2,
            productWithModelTokensCount: 1,
            partnerExpectationCount: 2,
            titleExpectationCount: 0,
            priceExpectationCount: 1,
            descriptionExpectationCount: 1,
            ambiguousNormalizedPartnerUrlCount: 1,
            freshPriceExpectationCount: 0,
            stalePriceExpectationCount: 0,
            expiredPriceExpectationCount: 1,
            missingPriceCapturedAtCount: 0,
            futurePriceCapturedAtCount: 0,
            freshDescriptionExpectationCount: 0,
            staleDescriptionExpectationCount: 0,
            expiredDescriptionExpectationCount: 0,
            missingDescriptionCapturedAtCount: 0,
            futureDescriptionCapturedAtCount: 1,
          },
        },
        {
          case: "score-only-missing-description-captured-at",
          evaluatedAt: "2026-03-13T12:00:00.000Z",
          diagnosticCodes: [],
          coverage: {
            productCount: 1,
            productWithModelTokensCount: 1,
            partnerExpectationCount: 1,
            titleExpectationCount: 0,
            priceExpectationCount: 0,
            descriptionExpectationCount: 1,
            ambiguousNormalizedPartnerUrlCount: 0,
            freshPriceExpectationCount: 0,
            stalePriceExpectationCount: 0,
            expiredPriceExpectationCount: 0,
            missingPriceCapturedAtCount: 0,
            futurePriceCapturedAtCount: 0,
            freshDescriptionExpectationCount: 0,
            staleDescriptionExpectationCount: 0,
            expiredDescriptionExpectationCount: 0,
            missingDescriptionCapturedAtCount: 1,
            futureDescriptionCapturedAtCount: 0,
          },
        },
      ],
    });
  });

  it("rejects sidecar expectation entries that provide no field expectations", () => {
    expect(() =>
      Schema.decodeUnknownSync(TeslaExpectationSidecarSchema)({
        generatedAt: "2026-03-13T08:00:00.000Z",
        products: [
          {
            officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
            partnerExpectations: [
              {
                partner: "alza",
                partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
                strictEligible: true,
              },
            ],
          },
        ],
      }),
    ).toThrow(/at least one of title, price, or description/u);
  });

  it("normalizes expectation join URLs deterministically", () => {
    expect(
      normalizeTeslaExpectationJoinUrl(
        "https://WWW.ALZA.CZ/tesla-sound-eb20-d7915352.htm/?b=2&a=1#detail",
      ),
    ).toBe("https://alza.cz/tesla-sound-eb20-d7915352.htm?a=1&b=2");
    expect(normalizeTeslaExpectationJoinUrl("https://www.datart.cz/")).toBe("https://datart.cz/");
  });

  it("looks up expectation entries by normalized partner URL", () => {
    const sidecar = Schema.decodeUnknownSync(TeslaExpectationSidecarSchema)({
      generatedAt: "2026-03-13T08:00:00.000Z",
      products: [
        {
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          partnerExpectations: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm?utm_source=foo#specs",
              strictEligible: true,
              title: {
                value: "TESLA Sound EB20",
                policy: "partner-display",
              },
            },
          ],
        },
      ],
    });

    expect(
      lookupTeslaExpectationByPartnerUrl(
        sidecar,
        "https://alza.cz/tesla-sound-eb20-d7915352.htm?utm_source=foo#description",
      ),
    ).toEqual({
      status: "matched",
      partnerUrl: "https://alza.cz/tesla-sound-eb20-d7915352.htm?utm_source=foo#description",
      normalizedPartnerUrl: "https://alza.cz/tesla-sound-eb20-d7915352.htm",
      strict: false,
      matchCount: 1,
      matches: [
        {
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          expectation: {
            partner: "alza",
            partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm?utm_source=foo#specs",
            strictEligible: true,
            title: {
              value: "TESLA Sound EB20",
              policy: "partner-display",
            },
          },
        },
      ],
    });
  });

  it("reports ambiguous and strict-excluded expectation lookups deterministically", () => {
    const sidecar = Schema.decodeUnknownSync(TeslaExpectationSidecarSchema)({
      generatedAt: "2026-03-13T08:00:00.000Z",
      products: [
        {
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          partnerExpectations: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/shared-product.htm",
              strictEligible: false,
              title: {
                value: "TESLA Sound EB20",
                policy: "semantic-identity",
              },
            },
          ],
        },
        {
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20-special",
          partnerExpectations: [
            {
              partner: "alza",
              partnerUrl: "https://alza.cz/shared-product.htm",
              strictEligible: false,
              title: {
                value: "TESLA Sound EB20 Special",
                policy: "semantic-identity",
              },
            },
          ],
        },
      ],
    });

    expect(
      lookupTeslaExpectationByPartnerUrl(sidecar, "https://www.alza.cz/shared-product.htm"),
    ).toEqual({
      status: "ambiguous",
      partnerUrl: "https://www.alza.cz/shared-product.htm",
      normalizedPartnerUrl: "https://alza.cz/shared-product.htm",
      strict: false,
      matchCount: 2,
      matches: [
        {
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          expectation: {
            partner: "alza",
            partnerUrl: "https://www.alza.cz/shared-product.htm",
            strictEligible: false,
            title: {
              value: "TESLA Sound EB20",
              policy: "semantic-identity",
            },
          },
        },
        {
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20-special",
          expectation: {
            partner: "alza",
            partnerUrl: "https://alza.cz/shared-product.htm",
            strictEligible: false,
            title: {
              value: "TESLA Sound EB20 Special",
              policy: "semantic-identity",
            },
          },
        },
      ],
    });
    expect(
      lookupTeslaExpectationByPartnerUrl(sidecar, "https://alza.cz/shared-product.htm", {
        strict: true,
      }),
    ).toEqual({
      status: "strict-excluded",
      partnerUrl: "https://alza.cz/shared-product.htm",
      normalizedPartnerUrl: "https://alza.cz/shared-product.htm",
      strict: true,
      matchCount: 0,
      matches: [],
    });
    expect(
      lookupTeslaExpectationByPartnerUrl(sidecar, "https://www.datart.cz/missing-product.html"),
    ).toEqual({
      status: "missing",
      partnerUrl: "https://www.datart.cz/missing-product.html",
      normalizedPartnerUrl: "https://datart.cz/missing-product.html",
      strict: false,
      matchCount: 0,
      matches: [],
    });
  });

  it("fails fast when a sidecar partner URL domain does not match the declared partner", () => {
    expect(() =>
      Schema.decodeUnknownSync(TeslaExpectationSidecarSchema)({
        generatedAt: "2026-03-13T08:00:00.000Z",
        products: [
          {
            officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
            partnerExpectations: [
              {
                partner: "alza",
                partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
                title: {
                  value: "TESLA Sound EB20",
                  policy: "partner-display",
                },
              },
            ],
          },
        ],
      }),
    ).toThrow(/partnerUrl whose domain matches the declared partner/u);
  });

  it("joins sidecar expectations onto the frozen corpus without changing corpus semantics", () => {
    const corpus = buildTeslaPartnerCorpusArtifact(
      "/tmp/tesla-electronics-partner-dataset-2026-03-12.json",
      {
        products: [
          {
            title: "TESLA Sound EB20",
            officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
            partnerMatches: [
              {
                partner: "alza",
                partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
              },
              {
                partner: "datart",
                partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
              },
            ],
          },
        ],
      },
      false,
    );
    const sidecar = Schema.decodeUnknownSync(TeslaExpectationSidecarSchema)({
      generatedAt: "2026-03-13T08:00:00.000Z",
      products: [
        {
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          partnerExpectations: [
            {
              partner: "alza",
              partnerUrl: "https://alza.cz/tesla-sound-eb20-d7915352.htm?utm_campaign=sidecar#foo",
              strictEligible: true,
              title: {
                value: "TESLA Sound EB20",
                policy: "partner-display",
              },
            },
            {
              partner: "datart",
              partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
              strictEligible: false,
              title: {
                value: "TESLA Sound EB20",
                policy: "partner-display",
              },
            },
          ],
        },
      ],
    });

    expect(joinTeslaExpectationSidecarToCorpus(corpus, sidecar)).toEqual({
      strict: false,
      matchedCount: 2,
      missingCount: 0,
      ambiguousCount: 0,
      strictExcludedCount: 0,
      records: [
        {
          status: "matched",
          pageUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
          normalizedPageUrl: "https://alza.cz/tesla-sound-eb20-d7915352.htm",
          siteId: "alza-cz",
          domain: "alza.cz",
          pageType: "product",
          matchCount: 1,
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          expectation: {
            partner: "alza",
            partnerUrl: "https://alza.cz/tesla-sound-eb20-d7915352.htm?utm_campaign=sidecar#foo",
            strictEligible: true,
            title: {
              value: "TESLA Sound EB20",
              policy: "partner-display",
            },
          },
        },
        {
          status: "matched",
          pageUrl: "https://www.datart.cz/tesla-sound-eb20.html",
          normalizedPageUrl: "https://datart.cz/tesla-sound-eb20.html",
          siteId: "datart-cz",
          domain: "datart.cz",
          pageType: "product",
          matchCount: 1,
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          expectation: {
            partner: "datart",
            partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
            strictEligible: false,
            title: {
              value: "TESLA Sound EB20",
              policy: "partner-display",
            },
          },
        },
      ],
    });
    expect(joinTeslaExpectationSidecarToCorpus(corpus, sidecar, { strict: true })).toEqual({
      strict: true,
      matchedCount: 1,
      missingCount: 0,
      ambiguousCount: 0,
      strictExcludedCount: 1,
      records: [
        {
          status: "matched",
          pageUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
          normalizedPageUrl: "https://alza.cz/tesla-sound-eb20-d7915352.htm",
          siteId: "alza-cz",
          domain: "alza.cz",
          pageType: "product",
          matchCount: 1,
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          expectation: {
            partner: "alza",
            partnerUrl: "https://alza.cz/tesla-sound-eb20-d7915352.htm?utm_campaign=sidecar#foo",
            strictEligible: true,
            title: {
              value: "TESLA Sound EB20",
              policy: "partner-display",
            },
          },
        },
        {
          status: "strict-excluded",
          pageUrl: "https://www.datart.cz/tesla-sound-eb20.html",
          normalizedPageUrl: "https://datart.cz/tesla-sound-eb20.html",
          siteId: "datart-cz",
          domain: "datart.cz",
          pageType: "product",
          matchCount: 0,
          officialUrl: undefined,
          expectation: undefined,
        },
      ],
    });
  });

  it("decodes the first-pass Tesla expectation sidecar schema for partner truth snapshots", () => {
    expect(
      Schema.decodeUnknownSync(TeslaExpectationSidecarSchema)(teslaExpectationSidecarFixture),
    ).toEqual(teslaExpectationSidecarFixture);
  });

  it("normalizes first-pass expectation join URLs deterministically", () => {
    expect(
      normalizeTeslaExpectationJoinUrl(
        "https://www.alza.cz/tesla-sound-eb20-d7915352.htm?b=2&a=1#details",
      ),
    ).toBe("https://alza.cz/tesla-sound-eb20-d7915352.htm?a=1&b=2");
    expect(
      normalizeTeslaExpectationJoinUrl("https://www.mironet.cz/tesla-sound-eb20+dp123456/?utm=1"),
    ).toBe("https://mironet.cz/tesla-sound-eb20+dp123456?utm=1");
  });

  it("looks up first-pass expectation entries by normalized partner URL", () => {
    const matchedLookup = lookupTeslaExpectationByPartnerUrl(
      teslaExpectationSidecarFixture,
      "https://alza.cz/tesla-sound-eb20-d7915352.htm?a=1&b=2#hero",
    );
    const ambiguousLookup = lookupTeslaExpectationByPartnerUrl(
      teslaExpectationSidecarFixture,
      "https://mironet.cz/tesla-sound-eb20+dp123456?utm=1",
    );
    const strictExcludedLookup = lookupTeslaExpectationByPartnerUrl(
      teslaExpectationSidecarFixture,
      "https://www.datart.cz/tesla-sound-eb20.html",
      {
        strict: true,
      },
    );
    const missingLookup = lookupTeslaExpectationByPartnerUrl(
      teslaExpectationSidecarFixture,
      "https://www.planeo.cz/tesla-sound-eb20.html",
    );

    expect(matchedLookup).toEqual({
      status: "matched",
      partnerUrl: "https://alza.cz/tesla-sound-eb20-d7915352.htm?a=1&b=2#hero",
      normalizedPartnerUrl: "https://alza.cz/tesla-sound-eb20-d7915352.htm?a=1&b=2",
      strict: false,
      matchCount: 1,
      matches: [
        {
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          expectation: teslaExpectationSidecarFixture.products[0].partnerExpectations[0],
        },
      ],
    });
    expect(ambiguousLookup.status).toBe("ambiguous");
    expect(ambiguousLookup.matchCount).toBe(2);
    expect(strictExcludedLookup).toEqual({
      status: "strict-excluded",
      partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
      normalizedPartnerUrl: "https://datart.cz/tesla-sound-eb20.html",
      strict: true,
      matchCount: 0,
      matches: [],
    });
    expect(missingLookup).toEqual({
      status: "missing",
      partnerUrl: "https://www.planeo.cz/tesla-sound-eb20.html",
      normalizedPartnerUrl: "https://planeo.cz/tesla-sound-eb20.html",
      strict: false,
      matchCount: 0,
      matches: [],
    });
  });

  it("joins first-pass expectation sidecars onto frozen corpus pages without changing corpus semantics", () => {
    const corpusArtifact = Schema.decodeUnknownSync(E9CommerceCorpusFreezeArtifactSchema)({
      benchmark: "e9-commerce-corpus-freeze",
      generatedAt: "2026-03-13T09:15:00.000Z",
      sourceArtifactPath: "/tmp/tesla-partners-corpus-fixture.json",
      targetPageCount: 4,
      selectedPageCount: 4,
      selectedSiteCount: 4,
      minimumSiteCount: 1,
      siteCoverage: 1,
      pageCoverage: 1,
      shortfallCount: 0,
      pages: [
        {
          siteId: "alza-cz",
          domain: "alza.cz",
          kind: "retailer",
          state: "healthy",
          url: "https://alza.cz/tesla-sound-eb20-d7915352.htm?a=1&b=2#hero",
          pageType: "product",
          title: "TESLA Sound EB20",
          challengeSignals: [],
        },
        {
          siteId: "datart-cz",
          domain: "datart.cz",
          kind: "retailer",
          state: "healthy",
          url: "https://www.datart.cz/tesla-sound-eb20.html",
          pageType: "product",
          title: "TESLA Sound EB20",
          challengeSignals: [],
        },
        {
          siteId: "mironet-cz",
          domain: "mironet.cz",
          kind: "retailer",
          state: "healthy",
          url: "https://mironet.cz/tesla-sound-eb20+dp123456?utm=1",
          pageType: "product",
          title: "TESLA Sound EB20",
          challengeSignals: [],
        },
        {
          siteId: "planeo-cz",
          domain: "planeo.cz",
          kind: "retailer",
          state: "healthy",
          url: "https://www.planeo.cz/tesla-sound-eb20.html",
          pageType: "product",
          title: "TESLA Sound EB20",
          challengeSignals: [],
        },
      ],
      allocations: [
        {
          siteId: "alza-cz",
          domain: "alza.cz",
          state: "healthy",
          kind: "retailer",
          availableSelectedPageCount: 1,
          allocatedPageCount: 1,
        },
        {
          siteId: "datart-cz",
          domain: "datart.cz",
          state: "healthy",
          kind: "retailer",
          availableSelectedPageCount: 1,
          allocatedPageCount: 1,
        },
        {
          siteId: "mironet-cz",
          domain: "mironet.cz",
          state: "healthy",
          kind: "retailer",
          availableSelectedPageCount: 1,
          allocatedPageCount: 1,
        },
        {
          siteId: "planeo-cz",
          domain: "planeo.cz",
          state: "healthy",
          kind: "retailer",
          availableSelectedPageCount: 1,
          allocatedPageCount: 1,
        },
      ],
    });

    const nonStrictJoin = joinTeslaExpectationSidecarToCorpus(
      corpusArtifact,
      teslaExpectationSidecarFixture,
    );
    const strictJoin = joinTeslaExpectationSidecarToCorpus(
      corpusArtifact,
      teslaExpectationSidecarFixture,
      {
        strict: true,
      },
    );

    expect(nonStrictJoin.matchedCount).toBe(2);
    expect(nonStrictJoin.ambiguousCount).toBe(1);
    expect(nonStrictJoin.missingCount).toBe(1);
    expect(nonStrictJoin.strictExcludedCount).toBe(0);
    expect(nonStrictJoin.records.map((record) => record.status)).toEqual([
      "matched",
      "matched",
      "ambiguous",
      "missing",
    ]);

    expect(strictJoin.matchedCount).toBe(1);
    expect(strictJoin.ambiguousCount).toBe(1);
    expect(strictJoin.missingCount).toBe(1);
    expect(strictJoin.strictExcludedCount).toBe(1);
    expect(strictJoin.records.map((record) => record.status)).toEqual([
      "matched",
      "strict-excluded",
      "ambiguous",
      "missing",
    ]);
  });

  it("reports ignored unknown fields during dataset loading", () => {
    const loaded = loadTeslaCompatibleDataset({
      generatedAt: "2026-03-12T06:00:00.000Z",
      source: {
        officialCatalog: "https://eshop.tesla-electronics.eu/sitemap?products=true&page=1",
        partnerDiscovery: ["https://search.seznam.cz/"],
        partnerDomains: [
          {
            partner: "alza",
            domain: "www.alza.cz",
          },
        ],
      },
      summary: {
        productCount: 1,
        partnerUrlCount: 1,
        strictProductCount: 1,
        strictPartnerUrlCount: 1,
      },
      ignoredTopLevelField: true,
      products: [
        {
          title: "TESLA Sound EB20",
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          modelTokens: ["eb20"],
          partnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
            },
          ],
          officialIsAccessory: false,
          strictPartnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
            },
          ],
          strictEligible: true,
          ignoredProductField: "extra",
        },
      ],
    });

    expect(loaded.diagnostics).toEqual([
      {
        severity: "warning",
        code: "unknown-top-level-field",
        field: "ignoredTopLevelField",
        message:
          'Dataset contains unknown top-level field "ignoredTopLevelField" that is ignored by the Tesla wrapper.',
      },
      {
        severity: "warning",
        code: "unknown-product-field",
        productIndex: 0,
        field: "ignoredProductField",
        officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
        message:
          'Dataset product contains unknown field "ignoredProductField" that is ignored by the Tesla wrapper.',
      },
    ]);
  });

  it("rejects legacy-compatible products that provide no title field at all", () => {
    expect(() =>
      Schema.decodeUnknownSync(TeslaCompatibleDatasetSchema)({
        products: [
          {
            officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
            partnerMatches: [
              {
                partner: "alza",
                partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects malformed observed full metadata", () => {
    expect(() =>
      Schema.decodeUnknownSync(TeslaObservedFullDatasetEnvelopeSchema)({
        generatedAt: "2026-03-12T06:00:00.000Z",
        source: {
          officialCatalog: "https://eshop.tesla-electronics.eu/sitemap?products=true&page=1",
          partnerDiscovery: "https://search.seznam.cz/",
          partnerDomains: [],
        },
        summary: {
          productCount: 1,
          partnerUrlCount: 1,
          strictProductCount: 1,
          strictPartnerUrlCount: 1,
        },
        products: [
          {
            title: "TESLA Sound EB20",
            officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
            modelTokens: ["eb20"],
            partnerMatches: [
              {
                partner: "alza",
                partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
              },
            ],
            officialIsAccessory: false,
            strictPartnerMatches: [
              {
                partner: "alza",
                partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
              },
            ],
            strictEligible: true,
          },
        ],
      }),
    ).toThrow();
  });

  it("fails closed when observed full top-level metadata is malformed during compatible loading", () => {
    expect(() =>
      loadTeslaCompatibleDataset({
        generatedAt: "2026-03-12T06:00:00.000Z",
        source: {
          officialCatalog: "https://eshop.tesla-electronics.eu/sitemap?products=true&page=1",
          partnerDiscovery: "https://search.seznam.cz/",
          partnerDomains: [],
        },
        summary: {
          productCount: 1,
          partnerUrlCount: 1,
          strictProductCount: 1,
          strictPartnerUrlCount: 1,
        },
        products: [],
      }),
    ).toThrow(/observed full-format fields/u);
  });

  it("fails with an actionable validation message for invalid dataset input", () => {
    expect(() =>
      loadTeslaCompatibleDataset({
        products: [
          {
            title: "TESLA Sound EB20",
            officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
            partnerMatches: [
              {
                partner: "alza",
              },
            ],
          },
        ],
      }),
    ).toThrow(/partnerUrl/u);
  });

  it("fails fast when legacy-compatible products omit both title fields", () => {
    expect(() =>
      loadTeslaCompatibleDataset({
        products: [
          {
            officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
            partnerMatches: [
              {
                partner: "alza",
                partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
              },
            ],
          },
        ],
      }),
    ).toThrow(/must include either "title" or "officialTitle"/u);
  });

  it("loads partially migrated observed full products through the legacy-compatible path", () => {
    const loaded = loadTeslaCompatibleDataset({
      products: [
        {
          title: "TESLA Sound EB20",
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
          modelTokens: ["eb20"],
          officialIsAccessory: false,
          partnerMatches: [
            {
              partner: "alza",
              partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
            },
          ],
        },
      ],
    });

    expect(loaded.variant).toBe("legacy-envelope");
    expect(loaded.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "legacy-compatible-input",
      "partial-observed-full-product",
      "missing-strict-partner-matches",
      "missing-strict-eligibility",
    ]);
    expect(loaded.coverage).toEqual({
      productCount: 1,
      legacyCompatibleProductCount: 1,
      observedFullProductCount: 0,
      observedStrictProductCount: 0,
      identityReadyProductCount: 0,
      strictReadyProductCount: 0,
      partialObservedFullProductCount: 1,
      partialObservedStrictProductCount: 0,
      partnerMatchCount: 1,
      strictPartnerMatchCount: 0,
      titleCount: 1,
      officialTitleCount: 0,
      modelTokensCount: 0,
      officialIsAccessoryCount: 0,
      strictEligibleCount: 0,
    });
  });

  it("adds migration hints for invalid partially migrated observed products", () => {
    expect(() =>
      loadTeslaCompatibleDataset({
        products: [
          {
            officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
            officialIsAccessory: false,
            partnerMatches: [
              {
                partner: "alza",
                partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
              },
            ],
          },
        ],
      }),
    ).toThrow(/includes officialIsAccessory but is missing modelTokens/u);
  });

  it("builds a frozen corpus from the Tesla dataset shape", () => {
    const artifact = buildTeslaPartnerCorpusArtifact(
      "/tmp/tesla-electronics-partner-dataset-2026-03-12.json",
      {
        products: [
          {
            title: "TESLA Sound EB20",
            officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
            partnerMatches: [
              {
                partner: "alza",
                partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
              },
              {
                partner: "alza",
                partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
              },
              {
                partner: "datart",
                partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
              },
            ],
            strictPartnerMatches: [
              {
                partner: "alza",
                partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
              },
            ],
          },
        ],
      },
      false,
    );

    expect(artifact.selectedPageCount).toBe(2);
    expect(artifact.selectedSiteCount).toBe(2);
    expect(artifact.pages).toEqual([
      {
        siteId: "alza-cz",
        domain: "alza.cz",
        kind: "retailer",
        state: "healthy",
        url: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
        pageType: "product",
        title: "TESLA Sound EB20",
        challengeSignals: [],
      },
      {
        siteId: "datart-cz",
        domain: "datart.cz",
        kind: "retailer",
        state: "healthy",
        url: "https://www.datart.cz/tesla-sound-eb20.html",
        pageType: "product",
        title: "TESLA Sound EB20",
        challengeSignals: [],
      },
    ]);
  });

  it("deduplicates corpus pages by normalized partner URL rather than raw URL spelling", () => {
    const artifact = buildTeslaPartnerCorpusArtifact(
      "/tmp/tesla-electronics-partner-dataset-2026-03-12.json",
      {
        products: [
          {
            title: "TESLA Sound EB20",
            officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
            partnerMatches: [
              {
                partner: "alza",
                partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm?utm_source=foo",
              },
              {
                partner: "alza",
                partnerUrl: "https://alza.cz/tesla-sound-eb20-d7915352.htm",
              },
            ],
          },
        ],
      },
      false,
    );

    expect(artifact.selectedPageCount).toBe(1);
    expect(artifact.selectedSiteCount).toBe(1);
  });

  it("fails closed in strict mode when legacy-compatible inputs lack strict partner matches", () => {
    expect(() =>
      buildTeslaPartnerCorpusArtifact(
        "/tmp/tesla-electronics-partner-dataset-2026-03-12.strict.json",
        {
          products: [
            {
              officialTitle: "TESLA Sound EB20",
              officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
              partnerMatches: [
                {
                  partner: "alza",
                  partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
                },
              ],
            },
          ],
        },
        true,
      ),
    ).toThrow("Strict Tesla dataset benchmark produced no partner pages");
  });

  it("excludes strict-ineligible products from strict corpus fallback when strict matches are missing", () => {
    const loaded = loadTeslaCompatibleDataset(
      {
        generatedAt: "2026-03-12T06:00:00.000Z",
        source: {
          officialCatalog: "https://eshop.tesla-electronics.eu/sitemap?products=true&page=1",
          partnerDiscovery: ["https://search.seznam.cz/"],
          partnerDomains: [
            {
              partner: "alza",
              domain: "www.alza.cz",
            },
            {
              partner: "datart",
              domain: "www.datart.cz",
            },
          ],
        },
        summary: {
          productCount: 2,
          partnerUrlCount: 2,
          strictProductCount: 1,
          strictPartnerUrlCount: 1,
        },
        products: [
          {
            title: "TESLA Sound EB20",
            officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
            modelTokens: ["eb20"],
            officialIsAccessory: false,
            partnerMatches: [
              {
                partner: "alza",
                partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
              },
            ],
            strictEligible: false,
          },
          {
            title: "TESLA Sound EB20 Plus",
            officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20-plus",
            modelTokens: ["eb20plus"],
            officialIsAccessory: false,
            partnerMatches: [
              {
                partner: "datart",
                partnerUrl: "https://www.datart.cz/tesla-sound-eb20-plus.html",
              },
            ],
            strictPartnerMatches: [
              {
                partner: "datart",
                partnerUrl: "https://www.datart.cz/tesla-sound-eb20-plus.html",
              },
            ],
            strictEligible: true,
          },
        ],
      },
      { strict: true },
    );

    const artifact = buildTeslaPartnerCorpusArtifact(
      "/tmp/tesla-electronics-partner-dataset-2026-03-12.strict.json",
      loaded.dataset,
      true,
    );

    expect(artifact.selectedPageCount).toBe(1);
    expect(artifact.pages).toEqual([
      {
        siteId: "datart-cz",
        domain: "datart.cz",
        kind: "retailer",
        state: "healthy",
        url: "https://www.datart.cz/tesla-sound-eb20-plus.html",
        pageType: "product",
        title: "TESLA Sound EB20 Plus",
        challengeSignals: [],
      },
    ]);
    expect(
      loaded.diagnostics.some(
        (diagnostic) => diagnostic.code === "strict-fallback-partner-matches",
      ),
    ).toBe(false);
  });

  it("fails closed when strict-ready products provide an empty strict partner list", () => {
    expect(() =>
      loadTeslaCompatibleDataset(
        {
          generatedAt: "2026-03-12T06:00:00.000Z",
          source: {
            officialCatalog: "https://eshop.tesla-electronics.eu/sitemap?products=true&page=1",
            partnerDiscovery: ["https://search.seznam.cz/"],
            partnerDomains: [
              {
                partner: "datart",
                domain: "www.datart.cz",
              },
            ],
          },
          summary: {
            productCount: 1,
            partnerUrlCount: 1,
            strictProductCount: 1,
            strictPartnerUrlCount: 0,
          },
          products: [
            {
              title: "TESLA Sound EB20",
              officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
              modelTokens: ["eb20"],
              officialIsAccessory: false,
              partnerMatches: [
                {
                  partner: "datart",
                  partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
                },
              ],
              strictPartnerMatches: [],
              strictEligible: true,
            },
          ],
        },
        { strict: true },
      ),
    ).toThrow(
      "Strict Tesla dataset benchmarking requires strict-ready partner matches; partnerMatches fallback is not allowed in --strict mode.",
    );
  });

  it("fails fast on unknown partner identifiers", () => {
    const invalidDataset = {
      products: [
        {
          title: "TESLA New Partner Product",
          officialUrl: "https://eshop.tesla-electronics.eu/tesla-new-partner-product",
          partnerMatches: [
            {
              partner: "novy-partner",
              partnerUrl: "https://shop.example.cz/tesla-new-partner-product",
            },
          ],
        },
      ],
    };

    expect(() =>
      Reflect.apply(buildTeslaPartnerCorpusArtifact, undefined, [
        "/tmp/tesla-electronics-partner-dataset-2026-03-12.json",
        invalidDataset,
        false,
      ]),
    ).toThrow();
  });

  it("fails fast when a partner URL domain does not match the declared partner", () => {
    expect(() =>
      buildTeslaPartnerCorpusArtifact(
        "/tmp/tesla-electronics-partner-dataset-2026-03-12.json",
        {
          products: [
            {
              title: "TESLA Sound EB20",
              officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
              partnerMatches: [
                {
                  partner: "alza",
                  partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
                },
              ],
            },
          ],
        },
        false,
      ),
    ).toThrow(
      'Tesla dataset partner "alza" expected one of alza.cz but received "datart.cz" from "https://www.datart.cz/tesla-sound-eb20.html".',
    );
  });

  it("prefers the newest full dataset by default and the newest strict dataset in strict mode", () => {
    const candidates = [
      "tesla-electronics-partner-dataset-2026-03-10.json",
      "tesla-electronics-partner-dataset-2026-03-11.strict.json",
      "tesla-electronics-partner-dataset-2026-03-12.json",
      "tesla-electronics-partner-dataset-2026-03-12.strict.json",
    ];

    expect(selectPreferredTeslaDatasetFile(candidates, false)).toBe(
      "tesla-electronics-partner-dataset-2026-03-12.json",
    );
    expect(selectPreferredTeslaDatasetFile(candidates, true)).toBe(
      "tesla-electronics-partner-dataset-2026-03-12.strict.json",
    );
  });

  it("requires an actual strict dataset file when strict autodiscovery is requested", () => {
    const candidates = [
      "tesla-electronics-partner-dataset-2026-03-10.json",
      "tesla-electronics-partner-dataset-2026-03-12.json",
    ];

    expect(selectPreferredTeslaDatasetFile(candidates, true)).toBeUndefined();
  });

  it("rejects forwarded corpus equals overrides so the wrapper always owns corpus selection", async () => {
    await expect(
      runTeslaPartnerDatasetBenchmarkCli(["--corpus=/tmp/other-corpus.json"], {
        writeLine: () => undefined,
        writeProgressLine: () => undefined,
        setExitCode: () => undefined,
      }),
    ).rejects.toThrow(
      "Use --corpus-artifact for the generated corpus path. The wrapper manages --corpus internally.",
    );
  });

  it("accepts wrapper-owned dataset and corpus artifact flags in --flag=value form", async () => {
    let capturedArgs: readonly string[] | undefined;
    const outputLines: string[] = [];
    const tempDir = await mkdtemp(join(tmpdir(), "e9-tesla-partner-equals-flags-"));
    const datasetPath = join(tempDir, "dataset.json");
    const corpusArtifactPath = join(tempDir, "corpus.json");
    const benchmarkArtifactPath = join(tempDir, "benchmark.json");

    try {
      await Bun.write(
        datasetPath,
        JSON.stringify({
          generatedAt: "2026-03-12T06:00:00.000Z",
          source: {
            officialCatalog: "https://eshop.tesla-electronics.eu/sitemap?products=true&page=1",
            partnerDiscovery: ["https://search.seznam.cz/"],
            partnerDomains: [
              {
                partner: "datart",
                domain: "www.datart.cz",
              },
            ],
          },
          summary: {
            productCount: 1,
            partnerUrlCount: 1,
            strictProductCount: 1,
            strictPartnerUrlCount: 1,
          },
          products: [
            {
              title: "TESLA Sound EB20",
              officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
              modelTokens: ["eb20"],
              officialIsAccessory: false,
              partnerMatches: [
                {
                  partner: "datart",
                  partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
                },
              ],
              strictPartnerMatches: [
                {
                  partner: "datart",
                  partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
                },
              ],
              strictEligible: true,
            },
          ],
        }),
      );

      await runTeslaPartnerDatasetBenchmarkCli(
        [
          `--dataset=${datasetPath}`,
          `--corpus-artifact=${corpusArtifactPath}`,
          "--artifact",
          benchmarkArtifactPath,
          "--strict=true",
        ],
        {
          writeLine: (line) => {
            outputLines.push(line);
          },
          writeProgressLine: () => undefined,
          hasBundledWireproxyAssets: async () => false,
          runBenchmarkSuiteCli: async (args) => {
            capturedArgs = [...args];
            return makeStubBenchmarkArtifact(corpusArtifactPath, "pass");
          },
        },
      );

      expect(capturedArgs).toContain("--corpus");
      expect(capturedArgs).toContain(corpusArtifactPath);
      expect(capturedArgs).toContain("--preset");
      expect(capturedArgs).toContain("state-of-the-art");
      expect(capturedArgs).not.toContain("--strict=true");
      expect(JSON.parse(outputLines[0] ?? "{}").dataset.strict).toBe(true);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("forwards benchmark execution with a generated corpus", async () => {
    const lines: string[] = [];
    const progressLines: string[] = [];
    const exitCodes: number[] = [];
    const tempDir = await mkdtemp(join(tmpdir(), "e9-tesla-partner-forward-"));
    const datasetPath = join(tempDir, "dataset.json");
    const corpusArtifactPath = join(tempDir, "corpus.json");
    const benchmarkArtifactPath = join(tempDir, "benchmark.json");

    const runBenchmarkSuite = async (
      args: readonly string[],
    ): Promise<E9BenchmarkSuiteArtifact> => {
      expect(args).toContain("--corpus");
      expect(args).toContain("--artifact");
      return {
        benchmark: "e9-benchmark-suite",
        benchmarkId: "e9-benchmark-suite",
        generatedAt: "2026-03-12T12:00:00.000Z",
        corpus: {
          sourceArtifactPath: corpusArtifactPath,
          sourcePageCount: 2,
          sourceSiteCount: 2,
          selectedPageCount: 2,
          selectedSiteCount: 2,
          highFrictionPageCount: 0,
          pageTypeCounts: {
            product: 2,
            listing: 0,
            search: 0,
            offer: 0,
            unknown: 0,
          },
        },
        profiles: {
          available: [
            {
              profile: "effect-http",
              available: true,
            },
            {
              profile: "patchright-browser",
              available: true,
            },
          ],
          unavailable: [],
        },
        httpCorpus: {
          phase: "live-http-corpus",
          pageCount: 2,
          attempts: [
            {
              phase: "live-http-corpus",
              profile: "effect-http",
              concurrency: 1,
              siteId: "alza-cz",
              domain: "alza.cz",
              url: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
              pageType: "product",
              frictionClass: "low",
              expectedChallengeSignals: [],
              success: false,
              blocked: true,
              redirected: false,
              challengeDetected: true,
              observedChallengeSignals: [],
              durationMs: 100,
              contentBytes: 1000,
              titlePresent: false,
              timings: {
                totalWallMs: 100,
                overheadMs: 0,
              },
            },
          ],
          sweeps: [],
        },
        browserCorpus: {
          phase: "live-browser-corpus",
          pageCount: 2,
          attempts: [
            {
              phase: "live-browser-corpus",
              profile: "patchright-browser",
              concurrency: 1,
              siteId: "datart-cz",
              domain: "datart.cz",
              url: "https://www.datart.cz/tesla-sound-eb20.html",
              pageType: "product",
              frictionClass: "low",
              expectedChallengeSignals: [],
              success: true,
              blocked: false,
              redirected: false,
              challengeDetected: false,
              observedChallengeSignals: [],
              durationMs: 100,
              contentBytes: 1000,
              titlePresent: true,
              timings: {
                totalWallMs: 100,
                overheadMs: 0,
              },
            },
          ],
          sweeps: [],
        },
        scraplingParity: {
          skipped: true,
          totalWallMs: 0,
        },
        highFrictionCanary: {
          skipped: true,
          totalWallMs: 0,
        },
        summary: {
          executedPhases: ["http", "browser"],
          skippedPhases: ["scrapling", "canary"],
          sampled: false,
          totalAttemptCount: 2,
          totalSweepCount: 0,
          httpAttemptCount: 1,
          browserAttemptCount: 1,
          httpLocalFailureCount: 0,
          browserLocalFailureCount: 0,
          browserRemoteFailureCount: 1,
          browserRecoveredBrowserAllocationCount: 0,
          httpSuccessRate: 0,
          browserSuccessRate: 1,
          httpEffectiveSuccessRate: 0,
          browserEffectiveSuccessRate: 1,
          httpBestThroughputPagesPerMinute: 0,
          browserBestThroughputPagesPerMinute: 0,
          httpBestEffectiveThroughputPagesPerMinute: 0,
          browserBestEffectiveThroughputPagesPerMinute: 0,
          topHttpFailureDomains: [],
          topBrowserFailureDomains: [],
          topRemoteFailureDomains: [],
          topRemoteFailureCategories: [],
          topChallengeFailureDomains: [],
          topConsentFailureDomains: [],
          topTrapFailureDomains: [],
          topRateLimitFailureDomains: [],
          topBrowserFailureCategories: [],
          topBrowserRemoteFailureDomains: [],
          topBrowserRemoteFailureCategories: [],
          topLocalFailureCategories: [],
          topBrowserRecoveredAllocationDomains: [],
          topBrowserRecoveredAllocationProfiles: [],
        },
        warnings: [],
        recommendations: [],
        status: "pass" as const,
      };
    };

    try {
      await Bun.write(
        datasetPath,
        JSON.stringify({
          products: [
            {
              title: "TESLA Sound EB20",
              officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
              partnerMatches: [
                {
                  partner: "alza",
                  partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
                },
                {
                  partner: "datart",
                  partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
                },
              ],
            },
          ],
        }),
      );

      await runTeslaPartnerDatasetBenchmarkCli(
        [
          "--dataset",
          datasetPath,
          "--corpus-artifact",
          corpusArtifactPath,
          "--artifact",
          benchmarkArtifactPath,
        ],
        {
          writeLine: (line) => {
            lines.push(line);
          },
          writeProgressLine: (line) => {
            progressLines.push(line);
          },
          setExitCode: (code) => {
            exitCodes.push(code);
          },
          runBenchmarkSuiteCli: runBenchmarkSuite,
        },
      );

      expect(progressLines.length).toBe(0);
      expect(exitCodes).toEqual([]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"datasetPath"');
      expect(lines[0]).toContain('"httpBySite"');
      expect(lines[0]).toContain('"browserBySite"');
      expect(lines[0]).toContain('"coverage"');
      expect(lines[0]).toContain('"variant"');
      expect(lines[0]).toContain('"diagnostics"');
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("defaults the wrapper to the strongest Tesla benchmark strategy when no shape overrides are provided", async () => {
    let capturedArgs: readonly string[] | undefined;
    const tempDir = await mkdtemp(join(tmpdir(), "e9-tesla-partner-defaults-"));
    const datasetPath = join(tempDir, "dataset.json");
    const corpusArtifactPath = join(tempDir, "corpus.json");
    const benchmarkArtifactPath = join(tempDir, "benchmark.json");

    try {
      await Bun.write(
        datasetPath,
        JSON.stringify({
          products: [
            {
              title: "TESLA Sound EB20",
              officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
              partnerMatches: [
                {
                  partner: "alza",
                  partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
                },
              ],
            },
          ],
        }),
      );

      await runTeslaPartnerDatasetBenchmarkCli(
        [
          "--dataset",
          datasetPath,
          "--corpus-artifact",
          corpusArtifactPath,
          "--artifact",
          benchmarkArtifactPath,
        ],
        {
          writeLine: () => undefined,
          writeProgressLine: () => undefined,
          hasBundledWireproxyAssets: async () => true,
          runBenchmarkSuiteCli: async (args) => {
            capturedArgs = [...args];
            return makeStubBenchmarkArtifact(corpusArtifactPath, "pass");
          },
        },
      );

      expect(capturedArgs).toEqual([
        "--artifact",
        benchmarkArtifactPath,
        "--corpus",
        corpusArtifactPath,
        "--preset",
        "state-of-the-art",
        "--browser-concurrency",
        "8",
        "--browser-timeout",
        "180000",
        "--wireproxy-bundled",
        "--wireproxy-rotate",
        "--wireproxy-rotation-fallbacks",
        "7",
        "--wireproxy-transport",
        "http",
      ]);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("keeps the Tesla defaults when callers explicitly restate the state-of-the-art preset", async () => {
    let capturedArgs: readonly string[] | undefined;
    const tempDir = await mkdtemp(join(tmpdir(), "e9-tesla-partner-explicit-sota-"));
    const datasetPath = join(tempDir, "dataset.json");
    const corpusArtifactPath = join(tempDir, "corpus.json");
    const benchmarkArtifactPath = join(tempDir, "benchmark.json");

    try {
      await Bun.write(
        datasetPath,
        JSON.stringify({
          products: [
            {
              title: "TESLA Sound EB20",
              officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
              partnerMatches: [
                {
                  partner: "alza",
                  partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
                },
              ],
            },
          ],
        }),
      );

      await runTeslaPartnerDatasetBenchmarkCli(
        [
          "--dataset",
          datasetPath,
          "--corpus-artifact",
          corpusArtifactPath,
          "--artifact",
          benchmarkArtifactPath,
          "--preset",
          "state-of-the-art",
        ],
        {
          writeLine: () => undefined,
          writeProgressLine: () => undefined,
          hasBundledWireproxyAssets: async () => true,
          runBenchmarkSuiteCli: async (args) => {
            capturedArgs = [...args];
            return makeStubBenchmarkArtifact(corpusArtifactPath, "pass");
          },
        },
      );

      expect(capturedArgs).toEqual([
        "--artifact",
        benchmarkArtifactPath,
        "--preset",
        "state-of-the-art",
        "--corpus",
        corpusArtifactPath,
        "--browser-concurrency",
        "8",
        "--browser-timeout",
        "180000",
        "--wireproxy-bundled",
        "--wireproxy-rotate",
        "--wireproxy-rotation-fallbacks",
        "7",
        "--wireproxy-transport",
        "http",
      ]);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("keeps the recommended lane when callers only tune browser and wireproxy knobs", async () => {
    let capturedArgs: readonly string[] | undefined;
    const tempDir = await mkdtemp(join(tmpdir(), "e9-tesla-partner-tunables-"));
    const datasetPath = join(tempDir, "dataset.json");
    const corpusArtifactPath = join(tempDir, "corpus.json");
    const benchmarkArtifactPath = join(tempDir, "benchmark.json");

    try {
      await Bun.write(
        datasetPath,
        JSON.stringify({
          products: [
            {
              title: "TESLA Sound EB20",
              officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
              partnerMatches: [
                {
                  partner: "datart",
                  partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
                },
              ],
            },
          ],
        }),
      );

      await runTeslaPartnerDatasetBenchmarkCli(
        [
          "--dataset",
          datasetPath,
          "--corpus-artifact",
          corpusArtifactPath,
          "--artifact",
          benchmarkArtifactPath,
          "--browser-concurrency",
          "4",
          "--browser-timeout",
          "120000",
          "--http-concurrency",
          "4",
          "--wireproxy-rotation-fallbacks",
          "5",
        ],
        {
          writeLine: () => undefined,
          writeProgressLine: () => undefined,
          hasBundledWireproxyAssets: async () => true,
          runBenchmarkSuiteCli: async (args) => {
            capturedArgs = [...args];
            return makeStubBenchmarkArtifact(corpusArtifactPath, "pass");
          },
        },
      );

      expect(capturedArgs).toEqual([
        "--artifact",
        benchmarkArtifactPath,
        "--browser-concurrency",
        "4",
        "--browser-timeout",
        "120000",
        "--http-concurrency",
        "4",
        "--wireproxy-rotation-fallbacks",
        "5",
        "--corpus",
        corpusArtifactPath,
        "--preset",
        "state-of-the-art",
        "--wireproxy-bundled",
        "--wireproxy-rotate",
        "--wireproxy-transport",
        "http",
      ]);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("adds rotation defaults when callers only supply the wireproxy source", async () => {
    let capturedArgs: readonly string[] | undefined;
    const tempDir = await mkdtemp(join(tmpdir(), "e9-tesla-partner-wireproxy-source-"));
    const datasetPath = join(tempDir, "dataset.json");
    const corpusArtifactPath = join(tempDir, "corpus.json");
    const benchmarkArtifactPath = join(tempDir, "benchmark.json");

    try {
      await Bun.write(
        datasetPath,
        JSON.stringify({
          products: [
            {
              title: "TESLA Sound EB20",
              officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
              partnerMatches: [
                {
                  partner: "alza",
                  partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
                },
              ],
            },
          ],
        }),
      );

      await runTeslaPartnerDatasetBenchmarkCli(
        [
          "--dataset",
          datasetPath,
          "--corpus-artifact",
          corpusArtifactPath,
          "--artifact",
          benchmarkArtifactPath,
          "--wireproxy-bundled",
        ],
        {
          writeLine: () => undefined,
          writeProgressLine: () => undefined,
          hasBundledWireproxyAssets: async () => true,
          runBenchmarkSuiteCli: async (args) => {
            capturedArgs = [...args];
            return makeStubBenchmarkArtifact(corpusArtifactPath, "pass");
          },
        },
      );

      expect(capturedArgs).toEqual([
        "--artifact",
        benchmarkArtifactPath,
        "--wireproxy-bundled",
        "--corpus",
        corpusArtifactPath,
        "--preset",
        "state-of-the-art",
        "--browser-concurrency",
        "8",
        "--browser-timeout",
        "180000",
        "--wireproxy-rotate",
        "--wireproxy-rotation-fallbacks",
        "7",
        "--wireproxy-transport",
        "http",
      ]);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("fails closed when generated wireproxy metadata is supplied without a manifest or bundled source", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "e9-tesla-partner-generated-manifest-only-"));
    const datasetPath = join(tempDir, "dataset.json");
    const corpusArtifactPath = join(tempDir, "corpus.json");

    try {
      await Bun.write(
        datasetPath,
        JSON.stringify({
          products: [
            {
              title: "TESLA Sound EB20",
              officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
              partnerMatches: [
                {
                  partner: "alza",
                  partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
                },
              ],
            },
          ],
        }),
      );

      await expect(
        runTeslaPartnerDatasetBenchmarkCli(
          [
            "--dataset",
            datasetPath,
            "--corpus-artifact",
            corpusArtifactPath,
            "--wireproxy-generated-manifest",
            "/tmp/generated.json",
            "--preset",
            "competitor-calibration",
          ],
          {
            writeLine: () => undefined,
            writeProgressLine: () => undefined,
            setExitCode: () => undefined,
            hasBundledWireproxyAssets: async () => false,
          },
        ),
      ).rejects.toThrow(
        "Wireproxy generated metadata requires --wireproxy-manifest or --wireproxy-bundled to supply the actual proxy pool.",
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("normalizes source-only wireproxy overrides even when the benchmark shape is explicit", async () => {
    let capturedArgs: readonly string[] | undefined;
    const tempDir = await mkdtemp(join(tmpdir(), "e9-tesla-partner-explicit-wireproxy-source-"));
    const datasetPath = join(tempDir, "dataset.json");
    const corpusArtifactPath = join(tempDir, "corpus.json");
    const benchmarkArtifactPath = join(tempDir, "benchmark.json");

    try {
      await Bun.write(
        datasetPath,
        JSON.stringify({
          products: [
            {
              title: "TESLA Sound EB20",
              officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
              partnerMatches: [
                {
                  partner: "alza",
                  partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
                },
              ],
            },
          ],
        }),
      );

      await runTeslaPartnerDatasetBenchmarkCli(
        [
          "--dataset",
          datasetPath,
          "--corpus-artifact",
          corpusArtifactPath,
          "--artifact",
          benchmarkArtifactPath,
          "--preset",
          "competitor-calibration",
          "--wireproxy-bundled",
        ],
        {
          writeLine: () => undefined,
          writeProgressLine: () => undefined,
          hasBundledWireproxyAssets: async () => true,
          runBenchmarkSuiteCli: async (args) => {
            capturedArgs = [...args];
            return makeStubBenchmarkArtifact(corpusArtifactPath, "pass");
          },
        },
      );

      expect(capturedArgs).toEqual([
        "--artifact",
        benchmarkArtifactPath,
        "--preset",
        "competitor-calibration",
        "--wireproxy-bundled",
        "--corpus",
        corpusArtifactPath,
        "--wireproxy-rotate",
        "--wireproxy-rotation-fallbacks",
        "7",
        "--wireproxy-transport",
        "http",
      ]);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("preserves explicit benchmark shape overrides instead of forcing the Tesla defaults", async () => {
    let capturedArgs: readonly string[] | undefined;
    const tempDir = await mkdtemp(join(tmpdir(), "e9-tesla-partner-explicit-shape-"));
    const datasetPath = join(tempDir, "dataset.json");
    const corpusArtifactPath = join(tempDir, "corpus.json");
    const benchmarkArtifactPath = join(tempDir, "benchmark.json");

    try {
      await Bun.write(
        datasetPath,
        JSON.stringify({
          products: [
            {
              title: "TESLA Sound EB20",
              officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
              partnerMatches: [
                {
                  partner: "datart",
                  partnerUrl: "https://www.datart.cz/tesla-sound-eb20.html",
                },
              ],
            },
          ],
        }),
      );

      await runTeslaPartnerDatasetBenchmarkCli(
        [
          "--dataset",
          datasetPath,
          "--corpus-artifact",
          corpusArtifactPath,
          "--artifact",
          benchmarkArtifactPath,
          "--preset",
          "state-of-the-art",
          "--browser-profiles",
          "effect-browser",
        ],
        {
          writeLine: () => undefined,
          writeProgressLine: () => undefined,
          hasBundledWireproxyAssets: async () => true,
          runBenchmarkSuiteCli: async (args) => {
            capturedArgs = [...args];
            return makeStubBenchmarkArtifact(corpusArtifactPath, "pass");
          },
        },
      );

      expect(capturedArgs).toEqual([
        "--artifact",
        benchmarkArtifactPath,
        "--browser-profiles",
        "effect-browser",
        "--corpus",
        corpusArtifactPath,
      ]);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("marks the process failed when the underlying benchmark fails", async () => {
    const exitCodes: number[] = [];
    const tempDir = await mkdtemp(join(tmpdir(), "e9-tesla-partner-fail-"));
    const datasetPath = join(tempDir, "dataset.json");
    const corpusArtifactPath = join(tempDir, "corpus.json");

    try {
      await Bun.write(
        datasetPath,
        JSON.stringify({
          products: [
            {
              title: "TESLA Sound EB20",
              officialUrl: "https://eshop.tesla-electronics.eu/tesla-sound-eb20",
              partnerMatches: [
                {
                  partner: "alza",
                  partnerUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
                },
              ],
            },
          ],
        }),
      );

      await runTeslaPartnerDatasetBenchmarkCli(
        ["--dataset", datasetPath, "--corpus-artifact", corpusArtifactPath],
        {
          setExitCode: (code) => {
            exitCodes.push(code);
          },
          writeLine: () => undefined,
          writeProgressLine: () => undefined,
          runBenchmarkSuiteCli: async () => makeStubBenchmarkArtifact(corpusArtifactPath, "fail"),
        },
      );

      expect(exitCodes).toEqual([1]);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
