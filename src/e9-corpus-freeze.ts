import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Schema } from "effect";
import { E9CommerceDiscoveryArtifactSchema } from "./e9-commerce-benchmark.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const UnitIntervalSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);
const DiscoveryPageTypeSchema = Schema.Literals([
  "product",
  "listing",
  "search",
  "offer",
  "unknown",
] as const);
const SiteKindSchema = Schema.Literals(["retailer", "aggregator"] as const);
const SiteBenchmarkStateSchema = Schema.Literals([
  "healthy",
  "partial",
  "degraded",
  "unreachable",
] as const);

export const E9FrozenCorpusPageSchema = Schema.Struct({
  siteId: NonEmptyStringSchema,
  domain: NonEmptyStringSchema,
  kind: SiteKindSchema,
  state: SiteBenchmarkStateSchema,
  url: NonEmptyStringSchema,
  pageType: DiscoveryPageTypeSchema,
  title: Schema.optional(NonEmptyStringSchema),
  challengeSignals: Schema.Array(NonEmptyStringSchema),
});

export const E9FrozenCorpusAllocationSchema = Schema.Struct({
  siteId: NonEmptyStringSchema,
  domain: NonEmptyStringSchema,
  state: SiteBenchmarkStateSchema,
  kind: SiteKindSchema,
  availableSelectedPageCount: NonNegativeIntSchema,
  allocatedPageCount: NonNegativeIntSchema,
});

export const E9CommerceCorpusFreezeArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e9-commerce-corpus-freeze"),
  generatedAt: Schema.String,
  sourceArtifactPath: NonEmptyStringSchema,
  targetPageCount: PositiveIntSchema,
  selectedPageCount: NonNegativeIntSchema,
  selectedSiteCount: NonNegativeIntSchema,
  minimumSiteCount: PositiveIntSchema,
  siteCoverage: UnitIntervalSchema,
  pageCoverage: UnitIntervalSchema,
  shortfallCount: NonNegativeIntSchema,
  pages: Schema.Array(E9FrozenCorpusPageSchema),
  allocations: Schema.Array(E9FrozenCorpusAllocationSchema),
});

type DiscoveryArtifact = Schema.Schema.Type<typeof E9CommerceDiscoveryArtifactSchema>;
type FrozenPage = Schema.Schema.Type<typeof E9FrozenCorpusPageSchema>;

