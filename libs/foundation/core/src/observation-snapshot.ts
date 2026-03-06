import { Effect, Schema, SchemaGetter } from "effect";
import { CanonicalIdentifierSchema } from "./schema-primitives.js";

const BOUNDED_SCORE_SCHEMA = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

const EVIDENCE_REFS_SCHEMA = Schema.UniqueArray(CanonicalIdentifierSchema).pipe(
  Schema.decode({
    decode: SchemaGetter.checkEffect((value) =>
      Effect.succeed(value.length > 0 ? undefined : "Expected at least one evidence reference."),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);

const ISO_DATE_TIME_SCHEMA = Schema.Trim.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.decode({
    decode: SchemaGetter.checkEffect((value) =>
      Effect.succeed(
        ISO_DATE_TIME_PATTERN.test(value) &&
          Number.isFinite(Date.parse(value)) &&
          new Date(value).toISOString() === value
          ? undefined
          : "Expected an ISO-8601 datetime string.",
      ),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);

const OBSERVATION_FIELDS = {
  confidence: BOUNDED_SCORE_SCHEMA,
  evidenceRefs: EVIDENCE_REFS_SCHEMA,
} as const;

const PRICE_NORMALIZED_VALUE_SCHEMA = Schema.Struct({
  amount: Schema.Finite,
  currency: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())),
});

const NON_PRICE_FIELD_SCHEMA = Schema.Trim.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.decode({
    decode: SchemaGetter.checkEffect((value) =>
      Effect.succeed(
        value !== "price"
          ? undefined
          : 'Expected non-price observations to use a field other than "price".',
      ),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);

const PRICE_OBSERVATION_SCHEMA = Schema.Struct({
  field: Schema.Literal("price"),
  normalizedValue: PRICE_NORMALIZED_VALUE_SCHEMA,
  ...OBSERVATION_FIELDS,
});

const GENERIC_OBSERVATION_SCHEMA = Schema.Struct({
  field: NON_PRICE_FIELD_SCHEMA,
  normalizedValue: Schema.Unknown,
  ...OBSERVATION_FIELDS,
});

export const Observation = Schema.Union([PRICE_OBSERVATION_SCHEMA, GENERIC_OBSERVATION_SCHEMA]);
export const ObservationSchema = Observation;

export class Snapshot extends Schema.Class<Snapshot>("Snapshot")({
  id: CanonicalIdentifierSchema,
  targetId: CanonicalIdentifierSchema,
  observations: Schema.Array(ObservationSchema),
  qualityScore: BOUNDED_SCORE_SCHEMA,
  createdAt: ISO_DATE_TIME_SCHEMA,
}) {}

export const SnapshotSchema = Snapshot;

export type ObservationEncoded = Schema.Codec.Encoded<typeof ObservationSchema>;
export type SnapshotEncoded = Schema.Codec.Encoded<typeof SnapshotSchema>;
