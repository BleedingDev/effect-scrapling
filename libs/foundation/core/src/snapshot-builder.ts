import { Data, Effect, Schema, SchemaGetter } from "effect";
import { ObservationSchema, SnapshotSchema } from "./observation-snapshot.ts";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";

const BOUNDED_SCORE_SCHEMA = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);
const NON_NEGATIVE_INT_SCHEMA = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const POSITIVE_INT_SCHEMA = Schema.Int.check(Schema.isGreaterThan(0));
const POSITIVE_FINITE_SCHEMA = Schema.Finite.check(Schema.isGreaterThan(0));

const SNAPSHOT_BUILDER_OBSERVATIONS_SCHEMA = Schema.Array(ObservationSchema).pipe(
  Schema.decode({
    decode: SchemaGetter.checkEffect((observations) =>
      Effect.succeed(
        observations.length > 0
          ? undefined
          : "Expected snapshot assembly input to include at least one observation.",
      ),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);

export class SnapshotBuilderInput extends Schema.Class<SnapshotBuilderInput>(
  "SnapshotBuilderInput",
)({
  id: CanonicalIdentifierSchema,
  targetId: CanonicalIdentifierSchema,
  observations: SNAPSHOT_BUILDER_OBSERVATIONS_SCHEMA,
  createdAt: IsoDateTimeSchema,
}) {}

export class SnapshotQualityScoreInputs extends Schema.Class<SnapshotQualityScoreInputs>(
  "SnapshotQualityScoreInputs",
)({
  sourceObservationCount: POSITIVE_INT_SCHEMA,
  assembledObservationCount: POSITIVE_INT_SCHEMA,
  duplicateObservationCount: NON_NEGATIVE_INT_SCHEMA,
  uniqueFieldCount: POSITIVE_INT_SCHEMA,
  conflictingFieldCount: NON_NEGATIVE_INT_SCHEMA,
  uniqueEvidenceRefCount: POSITIVE_INT_SCHEMA,
  multiEvidenceObservationCount: NON_NEGATIVE_INT_SCHEMA,
  averageEvidenceRefsPerObservation: POSITIVE_FINITE_SCHEMA,
  averageConfidence: BOUNDED_SCORE_SCHEMA,
  minimumConfidence: BOUNDED_SCORE_SCHEMA,
  evidenceStrengthScore: BOUNDED_SCORE_SCHEMA,
  conflictFreeScore: BOUNDED_SCORE_SCHEMA,
  uniquenessScore: BOUNDED_SCORE_SCHEMA,
}) {}

export class SnapshotQualityScoreBreakdown extends Schema.Class<SnapshotQualityScoreBreakdown>(
  "SnapshotQualityScoreBreakdown",
)({
  confidenceContribution: BOUNDED_SCORE_SCHEMA,
  evidenceStrengthContribution: BOUNDED_SCORE_SCHEMA,
  conflictFreeContribution: BOUNDED_SCORE_SCHEMA,
  uniquenessContribution: BOUNDED_SCORE_SCHEMA,
}) {}

export class SnapshotAssemblyResult extends Schema.Class<SnapshotAssemblyResult>(
  "SnapshotAssemblyResult",
)({
  snapshot: SnapshotSchema,
  qualityScoreInputs: SnapshotQualityScoreInputs,
  qualityScoreBreakdown: SnapshotQualityScoreBreakdown,
}) {}

export const SnapshotBuilderInputSchema = SnapshotBuilderInput;
export const SnapshotQualityScoreInputsSchema = SnapshotQualityScoreInputs;
export const SnapshotQualityScoreBreakdownSchema = SnapshotQualityScoreBreakdown;
export const SnapshotAssemblyResultSchema = SnapshotAssemblyResult;

type Observation = Schema.Schema.Type<typeof ObservationSchema>;

export class SnapshotBuilderFailure extends Data.TaggedError("SnapshotBuilderFailure")<{
  readonly message: string;
}> {}

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function roundFinite(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundBoundedScore(value: number) {
  return roundFinite(Math.max(0, Math.min(1, value)));
}

function toSortedUniqueIdentifiers(values: ReadonlyArray<string>) {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

// Sort nested object keys so unknown normalized values compare and encode deterministically.
function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeValue(entry));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, canonicalizeValue(nestedValue)]),
    );
  }

  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }

  return value;
}

