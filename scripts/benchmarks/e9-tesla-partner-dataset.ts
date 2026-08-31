#!/usr/bin/env bun

import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Schema } from "effect";
import { CanonicalHttpUrlSchema, IsoDateTimeSchema } from "@effect-scrapling/foundation-core";
import { E9CommerceCorpusFreezeArtifactSchema } from "../../src/e9-corpus-freeze.ts";
import { E9BenchmarkSuiteArtifactSchema } from "../../src/e9-benchmark-suite.ts";
import { resolveBundledSurfsharkWireGuardAssetPaths } from "../../src/sdk/surfshark-wireguard-runtime.ts";
import { runE9BenchmarkSuiteCli } from "./e9-benchmark-suite.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const TRACKING_QUERY_PARAM_PATTERN = /^(?:utm_[a-z0-9_]+|fbclid|gclid|msclkid|mc_cid|mc_eid)$/iu;
const HttpUrlWithoutCredentialsSchema = NonEmptyStringSchema.pipe(
  Schema.refine(
    (value): value is string => {
      try {
        const parsed = new URL(value);
        return (
          (parsed.protocol === "http:" || parsed.protocol === "https:") &&
          parsed.username.length === 0 &&
          parsed.password.length === 0
        );
      } catch {
        return false;
      }
    },
    {
      message: "Expected an absolute HTTP(S) URL without credentials.",
    },
  ),
);

function canDecode<SchemaType extends Schema.Top & { readonly DecodingServices: never }>(
  schema: SchemaType,
  value: unknown,
): value is Schema.Schema.Type<SchemaType> {
  try {
    Schema.decodeUnknownSync(schema)(value);
    return true;
  } catch {
    return false;
  }
}
const PartnerSchema = Schema.Literals([
  "allegro",
  "alza",
  "datart",
  "mironet",
  "planeo",
  "robotworld",
  "tsbohemia",
] as const);

const PartnerMatchSchema = Schema.Struct({
  partner: PartnerSchema,
  partnerUrl: CanonicalHttpUrlSchema,
});
const PartnerDomainSchema = Schema.Struct({
  partner: PartnerSchema,
  domain: NonEmptyStringSchema,
});

const ModelTokensSchema = Schema.NonEmptyArray(NonEmptyStringSchema);

const TeslaLegacyCompatibleDatasetProductWithTitleSchema = Schema.Struct({
  title: NonEmptyStringSchema,
  officialTitle: Schema.optional(NonEmptyStringSchema),
  officialUrl: CanonicalHttpUrlSchema,
  partnerMatches: Schema.Array(PartnerMatchSchema),
  strictPartnerMatches: Schema.optional(Schema.Array(PartnerMatchSchema)),
  strictEligible: Schema.optional(Schema.Boolean),
});

const TeslaLegacyCompatibleDatasetProductWithOfficialTitleSchema = Schema.Struct({
  title: Schema.optional(NonEmptyStringSchema),
  officialTitle: NonEmptyStringSchema,
  officialUrl: CanonicalHttpUrlSchema,
  partnerMatches: Schema.Array(PartnerMatchSchema),
  strictPartnerMatches: Schema.optional(Schema.Array(PartnerMatchSchema)),
  strictEligible: Schema.optional(Schema.Boolean),
});

export const TeslaLegacyCompatibleDatasetProductSchema = Schema.Union([
  TeslaLegacyCompatibleDatasetProductWithTitleSchema,
  TeslaLegacyCompatibleDatasetProductWithOfficialTitleSchema,
]);

const TeslaObservedFullDatasetProductFieldsSchema = Schema.Struct({
  title: NonEmptyStringSchema,
  officialUrl: CanonicalHttpUrlSchema,
  modelTokens: ModelTokensSchema,
  partnerMatches: Schema.Array(PartnerMatchSchema),
  officialIsAccessory: Schema.Boolean,
  strictPartnerMatches: Schema.optional(Schema.Array(PartnerMatchSchema)),
  strictEligible: Schema.Boolean,
});

export const TeslaObservedFullDatasetProductSchema =
  TeslaObservedFullDatasetProductFieldsSchema.pipe(
    Schema.refine(
      (
        product,
      ): product is Schema.Schema.Type<typeof TeslaObservedFullDatasetProductFieldsSchema> =>
        product.strictEligible === false || (product.strictPartnerMatches?.length ?? 0) > 0,
      {
        message:
          "Observed full Tesla products must include non-empty strictPartnerMatches whenever strictEligible is true.",
      },
    ),
  );

export const TeslaObservedStrictDatasetProductSchema = Schema.Struct({
  officialTitle: NonEmptyStringSchema,
  officialUrl: CanonicalHttpUrlSchema,
  modelTokens: ModelTokensSchema,
  officialIsAccessory: Schema.Boolean,
  partnerMatches: Schema.Array(PartnerMatchSchema),
});

export const TeslaCompatibleDatasetProductSchema = Schema.Union([
  TeslaObservedFullDatasetProductSchema,
  TeslaObservedStrictDatasetProductSchema,
  TeslaLegacyCompatibleDatasetProductSchema,
]);

const TeslaObservedFullDatasetSourceSchema = Schema.Struct({
  officialCatalog: CanonicalHttpUrlSchema,
  partnerDiscovery: Schema.Array(CanonicalHttpUrlSchema),
  partnerDomains: Schema.Array(PartnerDomainSchema),
});

const TeslaObservedFullDatasetSummarySchema = Schema.Struct({
  productCount: NonNegativeIntSchema,
  partnerUrlCount: NonNegativeIntSchema,
  strictProductCount: NonNegativeIntSchema,
  strictPartnerUrlCount: NonNegativeIntSchema,
});

const TeslaObservedStrictDatasetSummarySchema = Schema.Struct({
  productCount: NonNegativeIntSchema,
  partnerUrlCount: NonNegativeIntSchema,
});

const DatasetSummarySchema = Schema.Unknown;
const DatasetSourceSchema = Schema.Unknown;

export const TeslaObservedFullDatasetEnvelopeSchema = Schema.Struct({
  generatedAt: NonEmptyStringSchema,
  source: TeslaObservedFullDatasetSourceSchema,
  summary: TeslaObservedFullDatasetSummarySchema,
  products: Schema.Array(TeslaObservedFullDatasetProductSchema),
});

export const TeslaObservedStrictDatasetEnvelopeSchema = Schema.Struct({
  generatedAt: NonEmptyStringSchema,
  summary: TeslaObservedStrictDatasetSummarySchema,
  products: Schema.Array(TeslaObservedStrictDatasetProductSchema),
});

export const TeslaLegacyCompatibleDatasetEnvelopeSchema = Schema.Struct({
  generatedAt: Schema.optional(NonEmptyStringSchema),
  source: Schema.optional(DatasetSourceSchema),
  summary: Schema.optional(DatasetSummarySchema),
  products: Schema.Array(TeslaCompatibleDatasetProductSchema),
});

export const TeslaCompatibleDatasetSchema = Schema.Union([
  TeslaObservedFullDatasetEnvelopeSchema,
  TeslaObservedStrictDatasetEnvelopeSchema,
  TeslaLegacyCompatibleDatasetEnvelopeSchema,
  Schema.Array(TeslaCompatibleDatasetProductSchema),
]);

const TeslaDatasetVariantSchema = Schema.Literals([
  "legacy-array",
  "legacy-envelope",
  "observed-full-envelope",
  "observed-strict-envelope",
] as const);
const TeslaDatasetDiagnosticSeveritySchema = Schema.Literals(["warning"] as const);
const TeslaDatasetDiagnosticCodeSchema = Schema.Literals([
  "legacy-compatible-input",
  "partial-observed-full-product",
  "partial-observed-strict-product",
  "unknown-top-level-field",
  "unknown-product-field",
  "missing-model-tokens",
  "missing-official-accessory-flag",
  "missing-strict-partner-matches",
  "missing-strict-eligibility",
  "strict-fallback-partner-matches",
] as const);

export const TeslaDatasetDiagnosticSchema = Schema.Struct({
  severity: TeslaDatasetDiagnosticSeveritySchema,
  code: TeslaDatasetDiagnosticCodeSchema,
  message: NonEmptyStringSchema,
  field: Schema.optional(NonEmptyStringSchema),
  productIndex: Schema.optional(NonNegativeIntSchema),
  officialUrl: Schema.optional(CanonicalHttpUrlSchema),
});

export const TeslaDatasetCoverageSchema = Schema.Struct({
  productCount: NonNegativeIntSchema,
  legacyCompatibleProductCount: NonNegativeIntSchema,
  observedFullProductCount: NonNegativeIntSchema,
  observedStrictProductCount: NonNegativeIntSchema,
  identityReadyProductCount: NonNegativeIntSchema,
  strictReadyProductCount: NonNegativeIntSchema,
  partialObservedFullProductCount: NonNegativeIntSchema,
  partialObservedStrictProductCount: NonNegativeIntSchema,
  partnerMatchCount: NonNegativeIntSchema,
  strictPartnerMatchCount: NonNegativeIntSchema,
  titleCount: NonNegativeIntSchema,
  officialTitleCount: NonNegativeIntSchema,
  modelTokensCount: NonNegativeIntSchema,
  officialIsAccessoryCount: NonNegativeIntSchema,
  strictEligibleCount: NonNegativeIntSchema,
});

export const TeslaCompatibleDatasetLoadResultSchema = Schema.Struct({
  dataset: TeslaCompatibleDatasetSchema,
  variant: TeslaDatasetVariantSchema,
  diagnostics: Schema.Array(TeslaDatasetDiagnosticSchema),
  coverage: TeslaDatasetCoverageSchema,
});

const TeslaExpectationTextPolicySchema = Schema.Literals([
  "exact",
  "partner-display",
  "semantic-identity",
] as const);
const TeslaExpectationPricePolicySchema = Schema.Literals([
  "exact",
  "range",
  "parse-only",
] as const);
const TeslaExpectationDescriptionPolicySchema = Schema.Literals([
  "exact",
  "contains",
  "semantic-summary",
] as const);
const TeslaExpectationFreshnessBehaviorSchema = Schema.Literals([
  "hard-fail",
  "warning",
  "score-only",
] as const);
const TeslaExpectationFreshnessStatusSchema = Schema.Literals([
  "fresh",
  "stale",
  "expired",
  "missing-captured-at",
  "future-captured-at",
] as const);

export const TeslaPartnerTitleExpectationSchema = Schema.Struct({
  value: NonEmptyStringSchema,
  policy: TeslaExpectationTextPolicySchema,
});

export const TeslaPartnerPriceExpectationSchema = Schema.Struct({
  amount: Schema.Number,
  currency: NonEmptyStringSchema,
  policy: TeslaExpectationPricePolicySchema,
  capturedAt: Schema.optional(IsoDateTimeSchema),
  minAmount: Schema.optional(Schema.Number),
  maxAmount: Schema.optional(Schema.Number),
});

export const TeslaPartnerDescriptionExpectationSchema = Schema.Struct({
  value: NonEmptyStringSchema,
  policy: TeslaExpectationDescriptionPolicySchema,
  capturedAt: Schema.optional(IsoDateTimeSchema),
});

