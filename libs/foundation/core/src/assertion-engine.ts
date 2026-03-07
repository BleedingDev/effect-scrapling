import { Data, Effect, Schema } from "effect";
import {
  NormalizedPriceSchema,
  NormalizedProductIdentifierSchema,
  NormalizedTextSchema,
} from "./domain-normalizers.ts";
import { SnapshotSchema } from "./observation-snapshot.ts";
import { CanonicalIdentifierSchema } from "./schema-primitives.ts";

const BoundedScoreSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);

export const RequiredFieldAssertionSchema = Schema.Struct({
  field: CanonicalIdentifierSchema,
  minimumConfidence: Schema.optional(BoundedScoreSchema),
});

const NumericRangeBusinessInvariantSchema = Schema.Struct({
  kind: Schema.Literal("numericRange"),
  field: CanonicalIdentifierSchema,
  minimum: Schema.optional(Schema.Finite),
  maximum: Schema.optional(Schema.Finite),
});

const StringOneOfBusinessInvariantSchema = Schema.Struct({
  kind: Schema.Literal("stringOneOf"),
  field: CanonicalIdentifierSchema,
  allowedValues: Schema.NonEmptyArray(NormalizedTextSchema),
});

export const BusinessInvariantAssertionSchema = Schema.Union([
  NumericRangeBusinessInvariantSchema,
  StringOneOfBusinessInvariantSchema,
]);

export const AssertionEvidenceLinkSchema = Schema.Struct({
  snapshotId: CanonicalIdentifierSchema,
  field: CanonicalIdentifierSchema,
  evidenceRefs: Schema.Array(CanonicalIdentifierSchema),
});

export const MissingRequiredFieldFailureSchema = Schema.Struct({
  kind: Schema.Literal("missingRequiredField"),
  message: Schema.Trim.check(Schema.isNonEmpty()),
  context: AssertionEvidenceLinkSchema,
});

export const BusinessInvariantFailureSchema = Schema.Struct({
  kind: Schema.Literal("businessInvariantFailure"),
  message: Schema.Trim.check(Schema.isNonEmpty()),
  context: AssertionEvidenceLinkSchema,
});

export const AssertionFailureSchema = Schema.Union([
  MissingRequiredFieldFailureSchema,
  BusinessInvariantFailureSchema,
]);

export const AssertionReportSchema = Schema.Struct({
  snapshotId: CanonicalIdentifierSchema,
  evaluatedRuleCount: Schema.Int.check(Schema.isGreaterThan(0)),
  assertedFields: Schema.UniqueArray(CanonicalIdentifierSchema),
});

export const AssertionEngineInputSchema = Schema.Struct({
  snapshot: SnapshotSchema,
  requiredFields: Schema.Array(RequiredFieldAssertionSchema),
  businessInvariants: Schema.Array(BusinessInvariantAssertionSchema),
});

export class AssertionEngineFailure extends Data.TaggedError("AssertionEngineFailure")<{
  readonly failures: ReadonlyArray<Schema.Schema.Type<typeof AssertionFailureSchema>>;
}> {}

export type AssertionEvidenceLink = Schema.Schema.Type<typeof AssertionEvidenceLinkSchema>;
export type AssertionContext = AssertionEvidenceLink;
export type RequiredFieldAssertion = Schema.Schema.Type<typeof RequiredFieldAssertionSchema>;
export type BusinessInvariantAssertion = Schema.Schema.Type<
  typeof BusinessInvariantAssertionSchema
>;
export type MissingRequiredFieldFailure = Schema.Schema.Type<
  typeof MissingRequiredFieldFailureSchema
>;
export type BusinessInvariantFailure = Schema.Schema.Type<typeof BusinessInvariantFailureSchema>;
export type AssertionFailure = Schema.Schema.Type<typeof AssertionFailureSchema>;
export type AssertionEngineInput = Schema.Schema.Type<typeof AssertionEngineInputSchema>;

export function runAssertionEngine(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(AssertionEngineInputSchema)(input),
      catch: () =>
        new AssertionEngineFailure({
          failures: [
            Schema.decodeUnknownSync(BusinessInvariantFailureSchema)({
              kind: "businessInvariantFailure",
              message: "Failed to decode assertion-engine input through shared contracts.",
              context: {
                snapshotId: "unknown-snapshot",
                field: "unknown-field",
                evidenceRefs: [],
              },
            }),
          ],
        }),
    });

    const failures: ReadonlyArray<AssertionFailure> = [
      ...decoded.requiredFields.flatMap((assertion) =>
        evaluateRequiredFieldAssertion(decoded.snapshot, assertion),
      ),
      ...decoded.businessInvariants.flatMap((assertion) =>
        evaluateBusinessInvariant(decoded.snapshot, assertion),
      ),
    ];
    if (failures.length > 0) {
      return yield* Effect.fail(
        new AssertionEngineFailure({
          failures,
        }),
      );
    }

    const assertedFields = [
      ...new Set([
        ...decoded.requiredFields.map(({ field }) => field),
        ...decoded.businessInvariants.map(({ field }) => field),
      ]),
    ];

    return Schema.decodeUnknownSync(AssertionReportSchema)({
      snapshotId: decoded.snapshot.id,
      evaluatedRuleCount: decoded.requiredFields.length + decoded.businessInvariants.length,
      assertedFields,
    });
  });
}

