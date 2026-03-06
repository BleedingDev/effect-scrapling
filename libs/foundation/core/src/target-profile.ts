import { Schema } from "effect";
import {
  CanonicalDomainSchema,
  CanonicalHttpUrlSchema,
  CanonicalIdentifierSchema,
  CanonicalKeySchema,
} from "./schema-primitives.js";

export const TargetKindSchema = Schema.Literals([
  "productPage",
  "productListing",
  "marketingPost",
  "blogPost",
  "pressRelease",
  "socialPost",
  "searchResult",
] as const);

const TargetPrioritySchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1000),
);

const SeedUrlsSchema = Schema.UniqueArray(CanonicalHttpUrlSchema).pipe(
  Schema.refine((value): value is ReadonlyArray<string> => value.length > 0, {
    message: "Expected at least one seed URL.",
  }),
);

export class TargetProfile extends Schema.Class<TargetProfile>("TargetProfile")({
  id: CanonicalIdentifierSchema,
  tenantId: CanonicalIdentifierSchema,
  domain: CanonicalDomainSchema,
  kind: TargetKindSchema,
  canonicalKey: CanonicalKeySchema,
  seedUrls: SeedUrlsSchema,
  accessPolicyId: CanonicalIdentifierSchema,
  packId: CanonicalIdentifierSchema,
  priority: TargetPrioritySchema,
}) {}

export const TargetProfileSchema = TargetProfile;

export type TargetKind = Schema.Schema.Type<typeof TargetKindSchema>;
export type TargetProfileEncoded = Schema.Codec.Encoded<typeof TargetProfileSchema>;