const TeslaPartnerExpectationEntryFieldsSchema = Schema.Struct({
  partner: PartnerSchema,
  partnerUrl: HttpUrlWithoutCredentialsSchema,
  strictEligible: Schema.optional(Schema.Boolean),
  title: Schema.optional(TeslaPartnerTitleExpectationSchema),
  price: Schema.optional(TeslaPartnerPriceExpectationSchema),
  description: Schema.optional(TeslaPartnerDescriptionExpectationSchema),
});

type TeslaPartnerExpectationEntryFields = Schema.Schema.Type<
  typeof TeslaPartnerExpectationEntryFieldsSchema
>;

export const TeslaPartnerExpectationEntrySchema = TeslaPartnerExpectationEntryFieldsSchema.pipe(
  Schema.refine(
    (entry): entry is TeslaPartnerExpectationEntryFields =>
      entry.title !== undefined || entry.price !== undefined || entry.description !== undefined,
    {
      message:
        "Tesla partner expectation entries must include at least one of title, price, or description.",
    },
  ),
  Schema.refine(
    (entry): entry is TeslaPartnerExpectationEntryFields => {
      try {
        validatePartnerUrlDomain(entry.partner, entry.partnerUrl);
        return true;
      } catch {
        return false;
      }
    },
    {
      message:
        "Tesla partner expectation entries must use a partnerUrl whose domain matches the declared partner.",
    },
  ),
);

export const TeslaProductExpectationSidecarEntrySchema = Schema.Struct({
  officialUrl: CanonicalHttpUrlSchema,
  officialTitle: Schema.optional(NonEmptyStringSchema),
  modelTokens: Schema.optional(ModelTokensSchema),
  partnerExpectations: Schema.Array(TeslaPartnerExpectationEntrySchema),
});

export const TeslaExpectationFreshnessPolicySchema = Schema.Struct({
  priceMaxAgeHours: Schema.optional(NonNegativeIntSchema),
  priceExpireAgeHours: Schema.optional(NonNegativeIntSchema),
  descriptionMaxAgeHours: Schema.optional(NonNegativeIntSchema),
  descriptionExpireAgeHours: Schema.optional(NonNegativeIntSchema),
  stalePriceBehavior: Schema.optional(TeslaExpectationFreshnessBehaviorSchema),
  expiredPriceBehavior: Schema.optional(TeslaExpectationFreshnessBehaviorSchema),
  staleDescriptionBehavior: Schema.optional(TeslaExpectationFreshnessBehaviorSchema),
  expiredDescriptionBehavior: Schema.optional(TeslaExpectationFreshnessBehaviorSchema),
  missingPriceCapturedAtBehavior: Schema.optional(TeslaExpectationFreshnessBehaviorSchema),
  missingDescriptionCapturedAtBehavior: Schema.optional(TeslaExpectationFreshnessBehaviorSchema),
}).pipe(
  Schema.refine(
    (policy): policy is Schema.Schema.Type<typeof TeslaExpectationFreshnessPolicySchema> =>
      (policy.priceExpireAgeHours ?? policy.priceMaxAgeHours ?? 0) >=
        (policy.priceMaxAgeHours ?? 0) &&
      (policy.descriptionExpireAgeHours ?? policy.descriptionMaxAgeHours ?? 0) >=
        (policy.descriptionMaxAgeHours ?? 0),
    {
      message:
        "Tesla expectation freshness expiry windows must be greater than or equal to the corresponding freshness windows.",
    },
  ),
);

export const TeslaResolvedExpectationFreshnessPolicySchema = Schema.Struct({
  priceMaxAgeHours: NonNegativeIntSchema,
  priceExpireAgeHours: NonNegativeIntSchema,
  descriptionMaxAgeHours: NonNegativeIntSchema,
  descriptionExpireAgeHours: NonNegativeIntSchema,
  stalePriceBehavior: TeslaExpectationFreshnessBehaviorSchema,
  expiredPriceBehavior: TeslaExpectationFreshnessBehaviorSchema,
  staleDescriptionBehavior: TeslaExpectationFreshnessBehaviorSchema,
  expiredDescriptionBehavior: TeslaExpectationFreshnessBehaviorSchema,
  missingPriceCapturedAtBehavior: TeslaExpectationFreshnessBehaviorSchema,
  missingDescriptionCapturedAtBehavior: TeslaExpectationFreshnessBehaviorSchema,
});

// First-pass truth sidecars stay keyed by partner URL so they can be joined
// deterministically onto the frozen corpus without widening the corpus schema yet.
export const TeslaExpectationSidecarSchema = Schema.Struct({
  generatedAt: IsoDateTimeSchema,
  sourceDatasetPath: Schema.optional(NonEmptyStringSchema),
  freshnessPolicy: Schema.optional(TeslaExpectationFreshnessPolicySchema),
  products: Schema.Array(TeslaProductExpectationSidecarEntrySchema),
}).pipe(
  Schema.refine((sidecar): sidecar is Schema.Schema.Type<typeof TeslaExpectationSidecarSchema> => {
    for (const product of sidecar.products) {
      for (const expectation of product.partnerExpectations) {
        validatePartnerUrlDomain(expectation.partner, expectation.partnerUrl);
      }
    }

    return true;
  }),
);

const TeslaExpectationJoinStatusSchema = Schema.Literals([
  "matched",
  "missing",
  "ambiguous",
  "strict-excluded",
] as const);

export const TeslaExpectationLookupMatchSchema = Schema.Struct({
  officialUrl: CanonicalHttpUrlSchema,
  expectation: TeslaPartnerExpectationEntrySchema,
});

export const TeslaExpectationLookupResultSchema = Schema.Struct({
  status: TeslaExpectationJoinStatusSchema,
  partnerUrl: NonEmptyStringSchema,
  normalizedPartnerUrl: NonEmptyStringSchema,
  strict: Schema.Boolean,
  matchCount: NonNegativeIntSchema,
  matches: Schema.Array(TeslaExpectationLookupMatchSchema),
});

export const TeslaExpectationJoinRecordSchema = Schema.Struct({
  status: TeslaExpectationJoinStatusSchema,
  pageUrl: NonEmptyStringSchema,
  normalizedPageUrl: NonEmptyStringSchema,
  siteId: NonEmptyStringSchema,
  domain: NonEmptyStringSchema,
  pageType: NonEmptyStringSchema,
  matchCount: NonNegativeIntSchema,
  officialUrl: Schema.optional(CanonicalHttpUrlSchema),
  expectation: Schema.optional(TeslaPartnerExpectationEntrySchema),
});

export const TeslaExpectationJoinResultSchema = Schema.Struct({
  strict: Schema.Boolean,
  matchedCount: NonNegativeIntSchema,
  missingCount: NonNegativeIntSchema,
  ambiguousCount: NonNegativeIntSchema,
  strictExcludedCount: NonNegativeIntSchema,
  records: Schema.Array(TeslaExpectationJoinRecordSchema),
});

const TeslaExpectationSidecarDiagnosticSeveritySchema = Schema.Literals([
  "warning",
  "error",
] as const);
const TeslaExpectationSidecarDiagnosticCodeSchema = Schema.Literals([
  "unknown-top-level-field",
  "unknown-product-field",
  "unknown-partner-expectation-field",
  "missing-model-tokens",
  "ambiguous-normalized-partner-url",
  "stale-price-truth",
  "expired-price-truth",
  "future-price-captured-at",
  "stale-description-truth",
  "expired-description-truth",
  "future-description-captured-at",
  "missing-price-captured-at",
  "missing-description-captured-at",
] as const);

export const TeslaExpectationSidecarDiagnosticSchema = Schema.Struct({
  severity: TeslaExpectationSidecarDiagnosticSeveritySchema,
  code: TeslaExpectationSidecarDiagnosticCodeSchema,
  message: NonEmptyStringSchema,
  field: Schema.optional(NonEmptyStringSchema),
  productIndex: Schema.optional(NonNegativeIntSchema),
  expectationIndex: Schema.optional(NonNegativeIntSchema),
  officialUrl: Schema.optional(CanonicalHttpUrlSchema),
  partnerUrl: Schema.optional(HttpUrlWithoutCredentialsSchema),
  normalizedPartnerUrl: Schema.optional(NonEmptyStringSchema),
});

export const TeslaExpectationSidecarCoverageSchema = Schema.Struct({
  productCount: NonNegativeIntSchema,
  productWithModelTokensCount: NonNegativeIntSchema,
  partnerExpectationCount: NonNegativeIntSchema,
  titleExpectationCount: NonNegativeIntSchema,
  priceExpectationCount: NonNegativeIntSchema,
  descriptionExpectationCount: NonNegativeIntSchema,
  ambiguousNormalizedPartnerUrlCount: NonNegativeIntSchema,
  freshPriceExpectationCount: NonNegativeIntSchema,
  stalePriceExpectationCount: NonNegativeIntSchema,
  expiredPriceExpectationCount: NonNegativeIntSchema,
  missingPriceCapturedAtCount: NonNegativeIntSchema,
  futurePriceCapturedAtCount: NonNegativeIntSchema,
  freshDescriptionExpectationCount: NonNegativeIntSchema,
  staleDescriptionExpectationCount: NonNegativeIntSchema,
  expiredDescriptionExpectationCount: NonNegativeIntSchema,
  missingDescriptionCapturedAtCount: NonNegativeIntSchema,
  futureDescriptionCapturedAtCount: NonNegativeIntSchema,
});

export const TeslaExpectationSidecarLoadResultSchema = Schema.Struct({
  sidecar: TeslaExpectationSidecarSchema,
  evaluatedAt: IsoDateTimeSchema,
  freshnessPolicy: TeslaResolvedExpectationFreshnessPolicySchema,
  diagnostics: Schema.Array(TeslaExpectationSidecarDiagnosticSchema),
  coverage: TeslaExpectationSidecarCoverageSchema,
});

const TeslaPartnerDatasetCliOptionsSchema = Schema.Struct({
  datasetPath: NonEmptyStringSchema,
  datasetPathExplicit: Schema.Boolean,
  corpusArtifactPath: NonEmptyStringSchema,
  strict: Schema.Boolean,
  forwardedArgs: Schema.Array(NonEmptyStringSchema),
});

const DEFAULT_DATASET_DIRECTORY = "/tmp";
const DEFAULT_DATASET_FILE_PATTERN = /^tesla-electronics-partner-dataset-\d{4}-\d{2}-\d{2}\.json$/u;
const DEFAULT_STRICT_DATASET_FILE_PATTERN =
  /^tesla-electronics-partner-dataset-\d{4}-\d{2}-\d{2}\.strict\.json$/u;
const DEFAULT_CORPUS_ARTIFACT_PATH = "/tmp/tesla-partners-corpus.json";
const DEFAULT_BENCHMARK_ARTIFACT_PATH = "/tmp/tesla-partners-benchmark.json";
// Default to the strongest validated Tesla benchmark lane: HTTP-first hybrid stealth,
// then browser escalation through Surfshark wireproxy rotation when bundled assets exist.
const DEFAULT_BENCHMARK_PRESET = "state-of-the-art";
const DEFAULT_BROWSER_CONCURRENCY = "8";
const DEFAULT_BROWSER_TIMEOUT_MS = "180000";
const DEFAULT_WIREPROXY_ROTATION_FALLBACKS = "7";
const DEFAULT_WIREPROXY_TRANSPORT = "http";
const BENCHMARK_NON_PRESET_SHAPE_OPTIONS = [
  "--phases",
  "--http-profiles",
  "--browser-profiles",
] as const;
const BENCHMARK_WIREPROXY_SOURCE_OPTIONS = ["--wireproxy-manifest", "--wireproxy-bundled"] as const;
const BENCHMARK_WIREPROXY_MODE_OPTIONS = ["--wireproxy-entry", "--wireproxy-rotate"] as const;
const BENCHMARK_WIREPROXY_TUNABLE_OPTIONS = [
  "--wireproxy-transport",
  "--wireproxy-rotation-fallbacks",
] as const;