function compareStrings(left: string, right: string) {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function stateWeight(state: Schema.Schema.Type<typeof SiteBenchmarkStateSchema>) {
  switch (state) {
    case "healthy":
      return 4;
    case "partial":
      return 3;
    case "degraded":
      return 2;
    case "unreachable":
      return 1;
  }
}

function pageTypeWeight(pageType: Schema.Schema.Type<typeof DiscoveryPageTypeSchema>) {
  switch (pageType) {
    case "product":
      return 4;
    case "offer":
      return 3;
    case "listing":
      return 2;
    case "search":
      return 1;
    case "unknown":
      return 0;
  }
}

function normalizeDiscoveryPages(discoveryArtifact: DiscoveryArtifact) {
  return discoveryArtifact.sites
    .map((site) => {
      const selectedPages = site.pages
        .filter(({ selected }) => selected)
        .map((page) =>
          Schema.decodeUnknownSync(E9FrozenCorpusPageSchema)({
            siteId: site.siteId,
            domain: site.domain,
            kind: site.kind,
            state: site.state,
            url: page.url,
            pageType: page.pageType,
            title: page.title,
            challengeSignals: page.challengeSignals,
          }),
        )
        .sort(
          (left, right) =>
            pageTypeWeight(right.pageType) - pageTypeWeight(left.pageType) ||
            compareStrings(left.url, right.url),
        );

      return {
        siteId: site.siteId,
        domain: site.domain,
        state: site.state,
        kind: site.kind,
        selectedPages,
      };
    })
    .sort(
      (left, right) =>
        stateWeight(right.state) - stateWeight(left.state) ||
        right.selectedPages.length - left.selectedPages.length ||
        compareStrings(left.siteId, right.siteId),
    );
}

function allocateCorpusPages(
  discoveryArtifact: DiscoveryArtifact,
  targetPageCount: number,
  minimumSiteCount: number,
) {
  const normalizedSites = normalizeDiscoveryPages(discoveryArtifact);
  const selectedPages = new Array<FrozenPage>();
  const selectedUrls = new Set<string>();
  const selectedSiteIds = new Set<string>();
  const allocationCounts = new Map<string, number>();

  const tryAddPage = (page: FrozenPage) => {
    if (selectedPages.length >= targetPageCount || selectedUrls.has(page.url)) {
      return false;
    }

    selectedPages.push(page);
    selectedUrls.add(page.url);
    selectedSiteIds.add(page.siteId);
    allocationCounts.set(page.siteId, (allocationCounts.get(page.siteId) ?? 0) + 1);
    return true;
  };

  const prioritizedSites = normalizedSites.filter(({ selectedPages }) => selectedPages.length > 0);

  for (const site of prioritizedSites) {
    for (const pageType of ["product", "offer", "listing", "search", "unknown"] as const) {
      const candidate = site.selectedPages.find(
        (page) => page.pageType === pageType && !selectedUrls.has(page.url),
      );
      if (candidate !== undefined) {
        tryAddPage(candidate);
      }
    }
  }

  for (const site of prioritizedSites) {
    if (selectedSiteIds.size >= minimumSiteCount || selectedPages.length >= targetPageCount) {
      break;
    }

    const candidate = site.selectedPages.find((page) => !selectedUrls.has(page.url));
    if (candidate !== undefined) {
      tryAddPage(candidate);
    }
  }

  while (selectedPages.length < targetPageCount) {
    let addedInRound = false;

    for (const site of prioritizedSites) {
      if (selectedPages.length >= targetPageCount) {
        break;
      }

      const candidate = site.selectedPages.find((page) => !selectedUrls.has(page.url));
      if (candidate !== undefined) {
        addedInRound = tryAddPage(candidate) || addedInRound;
      }
    }

    if (!addedInRound) {
      break;
    }
  }

  const allocations = prioritizedSites.map((site) =>
    Schema.decodeUnknownSync(E9FrozenCorpusAllocationSchema)({
      siteId: site.siteId,
      domain: site.domain,
      state: site.state,
      kind: site.kind,
      availableSelectedPageCount: site.selectedPages.length,
      allocatedPageCount: allocationCounts.get(site.siteId) ?? 0,
    }),
  );

  return {
    pages: selectedPages,
    allocations,
    selectedSiteCount: selectedSiteIds.size,
  };
}

export async function runE9CommerceCorpusFreeze(options: {
  readonly sourceArtifactPath: string;
  readonly targetPageCount?: number;
  readonly minimumSiteCount?: number;
  readonly generatedAt?: string;
}) {
  const sourceArtifactPath = resolve(options.sourceArtifactPath);
  const targetPageCount = options.targetPageCount ?? 640;
  const minimumSiteCount = options.minimumSiteCount ?? 20;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const discoveryArtifact = Schema.decodeUnknownSync(E9CommerceDiscoveryArtifactSchema)(
    JSON.parse(await readFile(sourceArtifactPath, "utf8")),
  );
  const allocation = allocateCorpusPages(discoveryArtifact, targetPageCount, minimumSiteCount);

  return Schema.decodeUnknownSync(E9CommerceCorpusFreezeArtifactSchema)({
    benchmark: "e9-commerce-corpus-freeze",
    generatedAt,
    sourceArtifactPath,
    targetPageCount,
    selectedPageCount: allocation.pages.length,
    selectedSiteCount: allocation.selectedSiteCount,
    minimumSiteCount,
    siteCoverage:
      minimumSiteCount === 0 ? 1 : Math.min(1, allocation.selectedSiteCount / minimumSiteCount),
    pageCoverage:
      targetPageCount === 0 ? 1 : Math.min(1, allocation.pages.length / targetPageCount),
    shortfallCount: Math.max(0, targetPageCount - allocation.pages.length),
    pages: allocation.pages,
    allocations: allocation.allocations,
  });
}

export const runE9CommerceCorpusFreezeEffect = Effect.fn("E9.runE9CommerceCorpusFreezeEffect")(
  function* (options: {
    readonly sourceArtifactPath: string;
    readonly targetPageCount?: number;
    readonly minimumSiteCount?: number;
    readonly generatedAt?: string;
  }) {
    return yield* Effect.promise(() => runE9CommerceCorpusFreeze(options));
  },
);