function evaluateRequiredFieldAssertion(
  snapshot: Schema.Schema.Type<typeof SnapshotSchema>,
  assertion: RequiredFieldAssertion,
): ReadonlyArray<AssertionFailure> {
  const observations = snapshot.observations.filter(({ field }) => field === assertion.field);
  if (observations.length === 0) {
    return [
      Schema.decodeUnknownSync(MissingRequiredFieldFailureSchema)({
        kind: "missingRequiredField",
        message: `Required field ${assertion.field} is missing from the snapshot.`,
        context: {
          snapshotId: snapshot.id,
          field: assertion.field,
          evidenceRefs: [],
        },
      }),
    ];
  }

  if (assertion.minimumConfidence === undefined) {
    return [];
  }

  const strongestObservation = observations.reduce((currentBest, observation) => {
    return observation.confidence > currentBest.confidence ? observation : currentBest;
  }, observations[0]!);
  if (strongestObservation.confidence >= assertion.minimumConfidence) {
    return [];
  }

  return [
    createBusinessInvariantFailure(
      snapshot.id,
      assertion.field,
      strongestObservation.evidenceRefs,
      `Field ${assertion.field} confidence ${strongestObservation.confidence} is below required minimum ${assertion.minimumConfidence}.`,
    ),
  ];
}

function evaluateBusinessInvariant(
  snapshot: Schema.Schema.Type<typeof SnapshotSchema>,
  assertion: BusinessInvariantAssertion,
): ReadonlyArray<AssertionFailure> {
  const observation = snapshot.observations.find(({ field }) => field === assertion.field);
  if (observation === undefined) {
    return [
      Schema.decodeUnknownSync(MissingRequiredFieldFailureSchema)({
        kind: "missingRequiredField",
        message: `Required field ${assertion.field} is missing from the snapshot.`,
        context: {
          snapshotId: snapshot.id,
          field: assertion.field,
          evidenceRefs: [],
        },
      }),
    ];
  }

  switch (assertion.kind) {
    case "numericRange": {
      const numericValue = extractNumericValue(observation.normalizedValue);
      if (numericValue === undefined) {
        return [
          createBusinessInvariantFailure(
            snapshot.id,
            assertion.field,
            observation.evidenceRefs,
            `Field ${assertion.field} does not expose a numeric normalized value for range assertions.`,
          ),
        ];
      }

      if (assertion.minimum === undefined && assertion.maximum === undefined) {
        return [
          createBusinessInvariantFailure(
            snapshot.id,
            assertion.field,
            observation.evidenceRefs,
            `Field ${assertion.field} numericRange invariant must declare a minimum and/or maximum.`,
          ),
        ];
      }

      if (
        (assertion.minimum !== undefined && numericValue < assertion.minimum) ||
        (assertion.maximum !== undefined && numericValue > assertion.maximum)
      ) {
        return [
          createBusinessInvariantFailure(
            snapshot.id,
            assertion.field,
            observation.evidenceRefs,
            `Field ${assertion.field} violates numeric range invariant ${renderRange(assertion.minimum, assertion.maximum)}.`,
          ),
        ];
      }

      return [];
    }
    case "stringOneOf": {
      const actualValue = extractComparableString(observation.normalizedValue);
      if (actualValue === undefined) {
        return [
          createBusinessInvariantFailure(
            snapshot.id,
            assertion.field,
            observation.evidenceRefs,
            `Field ${assertion.field} does not expose a comparable string normalized value.`,
          ),
        ];
      }

      const allowedValues = assertion.allowedValues.map((value) => value.toLowerCase());
      if (allowedValues.includes(actualValue.toLowerCase())) {
        return [];
      }

      return [
        createBusinessInvariantFailure(
          snapshot.id,
          assertion.field,
          observation.evidenceRefs,
          `Field ${assertion.field} violates allowed-value invariant ${renderAllowedValues(assertion.allowedValues)}.`,
        ),
      ];
    }
  }
}

function extractNumericValue(value: unknown) {
  if (typeof value === "number") {
    return value;
  }

  if (Schema.is(NormalizedPriceSchema)(value)) {
    return value.amount;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function extractComparableString(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  if (Schema.is(NormalizedProductIdentifierSchema)(value)) {
    return value.value;
  }

  return undefined;
}

function createBusinessInvariantFailure(
  snapshotId: string,
  field: string,
  evidenceRefs: ReadonlyArray<string>,
  message: string,
): BusinessInvariantFailure {
  return Schema.decodeUnknownSync(BusinessInvariantFailureSchema)({
    kind: "businessInvariantFailure",
    message,
    context: {
      snapshotId,
      field,
      evidenceRefs,
    },
  });
}

function renderRange(minimum: number | undefined, maximum: number | undefined) {
  const lowerBound = minimum === undefined ? "-inf" : `${minimum}`;
  const upperBound = maximum === undefined ? "inf" : `${maximum}`;
  return `[${lowerBound}, ${upperBound}]`;
}

function renderAllowedValues(values: ReadonlyArray<string>) {
  return `(${values.join(", ")})`;
}