const PARTNER_SITE_METADATA: Readonly<
  Record<
    Schema.Schema.Type<typeof PartnerSchema>,
    {
      readonly siteId: string;
      readonly kind: "retailer" | "aggregator";
      readonly expectedDomains: readonly string[];
    }
  >
> = {
  allegro: {
    siteId: "allegro-cz",
    kind: "aggregator",
    expectedDomains: ["allegro.cz"],
  },
  alza: {
    siteId: "alza-cz",
    kind: "retailer",
    expectedDomains: ["alza.cz"],
  },
  datart: {
    siteId: "datart-cz",
    kind: "retailer",
    expectedDomains: ["datart.cz"],
  },
  mironet: {
    siteId: "mironet-cz",
    kind: "retailer",
    expectedDomains: ["mironet.cz"],
  },
  planeo: {
    siteId: "planeo-cz",
    kind: "retailer",
    expectedDomains: ["planeo.cz"],
  },
  robotworld: {
    siteId: "robotworld-cz",
    kind: "retailer",
    expectedDomains: ["robotworld.cz"],
  },
  tsbohemia: {
    siteId: "tsbohemia-cz",
    kind: "retailer",
    expectedDomains: ["tsbohemia.cz"],
  },
};

type DatasetProduct = Schema.Schema.Type<typeof TeslaCompatibleDatasetProductSchema>;
type DatasetVariant = Schema.Schema.Type<typeof TeslaDatasetVariantSchema>;
type DatasetDiagnostic = Schema.Schema.Type<typeof TeslaDatasetDiagnosticSchema>;
type DatasetCoverage = Schema.Schema.Type<typeof TeslaDatasetCoverageSchema>;
type TeslaExpectationJoinStatus = Schema.Schema.Type<typeof TeslaExpectationJoinStatusSchema>;
type E9BenchmarkArtifact = Schema.Schema.Type<typeof E9BenchmarkSuiteArtifactSchema>;
type BenchmarkAttempt = E9BenchmarkArtifact["httpCorpus"]["attempts"][number];
type TeslaExpectationLookupMatch = Schema.Schema.Type<typeof TeslaExpectationLookupMatchSchema>;
type TeslaExpectationSidecar = Schema.Schema.Type<typeof TeslaExpectationSidecarSchema>;
type TeslaExpectationFreshnessStatus = Schema.Schema.Type<
  typeof TeslaExpectationFreshnessStatusSchema
>;
type TeslaResolvedExpectationFreshnessPolicy = Schema.Schema.Type<
  typeof TeslaResolvedExpectationFreshnessPolicySchema
>;

const DATASET_VARIANT_ALLOWED_TOP_LEVEL_FIELDS: Readonly<
  Record<DatasetVariant, ReadonlySet<string>>
> = {
  "legacy-array": new Set(),
  "legacy-envelope": new Set(["generatedAt", "products", "source", "summary"]),
  "observed-full-envelope": new Set(["generatedAt", "products", "source", "summary"]),
  "observed-strict-envelope": new Set(["generatedAt", "products", "summary"]),
};

const PRODUCT_VARIANT_ALLOWED_FIELDS = {
  "legacy-compatible": new Set([
    "officialTitle",
    "officialUrl",
    "partnerMatches",
    "strictEligible",
    "strictPartnerMatches",
    "title",
  ]),
  "observed-full": new Set([
    "modelTokens",
    "officialIsAccessory",
    "officialUrl",
    "partnerMatches",
    "strictEligible",
    "strictPartnerMatches",
    "title",
  ]),
  "observed-strict": new Set([
    "modelTokens",
    "officialIsAccessory",
    "officialTitle",
    "officialUrl",
    "partnerMatches",
  ]),
} as const;

const SIDECAR_ALLOWED_TOP_LEVEL_FIELDS = new Set([
  "freshnessPolicy",
  "generatedAt",
  "products",
  "sourceDatasetPath",
]);

const SIDECAR_ALLOWED_PRODUCT_FIELDS = new Set([
  "modelTokens",
  "officialTitle",
  "officialUrl",
  "partnerExpectations",
]);

const SIDECAR_ALLOWED_EXPECTATION_FIELDS = new Set([
  "description",
  "partner",
  "partnerUrl",
  "price",
  "strictEligible",
  "title",
]);

const DEFAULT_TESLA_EXPECTATION_FRESHNESS_POLICY = Schema.decodeUnknownSync(
  TeslaResolvedExpectationFreshnessPolicySchema,
)({
  priceMaxAgeHours: 48,
  priceExpireAgeHours: 24 * 14,
  descriptionMaxAgeHours: 24 * 30,
  descriptionExpireAgeHours: 24 * 90,
  stalePriceBehavior: "warning",
  expiredPriceBehavior: "warning",
  staleDescriptionBehavior: "score-only",
  expiredDescriptionBehavior: "warning",
  missingPriceCapturedAtBehavior: "warning",
  missingDescriptionCapturedAtBehavior: "score-only",
});

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function resolveTeslaExpectationFreshnessPolicy(
  sidecar: TeslaExpectationSidecar,
): TeslaResolvedExpectationFreshnessPolicy {
  return Schema.decodeUnknownSync(TeslaResolvedExpectationFreshnessPolicySchema)({
    ...DEFAULT_TESLA_EXPECTATION_FRESHNESS_POLICY,
    ...sidecar.freshnessPolicy,
  });
}

function getFreshnessAgeHours(capturedAt: string, evaluatedAt: string) {
  return Number(
    ((new Date(evaluatedAt).getTime() - new Date(capturedAt).getTime()) / 3_600_000).toFixed(3),
  );
}

function classifyTeslaExpectationFreshness(
  capturedAt: string | undefined,
  maxAgeHours: number,
  expireAgeHours: number,
  evaluatedAt: string,
): TeslaExpectationFreshnessStatus {
  if (capturedAt === undefined) {
    return "missing-captured-at" as const;
  }

  const ageHours = getFreshnessAgeHours(capturedAt, evaluatedAt);
  if (ageHours < 0) {
    return "future-captured-at" as const;
  }
  if (ageHours <= maxAgeHours) {
    return "fresh" as const;
  }
  if (ageHours <= expireAgeHours) {
    return "stale" as const;
  }
  return "expired" as const;
}

function resolveTeslaExpectationFreshnessSeverity(
  behavior: Schema.Schema.Type<typeof TeslaExpectationFreshnessBehaviorSchema>,
) {
  return behavior === "hard-fail" ? ("error" as const) : ("warning" as const);
}

function resolveTeslaExpectationFreshnessDiagnostic(args: {
  readonly field: "price" | "description";
  readonly freshness: Schema.Schema.Type<typeof TeslaExpectationFreshnessStatusSchema>;
  readonly freshnessPolicy: TeslaResolvedExpectationFreshnessPolicy;
}) {
  if (args.field === "price") {
    switch (args.freshness) {
      case "missing-captured-at":
        return args.freshnessPolicy.missingPriceCapturedAtBehavior === "score-only"
          ? undefined
          : {
              severity: resolveTeslaExpectationFreshnessSeverity(
                args.freshnessPolicy.missingPriceCapturedAtBehavior,
              ),
              code: "missing-price-captured-at" as const,
              field: "price.capturedAt",
              message:
                "Tesla partner price truth is missing capturedAt, so freshness cannot be evaluated deterministically.",
            };
      case "stale":
        return args.freshnessPolicy.stalePriceBehavior === "score-only"
          ? undefined
          : {
              severity: resolveTeslaExpectationFreshnessSeverity(
                args.freshnessPolicy.stalePriceBehavior,
              ),
              code: "stale-price-truth" as const,
              field: "price.capturedAt",
              message: `Tesla partner price truth is older than the configured freshness window of ${args.freshnessPolicy.priceMaxAgeHours}h.`,
            };
      case "expired":
        return args.freshnessPolicy.expiredPriceBehavior === "score-only"
          ? undefined
          : {
              severity: resolveTeslaExpectationFreshnessSeverity(
                args.freshnessPolicy.expiredPriceBehavior,
              ),
              code: "expired-price-truth" as const,
              field: "price.capturedAt",
              message: `Tesla partner price truth is older than the configured expiry window of ${args.freshnessPolicy.priceExpireAgeHours}h.`,
            };
      case "future-captured-at":
        return {
          severity: "warning" as const,
          code: "future-price-captured-at" as const,
          field: "price.capturedAt",
          message:
            "Tesla partner price truth has a capturedAt timestamp in the future relative to the evaluation time.",
        };
      case "fresh":
        return undefined;
    }
  }

  switch (args.freshness) {
    case "missing-captured-at":
      return args.freshnessPolicy.missingDescriptionCapturedAtBehavior === "score-only"
        ? undefined
        : {
            severity: resolveTeslaExpectationFreshnessSeverity(
              args.freshnessPolicy.missingDescriptionCapturedAtBehavior,
            ),
            code: "missing-description-captured-at" as const,
            field: "description.capturedAt",
            message:
              "Tesla partner description truth is missing capturedAt, so freshness cannot be evaluated deterministically.",
          };
    case "stale":
      return args.freshnessPolicy.staleDescriptionBehavior === "score-only"
        ? undefined
        : {
            severity: resolveTeslaExpectationFreshnessSeverity(
              args.freshnessPolicy.staleDescriptionBehavior,
            ),
            code: "stale-description-truth" as const,
            field: "description.capturedAt",
            message: `Tesla partner description truth is older than the configured freshness window of ${args.freshnessPolicy.descriptionMaxAgeHours}h.`,
          };
    case "expired":
      return args.freshnessPolicy.expiredDescriptionBehavior === "score-only"
        ? undefined
        : {
            severity: resolveTeslaExpectationFreshnessSeverity(
              args.freshnessPolicy.expiredDescriptionBehavior,
            ),
            code: "expired-description-truth" as const,
            field: "description.capturedAt",
            message: `Tesla partner description truth is older than the configured expiry window of ${args.freshnessPolicy.descriptionExpireAgeHours}h.`,
          };
    case "future-captured-at":
      return {
        severity: "warning" as const,
        code: "future-description-captured-at" as const,
        field: "description.capturedAt",
        message:
          "Tesla partner description truth has a capturedAt timestamp in the future relative to the evaluation time.",
      };
    case "fresh":
      return undefined;
  }
}

function hasOption(args: readonly string[], option: string) {
  return args.some((argument) => argument === option || argument.startsWith(`${option}=`));
}

function readOptionValue(args: readonly string[], option: string) {
  let matchedValue: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const rawValue = args[index + 1];

    if (argument === option) {
      matchedValue = rawValue !== undefined && !rawValue.startsWith("--") ? rawValue : undefined;
      continue;
    }

    if (argument?.startsWith(`${option}=`)) {
      matchedValue = argument.slice(option.length + 1);
    }
  }

  return matchedValue;
}

