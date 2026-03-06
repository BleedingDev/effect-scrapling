import { Effect, Schema, SchemaGetter } from "effect";
import { CanonicalIdentifierSchema } from "./schema-primitives.ts";

const DOMAIN_PATTERN_SCHEMA = Schema.Trim.pipe(
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

export type PackState = Schema.Schema.Type<typeof PackStateSchema>;
export type SitePackEncoded = Schema.Codec.Encoded<typeof SitePackSchema>;
export type PackLifecycleTransition = Schema.Schema.Type<typeof PackLifecycleTransitionSchema>;
