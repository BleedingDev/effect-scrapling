import { describe, expect, it } from "@effect-native/bun-test";
import { classifyE9DiscoveryUrl, classifyE9PageType } from "../../src/e9-commerce-benchmark.ts";
import {
  parseOptions,
  runDefaultE9CommerceDiscovery,
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