function stripOption(args: readonly string[], option: string) {
  const nextArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const rawValue = args[index + 1];

    if (argument === option) {
      if (rawValue !== undefined && !rawValue.startsWith("--")) {
        index += 1;
      }
      continue;
    }

    if (argument?.startsWith(`${option}=`)) {
      continue;
    }

    nextArgs.push(argument);
  }

  return nextArgs;
}

function normalizeForwardedArgs(args: readonly string[]) {
  return args.flatMap((argument) => {
    const separatorIndex = argument.startsWith("--") ? argument.indexOf("=") : -1;
    return separatorIndex < 0
      ? [argument]
      : [argument.slice(0, separatorIndex), argument.slice(separatorIndex + 1)];
  });
}

function hasAnyOption(args: readonly string[], options: ReadonlyArray<string>) {
  return options.some((option) => hasOption(args, option));
}

async function defaultHasBundledWireproxyAssets() {
  const bundled = resolveBundledSurfsharkWireGuardAssetPaths();
  const checks = await Promise.allSettled([
    access(bundled.generatedManifestPath),
    access(bundled.wireproxyManifestPath),
  ]);
  return checks.every((check) => check.status === "fulfilled");
}

function parseTeslaPartnerDatasetOptions(args: readonly string[]) {
  let datasetPath = DEFAULT_DATASET_DIRECTORY;
  let datasetPathExplicit = false;
  let corpusArtifactPath = DEFAULT_CORPUS_ARTIFACT_PATH;
  let strict = false;
  const forwardedArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const rawValue = args[index + 1];
    if (argument === undefined) {
      continue;
    }

    const expectValue = () => {
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error(`Missing value for argument: ${argument}`);
      }

      return rawValue;
    };

    if (argument.startsWith("--dataset=")) {
      datasetPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(
        argument.slice("--dataset=".length),
      );
      datasetPathExplicit = true;
      continue;
    }

    if (argument.startsWith("--corpus-artifact=")) {
      corpusArtifactPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(
        argument.slice("--corpus-artifact=".length),
      );
      continue;
    }

    if (argument.startsWith("--corpus=")) {
      throw new Error(
        "Use --corpus-artifact for the generated corpus path. The wrapper manages --corpus internally.",
      );
    }

    if (argument.startsWith("--strict=")) {
      const rawStrict = argument.slice("--strict=".length);
      if (rawStrict === "true") {
        strict = true;
        continue;
      }
      if (rawStrict === "false") {
        strict = false;
        continue;
      }
      throw new Error(
        `Expected --strict to be true or false, received ${JSON.stringify(rawStrict)}.`,
      );
    }

    switch (argument) {
      case "--dataset":
        datasetPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(expectValue());
        datasetPathExplicit = true;
        index += 1;
        break;
      case "--corpus-artifact":
        corpusArtifactPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(expectValue());
        index += 1;
        break;
      case "--strict":
        strict = true;
        break;
      case "--corpus":
        throw new Error(
          "Use --corpus-artifact for the generated corpus path. The wrapper manages --corpus internally.",
        );
      default:
        forwardedArgs.push(argument);
        if (rawValue !== undefined && !rawValue.startsWith("--")) {
          forwardedArgs.push(rawValue);
          index += 1;
        }
        break;
    }
  }

  const normalizedForwardedArgs = normalizeForwardedArgs(forwardedArgs);

  return Schema.decodeUnknownSync(TeslaPartnerDatasetCliOptionsSchema)({
    datasetPath,
    datasetPathExplicit,
    corpusArtifactPath,
    strict,
    forwardedArgs: normalizedForwardedArgs,
  });
}

function normalizeProducts(dataset: Schema.Schema.Type<typeof TeslaCompatibleDatasetSchema>) {
  return "products" in dataset ? dataset.products : dataset;
}

