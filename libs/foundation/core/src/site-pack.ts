import { Schema } from "effect";
import { CanonicalIdentifierSchema } from "./schema-primitives.js";

const DOMAIN_PATTERN_SCHEMA = Schema.Trim.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.check(Schema.isLowercased()),
  Schema.refine(
    (value): value is string =>
      /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(
        value,
      ) &&
      !value.includes("://") &&
      !/\s/gu.test(value),
    {
      message: "Expected a lowercased domain pattern without protocol or whitespace.",
    },
  ),
);

const PACK_VERSION_SCHEMA = Schema.Trim.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.refine((value): value is string => !/\s/gu.test(value), {
    message: "Expected a non-empty pack version without whitespace.",
  }),
);

const ALLOWED_TRANSITIONS = new Set([
  "draft->shadow",
  "draft->retired",
  "shadow->active",
  "shadow->retired",
  "active->shadow",
  "active->guarded",
  "active->quarantined",
  "active->retired",
  "guarded->shadow",
  "guarded->active",
  "guarded->quarantined",
  "guarded->retired",
  "quarantined->shadow",
  "quarantined->active",
  "quarantined->retired",
]);

export const PackStateSchema = Schema.Literals([
  "draft",
  "shadow",
  "active",
  "guarded",
  "quarantined",
  "retired",
] as const);

export class SitePack extends Schema.Class<SitePack>("SitePack")({
  id: CanonicalIdentifierSchema,
  domainPattern: DOMAIN_PATTERN_SCHEMA,
  state: PackStateSchema,
  accessPolicyId: CanonicalIdentifierSchema,
  version: PACK_VERSION_SCHEMA,
}) {}

class PackLifecycleTransitionBase extends Schema.Class<PackLifecycleTransitionBase>(
  "PackLifecycleTransition",
)({
  from: PackStateSchema,
  to: PackStateSchema,
}) {}

export const PackLifecycleTransitionSchema = PackLifecycleTransitionBase.pipe(
  Schema.refine(
    (value): value is Schema.Schema.Type<typeof PackLifecycleTransitionBase> =>
      ALLOWED_TRANSITIONS.has(`${value.from}->${value.to}`),
    {
      message: "Expected a supported site-pack lifecycle transition.",
    },
  ),
);

export const SitePackSchema = SitePack;

export type PackState = Schema.Schema.Type<typeof PackStateSchema>;
export type SitePackEncoded = Schema.Codec.Encoded<typeof SitePackSchema>;
export type PackLifecycleTransition = Schema.Schema.Type<typeof PackLifecycleTransitionSchema>;
