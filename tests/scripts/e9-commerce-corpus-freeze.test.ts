import { describe, expect, it } from "@effect-native/bun-test";
import {
  parseOptions,
  runDefaultE9CommerceCorpusFreeze,
} from "../../scripts/benchmarks/e9-commerce-corpus-freeze.ts";

describe("e9 commerce corpus freeze", () => {
  it("parses CLI options", () => {
    expect(
      parseOptions([
        "--source-artifact",
        "tmp/e9-commerce-discovery.json",
        "--artifact",
        "tmp/e9-commerce-corpus-freeze.json",
        "--target-pages",
        "640",
        "--minimum-sites",
        "20",
      ]),
    ).toEqual({
      artifactPath: "tmp/e9-commerce-corpus-freeze.json",
      sourceArtifactPath: "tmp/e9-commerce-discovery.json",
      targetPageCount: 640,
      minimumSiteCount: 20,
    });
  });

  it("rejects unsupported arguments", () => {
    expect(() => parseOptions(["--wat"])).toThrow("Unknown argument: --wat");
  });

  it("freezes a corpus and reports shortfall truthfully", async () => {
    const sourcePath = "tmp/e9-commerce-discovery-artifact-test.json";
    await Bun.write(
      sourcePath,
      JSON.stringify({
        benchmark: "e9-commerce-discovery",
        generatedAt: "2026-03-09T00:00:00.000Z",
        targetSiteCount: 2,
        targetPagesPerSite: 4,
        targetPageCount: 8,
        selectedPageCount: 5,
        selectionCoverage: 0.625,
        sites: [
          {
            siteId: "site-a",
            domain: "site-a.example",
            kind: "retailer",
            state: "healthy",
            homepageHttp: {
              url: "https://site-a.example/",
              mode: "http",
              statusCode: 200,
              durationMs: 25,
              finalUrl: "https://site-a.example/",
              ok: true,
              contentType: "text/html",
              htmlBytes: 1024,
              challengeSignals: [],
            },
            homepageBrowser: {
              url: "https://site-a.example/",
              mode: "browser",
              statusCode: 200,
              durationMs: 120,
              finalUrl: "https://site-a.example/",
              ok: true,
              contentType: "text/html",
              htmlBytes: 2048,
              challengeSignals: [],
            },
            sitemapCount: 2,
            discoveredUrlCount: 12,
            selectedPageCount: 3,
            selectedProductCount: 1,
            selectedListingCount: 1,
            selectedSearchCount: 1,
            selectedOfferCount: 0,
            pages: [
              {
                url: "https://site-a.example/product-1",
                source: "sitemap",
                pageType: "product",
                selected: true,
                title: "Product 1",
                hasJsonLdProduct: true,
                challengeSignals: [],
              },
              {
                url: "https://site-a.example/category",
                source: "homepage",
                pageType: "listing",
                selected: true,
                title: "Category",
                hasJsonLdProduct: false,
                challengeSignals: [],
              },
              {
                url: "https://site-a.example/search?q=product",
                source: "seed",
                pageType: "search",
                selected: true,
                title: "Search",
                hasJsonLdProduct: false,
                challengeSignals: [],
              },
            ],
          },
          {
            siteId: "site-b",
            domain: "site-b.example",
            kind: "aggregator",
            state: "partial",
            homepageHttp: {
              url: "https://site-b.example/",
              mode: "http",
              statusCode: 200,
              durationMs: 25,
              finalUrl: "https://site-b.example/",
              ok: true,
              contentType: "text/html",
              htmlBytes: 1024,
              challengeSignals: [],
            },
            homepageBrowser: {
              url: "https://site-b.example/",
              mode: "browser",
              statusCode: 200,
              durationMs: 120,
              finalUrl: "https://site-b.example/",
              ok: true,
              contentType: "text/html",
              htmlBytes: 2048,
              challengeSignals: [],
            },
            sitemapCount: 1,
            discoveredUrlCount: 8,
            selectedPageCount: 2,
            selectedProductCount: 0,
            selectedListingCount: 1,
            selectedSearchCount: 0,
            selectedOfferCount: 1,
            pages: [
              {
                url: "https://site-b.example/offer-1",
                source: "sitemap",
                pageType: "offer",
                selected: true,
                title: "Offer 1",
                hasJsonLdProduct: false,
                challengeSignals: ["merchant"],
              },
              {
                url: "https://site-b.example/listing",
                source: "homepage",
                pageType: "listing",
                selected: true,
                title: "Listing",
                hasJsonLdProduct: false,
                challengeSignals: [],
              },
            ],
          },
        ],
      }),
    );

    const artifact = await runDefaultE9CommerceCorpusFreeze({
      sourceArtifactPath: sourcePath,
      targetPageCount: 8,
      minimumSiteCount: 2,
    });

    expect(artifact.benchmark).toBe("e9-commerce-corpus-freeze");
    expect(artifact.selectedPageCount).toBe(5);
    expect(artifact.shortfallCount).toBe(3);
    expect(artifact.selectedSiteCount).toBe(2);
    expect(artifact.pages[0]?.pageType).toBe("product");
    expect(artifact.allocations).toEqual([
      expect.objectContaining({
        siteId: "site-a",
        allocatedPageCount: 3,
      }),
      expect.objectContaining({
        siteId: "site-b",
        allocatedPageCount: 2,
      }),
    ]);
  });
});