function readUnknownRecord(value: unknown) {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function inferExpectedObservedDatasetVariant(rawDataset: unknown) {
  const rawDatasetRecord = readUnknownRecord(rawDataset);
  const rawSource = readUnknownRecord(rawDatasetRecord?.source);
  const rawSummary = readUnknownRecord(rawDatasetRecord?.summary);
  const rawProducts = Array.isArray(rawDataset)
    ? rawDataset
    : Array.isArray(rawDatasetRecord?.products)
      ? rawDatasetRecord.products
      : [];

  if (
    rawSource !== undefined &&
    ("officialCatalog" in rawSource ||
      "partnerDiscovery" in rawSource ||
      "partnerDomains" in rawSource)
  ) {
    return "observed-full-envelope" as const;
  }
  if (
    rawSummary !== undefined &&
    ("strictProductCount" in rawSummary || "strictPartnerUrlCount" in rawSummary)
  ) {
    return "observed-full-envelope" as const;
  }

  const looksStrictEnvelope =
    rawDatasetRecord !== undefined &&
    !Reflect.has(rawDatasetRecord, "source") &&
    ((Reflect.has(rawDatasetRecord, "generatedAt") && Reflect.has(rawDatasetRecord, "summary")) ||
      (Reflect.has(rawDatasetRecord, "summary") &&
        rawProducts.some(
          (rawProduct) => inferExpectedObservedProductVariant(rawProduct) === "observed-strict",
        )));
  if (looksStrictEnvelope) {
    return "observed-strict-envelope" as const;
  }

  return undefined;
}

export function classifyTeslaDatasetVariant(rawDataset: unknown): DatasetVariant {
  if (Array.isArray(rawDataset)) {
    return "legacy-array";
  }
  const expectedObservedVariant = inferExpectedObservedDatasetVariant(rawDataset);
  if (expectedObservedVariant !== undefined) {
    return expectedObservedVariant;
  }
  if (Schema.is(TeslaObservedFullDatasetEnvelopeSchema)(rawDataset)) {
    return "observed-full-envelope";
  }
  if (Schema.is(TeslaObservedStrictDatasetEnvelopeSchema)(rawDataset)) {
    return "observed-strict-envelope";
  }
  return "legacy-envelope";
}

export function classifyTeslaDatasetProductVariant(product: unknown) {
  if (Schema.is(TeslaObservedFullDatasetProductSchema)(product)) {
    return "observed-full";
  }
  if (Schema.is(TeslaObservedStrictDatasetProductSchema)(product)) {
    return "observed-strict";
  }
  return "legacy-compatible";
}

function inferExpectedObservedProductVariant(rawProduct: unknown) {
  const rawProductRecord = readUnknownRecord(rawProduct);
  if (rawProductRecord === undefined) {
    return undefined;
  }

  if (
    "title" in rawProductRecord &&
    ("modelTokens" in rawProductRecord ||
      "officialIsAccessory" in rawProductRecord ||
      "strictPartnerMatches" in rawProductRecord ||
      "strictEligible" in rawProductRecord)
  ) {
    return "observed-full" as const;
  }

  if ("modelTokens" in rawProductRecord || "officialIsAccessory" in rawProductRecord) {
    return "observed-strict" as const;
  }

  return undefined;
}

function validateObservedDatasetTopLevelMetadata(rawDataset: unknown) {
  const rawDatasetRecord = readUnknownRecord(rawDataset);
  if (rawDatasetRecord === undefined || Array.isArray(rawDataset)) {
    return;
  }

  const expectedVariant = inferExpectedObservedDatasetVariant(rawDataset);
  if (expectedVariant === "observed-full-envelope") {
    if (!canDecode(NonEmptyStringSchema, rawDatasetRecord.generatedAt)) {
      throw new Error(
        "Tesla dataset includes observed full-format fields but generatedAt is missing or invalid.",
      );
    }
    if (!canDecode(TeslaObservedFullDatasetSourceSchema, rawDatasetRecord.source)) {
      throw new Error(
        "Tesla dataset includes observed full-format fields but source metadata is malformed.",
      );
    }
    if (!canDecode(TeslaObservedFullDatasetSummarySchema, rawDatasetRecord.summary)) {
      throw new Error(
        "Tesla dataset includes observed full-format fields but summary metadata is malformed.",
      );
    }
    return;
  }

  if (expectedVariant === "observed-strict-envelope") {
    if (
      rawDatasetRecord.generatedAt !== undefined &&
      !canDecode(NonEmptyStringSchema, rawDatasetRecord.generatedAt)
    ) {
      throw new Error(
        "Tesla dataset includes observed strict-format fields but generatedAt is invalid.",
      );
    }
    if (rawDatasetRecord.summary !== undefined) {
      if (!canDecode(TeslaObservedStrictDatasetSummarySchema, rawDatasetRecord.summary)) {
        throw new Error(
          "Tesla dataset includes observed strict-format fields but summary metadata is malformed.",
        );
      }
    }
  }
}

function validateObservedDatasetProductFields(rawDataset: unknown) {
  const rawDatasetRecord = readUnknownRecord(rawDataset);
  const rawProducts = Array.isArray(rawDataset)
    ? rawDataset
    : Array.isArray(rawDatasetRecord?.products)
      ? rawDatasetRecord.products
      : [];

  for (const [productIndex, rawProduct] of rawProducts.entries()) {
    const rawProductRecord = readUnknownRecord(rawProduct);
    if (rawProductRecord === undefined) {
      continue;
    }

    const expectedObservedVariant = inferExpectedObservedProductVariant(rawProduct);
    if (expectedObservedVariant === undefined) {
      continue;
    }

    if (
      "modelTokens" in rawProductRecord &&
      !canDecode(ModelTokensSchema, rawProductRecord.modelTokens)
    ) {
      throw new Error(
        `Tesla dataset products[${productIndex}] includes observed ${expectedObservedVariant === "observed-full" ? "full" : "strict"}-format fields but modelTokens is malformed.`,
      );
    }
    if (
      "officialIsAccessory" in rawProductRecord &&
      !canDecode(Schema.Boolean, rawProductRecord.officialIsAccessory)
    ) {
      throw new Error(
        `Tesla dataset products[${productIndex}] includes observed ${expectedObservedVariant === "observed-full" ? "full" : "strict"}-format fields but officialIsAccessory is malformed.`,
      );
    }
    if (
      "strictPartnerMatches" in rawProductRecord &&
      !canDecode(Schema.Array(PartnerMatchSchema), rawProductRecord.strictPartnerMatches)
    ) {
      throw new Error(
        `Tesla dataset products[${productIndex}] includes observed full-format fields but strictPartnerMatches is malformed.`,
      );
    }
    if (
      "strictEligible" in rawProductRecord &&
      !canDecode(Schema.Boolean, rawProductRecord.strictEligible)
    ) {
      throw new Error(
        `Tesla dataset products[${productIndex}] includes observed full-format fields but strictEligible is malformed.`,
      );
    }
  }
}

const DATASET_VARIANT_RANK = {
  "legacy-array": 0,
  "legacy-envelope": 0,
  "observed-strict-envelope": 1,
  "observed-full-envelope": 2,
} as const satisfies Record<Schema.Schema.Type<typeof TeslaDatasetVariantSchema>, number>;

function satisfiesExpectedObservedDatasetVariant(
  actualVariant: Schema.Schema.Type<typeof TeslaDatasetVariantSchema>,
  expectedVariant: ReturnType<typeof inferExpectedObservedDatasetVariant>,
) {
  if (expectedVariant === undefined) {
    return true;
  }

  return DATASET_VARIANT_RANK[actualVariant] >= DATASET_VARIANT_RANK[expectedVariant];
}

function isObservedStrictDatasetProduct(product: DatasetProduct) {
  return (
    "officialTitle" in product &&
    product.officialTitle !== undefined &&
    "modelTokens" in product &&
    "officialIsAccessory" in product &&
    !("strictEligible" in product)
  );
}

function toDatasetMatchKey(product: DatasetProduct, strict: boolean) {
  if (strict) {
    if ("strictEligible" in product && product.strictEligible === false) {
      return [];
    }
    if ("strictPartnerMatches" in product && product.strictPartnerMatches !== undefined) {
      return product.strictPartnerMatches;
    }
    return isObservedStrictDatasetProduct(product) ? product.partnerMatches : [];
  }

  return product.partnerMatches;
}

function readDatasetProductTitle(product: DatasetProduct) {
  const title = "title" in product ? product.title : product.officialTitle;
  if (title === undefined) {
    throw new Error(
      `Tesla dataset product ${JSON.stringify(product.officialUrl)} is missing both "title" and "officialTitle".`,
    );
  }

  return title;
}

export function collectTeslaDatasetCoverage(
  dataset: Schema.Schema.Type<typeof TeslaCompatibleDatasetSchema>,
  rawDataset?: unknown,
) {
  const rawDatasetRecord = readUnknownRecord(rawDataset);
  const rawProducts = Array.isArray(rawDataset)
    ? rawDataset
    : Array.isArray(rawDatasetRecord?.products)
      ? rawDatasetRecord.products
      : [];

  return Schema.decodeUnknownSync(TeslaDatasetCoverageSchema)(
    normalizeProducts(dataset).reduce(
      (coverage, product, productIndex) => {
        const productVariant = classifyTeslaDatasetProductVariant(product);
        const expectedObservedProductVariant = inferExpectedObservedProductVariant(
          rawProducts[productIndex],
        );
        coverage.productCount += 1;
        if (productVariant === "legacy-compatible") {
          coverage.legacyCompatibleProductCount += 1;
        }
        if (productVariant === "observed-full") {
          coverage.observedFullProductCount += 1;
        }
        if (productVariant === "observed-strict") {
          coverage.observedStrictProductCount += 1;
        }
        if ("modelTokens" in product && "officialIsAccessory" in product) {
          coverage.identityReadyProductCount += 1;
        }
        if ("strictPartnerMatches" in product && "strictEligible" in product) {
          coverage.strictReadyProductCount += 1;
        }
        if (
          productVariant === "legacy-compatible" &&
          expectedObservedProductVariant === "observed-full"
        ) {
          coverage.partialObservedFullProductCount += 1;
        }
        if (
          productVariant === "legacy-compatible" &&
          expectedObservedProductVariant === "observed-strict"
        ) {
          coverage.partialObservedStrictProductCount += 1;
        }
        coverage.partnerMatchCount += product.partnerMatches.length;
        coverage.strictPartnerMatchCount +=
          "strictPartnerMatches" in product && product.strictPartnerMatches !== undefined
            ? product.strictPartnerMatches.length
            : 0;
        coverage.titleCount += "title" in product && product.title !== undefined ? 1 : 0;
        coverage.officialTitleCount +=
          "officialTitle" in product && product.officialTitle !== undefined ? 1 : 0;
        coverage.modelTokensCount += "modelTokens" in product ? 1 : 0;
        coverage.officialIsAccessoryCount += "officialIsAccessory" in product ? 1 : 0;
        coverage.strictEligibleCount += "strictEligible" in product ? 1 : 0;
        return coverage;
      },
      {
        productCount: 0,
        legacyCompatibleProductCount: 0,
        observedFullProductCount: 0,
        observedStrictProductCount: 0,
        identityReadyProductCount: 0,
        strictReadyProductCount: 0,
        partialObservedFullProductCount: 0,
        partialObservedStrictProductCount: 0,
        partnerMatchCount: 0,
        strictPartnerMatchCount: 0,
        titleCount: 0,
        officialTitleCount: 0,
        modelTokensCount: 0,
        officialIsAccessoryCount: 0,
        strictEligibleCount: 0,
      },
    ),
  );
}

function inferTeslaDatasetMigrationHints(rawDataset: unknown) {
  const rawDatasetRecord = readUnknownRecord(rawDataset);
  const rawProducts = Array.isArray(rawDataset)
    ? rawDataset
    : Array.isArray(rawDatasetRecord?.products)
      ? rawDatasetRecord.products
      : [];
  const hints = new Array<string>();

  for (const [productIndex, rawProduct] of rawProducts.entries()) {
    const product = readUnknownRecord(rawProduct);
    if (product === undefined) {
      continue;
    }

    const hasTitle = Reflect.has(product, "title");
    const hasOfficialTitle = Reflect.has(product, "officialTitle");
    const hasModelTokens = Reflect.has(product, "modelTokens");
    const hasOfficialIsAccessory = Reflect.has(product, "officialIsAccessory");
    const hasStrictPartnerMatches = Reflect.has(product, "strictPartnerMatches");
    const hasStrictEligible = Reflect.has(product, "strictEligible");

    if (hasModelTokens && !hasOfficialIsAccessory) {
      hints.push(
        `products[${productIndex}] includes modelTokens but is missing officialIsAccessory; observed Tesla dataset products require both fields.`,
      );
    }
    if (hasOfficialIsAccessory && !hasModelTokens) {
      hints.push(
        `products[${productIndex}] includes officialIsAccessory but is missing modelTokens; observed Tesla dataset products require both fields.`,
      );
    }
    if (hasTitle && hasModelTokens && hasOfficialIsAccessory && !hasStrictPartnerMatches) {
      hints.push(
        `products[${productIndex}] looks like an observed full Tesla product but is missing strictPartnerMatches.`,
      );
    }
    if (hasTitle && hasModelTokens && hasOfficialIsAccessory && !hasStrictEligible) {
      hints.push(
        `products[${productIndex}] looks like an observed full Tesla product but is missing strictEligible.`,
      );
    }
    if (hasOfficialTitle && hasModelTokens && hasOfficialIsAccessory && hasStrictEligible) {
      hints.push(
        `products[${productIndex}] mixes observed strict fields with strictEligible; strictEligible belongs to the observed full dataset shape.`,
      );
    }
    if (!hasTitle && !hasOfficialTitle) {
      hints.push(
        `products[${productIndex}] must include either "title" or "officialTitle"; the wrapper cannot derive a product label without one of them.`,
      );
    }
  }

  return [...new Set(hints)];
}

function collectTeslaDatasetDiagnostics(
  rawDataset: unknown,
  dataset: Schema.Schema.Type<typeof TeslaCompatibleDatasetSchema>,
  variant: DatasetVariant,
  strict: boolean,
) {
  const diagnostics: DatasetDiagnostic[] = [];
  const products = normalizeProducts(dataset);
  const rawDatasetRecord = readUnknownRecord(rawDataset);
  const rawProducts = Array.isArray(rawDataset)
    ? rawDataset
    : Array.isArray(rawDatasetRecord?.products)
      ? rawDatasetRecord.products
      : [];

  if (variant === "legacy-array" || variant === "legacy-envelope") {
    diagnostics.push({
      severity: "warning",
      code: "legacy-compatible-input",
      message:
        "Dataset loaded through the legacy-compatible Tesla schema; enriched identity and strict metadata may be missing.",
    });
  }

  if (!Array.isArray(rawDataset)) {
    const allowedFields = DATASET_VARIANT_ALLOWED_TOP_LEVEL_FIELDS[variant];
    for (const field of Object.keys(rawDatasetRecord ?? {})) {
      if (!allowedFields.has(field)) {
        diagnostics.push({
          severity: "warning",
          code: "unknown-top-level-field",
          field,
          message: `Dataset contains unknown top-level field ${JSON.stringify(field)} that is ignored by the Tesla wrapper.`,
        });
      }
    }
  }

  for (const [productIndex, product] of products.entries()) {
    const title = readDatasetProductTitle(product);
    void title;
    const officialUrl = product.officialUrl;
    const rawProduct = rawProducts[productIndex];
    const rawProductRecord = readUnknownRecord(rawProduct);
    const productVariant = classifyTeslaDatasetProductVariant(rawProduct);
    const expectedObservedProductVariant = inferExpectedObservedProductVariant(rawProduct);
    const allowedFieldsVariant = expectedObservedProductVariant ?? productVariant;
    const hasModelTokens =
      "modelTokens" in product ||
      (rawProductRecord !== undefined && "modelTokens" in rawProductRecord);
    const hasOfficialIsAccessory =
      "officialIsAccessory" in product ||
      (rawProductRecord !== undefined && "officialIsAccessory" in rawProductRecord);
    const strictPartnerMatchesCount =
      "strictPartnerMatches" in product && product.strictPartnerMatches !== undefined
        ? product.strictPartnerMatches.length
        : Array.isArray(rawProductRecord?.strictPartnerMatches)
          ? rawProductRecord.strictPartnerMatches.length
          : 0;
    const hasStrictPartnerMatches = strictPartnerMatchesCount > 0;
    const hasStrictEligible =
      "strictEligible" in product ||
      (rawProductRecord !== undefined && "strictEligible" in rawProductRecord);

    if (
      productVariant === "legacy-compatible" &&
      expectedObservedProductVariant === "observed-full"
    ) {
      diagnostics.push({
        severity: "warning",
        code: "partial-observed-full-product",
        productIndex,
        officialUrl,
        message:
          "Dataset product includes observed full Tesla fields but does not satisfy the full observed schema, so the wrapper loaded it through the legacy-compatible path.",
      });
    }
    if (
      productVariant === "legacy-compatible" &&
      expectedObservedProductVariant === "observed-strict"
    ) {
      diagnostics.push({
        severity: "warning",
        code: "partial-observed-strict-product",
        productIndex,
        officialUrl,
        message:
          "Dataset product includes observed strict Tesla fields but does not satisfy the strict observed schema, so the wrapper loaded it through the legacy-compatible path.",
      });
    }

    for (const field of Object.keys(rawProductRecord ?? {})) {
      if (!PRODUCT_VARIANT_ALLOWED_FIELDS[allowedFieldsVariant].has(field)) {
        diagnostics.push({
          severity: "warning",
          code: "unknown-product-field",
          productIndex,
          field,
          officialUrl,
          message: `Dataset product contains unknown field ${JSON.stringify(field)} that is ignored by the Tesla wrapper.`,
        });
      }
    }

    if (!hasModelTokens) {
      diagnostics.push({
        severity: "warning",
        code: "missing-model-tokens",
        message:
          "Dataset product is missing modelTokens, so identity-aware matching will be weaker.",
        productIndex,
        officialUrl,
      });
    }
    if (!hasOfficialIsAccessory) {
      diagnostics.push({
        severity: "warning",
        code: "missing-official-accessory-flag",
        message:
          "Dataset product is missing officialIsAccessory, so accessory-vs-product identity checks cannot be made explicit.",
        productIndex,
        officialUrl,
      });
    }
    const strictIneligibleProduct = "strictEligible" in product && product.strictEligible === false;
    if (variant !== "observed-strict-envelope" && !hasStrictPartnerMatches) {
      diagnostics.push({
        severity: "warning",
        code: "missing-strict-partner-matches",
        message: strictIneligibleProduct
          ? "Dataset product is missing strictPartnerMatches and marks strictEligible=false, so strict-mode benchmarking will exclude this product."
          : "Dataset product is missing strictPartnerMatches, so strict-mode benchmarking will fall back to partnerMatches for this product.",
        productIndex,
        officialUrl,
      });
      if (strict && !strictIneligibleProduct) {
        diagnostics.push({
          severity: "warning",
          code: "strict-fallback-partner-matches",
          message:
            "Strict mode requested but strictPartnerMatches are unavailable, so the wrapper will fall back to partnerMatches for this product.",
          productIndex,
          officialUrl,
        });
      }
    }
    if (variant !== "observed-strict-envelope" && !hasStrictEligible) {
      diagnostics.push({
        severity: "warning",
        code: "missing-strict-eligibility",
        message:
          "Dataset product is missing strictEligible, so strict eligibility cannot be distinguished from missing strict data.",
        productIndex,
        officialUrl,
      });
    }
  }

  return diagnostics;
}

export function loadTeslaCompatibleDataset(
  rawDataset: unknown,
  options?: { readonly strict?: boolean },
) {
  try {
    validateObservedDatasetTopLevelMetadata(rawDataset);
    validateObservedDatasetProductFields(rawDataset);
    const expectedObservedVariant = inferExpectedObservedDatasetVariant(rawDataset);

    if (
      expectedObservedVariant === "observed-strict-envelope" &&
      !Schema.is(TeslaObservedStrictDatasetEnvelopeSchema)(rawDataset)
    ) {
      throw new Error(
        "Tesla dataset includes observed strict-format fields but does not satisfy the corresponding observed schema.",
      );
    }

    const dataset = Schema.decodeUnknownSync(TeslaCompatibleDatasetSchema)(rawDataset);
    const variant = classifyTeslaDatasetVariant(dataset);

    if (!satisfiesExpectedObservedDatasetVariant(variant, expectedObservedVariant)) {
      throw new Error(
        `Tesla dataset includes ${expectedObservedVariant === "observed-full-envelope" ? "observed full-format fields" : "observed strict-format fields"} but does not satisfy the corresponding observed schema.`,
      );
    }

    const diagnostics = collectTeslaDatasetDiagnostics(
      rawDataset,
      dataset,
      variant,
      options?.strict ?? false,
    );
    const coverage = collectTeslaDatasetCoverage(dataset, rawDataset);

    if (
      options?.strict === true &&
      diagnostics.some((diagnostic) => diagnostic.code === "strict-fallback-partner-matches")
    ) {
      throw new Error(
        "Strict Tesla dataset benchmarking requires strict-ready partner matches; partnerMatches fallback is not allowed in --strict mode.",
      );
    }

    return Schema.decodeUnknownSync(TeslaCompatibleDatasetLoadResultSchema)({
      dataset,
      variant,
      diagnostics,
      coverage,
    });
  } catch (cause) {
    const hints = inferTeslaDatasetMigrationHints(rawDataset);
    const fallback = hints.some((hint) => hint.includes("is missing both title and officialTitle"))
      ? 'Tesla dataset products must include either "title" or "officialTitle".'
      : readCauseMessage(cause, "Tesla dataset failed schema validation.");
    throw new Error(
      hints.length === 0
        ? fallback
        : `${fallback} Migration diagnostics: ${hints.map((hint) => `- ${hint}`).join(" ")}`,
      { cause },
    );
  }
}

function collectTeslaExpectationSidecarDiagnostics(
  rawSidecar: unknown,
  sidecar: TeslaExpectationSidecar,
  evaluatedAt: string,
  freshnessPolicy: TeslaResolvedExpectationFreshnessPolicy,
) {
  const diagnostics: Schema.Schema.Type<typeof TeslaExpectationSidecarDiagnosticSchema>[] = [];
  const rawSidecarRecord = readUnknownRecord(rawSidecar);
  const rawProducts = Array.isArray(rawSidecarRecord?.products) ? rawSidecarRecord.products : [];
  const normalizedPartnerUrlToMatches = new Map<
    string,
    Array<{
      readonly productIndex: number;
      readonly expectationIndex: number;
      readonly officialUrl: string;
      readonly partnerUrl: string;
    }>
  >();

  for (const field of Object.keys(rawSidecarRecord ?? {})) {
    if (!SIDECAR_ALLOWED_TOP_LEVEL_FIELDS.has(field)) {
      diagnostics.push({
        severity: "warning",
        code: "unknown-top-level-field",
        field,
        message: `Tesla expectation sidecar contains unknown top-level field ${JSON.stringify(field)} that is ignored by the loader.`,
      });
    }
  }

  for (const [productIndex, product] of sidecar.products.entries()) {
    const rawProductRecord = readUnknownRecord(rawProducts[productIndex]);
    for (const field of Object.keys(rawProductRecord ?? {})) {
      if (!SIDECAR_ALLOWED_PRODUCT_FIELDS.has(field)) {
        diagnostics.push({
          severity: "warning",
          code: "unknown-product-field",
          productIndex,
          officialUrl: product.officialUrl,
          field,
          message: `Tesla expectation sidecar product contains unknown field ${JSON.stringify(field)} that is ignored by the loader.`,
        });
      }
    }
    if (product.modelTokens === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "missing-model-tokens",
        productIndex,
        officialUrl: product.officialUrl,
        field: "modelTokens",
        message:
          "Tesla expectation sidecar product is missing modelTokens, so future identity-aware truth scoring will be weaker.",
      });
    }

    const rawExpectations = Array.isArray(rawProductRecord?.partnerExpectations)
      ? rawProductRecord.partnerExpectations
      : [];
    for (const [expectationIndex, expectation] of product.partnerExpectations.entries()) {
      const rawExpectationRecord = readUnknownRecord(rawExpectations[expectationIndex]);
      for (const field of Object.keys(rawExpectationRecord ?? {})) {
        if (!SIDECAR_ALLOWED_EXPECTATION_FIELDS.has(field)) {
          diagnostics.push({
            severity: "warning",
            code: "unknown-partner-expectation-field",
            productIndex,
            expectationIndex,
            officialUrl: product.officialUrl,
            partnerUrl: expectation.partnerUrl,
            field,
            message: `Tesla expectation sidecar partner expectation contains unknown field ${JSON.stringify(field)} that is ignored by the loader.`,
          });
        }
      }

      const normalizedPartnerUrl = normalizeTeslaExpectationJoinUrl(expectation.partnerUrl);
      const currentMatches = normalizedPartnerUrlToMatches.get(normalizedPartnerUrl) ?? [];
      currentMatches.push({
        productIndex,
        expectationIndex,
        officialUrl: product.officialUrl,
        partnerUrl: expectation.partnerUrl,
      });
      normalizedPartnerUrlToMatches.set(normalizedPartnerUrl, currentMatches);

      if (expectation.price !== undefined) {
        const priceFreshness = classifyTeslaExpectationFreshness(
          expectation.price.capturedAt,
          freshnessPolicy.priceMaxAgeHours,
          freshnessPolicy.priceExpireAgeHours,
          evaluatedAt,
        );
        const priceDiagnostic = resolveTeslaExpectationFreshnessDiagnostic({
          field: "price",
          freshness: priceFreshness,
          freshnessPolicy,
        });
        if (priceDiagnostic !== undefined) {
          diagnostics.push({
            severity: priceDiagnostic.severity,
            code: priceDiagnostic.code,
            productIndex,
            expectationIndex,
            officialUrl: product.officialUrl,
            partnerUrl: expectation.partnerUrl,
            field: priceDiagnostic.field,
            message: priceDiagnostic.message,
          });
        }
      }

      if (expectation.description !== undefined) {
        const descriptionFreshness = classifyTeslaExpectationFreshness(
          expectation.description.capturedAt,
          freshnessPolicy.descriptionMaxAgeHours,
          freshnessPolicy.descriptionExpireAgeHours,
          evaluatedAt,
        );
        const descriptionDiagnostic = resolveTeslaExpectationFreshnessDiagnostic({
          field: "description",
          freshness: descriptionFreshness,
          freshnessPolicy,
        });
        if (descriptionDiagnostic !== undefined) {
          diagnostics.push({
            severity: descriptionDiagnostic.severity,
            code: descriptionDiagnostic.code,
            productIndex,
            expectationIndex,
            officialUrl: product.officialUrl,
            partnerUrl: expectation.partnerUrl,
            field: descriptionDiagnostic.field,
            message: descriptionDiagnostic.message,
          });
        }
      }
    }
  }

  for (const [normalizedPartnerUrl, matches] of normalizedPartnerUrlToMatches.entries()) {
    if (matches.length <= 1) {
      continue;
    }
    for (const match of matches) {
      diagnostics.push({
        severity: "warning",
        code: "ambiguous-normalized-partner-url",
        productIndex: match.productIndex,
        expectationIndex: match.expectationIndex,
        officialUrl: match.officialUrl,
        partnerUrl: match.partnerUrl,
        normalizedPartnerUrl,
        field: "partnerUrl",
        message: `Tesla expectation sidecar normalizes multiple partner expectations to ${JSON.stringify(normalizedPartnerUrl)}, so corpus joins may become ambiguous.`,
      });
    }
  }

  return diagnostics;
}

