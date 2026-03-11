import { describe, expect, it } from "@effect-native/bun-test";
import {
  classifyE9DiscoveryUrl,
  classifyE9PageType,
  type E9CommerceDiscoveryProgressEvent,
} from "../../src/e9-commerce-benchmark.ts";
import {
  formatE9CommerceDiscoveryProgressEvent,
  parseOptions,
  runDefaultE9CommerceDiscovery,
  runE9CommerceDiscoveryCli,
} from "../../scripts/benchmarks/e9-commerce-discovery.ts";

describe("e9 commerce discovery benchmark", () => {
  it("parses CLI options", () => {
    expect(
      parseOptions([
        "--artifact",
        "tmp/e9-commerce-discovery.json",
        "--pages-per-site",
        "8",
        "--site-catalog",
        "tmp/sites.json",
        "--site-concurrency",
        "6",
        "--http-only",
      ]),
    ).toEqual({
      artifactPath: "tmp/e9-commerce-discovery.json",
      targetPagesPerSite: 8,
      siteCatalogPath: "tmp/sites.json",
      siteConcurrency: 6,
      httpOnly: true,
    });
  });

  it("rejects unknown arguments", () => {
    expect(() => parseOptions(["--wat"])).toThrow("Unknown argument: --wat");
  });

  it("runs against a custom one-site catalog", async () => {
    const path = "tmp/e9-commerce-discovery-sites.json";
    await Bun.write(
      path,
      JSON.stringify([
        {
          siteId: "example-site",
          domain: "example.com",
          displayName: "Example",
          kind: "retailer",
          seedUrls: ["https://example.com/"],
          sitemapUrls: ["https://example.com/sitemap.xml"],
        },
      ]),
    );

    const artifact = await runDefaultE9CommerceDiscovery({
      targetPagesPerSite: 2,
      siteCatalogPath: path,
    });

    expect(artifact.benchmark).toBe("e9-commerce-discovery");
    expect(artifact.targetSiteCount).toBe(1);
    expect(artifact.targetPagesPerSite).toBe(2);
    expect(artifact.targetPageCount).toBe(2);
    expect(artifact.sites).toHaveLength(1);
    expect(artifact.sites[0]?.siteId).toBe("example-site");
  });

  it("emits live progress while discovering sites", async () => {
    const path = "tmp/e9-commerce-discovery-progress-sites.json";
    await Bun.write(
      path,
      JSON.stringify([
        {
          siteId: "example-site",
          domain: "example.com",
          displayName: "Example",
          kind: "retailer",
          seedUrls: ["https://example.com/"],
          sitemapUrls: ["https://example.com/sitemap.xml"],
        },
      ]),
    );
    const progressEvents = new Array<E9CommerceDiscoveryProgressEvent>();

    await runDefaultE9CommerceDiscovery(
      {
        targetPagesPerSite: 1,
        siteCatalogPath: path,
        siteConcurrency: 2,
        httpOnly: true,
      },
      {
        onProgress: (event) => {
          progressEvents.push(event);
        },
      },
    );

    expect(progressEvents[0]).toMatchObject({
      kind: "suite-start",
      totalSites: 1,
      targetPagesPerSite: 1,
      httpOnly: true,
    });
    expect(
      progressEvents.some(
        (event) =>
          event.kind === "site-start" && event.siteOrdinal === 1 && event.siteId === "example-site",
      ),
    ).toBe(true);
    expect(
      progressEvents.some(
        (event) =>
          event.kind === "site-complete" &&
          event.completedSites === 1 &&
          event.totalSites === 1 &&
          event.siteId === "example-site",
      ),
    ).toBe(true);
    expect(progressEvents.at(-1)).toMatchObject({
      kind: "suite-complete",
      totalSites: 1,
    });

    const lines = progressEvents.map((event) => formatE9CommerceDiscoveryProgressEvent(event));
    expect(
      lines.some((line) => line.includes("[progress:e9-commerce-discovery] site complete")),
    ).toBe(true);
    expect(lines.some((line) => line.includes('input_site="1/1"'))).toBe(true);
    expect(lines.some((line) => line.includes('completed_sites="1/1"'))).toBe(true);
  });

  it("swallows discovery progress sink failures", async () => {
    const path = "tmp/e9-commerce-discovery-progress-failure-sites.json";
    await Bun.write(
      path,
      JSON.stringify([
        {
          siteId: "example-site",
          domain: "example.com",
          displayName: "Example",
          kind: "retailer",
          seedUrls: ["https://example.com/"],
          sitemapUrls: ["https://example.com/sitemap.xml"],
        },
      ]),
    );

    const artifact = await runDefaultE9CommerceDiscovery(
      {
        targetPagesPerSite: 1,
        siteCatalogPath: path,
        siteConcurrency: 1,
        httpOnly: true,
      },
      {
        onProgress: () => {
          throw new Error("sink failed");
        },
      },
    );

    expect(artifact.benchmark).toBe("e9-commerce-discovery");
    expect(artifact.targetSiteCount).toBe(1);
  });

  it("writes discovery progress separately from the final CLI artifact", async () => {
    const outputLines = new Array<string>();
    const progressLines = new Array<string>();

    await runE9CommerceDiscoveryCli(["--artifact", "tmp/e9-commerce-discovery-cli.json"], {
      writeLine: (line) => {
        outputLines.push(line);
      },
      writeProgressLine: (line) => {
        progressLines.push(line);
      },
      runDiscovery: async (_options, dependencies) => {
        dependencies?.onProgress?.({
          kind: "suite-start",
          generatedAt: "2026-03-09T22:00:00.000Z",
          totalSites: 1,
          targetPagesPerSite: 2,
          siteConcurrency: 1,
          httpOnly: true,
          siteCatalogPath: "tmp/sites.json",
        });

        return {
          benchmark: "e9-commerce-discovery",
          generatedAt: "2026-03-09T22:00:00.000Z",
          targetSiteCount: 1,
          targetPagesPerSite: 2,
          targetPageCount: 2,
          selectedPageCount: 1,
          selectionCoverage: 0.5,
          sites: [
            {
              siteId: "example-site",
              domain: "example.com",
              kind: "retailer",
              state: "partial",
              homepageHttp: {
                url: "https://example.com/",
                mode: "http",
                statusCode: 200,
                durationMs: 10,
                finalUrl: "https://example.com/",
                ok: true,
                contentType: "text/html",
                htmlBytes: 512,
                title: "Example",
                challengeSignals: [],
              },
              homepageBrowser: {
                url: "https://example.com/",
                mode: "browser",
                ok: false,
                durationMs: 0,
                challengeSignals: [],
                error: "skipped",
              },
              sitemapCount: 1,
              discoveredUrlCount: 2,
              selectedPageCount: 1,
              selectedProductCount: 1,
              selectedListingCount: 0,
              selectedSearchCount: 0,
              selectedOfferCount: 0,
              pages: [
                {
                  url: "https://example.com/p/1",
                  source: "seed",
                  pageType: "product",
                  selected: true,
                  title: "Example Product",
                  hasJsonLdProduct: true,
                  challengeSignals: [],
                },
              ],
            },
          ],
        };
      },
    });

    expect(progressLines).toHaveLength(1);
    expect(progressLines[0]).toContain("[progress:e9-commerce-discovery] suite start");
    expect(outputLines).toHaveLength(1);
    expect(() => JSON.parse(outputLines[0] ?? "")).not.toThrow();
  });

  it("classifies site-specific URLs before generic fallback", () => {
    expect(
      classifyE9DiscoveryUrl(
        "mironet-cz",
        "https://www.mironet.cz/playstation-5-pro-2tb+dp780477/",
      ),
    ).toBe("product");
    expect(
      classifyE9DiscoveryUrl("mironet-cz", "https://www.mironet.cz/pocitace-a-notebooky+rzn10761/"),
    ).toBe("listing");
    expect(
      classifyE9DiscoveryUrl(
        "zbozi-cz",
        "https://www.zbozi.cz/telefony-navigace/mobilni-telefony/?vyrobce=apple",
      ),
    ).toBe("listing");
    expect(
      classifyE9DiscoveryUrl(
        "datart-cz",
        "https://www.datart.cz/cisticka-vzduchu-tesla-smart-air-purifier-s200b-cerna.html",
      ),
    ).toBe("product");
    expect(
      classifyE9DiscoveryUrl("datart-cz", "https://www.datart.cz/male-domaci-spotrebice.html"),
    ).toBe("listing");
    expect(classifyE9DiscoveryUrl("glami-cz", "https://www.glami.cz/adidas/")).toBe("listing");
    expect(
      classifyE9DiscoveryUrl(
        "ikea-cz",
        "https://www.ikea.com/cz/cs/p/billy-knihovna-bila-30263844/",
      ),
    ).toBe("product");
    expect(classifyE9DiscoveryUrl("ikea-cz", "https://www.ikea.com/cz/cs/search/?q=tesla")).toBe(
      "search",
    );
    expect(classifyE9DiscoveryUrl("ebay-com", "https://www.ebay.com/sch/i.html?_nkw=tesla")).toBe(
      "search",
    );
    expect(classifyE9DiscoveryUrl("fourhome-cz", "https://www.4home.cz/bytovy-textil/")).toBe(
      "listing",
    );
    expect(classifyE9DiscoveryUrl("jysk-cz", "https://jysk.cz/loznice")).toBe("listing");
    expect(classifyE9DiscoveryUrl("jysk-cz", "https://jysk.cz/search?query=matrace")).toBe(
      "search",
    );
  });

  it("does not let embedded product json-ld override strong listing signals", () => {
    const html = `
      <html>
        <head>
          <script type="application/ld+json">
            {"@context":"https://schema.org","@type":"ItemList","itemListElement":[{"@type":"Product","name":"A"},{"@type":"Product","name":"B"}]}
          </script>
        </head>
        <body>
          ${'<a href="/item">item</a>'.repeat(40)}
          ${"<span>1 999 Kč</span>".repeat(6)}
        </body>
      </html>
    `;

    expect(
      classifyE9PageType("astratex-cz", "https://www.astratex.cz/damske-pradlo/", html, "retailer"),
    ).toEqual({
      hasJsonLdProduct: true,
      pageType: "listing",
    });
  });

  it("lets explicit product URL hints win over generic listing signals", () => {
    const html = `
      <html>
        <body>
          ${'<a href="/item">item</a>'.repeat(48)}
          ${"<span>1 999 Kč</span>".repeat(10)}
        </body>
      </html>
    `;

    expect(
      classifyE9PageType(
        "mironet-cz",
        "https://www.mironet.cz/playstation-5-pro-2tb+dp780477/",
        html,
        "retailer",
      ),
    ).toEqual({
      hasJsonLdProduct: false,
      pageType: "product",
    });
  });
});
