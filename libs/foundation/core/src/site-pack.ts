import { Effect, Schema, SchemaGetter } from "effect";
import { AccessModeSchema, RenderingPolicySchema } from "./access-policy.ts";
import {
  BusinessInvariantAssertionSchema,
  RequiredFieldAssertionSchema,
} from "./assertion-engine.ts";
import { CanonicalDomainSchema, CanonicalIdentifierSchema } from "./schema-primitives.ts";
import { SelectorCandidateSchema, SelectorFallbackPolicySchema } from "./selector-engine.ts";
import { TargetKindSchema } from "./target-profile.ts";

const DOMAIN_PATTERN_SCHEMA = Schema.String.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.check(Schema.isLowercased()),
  Schema.decode({
    decode: SchemaGetter.checkEffect((value) =>
      Effect.succeed(
        /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(
          value,
        ) &&
          !value.includes("://") &&
          !/\s/gu.test(value)
          ? undefined
          : "Expected a lowercased domain pattern without protocol or whitespace.",
      ),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);

const PACK_VERSION_SCHEMA = Schema.Trim.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.decode({
    decode: SchemaGetter.checkEffect((value) =>
      Effect.succeed(
        !/\s/gu.test(value) ? undefined : "Expected a non-empty pack version without whitespace.",
      ),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);

export const PackVersionSchema = PACK_VERSION_SCHEMA;

const PACK_VERSION_SEGMENT_PATTERN = /[A-Za-z]+|\d+/gu;

function packVersionSegments(version: string) {
  return version.match(PACK_VERSION_SEGMENT_PATTERN) ?? [version];
}

function isNumericPackVersionSegment(segment: string) {
  return /^\d+$/u.test(segment);
}

export function comparePackVersions(left: string, right: string) {
  const leftSegments = packVersionSegments(left);
  const rightSegments = packVersionSegments(right);
  const segmentCount = Math.max(leftSegments.length, rightSegments.length);

  for (let index = 0; index < segmentCount; index += 1) {
    const leftSegment = leftSegments[index];
    const rightSegment = rightSegments[index];

    if (leftSegment === undefined) {
      return -1;
    }

    if (rightSegment === undefined) {
      return 1;
    }

    if (isNumericPackVersionSegment(leftSegment) && isNumericPackVersionSegment(rightSegment)) {
      const numericDelta = Number(leftSegment) - Number(rightSegment);
      if (numericDelta !== 0) {
        return numericDelta;
      }

      continue;
    }

    const segmentDelta = leftSegment.localeCompare(rightSegment);
    if (segmentDelta !== 0) {
      return segmentDelta;
    }
  }

  return left.localeCompare(right);
}

const DEFAULT_PACK_LOOKUP_STATES = ["active", "shadow"] as const;

export const PackStateSchema = Schema.Literals([
  "draft",
  "shadow",
  "active",
  "guarded",
  "quarantined",
  "retired",
] as const);

const SelectorCandidatesSchema = Schema.Array(SelectorCandidateSchema).pipe(
  Schema.refine(
    (candidates): candidates is ReadonlyArray<Schema.Schema.Type<typeof SelectorCandidateSchema>> =>
      candidates.length > 0,
    {
      message: "Expected at least one selector candidate for each pack field definition.",
    },
  ),
);

const TargetKindsSchema = Schema.Array(TargetKindSchema).pipe(
  Schema.refine(
    (targetKinds): targetKinds is ReadonlyArray<Schema.Schema.Type<typeof TargetKindSchema>> =>
      targetKinds.length > 0 && new Set(targetKinds).size === targetKinds.length,
    {
      message: "Expected at least one unique target kind in the pack policy contract.",
    },
  ),
);

const OwnerIdsSchema = Schema.Array(CanonicalIdentifierSchema).pipe(
  Schema.refine(
    (owners): owners is ReadonlyArray<string> =>
      owners.length > 0 && new Set(owners).size === owners.length,
    {
      message: "Expected at least one unique owner identifier in pack metadata.",
    },
  ),
);

const LabelIdsSchema = Schema.Array(CanonicalIdentifierSchema).pipe(
  Schema.withDecodingDefault(() => []),
  Schema.refine(
    (labels): labels is ReadonlyArray<string> => new Set(labels).size === labels.length,
    {
      message: "Expected pack metadata labels to be unique canonical identifiers.",
    },
  ),
);

const PackLookupStatesSchema = Schema.Array(PackStateSchema).pipe(
  Schema.withDecodingDefault(() => [...DEFAULT_PACK_LOOKUP_STATES]),
  Schema.refine(
    (states): states is ReadonlyArray<Schema.Schema.Type<typeof PackStateSchema>> =>
      states.length > 0 && new Set(states).size === states.length,
    {
      message: "Expected at least one unique lifecycle state in pack lookup input.",
    },
  ),
);

export class SitePackFieldSelector extends Schema.Class<SitePackFieldSelector>(
  "SitePackFieldSelector",
)({
  field: CanonicalIdentifierSchema,
  candidates: SelectorCandidatesSchema,
  fallbackPolicy: SelectorFallbackPolicySchema,
}) {}

const SitePackFieldSelectorsSchema = Schema.Array(SitePackFieldSelector).pipe(
  Schema.refine(
    (selectors): selectors is ReadonlyArray<SitePackFieldSelector> => selectors.length > 0,
    {
      message: "Expected at least one field selector in the site pack DSL.",
    },
  ),
  Schema.refine(
    (selectors): selectors is ReadonlyArray<SitePackFieldSelector> =>
      new Set(selectors.map(({ field }) => field)).size === selectors.length &&
      new Set(selectors.flatMap(({ candidates }) => candidates.map(({ path }) => `${path}`)))
        .size === selectors.flatMap(({ candidates }) => candidates).length,
    {
      message:
        "Expected field selectors to declare unique fields and globally unique selector candidate paths.",
    },
  ),
);

export class SitePackAssertions extends Schema.Class<SitePackAssertions>("SitePackAssertions")({
  requiredFields: Schema.Array(RequiredFieldAssertionSchema).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  businessInvariants: Schema.Array(BusinessInvariantAssertionSchema).pipe(
    Schema.withDecodingDefault(() => []),
  ),
}) {}

export const SitePackAssertionsSchema = SitePackAssertions.pipe(
  Schema.refine(
    (value): value is SitePackAssertions =>
      new Set(value.requiredFields.map(({ field }) => field)).size === value.requiredFields.length,
    {
      message: "Expected required-field assertions to be unique per field.",
    },
  ),
);

class SitePackPolicyBase extends Schema.Class<SitePackPolicyBase>("SitePackPolicy")({
  targetKinds: TargetKindsSchema,
  mode: AccessModeSchema,
  render: RenderingPolicySchema,
}) {}

export const SitePackPolicySchema = SitePackPolicyBase.pipe(
  Schema.refine(
    (policy): policy is Schema.Schema.Type<typeof SitePackPolicyBase> =>
      (policy.render !== "never" || policy.mode === "http") &&
      (policy.mode !== "http" || policy.render === "never"),
    {
      message:
        "Expected pack policy rendering rules to stay compatible with the configured access mode.",
    },
  ),
);

export class SitePackMetadata extends Schema.Class<SitePackMetadata>("SitePackMetadata")({
  tenantId: Schema.optional(CanonicalIdentifierSchema),
  owners: OwnerIdsSchema,
  labels: LabelIdsSchema,
}) {}

export class SitePack extends Schema.Class<SitePack>("SitePack")({
  id: CanonicalIdentifierSchema,
  tenantId: Schema.optional(CanonicalIdentifierSchema),
  domainPattern: DOMAIN_PATTERN_SCHEMA,
  state: PackStateSchema,
  accessPolicyId: CanonicalIdentifierSchema,
  version: PACK_VERSION_SCHEMA,
}) {}

export class PackRegistryLookup extends Schema.Class<PackRegistryLookup>("PackRegistryLookup")({
  domain: CanonicalDomainSchema,
  tenantId: Schema.optional(CanonicalIdentifierSchema),
  states: PackLookupStatesSchema,
}) {}

export const PackLifecycleTransitionSchema = Schema.Union([
  Schema.Struct({
    from: Schema.Literal("draft"),
    to: Schema.Literal("shadow"),
  }),
  Schema.Struct({
    from: Schema.Literal("draft"),
    to: Schema.Literal("retired"),
  }),
  Schema.Struct({
    from: Schema.Literal("shadow"),
    to: Schema.Literal("active"),
  }),
  Schema.Struct({
    from: Schema.Literal("shadow"),
    to: Schema.Literal("retired"),
  }),
  Schema.Struct({
    from: Schema.Literal("active"),
    to: Schema.Literal("shadow"),
  }),
  Schema.Struct({
    from: Schema.Literal("active"),
    to: Schema.Literal("guarded"),
  }),
  Schema.Struct({
    from: Schema.Literal("active"),
    to: Schema.Literal("quarantined"),
  }),
  Schema.Struct({
    from: Schema.Literal("active"),
    to: Schema.Literal("retired"),
  }),
  Schema.Struct({
    from: Schema.Literal("guarded"),
    to: Schema.Literal("shadow"),
  }),
  Schema.Struct({
    from: Schema.Literal("guarded"),
    to: Schema.Literal("active"),
  }),
  Schema.Struct({
    from: Schema.Literal("guarded"),
    to: Schema.Literal("quarantined"),
  }),
  Schema.Struct({
    from: Schema.Literal("guarded"),
    to: Schema.Literal("retired"),
  }),
  Schema.Struct({
    from: Schema.Literal("quarantined"),
    to: Schema.Literal("shadow"),
  }),
  Schema.Struct({
    from: Schema.Literal("quarantined"),
    to: Schema.Literal("active"),
  }),
  Schema.Struct({
    from: Schema.Literal("quarantined"),
    to: Schema.Literal("retired"),
  }),
]);

export const SitePackSchema = SitePack;

const SitePackDslBaseSchema = Schema.Struct({
  pack: SitePackSchema,
  selectors: SitePackFieldSelectorsSchema,
  assertions: SitePackAssertionsSchema,
  policy: SitePackPolicySchema,
  metadata: SitePackMetadata,
});

export const SitePackDslSchema = SitePackDslBaseSchema.pipe(
  Schema.refine(
    (definition): definition is Schema.Schema.Type<typeof SitePackDslBaseSchema> => {
      const selectorFields = new Set(definition.selectors.map(({ field }) => field));
      const assertedFields = [
        ...definition.assertions.requiredFields.map(({ field }) => field),
        ...definition.assertions.businessInvariants.map(({ field }) => field),
      ];
      const tenantIds = [definition.pack.tenantId, definition.metadata.tenantId].filter(
        (tenantId): tenantId is string => tenantId !== undefined,
      );

      return (
        assertedFields.every((field) => selectorFields.has(field)) &&
        (tenantIds.length < 2 || new Set(tenantIds).size === 1)
      );
    },
    {
      message:
        "Expected pack DSL assertions to reference declared selector fields and pack metadata tenant isolation to match the pack contract.",
    },
  ),
);

export type PackState = Schema.Schema.Type<typeof PackStateSchema>;
export type PackVersion = Schema.Schema.Type<typeof PackVersionSchema>;
export type SitePackFieldSelectorEncoded = Schema.Codec.Encoded<typeof SitePackFieldSelector>;
export type SitePackAssertionsEncoded = Schema.Codec.Encoded<typeof SitePackAssertionsSchema>;
export type SitePackPolicy = Schema.Schema.Type<typeof SitePackPolicySchema>;
export type SitePackPolicyEncoded = Schema.Codec.Encoded<typeof SitePackPolicySchema>;
export type SitePackMetadataEncoded = Schema.Codec.Encoded<typeof SitePackMetadata>;
export type SitePackEncoded = Schema.Codec.Encoded<typeof SitePackSchema>;
export type PackRegistryLookupEncoded = Schema.Codec.Encoded<typeof PackRegistryLookup>;
export type PackRegistryLookupState = Schema.Schema.Type<typeof PackLookupStatesSchema>[number];
export type PackRegistryLookupType = Schema.Schema.Type<typeof PackRegistryLookup>;
export type SitePackDsl = Schema.Schema.Type<typeof SitePackDslSchema>;
export type SitePackDslEncoded = Schema.Codec.Encoded<typeof SitePackDslSchema>;
export type PackLifecycleTransition = Schema.Schema.Type<typeof PackLifecycleTransitionSchema>;