function stableSerialize(value: unknown): string {
  const canonicalValue = canonicalizeValue(value);

  if (Array.isArray(canonicalValue)) {
    return `[${canonicalValue.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  if (typeof canonicalValue === "object" && canonicalValue !== null) {
    return `{${Object.entries(canonicalValue)
      .map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableSerialize(nestedValue)}`)
      .join(",")}}`;
  }

  switch (typeof canonicalValue) {
    case "string":
      return JSON.stringify(canonicalValue);
    case "number":
    case "boolean":
      return String(canonicalValue);
    case "undefined":
      return "undefined";
    default:
      return JSON.stringify(canonicalValue);
  }
}

function normalizeObservation(observation: Observation) {
  return Schema.decodeUnknownSync(ObservationSchema)({
    field: observation.field,
    normalizedValue: canonicalizeValue(observation.normalizedValue),
    confidence: observation.confidence,
    evidenceRefs: toSortedUniqueIdentifiers(observation.evidenceRefs),
  });
}

function observationKey(observation: Observation) {
  return `${observation.field}:${stableSerialize(observation.normalizedValue)}`;
}

function compareObservations(left: Observation, right: Observation) {
  const fieldOrder = left.field.localeCompare(right.field);
  if (fieldOrder !== 0) {
    return fieldOrder;
  }

  const valueOrder = stableSerialize(left.normalizedValue).localeCompare(
    stableSerialize(right.normalizedValue),
  );
  if (valueOrder !== 0) {
    return valueOrder;
  }

  if (left.confidence !== right.confidence) {
    return right.confidence - left.confidence;
  }

  return left.evidenceRefs.join("|").localeCompare(right.evidenceRefs.join("|"));
}

function mergeObservationPair(current: Observation, next: Observation) {
  return Schema.decodeUnknownSync(ObservationSchema)({
    field: current.field,
    normalizedValue: current.normalizedValue,
    confidence: Math.max(current.confidence, next.confidence),
    evidenceRefs: toSortedUniqueIdentifiers([...current.evidenceRefs, ...next.evidenceRefs]),
  });
}

function assembleObservations(observations: ReadonlyArray<Observation>) {
  const normalizedObservations = observations.map((observation) =>
    normalizeObservation(observation),
  );
  const observationsByKey = new Map<string, Observation>();

  for (const observation of normalizedObservations) {
    const key = observationKey(observation);
    const current = observationsByKey.get(key);
    observationsByKey.set(
      key,
      current === undefined ? observation : mergeObservationPair(current, observation),
    );
  }

  return [...observationsByKey.values()].toSorted(compareObservations);
}

function countConflictingFields(observations: ReadonlyArray<Observation>) {
  const valuesByField = new Map<string, Set<string>>();

  for (const observation of observations) {
    const values = valuesByField.get(observation.field) ?? new Set<string>();
    values.add(stableSerialize(observation.normalizedValue));
    valuesByField.set(observation.field, values);
  }

  return [...valuesByField.values()].filter((values) => values.size > 1).length;
}

function buildQualityScoreInputs(
  sourceObservationCount: number,
  observations: ReadonlyArray<Observation>,
) {
  const assembledObservationCount = observations.length;
  const uniqueFieldCount = new Set(observations.map(({ field }) => field)).size;
  const conflictingFieldCount = countConflictingFields(observations);
  const uniqueEvidenceRefCount = new Set(observations.flatMap(({ evidenceRefs }) => evidenceRefs))
    .size;
  const multiEvidenceObservationCount = observations.filter(
    ({ evidenceRefs }) => evidenceRefs.length > 1,
  ).length;
  const totalEvidenceRefs = observations.reduce(
    (currentTotal, observation) => currentTotal + observation.evidenceRefs.length,
    0,
  );
  const totalConfidence = observations.reduce(
    (currentTotal, observation) => currentTotal + observation.confidence,
    0,
  );
  const [firstObservation, ...remainingObservations] = observations;

  if (firstObservation === undefined) {
    throw new Error("Snapshot assembly requires at least one observation after normalization.");
  }

  const minimumConfidence = remainingObservations.reduce(
    (currentMinimum, observation) =>
      observation.confidence < currentMinimum ? observation.confidence : currentMinimum,
    firstObservation.confidence,
  );
  const averageEvidenceRefsPerObservation = roundFinite(
    totalEvidenceRefs / assembledObservationCount,
  );
  const evidenceStrengthScore = roundBoundedScore(
    Math.min(1, averageEvidenceRefsPerObservation / 2),
  );
  const conflictFreeScore = roundBoundedScore(1 - conflictingFieldCount / uniqueFieldCount);
  const uniquenessScore = roundBoundedScore(assembledObservationCount / sourceObservationCount);

  return Schema.decodeUnknownSync(SnapshotQualityScoreInputsSchema)({
    sourceObservationCount,
    assembledObservationCount,
    duplicateObservationCount: sourceObservationCount - assembledObservationCount,
    uniqueFieldCount,
    conflictingFieldCount,
    uniqueEvidenceRefCount,
    multiEvidenceObservationCount,
    averageEvidenceRefsPerObservation,
    averageConfidence: roundBoundedScore(totalConfidence / assembledObservationCount),
    minimumConfidence: roundBoundedScore(minimumConfidence),
    evidenceStrengthScore,
    conflictFreeScore,
    uniquenessScore,
  });
}

function buildQualityScoreBreakdown(
  qualityScoreInputs: Schema.Schema.Type<typeof SnapshotQualityScoreInputsSchema>,
) {
  return Schema.decodeUnknownSync(SnapshotQualityScoreBreakdownSchema)({
    confidenceContribution: roundBoundedScore(qualityScoreInputs.averageConfidence * 0.55),
    evidenceStrengthContribution: roundBoundedScore(qualityScoreInputs.evidenceStrengthScore * 0.2),
    conflictFreeContribution: roundBoundedScore(qualityScoreInputs.conflictFreeScore * 0.15),
    uniquenessContribution: roundBoundedScore(qualityScoreInputs.uniquenessScore * 0.1),
  });
}

function buildQualityScore(
  breakdown: Schema.Schema.Type<typeof SnapshotQualityScoreBreakdownSchema>,
) {
  return roundBoundedScore(
    breakdown.confidenceContribution +
      breakdown.evidenceStrengthContribution +
      breakdown.conflictFreeContribution +
      breakdown.uniquenessContribution,
  );
}

export const buildObservationSnapshot = Effect.fn("SnapshotBuilder.buildObservationSnapshot")(
  function* (input: unknown) {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(SnapshotBuilderInputSchema)(input),
      catch: (cause) =>
        new SnapshotBuilderFailure({
          message: readCauseMessage(cause, "Failed to decode snapshot-builder input."),
        }),
    });

    return yield* Effect.try({
      try: () => {
        const observations = assembleObservations(decoded.observations);
        const qualityScoreInputs = buildQualityScoreInputs(
          decoded.observations.length,
          observations,
        );
        const qualityScoreBreakdown = buildQualityScoreBreakdown(qualityScoreInputs);
        const snapshot = Schema.decodeUnknownSync(SnapshotSchema)({
          id: decoded.id,
          targetId: decoded.targetId,
          observations,
          qualityScore: buildQualityScore(qualityScoreBreakdown),
          createdAt: decoded.createdAt,
        });

        return Schema.decodeUnknownSync(SnapshotAssemblyResultSchema)({
          snapshot,
          qualityScoreInputs,
          qualityScoreBreakdown,
        });
      },
      catch: (cause) =>
        new SnapshotBuilderFailure({
          message: readCauseMessage(cause, "Failed to build deterministic observation snapshot."),
        }),
    });
  },
);
