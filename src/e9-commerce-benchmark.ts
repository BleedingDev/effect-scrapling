import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect, Schema } from "effect";
import { detectAccessWall } from "./sdk/access-wall-detection.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeNumberSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const UnitIntervalSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);
const SiteKindSchema = Schema.Literals(["retailer", "aggregator"] as const);
const AccessModeSchema = Schema.Literals(["http", "browser"] as const);
const DiscoverySourceSchema = Schema.Literals(["sitemap", "homepage", "seed", "fallback"] as const);
const DiscoveryPageTypeSchema = Schema.Literals([
  "product",
  "listing",
  "search",
  "offer",
  "unknown",
] as const);
const SiteBenchmarkStateSchema = Schema.Literals([
  "healthy",
  "partial",
  "degraded",
  "unreachable",
] as const);

const BenchmarkSiteSchema = Schema.Struct({
  siteId: NonEmptyStringSchema,
  domain: NonEmptyStringSchema,
  displayName: NonEmptyStringSchema,
  kind: SiteKindSchema,
  seedUrls: Schema.Array(NonEmptyStringSchema),
  sitemapUrls: Schema.Array(NonEmptyStringSchema),
});

const ProbeResultSchema = Schema.Struct({
  url: NonEmptyStringSchema,
  mode: AccessModeSchema,
  statusCode: Schema.optional(PositiveIntSchema),
  durationMs: Schema.optional(NonNegativeNumberSchema),
  finalUrl: Schema.optional(NonEmptyStringSchema),
  ok: Schema.Boolean,
  contentType: Schema.optional(NonEmptyStringSchema),
  htmlBytes: Schema.optional(NonNegativeIntSchema),
  title: Schema.optional(NonEmptyStringSchema),
  challengeSignals: Schema.Array(NonEmptyStringSchema),
  error: Schema.optional(NonEmptyStringSchema),
});

const DiscoveryPageSchema = Schema.Struct({
  url: NonEmptyStringSchema,
  source: DiscoverySourceSchema,
  pageType: DiscoveryPageTypeSchema,
  selected: Schema.Boolean,
  title: Schema.optional(NonEmptyStringSchema),
  hasJsonLdProduct: Schema.Boolean,
  challengeSignals: Schema.Array(NonEmptyStringSchema),
});

const SiteDiscoverySummarySchema = Schema.Struct({
  siteId: NonEmptyStringSchema,
  domain: NonEmptyStringSchema,
  kind: SiteKindSchema,
  state: SiteBenchmarkStateSchema,
  homepageHttp: ProbeResultSchema,
  homepageBrowser: ProbeResultSchema,
  sitemapCount: NonNegativeIntSchema,
  discoveredUrlCount: NonNegativeIntSchema,
  selectedPageCount: NonNegativeIntSchema,
  selectedProductCount: NonNegativeIntSchema,
  selectedListingCount: NonNegativeIntSchema,
  selectedSearchCount: NonNegativeIntSchema,
  selectedOfferCount: NonNegativeIntSchema,
  pages: Schema.Array(DiscoveryPageSchema),
});

export const E9CommerceDiscoveryArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e9-commerce-discovery"),
  generatedAt: Schema.String,
  targetSiteCount: PositiveIntSchema,
  targetPagesPerSite: PositiveIntSchema,
  targetPageCount: PositiveIntSchema,
  selectedPageCount: NonNegativeIntSchema,
  selectionCoverage: UnitIntervalSchema,
  sites: Schema.Array(SiteDiscoverySummarySchema),
});

type BenchmarkSite = Schema.Schema.Type<typeof BenchmarkSiteSchema>;
export type E9CommerceDiscoveryProgressEvent =
  | {
      readonly kind: "suite-start";
      readonly generatedAt: string;
      readonly totalSites: number;
      readonly targetPagesPerSite: number;
      readonly siteConcurrency: number;
      readonly httpOnly: boolean;
      readonly siteCatalogPath: string;
    }
  | {
      readonly kind: "site-start";
      readonly generatedAt: string;
      readonly siteOrdinal: number;
      readonly totalSites: number;
      readonly siteId: string;
      readonly domain: string;
      readonly targetPagesPerSite: number;
      readonly httpOnly: boolean;
    }
  | {
      readonly kind: "site-complete";
      readonly generatedAt: string;
      readonly siteOrdinal: number;
      readonly completedSites: number;
      readonly totalSites: number;
      readonly siteId: string;
      readonly domain: string;
      readonly state: Schema.Schema.Type<typeof SiteBenchmarkStateSchema>;
      readonly discoveredUrlCount: number;
      readonly selectedPageCount: number;
      readonly elapsedMs: number;
      readonly etaMs: number;
      readonly homepageHttpOk: boolean;
      readonly homepageBrowserOk: boolean;
    }
  | {
      readonly kind: "suite-complete";
      readonly generatedAt: string;
      readonly totalSites: number;
      readonly selectedPageCount: number;
      readonly selectionCoverage: number;
      readonly totalWallMs: number;
      readonly degradedSiteCount: number;
      readonly unreachableSiteCount: number;
    };

type E9CommerceDiscoveryProgressListener = (event: E9CommerceDiscoveryProgressEvent) => void;

function emitProgress(
  listener: E9CommerceDiscoveryProgressListener | undefined,
  event: E9CommerceDiscoveryProgressEvent,
) {
  if (listener === undefined) {
    return;
  }

  try {
    listener(event);
  } catch {
    // Discovery progress is best-effort and must not abort the benchmark.
  }
}

const XML_CONTENT_TYPES = ["application/xml", "text/xml"];
const HTML_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];
const EXCLUDED_URL_PATTERNS = [
  "/blog",
  "/magazin",
  "/magazine",
  "/faq",
  "/kontakt",
  "/contact",
  "/privacy",
  "/gdpr",
  "/terms",
  "/podminky",
  "/kariera",
  "/career",
  "/prodejna",
  "/stores",
  "/o-nas",
  "/about",
  "/help",
  "/support",
  "/poradna",
  "/recenze",
  "/reviews",
  "/wp-",
  "/tag/",
];
const MAX_SITEMAP_URLS_PER_SITE = 2_048;
const MAX_HOMEPAGE_URLS_PER_SITE = 512;
const PAGE_PROBE_CONCURRENCY = 4;

type DiscoveryProfile = {
  readonly extraSeedUrls?: ReadonlyArray<string>;
  readonly productUrlPatterns?: ReadonlyArray<RegExp>;
  readonly listingUrlPatterns?: ReadonlyArray<RegExp>;
  readonly searchUrlPatterns?: ReadonlyArray<RegExp>;
  readonly offerUrlPatterns?: ReadonlyArray<RegExp>;
};

type HtmlFetchSuccess = {
  readonly ok: true;
  readonly statusCode: number;
  readonly finalUrl: string;
  readonly contentType?: string;
  readonly durationMs: number;
  readonly html: string;
  readonly htmlBytes: number;
  readonly title?: string;
};