export function collectTeslaExpectationSidecarCoverage(
  sidecar: TeslaExpectationSidecar,
  options?: { readonly evaluatedAt?: string },
) {
  const evaluatedAt = options?.evaluatedAt ?? sidecar.generatedAt;
  const freshnessPolicy = resolveTeslaExpectationFreshnessPolicy(sidecar);
  const seenNormalizedPartnerUrls = new Set<string>();

  return Schema.decodeUnknownSync(TeslaExpectationSidecarCoverageSchema)(
    sidecar.products.reduce(
      (coverage, product) => {
        coverage.productCount += 1;
        if (product.modelTokens !== undefined) {
          coverage.productWithModelTokensCount += 1;
        }
        for (const expectation of product.partnerExpectations) {
          coverage.partnerExpectationCount += 1;
          const normalizedPartnerUrl = normalizeTeslaExpectationJoinUrl(expectation.partnerUrl);
          if (seenNormalizedPartnerUrls.has(normalizedPartnerUrl)) {
            coverage.ambiguousNormalizedPartnerUrlCount += 1;
          } else {
            seenNormalizedPartnerUrls.add(normalizedPartnerUrl);
          }
          if (expectation.title !== undefined) {
            coverage.titleExpectationCount += 1;
          }
          if (expectation.price !== undefined) {
            coverage.priceExpectationCount += 1;
            const freshness = classifyTeslaExpectationFreshness(
              expectation.price.capturedAt,
              freshnessPolicy.priceMaxAgeHours,
              freshnessPolicy.priceExpireAgeHours,
              evaluatedAt,
            );
            if (freshness === "fresh") {
              coverage.freshPriceExpectationCount += 1;
            } else if (freshness === "stale") {
              coverage.stalePriceExpectationCount += 1;
            } else if (freshness === "expired") {
              coverage.expiredPriceExpectationCount += 1;
            } else if (freshness === "future-captured-at") {
              coverage.futurePriceCapturedAtCount += 1;
            } else {
              coverage.missingPriceCapturedAtCount += 1;
            }
          }
          if (expectation.description !== undefined) {
            coverage.descriptionExpectationCount += 1;
            const freshness = classifyTeslaExpectationFreshness(
              expectation.description.capturedAt,
              freshnessPolicy.descriptionMaxAgeHours,
              freshnessPolicy.descriptionExpireAgeHours,
              evaluatedAt,
            );
            if (freshness === "fresh") {
              coverage.freshDescriptionExpectationCount += 1;
            } else if (freshness === "stale") {
              coverage.staleDescriptionExpectationCount += 1;
            } else if (freshness === "expired") {
              coverage.expiredDescriptionExpectationCount += 1;
            } else if (freshness === "future-captured-at") {
              coverage.futureDescriptionCapturedAtCount += 1;
            } else {
              coverage.missingDescriptionCapturedAtCount += 1;
            }
          }
        }
        return coverage;
      },
      {
        productCount: 0,
        productWithModelTokensCount: 0,
        partnerExpectationCount: 0,
        titleExpectationCount: 0,
        priceExpectationCount: 0,
        descriptionExpectationCount: 0,
        ambiguousNormalizedPartnerUrlCount: 0,
        freshPriceExpectationCount: 0,
        stalePriceExpectationCount: 0,
        expiredPriceExpectationCount: 0,
        missingPriceCapturedAtCount: 0,
        futurePriceCapturedAtCount: 0,
        freshDescriptionExpectationCount: 0,
        staleDescriptionExpectationCount: 0,
        expiredDescriptionExpectationCount: 0,
        missingDescriptionCapturedAtCount: 0,
        futureDescriptionCapturedAtCount: 0,
      },
    ),
  );
}

