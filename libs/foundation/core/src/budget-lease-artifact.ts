import { Schema } from "effect";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";

const GlobalConcurrencySchema = Schema.Int.check(Schema.isGreaterThan(0)).check(
  Schema.isLessThanOrEqualTo(4096),
);
const MaxPerDomainSchema = Schema.Int.check(Schema.isGreaterThan(0)).check(
  Schema.isLessThanOrEqualTo(128),
);
const ArtifactLocatorSchema = Schema.Trim.check(Schema.isNonEmpty());

export const ArtifactKindSchema = Schema.Literals([
  "requestMetadata",
  "responseMetadata",
  "html",
  "renderedDom",
  "screenshot",
  "timings",
] as const);

export const ArtifactVisibilitySchema = Schema.Literals(["raw", "redacted"] as const);

class ConcurrencyBudgetBase extends Schema.Class<ConcurrencyBudgetBase>("ConcurrencyBudget")({
  id: CanonicalIdentifierSchema,
  ownerId: CanonicalIdentifierSchema,
  globalConcurrency: GlobalConcurrencySchema,
  maxPerDomain: MaxPerDomainSchema,
}) {}

export const ConcurrencyBudgetSchema = ConcurrencyBudgetBase.pipe(
  Schema.refine(
    (value): value is Schema.Schema.Type<typeof ConcurrencyBudgetBase> =>
      value.globalConcurrency >= value.maxPerDomain,
    {
      message: "Expected globalConcurrency to be greater than or equal to maxPerDomain.",
    },
  ),
);

export class EgressLease extends Schema.Class<EgressLease>("EgressLease")({
  id: CanonicalIdentifierSchema,
  ownerId: CanonicalIdentifierSchema,
  egressKey: CanonicalIdentifierSchema,
  expiresAt: IsoDateTimeSchema,
}) {}

export class IdentityLease extends Schema.Class<IdentityLease>("IdentityLease")({
  id: CanonicalIdentifierSchema,
  ownerId: CanonicalIdentifierSchema,
  identityKey: CanonicalIdentifierSchema,
  expiresAt: IsoDateTimeSchema,
}) {}

export class ArtifactRef extends Schema.Class<ArtifactRef>("ArtifactRef")({
  id: CanonicalIdentifierSchema,
  ownerId: CanonicalIdentifierSchema,
  runId: CanonicalIdentifierSchema,
  kind: ArtifactKindSchema,
  visibility: ArtifactVisibilitySchema,
  locator: ArtifactLocatorSchema,
}) {}

export const EgressLeaseSchema = EgressLease;
export const IdentityLeaseSchema = IdentityLease;
export const ArtifactRefSchema = ArtifactRef;

export type ArtifactKind = Schema.Schema.Type<typeof ArtifactKindSchema>;
export type ArtifactVisibility = Schema.Schema.Type<typeof ArtifactVisibilitySchema>;
export type ConcurrencyBudget = Schema.Schema.Type<typeof ConcurrencyBudgetSchema>;
export type EgressLeaseEncoded = Schema.Codec.Encoded<typeof EgressLeaseSchema>;
export type IdentityLeaseEncoded = Schema.Codec.Encoded<typeof IdentityLeaseSchema>;
export type ArtifactRefEncoded = Schema.Codec.Encoded<typeof ArtifactRefSchema>;