type HtmlFetchFailure = {
  readonly ok: false;
  readonly durationMs: number;
  readonly error: string;
};

type HtmlFetchResult = HtmlFetchSuccess | HtmlFetchFailure;

const SITE_DISCOVERY_PROFILES: Readonly<Record<string, DiscoveryProfile>> = {
  "alza-cz": {
    extraSeedUrls: [
      "https://www.alza.cz/tesla-smart-air-purifier-s300w-d7911946.htm",
      "https://www.alza.cz/tesla-smart-fan-f500-d7911947.htm",
      "https://www.alza.cz/tesla-smart-heater-h300-d7911948.htm",
      "https://www.alza.cz/tesla-smart-humidifier-h100-d7911949.htm",
      "https://www.alza.cz/elektro/",
      "https://www.alza.cz/vyhledavani.htm?exps=tesla",
    ],
    productUrlPatterns: [/\/[^/]+-d\d+\.htm$/u],
    listingUrlPatterns: [/\/elektro\/?$/u, /\/levne-/u],
    searchUrlPatterns: [/\/vyhledavani\.htm/u, /[?&]exps=/u],
  },
  "datart-cz": {
    extraSeedUrls: [
      "https://www.datart.cz/cisticka-vzduchu-tesla-smart-air-purifier-s200b-cerna.html",
      "https://www.datart.cz/cisticka-vzduchu-tesla-smart-ar300-bila.html",
      "https://www.datart.cz/odvlhcovac-tesla-smart-dehumidifier-d400.html",
      "https://www.datart.cz/male-domaci-spotrebice.html",
      "https://www.datart.cz/vyhledavani.html?query=tesla",
    ],
    productUrlPatterns: [/\/[^/?]*\d[^/?]*\.html$/u],
    listingUrlPatterns: [
      /\/(?:male-domaci-spotrebice|velke-domaci-spotrebice|tv-audio-video|telefony|pocitace-tablety)\.html$/u,
      /\/[^/]+\.html\?sort=/u,
      /\/[^/]+\/?$/u,
    ],
    searchUrlPatterns: [/vyhledav/u, /[?&](query|q)=/u],
  },
  "tsbohemia-cz": {
    extraSeedUrls: [
      "https://www.tsbohemia.cz/tesla-te-300_d341842",
      "https://www.tsbohemia.cz/tesla-te-310_d341843",
      "https://www.tsbohemia.cz/tesla-te-320_d341844",
      "https://www.tsbohemia.cz/elektro-c2591/",
      "https://www.tsbohemia.cz/vyhledavani?Search=tesla",
    ],
    productUrlPatterns: [/_[dc]\d+$/u, /_d\d+$/u],
    listingUrlPatterns: [/-c\d+\/?$/u],
    searchUrlPatterns: [/vyhledav/u, /[?&]search=/u],
  },
  "heureka-cz": {
    extraSeedUrls: [
      "https://mobilni-telefony.heureka.cz/",
      "https://televize.heureka.cz/",
      "https://sluchatka.heureka.cz/",
      "https://www.heureka.cz/?h%5Bfraze%5D=tesla",
    ],
    listingUrlPatterns: [/^[^?]*\/$/u],
    searchUrlPatterns: [/[?&]h%5bfraze%5d=/u, /[?&]fraze=/u],
    offerUrlPatterns: [/\/[^/]+\/$/u],
  },
  "zbozi-cz": {
    extraSeedUrls: [
      "https://www.zbozi.cz/elektronika/",
      "https://www.zbozi.cz/telefony-navigace/mobilni-telefony/",
      "https://www.zbozi.cz/elektronika/tv-a-audio-video/audio/bluetooth-reproduktory/",
      "https://www.zbozi.cz/?q=tesla",
    ],
    listingUrlPatterns: [/^\/[^?]+\/$/u, /[?&]vyrobce=/u, /^\/kategorie\/?$/u],
    searchUrlPatterns: [/[?&]q=/u, /vyhled/u],
    offerUrlPatterns: [/\/vyrobek\//u, /\/obchod\//u],
  },
  "mironet-cz": {
    extraSeedUrls: [
      "https://www.mironet.cz/playstation-5-pro-2tb+dp780477/",
      "https://www.mironet.cz/adata-legend-710-512gb-ssd-m2-2280-pcie-gen-3-cteni-2400mbps-zapis-1800mbps+dp646970/",
      "https://www.mironet.cz/pocitace-a-notebooky+rzn10761/",
      "https://www.mironet.cz/ProductList/showSearch?EXPS=91414195+or+91411391+or+91418202",
    ],
    productUrlPatterns: [/\+dp\d+\/?$/u],
    listingUrlPatterns: [/\+rzn\d+\/?$/u, /\+c\d+\/?$/u, /\/vyprodej\/?$/u, /\/akcni-nabidky\/?$/u],
    searchUrlPatterns: [/productlist\/showsearch/u, /productlist\/remember/u],
  },
  "glami-cz": {
    extraSeedUrls: [
      "https://www.glami.cz/adidas/",
      "https://www.glami.cz/panska-obuv/",
      "https://www.glami.cz/obleceni-a-obuv/",
      "https://www.glami.cz/slunecni-bryle/",
      "https://www.glami.cz/dziny/siroky-strih/",
      "https://www.glami.cz/mikiny/oversized/",
      "https://www.glami.cz/svetry/polo-limec/",
      "https://www.glami.cz/tenisky/adidas-samba/",
    ],
    productUrlPatterns: [/\/p\/\d+/u],
    listingUrlPatterns: [/^\/[^?]+\/$/u, /\/c\//u, /\/znacky\/?$/u],
    searchUrlPatterns: [/[?&]q=/u, /vyhled/u],
  },
  "biano-cz": {
    productUrlPatterns: [/\/produkt\//u, /\/shop\//u],
    listingUrlPatterns: [/^\/produkty(?:\/|$)/u, /\/compare-products\/?$/u],
    searchUrlPatterns: [/[?&]q=/u, /vyhled/u],
  },
  "aboutyou-cz": {
    productUrlPatterns: [/\/p\/[^/]+\/\d+$/u],
    listingUrlPatterns: [/^\/c\//u, /^\/hub\//u, /^\/znacka/u],
    searchUrlPatterns: [/^\/s\//u, /[?&]term=/u],
  },
  "astratex-cz": {
    productUrlPatterns: [/\/[^/]+-p-\d+$/u],
    listingUrlPatterns: [/^\/[^?]+\/$/u, /\/vyprodej\/?$/u],
    searchUrlPatterns: [/[?&]search=/u, /vyhled/u],
  },
  "bonami-cz": {
    productUrlPatterns: [/\/p\/[^/]+$/u, /\/produkt\//u],
    listingUrlPatterns: [/^\/c\//u, /^\/[^?]+\/$/u],
    searchUrlPatterns: [/[?&]q=/u, /vyhled/u],
  },
  "muziker-cz": {
    extraSeedUrls: [
      "https://muziker.cz/kytary",
      "https://muziker.cz/lp-desky",
      "https://muziker.cz/s/8ba2d716a5",
      "https://muziker.cz/slevy-a-akce",
    ],
    listingUrlPatterns: [/^\/(?:kytary|lp-desky|slevy-a-akce|rozbaleno|vyhodne-sety)\/?$/u],
    searchUrlPatterns: [/^\/s\//u, /[?&]q=/u],
  },
  "pilulka-cz": {
    extraSeedUrls: [
      "https://pilulka.cz/akce-a-slevy",
      "https://pilulka.cz/doplnky-stravy",
      "https://pilulka.cz/volne-prodejne-leky",
      "https://pilulka.cz/na-imunitu",
    ],
    listingUrlPatterns: [
      /^\/(?:akce-a-slevy|doplnky-stravy|volne-prodejne-leky|na-imunitu|traveni-a-metabolismus|energie-a-vitalita)\/?$/u,
    ],
    searchUrlPatterns: [/vyhled/u, /[?&](search|q)=/u],
  },
  "electroworld-cz": {
    productUrlPatterns: [/\/[^/]+\.html$/u],
    listingUrlPatterns: [/^\/[^?]+\/$/u],
    searchUrlPatterns: [/vyhledav/u, /[?&]q=/u],
  },
  "sportisimo-cz": {
    extraSeedUrls: [
      "https://www.sportisimo.cz/boty/",
      "https://www.sportisimo.cz/obleceni/",
      "https://www.sportisimo.cz/vybaveni/",
      "https://www.sportisimo.cz/hledat/?q=tesla",
    ],
    listingUrlPatterns: [/^\/(?:boty|obleceni|vybaveni)\/?$/u],
    searchUrlPatterns: [/\/hledat\/?/u, /[?&]q=/u],
  },
  "fourhome-cz": {
    extraSeedUrls: [
      "https://www.4home.cz/bytovy-textil/",
      "https://www.4home.cz/povleceni/",
      "https://www.4home.cz/kuchyne-a-jidelna/",
      "https://www.4home.cz/hledani/?string=tesla",
    ],
    listingUrlPatterns: [/^\/(?:bytovy-textil|povleceni|kuchyne-a-jidelna)\/?$/u],
    searchUrlPatterns: [/\/hledan/i, /[?&](q|string)=/u],
  },
  "bauhaus-cz": {
    extraSeedUrls: [
      "https://www.bauhaus.cz/sortiment",
      "https://www.bauhaus.cz/sortiment/naradi-a-stroje",
      "https://www.bauhaus.cz/sortiment/zahrada-a-volny-cas",
      "https://www.bauhaus.cz/search?q=tesla",
    ],
    productUrlPatterns: [/\/p\/[^/?]+/u],
    listingUrlPatterns: [/^\/sortiment(?:\/|$)/u],
    searchUrlPatterns: [/\/search/u, /[?&]q=/u],
  },
  "lidl-shop-cz": {
    extraSeedUrls: [
      "https://www.lidl-shop.cz/c/domacnost/s10067705",
      "https://www.lidl-shop.cz/c/kuchyne-a-jidelna/s10067706",
      "https://www.lidl-shop.cz/c/elektro/s10067709",
      "https://www.lidl-shop.cz/q/search?q=tesla",
    ],
    productUrlPatterns: [/\/p\/[^/?]+\/p\d+/u],
    listingUrlPatterns: [/^\/c\/[^/?]+/u],
    searchUrlPatterns: [/\/q\/search/u, /[?&]q=/u],
  },
  "ikea-cz": {
    extraSeedUrls: [
      "https://www.ikea.com/cz/cs/cat/nabytek-fu001/",
      "https://www.ikea.com/cz/cs/cat/postele-bm003/",
      "https://www.ikea.com/cz/cs/cat/kuchyne-ka002/",
      "https://www.ikea.com/cz/cs/search/?q=tesla",
    ],
    productUrlPatterns: [/\/p\/[^/?]+-\d+\/?$/u],
    listingUrlPatterns: [/\/cat\/[^/?]+/u],
    searchUrlPatterns: [/\/search\/?/u, /[?&]q=/u],
  },
  "ebay-com": {
    extraSeedUrls: [
      "https://www.ebay.com/sch/i.html?_nkw=tesla",
      "https://www.ebay.com/b/Electronics/bn_7000259124",
      "https://www.ebay.com/b/Home-Garden/11700/bn_1853126",
    ],
    productUrlPatterns: [/\/itm\//u],
    listingUrlPatterns: [/\/b\/[^/?]+/u],
    searchUrlPatterns: [/\/sch\/i\.html/u, /[?&]_nkw=/u],
    offerUrlPatterns: [/\/itm\//u],
  },
  "aboutyou-sk": {
    productUrlPatterns: [/\/p\/[^/]+\/\d+$/u],
    listingUrlPatterns: [/^\/c\//u, /^\/hub\//u, /^\/znacka/u],
    searchUrlPatterns: [/^\/s\//u, /[?&]term=/u],
  },
  "boozt-com": {
    productUrlPatterns: [/\/[a-z0-9-]+\/[a-z0-9-]+_[a-z0-9]+\/\d+/u, /\/product\//u],
    listingUrlPatterns: [/^\/[a-z]{2}\/[a-z]{2}\/(?:women|men|kids|home)\/?/u],
    searchUrlPatterns: [/\/search/u, /[?&]q=/u],
  },
  "asos-com": {
    productUrlPatterns: [/\/prd\/\d+/u],
    listingUrlPatterns: [/\/(?:men|women|search)\/?/u],
    searchUrlPatterns: [/\/search\/?/u, /[?&]q=/u],
  },
  "shein-com": {
    productUrlPatterns: [/\/[^/?]+-p-\d+\.html/u],
    listingUrlPatterns: [/\/(?:cat|trend|campaigns)-/u],
    searchUrlPatterns: [/\/pdsearch\//u, /[?&]keyword=/u],
  },
  "jysk-cz": {
    extraSeedUrls: [
      "https://jysk.cz/home",
      "https://jysk.cz/loznice",
      "https://jysk.cz/loznice/matrace",
      "https://jysk.cz/obyvaci-pokoj",
      "https://jysk.cz/zahrada",
      "https://jysk.cz/search?query=matrace",
    ],
    listingUrlPatterns: [
      /^\/(?:home|loznice|obyvaci-pokoj|zahrada|koupelna|kancelar|ulozne-prostory)(?:\/|$)/u,
    ],
    searchUrlPatterns: [/\/search/u, /[?&](query|q)=/u],
  },
};

const DEFAULT_SITE_CATALOG = Schema.decodeUnknownSync(Schema.Array(BenchmarkSiteSchema))([
  {
    siteId: "alza-cz",
    domain: "alza.cz",
    displayName: "Alza",
    kind: "retailer",
    seedUrls: ["https://www.alza.cz/"],
    sitemapUrls: ["https://www.alza.cz/sitemap.xml"],
  },
  {
    siteId: "datart-cz",
    domain: "datart.cz",
    displayName: "Datart",
    kind: "retailer",
    seedUrls: ["https://www.datart.cz/"],
    sitemapUrls: ["https://www.datart.cz/sitemap.xml"],
  },
  {
    siteId: "tsbohemia-cz",
    domain: "tsbohemia.cz",
    displayName: "TS Bohemia",
    kind: "retailer",
    seedUrls: ["https://www.tsbohemia.cz/"],
    sitemapUrls: ["https://www.tsbohemia.cz/sitemap.xml"],
  },
  {
    siteId: "heureka-cz",
    domain: "heureka.cz",
    displayName: "Heureka",
    kind: "aggregator",
    seedUrls: ["https://www.heureka.cz/"],
    sitemapUrls: ["https://www.heureka.cz/sitemap.xml"],
  },
  {
    siteId: "zbozi-cz",
    domain: "zbozi.cz",
    displayName: "Zbozi",
    kind: "aggregator",
    seedUrls: ["https://www.zbozi.cz/"],
    sitemapUrls: ["https://www.zbozi.cz/sitemap.xml"],
  },
  {
    siteId: "smarty-cz",
    domain: "smarty.cz",
    displayName: "Smarty",
    kind: "retailer",
    seedUrls: ["https://www.smarty.cz/"],
    sitemapUrls: ["https://www.smarty.cz/sitemap.xml"],
  },
  {
    siteId: "planeo-cz",
    domain: "planeo.cz",
    displayName: "Planeo",
    kind: "retailer",
    seedUrls: ["https://www.planeo.cz/"],
    sitemapUrls: ["https://www.planeo.cz/sitemap.xml"],
  },
  {
    siteId: "mironet-cz",
    domain: "mironet.cz",
    displayName: "Mironet",
    kind: "retailer",
    seedUrls: ["https://www.mironet.cz/"],
    sitemapUrls: ["https://www.mironet.cz/sitemap.xml"],
  },
  {
    siteId: "notino-cz",
    domain: "notino.cz",
    displayName: "Notino",
    kind: "retailer",
    seedUrls: ["https://www.notino.cz/"],
    sitemapUrls: ["https://www.notino.cz/sitemap.xml"],
  },
  {
    siteId: "muziker-cz",
    domain: "muziker.cz",
    displayName: "Muziker",
    kind: "retailer",
    seedUrls: ["https://www.muziker.cz/"],
    sitemapUrls: ["https://www.muziker.cz/sitemap.xml"],
  },
  {
    siteId: "pilulka-cz",
    domain: "pilulka.cz",
    displayName: "Pilulka",
    kind: "retailer",
    seedUrls: ["https://www.pilulka.cz/"],
    sitemapUrls: ["https://www.pilulka.cz/sitemap.xml"],
  },
  {
    siteId: "drmax-cz",
    domain: "drmax.cz",
    displayName: "Dr.Max",
    kind: "retailer",
    seedUrls: ["https://www.drmax.cz/"],
    sitemapUrls: ["https://www.drmax.cz/sitemap.xml"],
  },
  {
    siteId: "favi-cz",
    domain: "favi.cz",
    displayName: "Favi",
    kind: "aggregator",
    seedUrls: ["https://favi.cz/"],
    sitemapUrls: ["https://favi.cz/sitemap.xml"],
  },
  {
    siteId: "biano-cz",
    domain: "biano.cz",
    displayName: "Biano",
    kind: "aggregator",
    seedUrls: ["https://www.biano.cz/"],
    sitemapUrls: ["https://www.biano.cz/sitemap.xml"],
  },
  {
    siteId: "glami-cz",
    domain: "glami.cz",
    displayName: "Glami",
    kind: "aggregator",
    seedUrls: ["https://www.glami.cz/"],
    sitemapUrls: ["https://www.glami.cz/sitemap.xml"],
  },
  {
    siteId: "allegro-cz",
    domain: "allegro.cz",
    displayName: "Allegro",
    kind: "retailer",
    seedUrls: ["https://allegro.cz/"],
    sitemapUrls: ["https://allegro.cz/sitemap.xml"],
  },
  {
    siteId: "iwant-cz",
    domain: "iwant.cz",
    displayName: "iWant",
    kind: "retailer",
    seedUrls: ["https://www.iwant.cz/"],
    sitemapUrls: ["https://www.iwant.cz/sitemap.xml"],
  },
  {
    siteId: "mobilpohotovost-cz",
    domain: "mobilpohotovost.cz",
    displayName: "Mobil Pohotovost",
    kind: "retailer",
    seedUrls: ["https://www.mobilpohotovost.cz/"],
    sitemapUrls: ["https://www.mobilpohotovost.cz/sitemap.xml"],
  },
  {
    siteId: "rohlik-cz",
    domain: "rohlik.cz",
    displayName: "Rohlik",
    kind: "retailer",
    seedUrls: ["https://www.rohlik.cz/"],
    sitemapUrls: ["https://www.rohlik.cz/sitemap.xml"],
  },
  {
    siteId: "okay-cz",
    domain: "okay.cz",
    displayName: "OKAY",
    kind: "retailer",
    seedUrls: ["https://www.okay.cz/"],
    sitemapUrls: ["https://www.okay.cz/sitemap.xml"],
  },
  {
    siteId: "aboutyou-cz",
    domain: "aboutyou.cz",
    displayName: "About You",
    kind: "retailer",
    seedUrls: ["https://www.aboutyou.cz/"],
    sitemapUrls: ["https://www.aboutyou.cz/sitemap.xml"],
  },
  {
    siteId: "astratex-cz",
    domain: "astratex.cz",
    displayName: "Astratex",
    kind: "retailer",
    seedUrls: ["https://www.astratex.cz/"],
    sitemapUrls: ["https://www.astratex.cz/sitemap.xml"],
  },
  {
    siteId: "bonami-cz",
    domain: "bonami.cz",
    displayName: "Bonami",
    kind: "retailer",
    seedUrls: ["https://www.bonami.cz/"],
    sitemapUrls: ["https://www.bonami.cz/sitemap.xml"],
  },
  {
    siteId: "electroworld-cz",
    domain: "electroworld.cz",
    displayName: "Electroworld",
    kind: "retailer",
    seedUrls: ["https://www.electroworld.cz/"],
    sitemapUrls: ["https://www.electroworld.cz/sitemap.xml"],
  },
]);

function decodeTitle(html: string) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/iu);
  return match?.[1]?.replace(/\s+/gu, " ").trim() || undefined;
}

function collectChallengeSignals(input: {
  readonly statusCode?: number | undefined;
  readonly requestedUrl?: string | undefined;
  readonly finalUrl?: string | undefined;
  readonly title?: string | undefined;
  readonly text?: string | undefined;
}) {
  const analysis = detectAccessWall({
    statusCode: input.statusCode,
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    title: input.title,
    text: input.text?.slice(0, 12_000),
  });
  return analysis.likelyAccessWall ? analysis.signals : [];
}

function isSameDomain(url: URL, domain: string) {
  return url.hostname === domain || url.hostname.endsWith(`.${domain}`);
}

function isAllowedUrl(url: URL, domain: string) {
  if (!isSameDomain(url, domain)) {
    return false;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return false;
  }

  const href = url.toString().toLowerCase();
  return !EXCLUDED_URL_PATTERNS.some((pattern) => href.includes(pattern));
}

function compareStrings(left: string, right: string) {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function getUrlPathAndSearch(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function getDiscoveryProfile(siteId: string) {
  return SITE_DISCOVERY_PROFILES[siteId];
}

export function classifyE9DiscoveryUrl(siteId: string, url: string) {
  const lowerPathAndSearch = getUrlPathAndSearch(url);
  const profile = getDiscoveryProfile(siteId);
  if (profile !== undefined) {
    if (profile.searchUrlPatterns?.some((pattern) => pattern.test(lowerPathAndSearch))) {
      return "search" as const;
    }

    if (profile.offerUrlPatterns?.some((pattern) => pattern.test(lowerPathAndSearch))) {
      return "offer" as const;
    }

    if (profile.productUrlPatterns?.some((pattern) => pattern.test(lowerPathAndSearch))) {
      return "product" as const;
    }

    if (profile.listingUrlPatterns?.some((pattern) => pattern.test(lowerPathAndSearch))) {
      return "listing" as const;
    }
  }

  if (
    lowerPathAndSearch.includes("search") ||
    lowerPathAndSearch.includes("vyhled") ||
    lowerPathAndSearch.includes("?q=") ||
    lowerPathAndSearch.includes("&q=") ||
    lowerPathAndSearch.includes("?s=")
  ) {
    return "search" as const;
  }

  return undefined;
}

function hasStrongListingSignals(pathAndSearch: string, html: string) {
  const linkCount = html.match(/<a\s/giu)?.length ?? 0;
  const priceSignalCount = html.match(/\b(?:kč|czk|€|eur)\b/giu)?.length ?? 0;
  const structuredListCount = html.match(/"itemlist"|schema\.org\/itemlist/giu)?.length ?? 0;
  return (
    structuredListCount > 0 ||
    (linkCount >= 24 && priceSignalCount >= 3) ||
    pathAndSearch.includes("/c/") ||
    pathAndSearch.includes("/produkty/") ||
    pathAndSearch.includes("/kategorie/")
  );
}

export function classifyE9PageType(
  siteId: string,
  url: string,
  html: string,
  kind: Schema.Schema.Type<typeof SiteKindSchema>,
) {
  const lowerPathAndSearch = getUrlPathAndSearch(url);
  const lowerHtml = html.toLowerCase();
  const hintedPageType = classifyE9DiscoveryUrl(siteId, url);
  const hasJsonLdProduct =
    lowerHtml.includes('"@type":"product"') ||
    lowerHtml.includes('"@type": "product"') ||
    lowerHtml.includes("schema.org/product");
  const listingSignals = hasStrongListingSignals(lowerPathAndSearch, html);

  if (hintedPageType === "search") {
    return { pageType: "search" as const, hasJsonLdProduct };
  }

  if (kind === "aggregator" && hintedPageType === "offer") {
    return { pageType: "offer" as const, hasJsonLdProduct };
  }

  if (hintedPageType === "product") {
    return { pageType: "product" as const, hasJsonLdProduct };
  }

  if (hintedPageType === "listing" && !hasJsonLdProduct) {
    return { pageType: "listing" as const, hasJsonLdProduct };
  }

  if (hasJsonLdProduct && !listingSignals && hintedPageType !== "listing") {
    return { pageType: "product" as const, hasJsonLdProduct: true };
  }

  if (
    kind === "aggregator" &&
    (lowerPathAndSearch.includes("produkt") ||
      lowerPathAndSearch.includes("nabidk") ||
      lowerHtml.includes("nabídek") ||
      lowerHtml.includes("merchant") ||
      lowerHtml.includes("prodejc"))
  ) {
    return { pageType: "offer" as const, hasJsonLdProduct };
  }

  if (listingSignals || hintedPageType === "listing") {
    return { pageType: "listing" as const, hasJsonLdProduct };
  }

  return { pageType: "unknown" as const, hasJsonLdProduct };
}

async function fetchHtml(url: string, headers?: HeadersInit) {
  const startedAt = performance.now();
  const signal = AbortSignal.timeout(12_000);

  try {
    const response = await fetch(
      url,
      headers === undefined
        ? {
            redirect: "follow",
            signal,
          }
        : {
            redirect: "follow",
            headers,
            signal,
          },
    );
    const html = await response.text();
    const durationMs = Number((performance.now() - startedAt).toFixed(3));
    return {
      ok: response.ok,
      statusCode: response.status,
      finalUrl: response.url,
      contentType: response.headers.get("content-type") ?? undefined,
      durationMs,
      html,
      htmlBytes: Buffer.byteLength(html, "utf8"),
    } as const;
  } catch (cause) {
    const durationMs = Number((performance.now() - startedAt).toFixed(3));
    return {
      ok: false,
      durationMs,
      error:
        (typeof cause === "object" || typeof cause === "function") && cause !== null
          ? typeof Reflect.get(cause, "message") === "string"
            ? String(Reflect.get(cause, "message"))
            : String(cause)
          : String(cause),
    } as const;
  }
}

async function fetchHtmlWithBrowser(url: string): Promise<HtmlFetchResult> {
  const patchrightModuleName = "patchright";
  try {
    const loaded = await import(patchrightModuleName);
    const chromium = Reflect.get(loaded, "chromium");
    if (typeof chromium !== "object" || chromium === null) {
      return {
        ok: false,
        durationMs: 0,
        error: "Patchright chromium export is unavailable.",
      };
    }

    const launch = Reflect.get(chromium, "launch");
    if (typeof launch !== "function") {
      return {
        ok: false,
        durationMs: 0,
        error: "Patchright chromium.launch is unavailable.",
      };
    }

    const startedAt = performance.now();
    const browser = await launch.call(chromium, { headless: true });
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.route(
          "**/*",
          (route: {
            readonly request: () => { readonly resourceType: () => string };
            readonly abort: () => Promise<void>;
            readonly continue: () => Promise<void>;
          }) => {
            const resourceType = route.request().resourceType();
            if (
              resourceType === "image" ||
              resourceType === "font" ||
              resourceType === "media" ||
              resourceType === "stylesheet"
            ) {
              return route.abort();
            }

            return route.continue();
          },
        );
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 12_000,
        });
        const html = await page.content();
        const title = await page.title();
        const durationMs = Number((performance.now() - startedAt).toFixed(3));
        return {
          ok: response?.ok() ?? html.length > 0,
          statusCode: response?.status() ?? 200,
          durationMs,
          finalUrl: page.url(),
          contentType: response?.headers()["content-type"],
          html,
          htmlBytes: Buffer.byteLength(html, "utf8"),
          title: title.trim() === "" ? undefined : title.trim(),
        };
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  } catch (cause) {
    return {
      ok: false,
      durationMs: 0,
      error:
        (typeof cause === "object" || typeof cause === "function") && cause !== null
          ? typeof Reflect.get(cause, "message") === "string"
            ? String(Reflect.get(cause, "message"))
            : String(cause)
          : String(cause),
    };
  }
}

async function fetchSitemapUrls(site: BenchmarkSite) {
  const visited = new Set<string>();
  const discovered = new Set<string>();
  const queue = [...site.sitemapUrls];

  while (queue.length > 0 && visited.size < 20 && discovered.size < MAX_SITEMAP_URLS_PER_SITE) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) {
      continue;
    }

    visited.add(current);
    const result = await fetchHtml(current, {
      accept: "application/xml,text/xml;q=0.9,text/html;q=0.8,*/*;q=0.5",
    });
    if (!result.ok || result.contentType === undefined) {
      continue;
    }

    const isXml = XML_CONTENT_TYPES.some((entry) => result.contentType?.includes(entry));
    if (!isXml) {
      continue;
    }

    const locMatches = result.html.matchAll(/<loc>([^<]+)<\/loc>/giu);
    for (const match of locMatches) {
      if (discovered.size >= MAX_SITEMAP_URLS_PER_SITE) {
        break;
      }

      const rawUrl = match[1]?.trim();
      if (rawUrl === undefined || rawUrl === "") {
        continue;
      }

      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        continue;
      }

      if (!isSameDomain(parsed, site.domain)) {
        continue;
      }

      if (
        basename(parsed.pathname).toLowerCase().includes("sitemap") ||
        parsed.pathname.toLowerCase().includes("/sitemap")
      ) {
        if (!visited.has(parsed.toString())) {
          queue.push(parsed.toString());
        }
        continue;
      }

      if (isAllowedUrl(parsed, site.domain)) {
        discovered.add(parsed.toString());
      }
    }
  }

  return [...discovered];
}

function extractHomepageUrls(site: BenchmarkSite, html: string, baseUrl: string) {
  const hrefMatches = html.matchAll(/href=["']([^"'#]+)["']/giu);
  const discovered = new Set<string>();
  for (const match of hrefMatches) {
    if (discovered.size >= MAX_HOMEPAGE_URLS_PER_SITE) {
      break;
    }

    const href = match[1]?.trim();
    if (href === undefined || href === "") {
      continue;
    }

    try {
      const parsed = new URL(href, baseUrl);
      if (isAllowedUrl(parsed, site.domain)) {
        discovered.add(parsed.toString());
      }
    } catch {
      continue;
    }
  }

  return discovered;
}

async function discoverHomepageUrls(
  site: BenchmarkSite,
  homepageHttpFetch: Awaited<ReturnType<typeof fetchHtml>>,
  homepageBrowserFetch: HtmlFetchResult,
) {
  const discovered = new Set<string>();

  if (homepageHttpFetch.ok) {
    const baseUrl = homepageHttpFetch.finalUrl ?? site.seedUrls[0] ?? `https://${site.domain}/`;
    for (const url of extractHomepageUrls(site, homepageHttpFetch.html, baseUrl)) {
      discovered.add(url);
      if (discovered.size >= MAX_HOMEPAGE_URLS_PER_SITE) {
        return [...discovered];
      }
    }
  }

  if (homepageBrowserFetch.ok) {
    for (const url of extractHomepageUrls(
      site,
      homepageBrowserFetch.html,
      homepageBrowserFetch.finalUrl,
    )) {
      discovered.add(url);
      if (discovered.size >= MAX_HOMEPAGE_URLS_PER_SITE) {
        break;
      }
    }
  }

  return [...discovered];
}

function prioritizeUrl(url: string) {
  const lowerUrl = getUrlPathAndSearch(url);
  let score = 0;
  if (lowerUrl.includes("produkt") || lowerUrl.includes("product")) {
    score += 6;
  }
  if (lowerUrl.includes("zbozi") || lowerUrl.includes("item")) {
    score += 4;
  }
  if (lowerUrl.includes("search") || lowerUrl.includes("vyhled")) {
    score += 3;
  }
  if (lowerUrl.includes("kategorie") || lowerUrl.includes("category")) {
    score += 2;
  }
  if (/\d{4,}/u.test(lowerUrl)) {
    score += 3;
  }
  if (lowerUrl.endsWith(".html") || lowerUrl.endsWith(".htm")) {
    score += 2;
  }
  return score;
}

function buildFetchPlan(
  site: BenchmarkSite,
  candidateUrls: ReadonlyArray<string>,
  targetPagesPerSite: number,
) {
  const orderedUrls = [...candidateUrls].sort(
    (left, right) => prioritizeUrl(right) - prioritizeUrl(left) || compareStrings(left, right),
  );
  const pageTypeBuckets: Record<
    Schema.Schema.Type<typeof DiscoveryPageTypeSchema>,
    Array<string>
  > = {
    product: [],
    listing: [],
    search: [],
    offer: [],
    unknown: [],
  };
  const bucketLimits = {
    product: Math.max(targetPagesPerSite * 3, 16),
    listing: Math.max(targetPagesPerSite * 2, 12),
    search: Math.max(targetPagesPerSite, 8),
    offer: Math.max(targetPagesPerSite * 2, 12),
    unknown: Math.max(targetPagesPerSite, 8),
  } as const;

  for (const url of orderedUrls) {
    const hintedPageType = classifyE9DiscoveryUrl(site.siteId, url) ?? "unknown";
    const bucket = pageTypeBuckets[hintedPageType];
    if (bucket.length < bucketLimits[hintedPageType]) {
      bucket.push(url);
    }
  }

  const fetchPlan = [
    ...pageTypeBuckets.product,
    ...pageTypeBuckets.listing,
    ...pageTypeBuckets.search,
    ...pageTypeBuckets.offer,
    ...pageTypeBuckets.unknown,
  ];

  return [...new Set(fetchPlan)].slice(0, Math.max(targetPagesPerSite * 2, 32));
}

async function mapWithConcurrency<Input, Output>(
  entries: ReadonlyArray<Input>,
  concurrency: number,
  mapEntry: (entry: Input, index: number) => Promise<Output>,
) {
  const outputs = Array.from({ length: entries.length }) as Output[];
  let index = 0;
  const workerCount = Math.max(1, Math.min(concurrency, entries.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < entries.length) {
        const nextIndex = index;
        index += 1;
        const entry = entries[nextIndex];
        if (entry === undefined) {
          continue;
        }

        outputs[nextIndex] = await mapEntry(entry, nextIndex);
      }
    }),
  );

  return outputs;
}

async function buildDiscoveryPages(
  site: BenchmarkSite,
  candidateUrls: ReadonlyArray<string>,
  targetPagesPerSite: number,
  allowBrowserFallback: boolean,
) {
  const orderedUrls = buildFetchPlan(site, candidateUrls, targetPagesPerSite);
  const httpResults = await mapWithConcurrency(orderedUrls, PAGE_PROBE_CONCURRENCY, async (url) => {
    const result = await fetchHtml(url, {
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    });
    if (!result.ok || result.contentType === undefined) {
      return undefined;
    }

    const isHtml = HTML_CONTENT_TYPES.some((entry) => result.contentType?.includes(entry));
    if (!isHtml) {
      return undefined;
    }

    const { pageType, hasJsonLdProduct } = classifyE9PageType(
      site.siteId,
      url,
      result.html,
      site.kind,
    );
    return Schema.decodeUnknownSync(DiscoveryPageSchema)({
      url,
      source: "sitemap",
      pageType,
      selected: false,
      title: decodeTitle(result.html),
      hasJsonLdProduct,
      challengeSignals: collectChallengeSignals({
        statusCode: result.statusCode,
        requestedUrl: url,
        finalUrl: result.finalUrl,
        title: decodeTitle(result.html),
        text: result.html,
      }),
    });
  });
  const pages = httpResults.flatMap((page) => (page === undefined ? [] : [page]));

  if (allowBrowserFallback && pages.length < targetPagesPerSite) {
    const missingUrls = orderedUrls.filter((url) => pages.every((page) => page.url !== url));
    const fallbackUrls = missingUrls.slice(
      0,
      Math.min(Math.max(targetPagesPerSite - pages.length, 8), 12),
    );
    const browserCandidates = await mapWithConcurrency(fallbackUrls, 2, async (url) => {
      const result = await fetchHtmlWithBrowser(url);
      if (!result.ok) {
        return undefined;
      }

      const isHtml = HTML_CONTENT_TYPES.some(
        (entry) => result.contentType?.includes(entry) ?? false,
      );
      if (!isHtml) {
        return undefined;
      }

      const { pageType, hasJsonLdProduct } = classifyE9PageType(
        site.siteId,
        result.finalUrl,
        result.html,
        site.kind,
      );
      return Schema.decodeUnknownSync(DiscoveryPageSchema)({
        url: result.finalUrl,
        source: "fallback",
        pageType,
        selected: false,
        title: result.title ?? decodeTitle(result.html),
        hasJsonLdProduct,
        challengeSignals: collectChallengeSignals({
          statusCode: result.statusCode,
          requestedUrl: url,
          finalUrl: result.finalUrl,
          title: result.title ?? decodeTitle(result.html),
          text: result.html,
        }),
      });
    });

    for (const page of browserCandidates) {
      if (page !== undefined && pages.every((entry) => entry.url !== page.url)) {
        pages.push(page);
      }
    }
  }

  const selected = new Set<string>();
  const selectByType = (
    pageType: Schema.Schema.Type<typeof DiscoveryPageTypeSchema>,
    count: number,
  ) => {
    for (const page of pages) {
      if (selected.size >= targetPagesPerSite) {
        return;
      }
      if (page.pageType === pageType && !selected.has(page.url)) {
        selected.add(page.url);
        if (selected.size >= count) {
          return;
        }
      }
    }
  };

  selectByType("product", Math.min(targetPagesPerSite, Math.max(targetPagesPerSite - 8, 16)));
  selectByType("listing", Math.min(targetPagesPerSite, selected.size + 4));
  selectByType("search", Math.min(targetPagesPerSite, selected.size + 2));
  selectByType("offer", Math.min(targetPagesPerSite, selected.size + 4));

  for (const page of pages) {
    if (selected.size >= targetPagesPerSite) {
      break;
    }
    if (!selected.has(page.url)) {
      selected.add(page.url);
    }
  }

  return pages.map((page) =>
    Schema.decodeUnknownSync(DiscoveryPageSchema)({
      ...page,
      selected: selected.has(page.url),
    }),
  );
}

function getSeedUrls(site: BenchmarkSite) {
  const profile = getDiscoveryProfile(site.siteId);
  return [...site.seedUrls, ...(profile?.extraSeedUrls ?? [])];
}

async function buildSiteSummary(
  site: BenchmarkSite,
  targetPagesPerSite: number,
  httpOnly: boolean,
) {
  const homepageUrl = getSeedUrls(site)[0] ?? `https://${site.domain}/`;
  const homepageHttpFetch = await fetchHtml(homepageUrl, {
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  });
  const homepageHttp = Schema.decodeUnknownSync(ProbeResultSchema)({
    url: homepageUrl,
    mode: "http",
    statusCode: homepageHttpFetch.statusCode,
    durationMs: homepageHttpFetch.durationMs,
    finalUrl: homepageHttpFetch.finalUrl,
    ok: homepageHttpFetch.ok,
    contentType: homepageHttpFetch.contentType,
    htmlBytes: homepageHttpFetch.htmlBytes,
    title:
      homepageHttpFetch.ok && "html" in homepageHttpFetch
        ? decodeTitle(homepageHttpFetch.html)
        : undefined,
    challengeSignals:
      "html" in homepageHttpFetch
        ? collectChallengeSignals({
            statusCode: homepageHttpFetch.statusCode,
            requestedUrl: homepageUrl,
            finalUrl: homepageHttpFetch.finalUrl,
            title: decodeTitle(homepageHttpFetch.html),
            text: homepageHttpFetch.html,
          })
        : [],
    error: "error" in homepageHttpFetch ? homepageHttpFetch.error : undefined,
  });
  const homepageBrowserFetch = httpOnly
    ? ({ ok: false, durationMs: 0, error: "Skipped by http-only discovery mode." } as const)
    : await fetchHtmlWithBrowser(homepageUrl);
  const homepageBrowser = homepageBrowserFetch.ok
    ? Schema.decodeUnknownSync(ProbeResultSchema)({
        url: homepageUrl,
        mode: "browser",
        statusCode: homepageBrowserFetch.statusCode,
        durationMs: homepageBrowserFetch.durationMs,
        finalUrl: homepageBrowserFetch.finalUrl,
        ok: homepageBrowserFetch.ok,
        contentType: homepageBrowserFetch.contentType,
        htmlBytes: homepageBrowserFetch.htmlBytes,
        title: homepageBrowserFetch.title,
        challengeSignals: collectChallengeSignals({
          statusCode: homepageBrowserFetch.statusCode,
          requestedUrl: homepageUrl,
          finalUrl: homepageBrowserFetch.finalUrl,
          title: homepageBrowserFetch.title,
          text: homepageBrowserFetch.html,
        }),
      })
    : Schema.decodeUnknownSync(ProbeResultSchema)({
        url: homepageUrl,
        mode: "browser",
        ok: false,
        durationMs: homepageBrowserFetch.durationMs,
        error: homepageBrowserFetch.error,
        challengeSignals: [],
      });

  const sitemapUrls = await fetchSitemapUrls(site);
  const homepageUrls = await discoverHomepageUrls(site, homepageHttpFetch, homepageBrowserFetch);
  const candidateUrls = [...new Set([...sitemapUrls, ...homepageUrls, ...getSeedUrls(site)])];
  const pages = await buildDiscoveryPages(
    site,
    candidateUrls,
    targetPagesPerSite,
    !httpOnly && homepageBrowser.ok,
  );
  const selectedPages = pages.filter(({ selected }) => selected);
  const selectedProductCount = selectedPages.filter(
    ({ pageType }) => pageType === "product",
  ).length;
  const selectedListingCount = selectedPages.filter(
    ({ pageType }) => pageType === "listing",
  ).length;
  const selectedSearchCount = selectedPages.filter(({ pageType }) => pageType === "search").length;
  const selectedOfferCount = selectedPages.filter(({ pageType }) => pageType === "offer").length;

  const state =
    selectedPages.length >= targetPagesPerSite && homepageBrowser.ok
      ? "healthy"
      : selectedPages.length >= Math.ceil(targetPagesPerSite / 2) ||
          homepageBrowser.ok ||
          homepageHttp.ok
        ? "partial"
        : candidateUrls.length > 0
          ? "degraded"
          : "unreachable";

  return Schema.decodeUnknownSync(SiteDiscoverySummarySchema)({
    siteId: site.siteId,
    domain: site.domain,
    kind: site.kind,
    state,
    homepageHttp,
    homepageBrowser,
    sitemapCount: sitemapUrls.length,
    discoveredUrlCount: candidateUrls.length,
    selectedPageCount: selectedPages.length,
    selectedProductCount,
    selectedListingCount,
    selectedSearchCount,
    selectedOfferCount,
    pages,
  });
}

export async function runE9CommerceDiscoveryBenchmark(
  options: {
    readonly targetPagesPerSite?: number;
    readonly generatedAt?: string;
    readonly siteCatalogPath?: string;
    readonly siteConcurrency?: number;
    readonly httpOnly?: boolean;
    readonly onProgress?: E9CommerceDiscoveryProgressListener;
  } = {},
) {
  const targetPagesPerSite = options.targetPagesPerSite ?? 32;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const siteConcurrency = options.siteConcurrency ?? 4;
  const httpOnly = options.httpOnly ?? false;
  const siteCatalog =
    options.siteCatalogPath === undefined
      ? DEFAULT_SITE_CATALOG
      : Schema.decodeUnknownSync(Schema.Array(BenchmarkSiteSchema))(
          JSON.parse(await readFile(options.siteCatalogPath, "utf8")),
        );
  const suiteStartedAt = performance.now();
  let completedSites = 0;
  const siteCatalogPath = options.siteCatalogPath ?? "default-site-catalog";
  emitProgress(options.onProgress, {
    kind: "suite-start",
    generatedAt,
    totalSites: siteCatalog.length,
    targetPagesPerSite,
    siteConcurrency,
    httpOnly,
    siteCatalogPath,
  });

  const sites = await mapWithConcurrency(siteCatalog, siteConcurrency, async (site, index) => {
    emitProgress(options.onProgress, {
      kind: "site-start",
      generatedAt,
      siteOrdinal: index + 1,
      totalSites: siteCatalog.length,
      siteId: site.siteId,
      domain: site.domain,
      targetPagesPerSite,
      httpOnly,
    });
    const siteSummary = await buildSiteSummary(site, targetPagesPerSite, httpOnly);
    completedSites += 1;
    const elapsedMs = performance.now() - suiteStartedAt;
    const etaMs =
      completedSites >= siteCatalog.length || completedSites === 0
        ? 0
        : (elapsedMs / completedSites) * (siteCatalog.length - completedSites);
    emitProgress(options.onProgress, {
      kind: "site-complete",
      generatedAt,
      siteOrdinal: index + 1,
      completedSites,
      totalSites: siteCatalog.length,
      siteId: site.siteId,
      domain: site.domain,
      state: siteSummary.state,
      discoveredUrlCount: siteSummary.discoveredUrlCount,
      selectedPageCount: siteSummary.selectedPageCount,
      elapsedMs: Math.round(elapsedMs * 1_000) / 1_000,
      etaMs: Math.round(etaMs * 1_000) / 1_000,
      homepageHttpOk: siteSummary.homepageHttp.ok,
      homepageBrowserOk: siteSummary.homepageBrowser.ok,
    });
    return siteSummary;
  });

  const selectedPageCount = sites.reduce((total, site) => total + site.selectedPageCount, 0);
  const targetPageCount = siteCatalog.length * targetPagesPerSite;
  const artifact = Schema.decodeUnknownSync(E9CommerceDiscoveryArtifactSchema)({
    benchmark: "e9-commerce-discovery",
    generatedAt,
    targetSiteCount: siteCatalog.length,
    targetPagesPerSite,
    targetPageCount,
    selectedPageCount,
    selectionCoverage: targetPageCount === 0 ? 0 : selectedPageCount / targetPageCount,
    sites,
  });
  emitProgress(options.onProgress, {
    kind: "suite-complete",
    generatedAt,
    totalSites: siteCatalog.length,
    selectedPageCount: artifact.selectedPageCount,
    selectionCoverage: artifact.selectionCoverage,
    totalWallMs: Math.round((performance.now() - suiteStartedAt) * 1_000) / 1_000,
    degradedSiteCount: artifact.sites.filter(({ state }) => state === "degraded").length,
    unreachableSiteCount: artifact.sites.filter(({ state }) => state === "unreachable").length,
  });
  return artifact;
}

export const runE9CommerceDiscoveryBenchmarkEffect = Effect.fn(
  "E9.runE9CommerceDiscoveryBenchmarkEffect",
)(function* (
  options: {
    readonly targetPagesPerSite?: number;
    readonly generatedAt?: string;
    readonly siteCatalogPath?: string;
    readonly siteConcurrency?: number;
    readonly httpOnly?: boolean;
    readonly onProgress?: E9CommerceDiscoveryProgressListener;
  } = {},
) {
  return yield* Effect.promise(() => runE9CommerceDiscoveryBenchmark(options));
});