export function loadTeslaExpectationSidecar(
  rawSidecar: unknown,
  options?: { readonly evaluatedAt?: string },
) {
  const sidecar = Schema.decodeUnknownSync(TeslaExpectationSidecarSchema)(rawSidecar);
  const evaluatedAt = Schema.decodeUnknownSync(IsoDateTimeSchema)(
    options?.evaluatedAt ?? sidecar.generatedAt,
  );
  const freshnessPolicy = resolveTeslaExpectationFreshnessPolicy(sidecar);
  const diagnostics = collectTeslaExpectationSidecarDiagnostics(
    rawSidecar,
    sidecar,
    evaluatedAt,
    freshnessPolicy,
  );
  const coverage = collectTeslaExpectationSidecarCoverage(sidecar, {
    evaluatedAt,
  });

  return Schema.decodeUnknownSync(TeslaExpectationSidecarLoadResultSchema)({
    sidecar,
    evaluatedAt,
    freshnessPolicy,
    diagnostics,
    coverage,
  });
}

async function resolveDatasetPath(path: string, explicit: boolean, strict: boolean) {
  if (explicit) {
    return resolve(path);
  }

  const entries = await readdir(path, { withFileTypes: true });
  const candidate = selectPreferredTeslaDatasetFile(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
    strict,
  );

  if (candidate === undefined) {
    throw new Error(
      `No Tesla dataset matching ${DEFAULT_DATASET_FILE_PATTERN.source} or ${DEFAULT_STRICT_DATASET_FILE_PATTERN.source} found in ${resolve(path)}. Pass --dataset explicitly.`,
    );
  }

  return resolve(path, candidate);
}

export function selectPreferredTeslaDatasetFile(
  candidateNames: readonly string[],
  strict: boolean,
) {
  const sortNewestFirst = (pattern: RegExp) =>
    candidateNames
      .filter((name) => pattern.test(name))
      .sort((left, right) => right.localeCompare(left));

  const strictCandidates = sortNewestFirst(DEFAULT_STRICT_DATASET_FILE_PATTERN);
  const fullCandidates = sortNewestFirst(DEFAULT_DATASET_FILE_PATTERN);

  return strict ? strictCandidates[0] : (fullCandidates[0] ?? strictCandidates[0]);
}

function normalizePartnerUrlDomain(partnerUrl: string) {
  return new URL(partnerUrl).hostname.replace(/^www\./u, "");
}

function validatePartnerUrlDomain(
  partner: Schema.Schema.Type<typeof PartnerSchema>,
  partnerUrl: string,
) {
  const metadata = PARTNER_SITE_METADATA[partner];
  const normalizedDomain = normalizePartnerUrlDomain(partnerUrl);

  if (!metadata.expectedDomains.includes(normalizedDomain)) {
    throw new Error(
      `Tesla dataset partner ${JSON.stringify(partner)} expected one of ${metadata.expectedDomains.join(", ")} but received ${JSON.stringify(normalizedDomain)} from ${JSON.stringify(partnerUrl)}.`,
    );
  }

  return normalizedDomain;
}

function buildTeslaExpectationLookupIndex(
  sidecar: Schema.Schema.Type<typeof TeslaExpectationSidecarSchema>,
) {
  const expectationByUrl = new Map<string, TeslaExpectationLookupMatch[]>();

  for (const product of sidecar.products) {
    for (const expectation of product.partnerExpectations) {
      validatePartnerUrlDomain(expectation.partner, expectation.partnerUrl);
      const normalizedPartnerUrl = normalizeTeslaExpectationJoinUrl(expectation.partnerUrl);
      const current = expectationByUrl.get(normalizedPartnerUrl) ?? [];
      current.push({
        officialUrl: product.officialUrl,
        expectation,
      });
      expectationByUrl.set(normalizedPartnerUrl, current);
    }
  }

  for (const [normalizedPartnerUrl, candidates] of expectationByUrl) {
    expectationByUrl.set(
      normalizedPartnerUrl,
      [...candidates].sort(
        (left, right) =>
          left.officialUrl.localeCompare(right.officialUrl) ||
          left.expectation.partner.localeCompare(right.expectation.partner) ||
          left.expectation.partnerUrl.localeCompare(right.expectation.partnerUrl),
      ),
    );
  }

  return expectationByUrl;
}

export function normalizeTeslaExpectationJoinUrl(url: string) {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.hostname = parsed.hostname.replace(/^www\./u, "").toLowerCase();
  for (const key of new Set(parsed.searchParams.keys())) {
    if (TRACKING_QUERY_PARAM_PATTERN.test(key)) {
      parsed.searchParams.delete(key);
    }
  }
  if (parsed.pathname !== "/") {
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  }
  parsed.searchParams.sort();
  return parsed.toString();
}

function lookupTeslaExpectationByNormalizedPartnerUrl(
  expectationByUrl: ReadonlyMap<string, readonly TeslaExpectationLookupMatch[]>,
  normalizedPartnerUrl: string,
  partnerUrl: string,
  strict: boolean,
) {
  const candidates = expectationByUrl.get(normalizedPartnerUrl) ?? [];
  const matches = strict
    ? candidates.filter(({ expectation }) => expectation.strictEligible === true)
    : candidates;
  let status: TeslaExpectationJoinStatus = "missing";

  if (matches.length === 0) {
    if (strict && candidates.length > 0) {
      status = "strict-excluded";
    }
  } else if (matches.length === 1) {
    status = "matched";
  } else {
    status = "ambiguous";
  }

  return Schema.decodeUnknownSync(TeslaExpectationLookupResultSchema)({
    status,
    partnerUrl,
    normalizedPartnerUrl,
    strict,
    matchCount: matches.length,
    matches,
  });
}

export function lookupTeslaExpectationByPartnerUrl(
  sidecar: Schema.Schema.Type<typeof TeslaExpectationSidecarSchema>,
  partnerUrl: string,
  options?: { readonly strict?: boolean },
) {
  const strict = options?.strict ?? false;
  const normalizedPartnerUrl = normalizeTeslaExpectationJoinUrl(partnerUrl);
  return lookupTeslaExpectationByNormalizedPartnerUrl(
    buildTeslaExpectationLookupIndex(sidecar),
    normalizedPartnerUrl,
    partnerUrl,
    strict,
  );
}

export function joinTeslaExpectationSidecarToCorpus(
  corpusArtifact: Schema.Schema.Type<typeof E9CommerceCorpusFreezeArtifactSchema>,
  sidecar: Schema.Schema.Type<typeof TeslaExpectationSidecarSchema>,
  options?: { readonly strict?: boolean },
) {
  const strict = options?.strict ?? false;
  const expectationByUrl = buildTeslaExpectationLookupIndex(sidecar);

  const records = corpusArtifact.pages.map((page) => {
    const lookup = lookupTeslaExpectationByNormalizedPartnerUrl(
      expectationByUrl,
      normalizeTeslaExpectationJoinUrl(page.url),
      page.url,
      strict,
    );
    const resolvedCandidate = lookup.matches.length === 1 ? lookup.matches[0] : undefined;

    return Schema.decodeUnknownSync(TeslaExpectationJoinRecordSchema)({
      status: lookup.status,
      pageUrl: page.url,
      normalizedPageUrl: lookup.normalizedPartnerUrl,
      siteId: page.siteId,
      domain: page.domain,
      pageType: page.pageType,
      matchCount: lookup.matchCount,
      officialUrl: resolvedCandidate?.officialUrl,
      expectation: resolvedCandidate?.expectation,
    });
  });

  return Schema.decodeUnknownSync(TeslaExpectationJoinResultSchema)({
    strict,
    matchedCount: records.filter((record) => record.status === "matched").length,
    missingCount: records.filter((record) => record.status === "missing").length,
    ambiguousCount: records.filter((record) => record.status === "ambiguous").length,
    strictExcludedCount: records.filter((record) => record.status === "strict-excluded").length,
    records,
  });
}

export function buildTeslaPartnerCorpusArtifact(
  datasetPath: string,
  dataset: Schema.Schema.Type<typeof TeslaCompatibleDatasetSchema>,
  strict: boolean,
) {
  const pageByUrl = new Map<
    string,
    {
      readonly siteId: string;
      readonly domain: string;
      readonly kind: "retailer" | "aggregator";
      readonly state: "healthy";
      readonly url: string;
      readonly pageType: "product";
      readonly title: string;
      readonly challengeSignals: readonly string[];
    }
  >();

  for (const product of normalizeProducts(dataset)) {
    const matches = toDatasetMatchKey(product, strict);
    const title = readDatasetProductTitle(product);
    for (const match of matches) {
      const site = PARTNER_SITE_METADATA[match.partner];
      const domain = validatePartnerUrlDomain(match.partner, match.partnerUrl);
      const normalizedPartnerUrl = normalizeTeslaExpectationJoinUrl(match.partnerUrl);
      pageByUrl.set(normalizedPartnerUrl, {
        siteId: site.siteId,
        domain,
        kind: site.kind,
        state: "healthy",
        url: match.partnerUrl,
        pageType: "product",
        title,
        challengeSignals: [],
      });
    }
  }

  const pages = [...pageByUrl.values()].sort(
    (left, right) => left.siteId.localeCompare(right.siteId) || left.url.localeCompare(right.url),
  );
  const allocations = [
    ...pages
      .reduce(
        (sites, page) => {
          const current = sites.get(page.siteId);
          sites.set(page.siteId, {
            siteId: page.siteId,
            domain: page.domain,
            state: "healthy" as const,
            kind: page.kind,
            availableSelectedPageCount: (current?.availableSelectedPageCount ?? 0) + 1,
            allocatedPageCount: (current?.allocatedPageCount ?? 0) + 1,
          });
          return sites;
        },
        new Map<
          string,
          {
            readonly siteId: string;
            readonly domain: string;
            readonly state: "healthy";
            readonly kind: "retailer" | "aggregator";
            readonly availableSelectedPageCount: number;
            readonly allocatedPageCount: number;
          }
        >(),
      )
      .values(),
  ].sort((left, right) => left.siteId.localeCompare(right.siteId));

  if (pages.length === 0) {
    throw new Error(
      strict
        ? "Strict Tesla dataset benchmark produced no partner pages. Use the full dataset or rerun without --strict."
        : "Tesla dataset benchmark produced no partner pages.",
    );
  }

  return Schema.decodeUnknownSync(E9CommerceCorpusFreezeArtifactSchema)({
    benchmark: "e9-commerce-corpus-freeze",
    generatedAt: new Date().toISOString(),
    sourceArtifactPath: resolve(datasetPath),
    targetPageCount: pages.length,
    selectedPageCount: pages.length,
    selectedSiteCount: allocations.length,
    minimumSiteCount: allocations.length,
    siteCoverage: 1,
    pageCoverage: 1,
    shortfallCount: 0,
    pages,
    allocations,
  });
}

