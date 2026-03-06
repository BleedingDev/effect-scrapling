import { Schema } from "effect";
import { CanonicalIdentifierSchema } from "./schema-primitives.js";

const BOUNDED_SCORE_SCHEMA = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

const EVIDENCE_REFS_SCHEMA = Schema.UniqueArray(CanonicalIdentifierSchema).pipe(
  Schema.refine((value): value is ReadonlyArray<string> => value.length > 0, {
    message: "Expected at least one evidence reference.",
  }),
);

const ISO_DATE_TIME_SCHEMA = Schema.Trim.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.refine(
    (value): value is string =>
      ISO_DATE_TIME_PATTERN.test(value) && Number.isFinite(Date.parse(value)),
    {
      message: "Expected an ISO-8601 datetime string.",
    },
  ),
);

function hasPriceCurrencyContext(value: unknown): value is {
  readonly amount: number;
  readonly currency: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const normalizedValue = value as { readonly amount?: unknown; readonly currency?: unknown };
  return (
    typeof normalizedValue.amount === "number" &&
    Number.isFinite(normalizedValue.amount) &&
    typeof normalizedValue.currency === "string" &&
    normalizedValue.currency.trim().length > 0
  );
}

export class Observation extends Schema.Class<Observation>("Observation")({
  field: Schema.Trim.check(Schema.isNonEmpty()),
  normalizedValue: Schema.Unknown,
  confidence: BOUNDED_SCORE_SCHEMA,
  evidenceRefs: EVIDENCE_REFS_SCHEMA,
}) {}

export const ObservationSchema = Observation.pipe(
  Schema.refine(
    (value): value is Schema.Schema.Type<typeof Observation> =>
      value.field !== "price" || hasPriceCurrencyContext(value.normalizedValue),
    {
      message: "Expected price observations to include amount and currency context.",
    },
  ),
);

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