function summarizeAttemptsBySite(attempts: readonly BenchmarkAttempt[]) {
  const summary = new Map<
    string,
    {
      readonly site: string;
      readonly domain: string;
      attemptCount: number;
      successCount: number;
      blockedCount: number;
      challengeCount: number;
    }
  >();

  for (const attempt of attempts) {
    const key = `${attempt.siteId}|${attempt.domain}`;
    const current = summary.get(key) ?? {
      site: attempt.siteId,
      domain: attempt.domain,
      attemptCount: 0,
      successCount: 0,
      blockedCount: 0,
      challengeCount: 0,
    };
    current.attemptCount += 1;
    current.successCount += attempt.success ? 1 : 0;
    current.blockedCount += attempt.blocked ? 1 : 0;
    current.challengeCount += attempt.challengeDetected ? 1 : 0;
    summary.set(key, current);
  }

  return [...summary.values()]
    .map((entry) => ({
      site: entry.site,
      domain: entry.domain,
      attempts: entry.attemptCount,
      successRate: Number((entry.successCount / entry.attemptCount).toFixed(3)),
      blockedRate: Number((entry.blockedCount / entry.attemptCount).toFixed(3)),
      challengeRate: Number((entry.challengeCount / entry.attemptCount).toFixed(3)),
    }))
    .sort((left, right) => right.attempts - left.attempts || left.site.localeCompare(right.site));
}

function summarizeDataset(
  dataset: Schema.Schema.Type<typeof TeslaCompatibleDatasetSchema>,
  corpusArtifact: Schema.Schema.Type<typeof E9CommerceCorpusFreezeArtifactSchema>,
  strict: boolean,
  variant: DatasetVariant,
  diagnostics: readonly DatasetDiagnostic[],
  coverage: DatasetCoverage,
) {
  const products = normalizeProducts(dataset);

  return {
    strict,
    variant,
    productCount: products.length,
    benchmarkPageCount: corpusArtifact.selectedPageCount,
    diagnostics,
    coverage,
    benchmarkPartnerCounts: Object.fromEntries(
      corpusArtifact.allocations
        .map((allocation) => [allocation.siteId, allocation.allocatedPageCount] as const)
        .sort((left, right) => left[0].localeCompare(right[0])),
    ),
  };
}

async function persistArtifact(path: string, artifact: unknown) {
  const resolvedPath = resolve(path);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return resolvedPath;
}

async function applyDefaultBenchmarkArgs(
  args: readonly string[],
  options: {
    readonly hasBundledWireproxyAssets?: () => Promise<boolean>;
  } = {},
) {
  let nextArgs = [...args];

  if (!hasOption(nextArgs, "--artifact")) {
    nextArgs.push("--artifact", DEFAULT_BENCHMARK_ARTIFACT_PATH);
  }

  const explicitPreset = readOptionValue(nextArgs, "--preset");
  const hasNonPresetShapeOverride = hasAnyOption(nextArgs, BENCHMARK_NON_PRESET_SHAPE_OPTIONS);
  const shouldApplyRecommendedPreset = explicitPreset === undefined && !hasNonPresetShapeOverride;
  const usesRecommendedPreset =
    shouldApplyRecommendedPreset ||
    (explicitPreset === DEFAULT_BENCHMARK_PRESET && !hasNonPresetShapeOverride);

  if (explicitPreset === DEFAULT_BENCHMARK_PRESET && hasNonPresetShapeOverride) {
    nextArgs = stripOption(nextArgs, "--preset");
  }

  if (shouldApplyRecommendedPreset) {
    nextArgs.push("--preset", DEFAULT_BENCHMARK_PRESET);
  }

  if (usesRecommendedPreset) {
    if (!hasOption(nextArgs, "--browser-concurrency")) {
      nextArgs.push("--browser-concurrency", DEFAULT_BROWSER_CONCURRENCY);
    }

    if (!hasOption(nextArgs, "--browser-timeout")) {
      nextArgs.push("--browser-timeout", DEFAULT_BROWSER_TIMEOUT_MS);
    }
  }

  const shouldNormalizeWireproxyConfig =
    usesRecommendedPreset ||
    hasAnyOption(nextArgs, BENCHMARK_WIREPROXY_SOURCE_OPTIONS) ||
    hasOption(nextArgs, "--wireproxy-generated-manifest") ||
    hasAnyOption(nextArgs, BENCHMARK_WIREPROXY_MODE_OPTIONS) ||
    hasAnyOption(nextArgs, BENCHMARK_WIREPROXY_TUNABLE_OPTIONS);

  if (shouldNormalizeWireproxyConfig) {
    const bundledWireproxyAssetsAvailable = await (
      options.hasBundledWireproxyAssets ?? defaultHasBundledWireproxyAssets
    )();
    const hasWireproxySourceOverride = hasAnyOption(nextArgs, BENCHMARK_WIREPROXY_SOURCE_OPTIONS);
    const hasWireproxyModeOverride = hasAnyOption(nextArgs, BENCHMARK_WIREPROXY_MODE_OPTIONS);
    const hasExplicitCustomWireproxyManifest = hasOption(nextArgs, "--wireproxy-manifest");
    const hasExplicitGeneratedWireproxyManifest = hasOption(
      nextArgs,
      "--wireproxy-generated-manifest",
    );
    const hasExplicitBundledWireproxySource = hasOption(nextArgs, "--wireproxy-bundled");

    if (
      hasExplicitGeneratedWireproxyManifest &&
      !hasWireproxySourceOverride &&
      !bundledWireproxyAssetsAvailable
    ) {
      throw new Error(
        "Wireproxy generated metadata requires --wireproxy-manifest or --wireproxy-bundled to supply the actual proxy pool.",
      );
    }

    const shouldInjectBundledWireproxySource =
      !hasWireproxySourceOverride && bundledWireproxyAssetsAvailable;

    if (shouldInjectBundledWireproxySource) {
      nextArgs.push("--wireproxy-bundled");
    }

    const hasWireproxySource = hasWireproxySourceOverride || shouldInjectBundledWireproxySource;
    const canAutoRotateWireproxySource =
      shouldInjectBundledWireproxySource ||
      hasExplicitBundledWireproxySource ||
      hasExplicitGeneratedWireproxyManifest;
    const shouldInjectWireproxyRotation = !hasWireproxyModeOverride && hasWireproxySource;

    if (
      shouldInjectWireproxyRotation &&
      !canAutoRotateWireproxySource &&
      hasExplicitCustomWireproxyManifest
    ) {
      throw new Error(
        "Custom wireproxy manifests require --wireproxy-generated-manifest for rotation defaults, or explicit --wireproxy-entry to select a single exit.",
      );
    }

    if (shouldInjectWireproxyRotation && canAutoRotateWireproxySource) {
      nextArgs.push("--wireproxy-rotate");
    }

    if (
      (shouldInjectWireproxyRotation || hasOption(nextArgs, "--wireproxy-rotate")) &&
      !hasOption(nextArgs, "--wireproxy-rotation-fallbacks")
    ) {
      nextArgs.push("--wireproxy-rotation-fallbacks", DEFAULT_WIREPROXY_ROTATION_FALLBACKS);
    }

    if (hasWireproxySource && !hasOption(nextArgs, "--wireproxy-transport")) {
      nextArgs.push("--wireproxy-transport", DEFAULT_WIREPROXY_TRANSPORT);
    }
  }

  return nextArgs;
}

export async function runTeslaPartnerDatasetBenchmarkCli(
  args: readonly string[],
  dependencies: {
    readonly setExitCode?: (code: number) => void;
    readonly writeLine?: (line: string) => void;
    readonly writeProgressLine?: (line: string) => void;
    readonly runBenchmarkSuiteCli?: typeof runE9BenchmarkSuiteCli;
    readonly hasBundledWireproxyAssets?: () => Promise<boolean>;
  } = {},
) {
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  const applyExitCode = (code: number) => {
    setExitCode(code);
  };
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));
  const runBenchmarkSuiteCli = dependencies.runBenchmarkSuiteCli ?? runE9BenchmarkSuiteCli;

  try {
    const options = parseTeslaPartnerDatasetOptions(args);
    const datasetPath = await resolveDatasetPath(
      options.datasetPath,
      options.datasetPathExplicit,
      options.strict,
    );
    const rawDataset = JSON.parse(await readFile(datasetPath, "utf8"));

    if (
      options.strict &&
      !Schema.is(TeslaObservedFullDatasetEnvelopeSchema)(rawDataset) &&
      !Schema.is(TeslaObservedStrictDatasetEnvelopeSchema)(rawDataset)
    ) {
      throw new Error(
        `Strict Tesla dataset file ${JSON.stringify(datasetPath)} must satisfy the observed strict or observed full dataset schema.`,
      );
    }

    const { dataset, diagnostics, variant, coverage } = loadTeslaCompatibleDataset(rawDataset, {
      strict: options.strict,
    });
    const corpusArtifact = buildTeslaPartnerCorpusArtifact(datasetPath, dataset, options.strict);
    const corpusArtifactPath = await persistArtifact(options.corpusArtifactPath, corpusArtifact);
    const benchmarkArtifact = Schema.decodeUnknownSync(E9BenchmarkSuiteArtifactSchema)(
      await runBenchmarkSuiteCli(
        await applyDefaultBenchmarkArgs(
          [...options.forwardedArgs, "--corpus", corpusArtifactPath],
          {
            hasBundledWireproxyAssets: dependencies.hasBundledWireproxyAssets,
          },
        ),
        {
          ...dependencies,
          writeLine: () => undefined,
          writeProgressLine: () => undefined,
        },
      ),
    );
    if (benchmarkArtifact.status !== "pass") {
      applyExitCode(1);
    }

    writeLine(
      JSON.stringify(
        {
          datasetPath,
          corpusArtifactPath,
          dataset: summarizeDataset(
            dataset,
            corpusArtifact,
            options.strict,
            variant,
            diagnostics,
            coverage,
          ),
          httpBySite: summarizeAttemptsBySite(benchmarkArtifact.httpCorpus.attempts),
          browserBySite: summarizeAttemptsBySite(benchmarkArtifact.browserCorpus.attempts),
        },
        null,
        2,
      ),
    );

    return benchmarkArtifact;
  } catch (cause) {
    applyExitCode(1);
    throw new Error(readCauseMessage(cause, "Failed to run the Tesla partner dataset benchmark."));
  }
}

if (import.meta.main) {
  await runTeslaPartnerDatasetBenchmarkCli(process.argv.slice(2));
  process.exit(process.exitCode ?? 0);
}
