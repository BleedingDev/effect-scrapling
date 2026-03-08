import { Effect, Schema } from "effect";
import { AssertionFailureSchema } from "./assertion-engine.ts";
import {
  CanonicalIdentifierSchema,
  CanonicalKeySchema,
  IsoDateTimeSchema,
} from "./schema-primitives.ts";
import { SelectorCandidateSchema } from "./selector-engine.ts";
import { PackStateSchema, SitePackDslSchema } from "./site-pack.ts";
import { PolicyViolation } from "./tagged-errors.ts";

const NonEmptyMessageSchema = Schema.Trim.check(Schema.isNonEmpty());
const NonEmptyEvidenceRefsSchema = Schema.Array(CanonicalIdentifierSchema).pipe(
  Schema.refine(
    (evidenceRefs): evidenceRefs is ReadonlyArray<string> =>
      evidenceRefs.length > 0 && new Set(evidenceRefs).size === evidenceRefs.length,
    {
      message: "Expected non-empty unique evidence references for candidate generation signals.",
    },
  ),
);
const SignalKindSchema = Schema.Union([
  Schema.Literal("failure"),
  Schema.Literal("regression"),
  Schema.Literal("fixture"),
]);
const CandidateOperationActionSchema = Schema.Union([
  Schema.Literal("appendSelectorCandidate"),
  Schema.Literal("promoteSelectorCandidate"),
]);

const FailureCandidateSignalSchema = Schema.Struct({
  kind: Schema.Literal("failure"),
  failure: AssertionFailureSchema,
  selectorCandidate: SelectorCandidateSchema,
  evidenceRefs: NonEmptyEvidenceRefsSchema,
  observedAt: IsoDateTimeSchema,
});

const RegressionCandidateSignalSchema = Schema.Struct({
  kind: Schema.Literal("regression"),
  field: CanonicalIdentifierSchema,
  selectorCandidate: SelectorCandidateSchema,
  currentPrimarySelectorPath: CanonicalKeySchema,
  evidenceRefs: NonEmptyEvidenceRefsSchema,
  observedAt: IsoDateTimeSchema,
});

const FixtureCandidateSignalSchema = Schema.Struct({
  kind: Schema.Literal("fixture"),
  fixtureId: CanonicalIdentifierSchema,
  field: CanonicalIdentifierSchema,
  selectorCandidate: SelectorCandidateSchema,
  evidenceRefs: NonEmptyEvidenceRefsSchema,
  observedAt: IsoDateTimeSchema,
});

export const PackCandidateSignalSchema = Schema.Union([
  FailureCandidateSignalSchema,
  RegressionCandidateSignalSchema,
  FixtureCandidateSignalSchema,
]);

const PackCandidateSignalsSchema = Schema.Array(PackCandidateSignalSchema).pipe(
  Schema.refine(
    (signals): signals is ReadonlyArray<Schema.Schema.Type<typeof PackCandidateSignalSchema>> =>
      signals.length > 0,
    {
      message: "Expected at least one typed signal for pack candidate generation.",
    },
  ),
);

export const PackCandidateOperationSchema = Schema.Struct({
  action: CandidateOperationActionSchema,
  field: CanonicalIdentifierSchema,
  selectorCandidate: SelectorCandidateSchema,
  evidenceRefs: NonEmptyEvidenceRefsSchema,
  sourceKinds: Schema.Array(SignalKindSchema).pipe(
    Schema.refine(
      (sourceKinds): sourceKinds is ReadonlyArray<Schema.Schema.Type<typeof SignalKindSchema>> =>
        sourceKinds.length > 0 && new Set(sourceKinds).size === sourceKinds.length,
      {
        message: "Expected candidate operations to record at least one unique source kind.",
      },
    ),
  ),
  fixtureIds: Schema.Array(CanonicalIdentifierSchema).pipe(
    Schema.withDecodingDefault(() => []),
    Schema.refine(
      (fixtureIds): fixtureIds is ReadonlyArray<string> =>
        new Set(fixtureIds).size === fixtureIds.length,
      {
        message: "Expected candidate operation fixture ids to be unique.",
      },
    ),
  ),
  rationale: NonEmptyMessageSchema,
});

const PackCandidateOperationSourceKindsSchema = PackCandidateOperationSchema.fields.sourceKinds;

const PackCandidateOperationsSchema = Schema.Array(PackCandidateOperationSchema).pipe(
  Schema.refine(
    (
      operations,
    ): operations is ReadonlyArray<Schema.Schema.Type<typeof PackCandidateOperationSchema>> =>
      operations.length > 0 &&
      new Set(
        operations.map(
          ({ field, action, selectorCandidate }) => `${field}:${action}:${selectorCandidate.path}`,
        ),
      ).size === operations.length,
    {
      message:
        "Expected non-empty candidate operations with unique field/action/selector combinations.",
    },
  ),
);

export class PackCandidateProposal extends Schema.Class<PackCandidateProposal>(
  "PackCandidateProposal",
)({
  id: CanonicalIdentifierSchema,
  sourcePackId: CanonicalIdentifierSchema,
  sourcePackVersion: Schema.String,
  sourcePackState: PackStateSchema,
  targetPackState: Schema.Literal("draft"),
  operations: PackCandidateOperationsSchema,
  evidenceRefs: NonEmptyEvidenceRefsSchema,
  createdAt: IsoDateTimeSchema,
}) {}

const PackCandidateGeneratorInputSchema = Schema.Struct({
  pack: SitePackDslSchema,
  signals: PackCandidateSignalsSchema,
  createdAt: IsoDateTimeSchema,
});

export const PackCandidateProposalSchema = PackCandidateProposal;

type PackCandidateSignal = Schema.Schema.Type<typeof PackCandidateSignalSchema>;
type PackCandidateOperation = Schema.Schema.Type<typeof PackCandidateOperationSchema>;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function sanitizeIdentifierFragment(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-");
}

function signalField(signal: PackCandidateSignal) {
  switch (signal.kind) {
    case "failure":
      return signal.failure.context.field;
    case "fixture":
    case "regression":
      return signal.field;
  }
}

function signalFixtureIds(signal: PackCandidateSignal) {
  return signal.kind === "fixture" ? [signal.fixtureId] : [];
}

function operationAction(
  selectorOrder: ReadonlyArray<string>,
  selectorPath: string,
): Schema.Schema.Type<typeof CandidateOperationActionSchema> | undefined {
  if (selectorOrder[0] === selectorPath) {
    return undefined;
  }

  return selectorOrder.includes(selectorPath)
    ? "promoteSelectorCandidate"
    : "appendSelectorCandidate";
}

function operationRank(action: PackCandidateOperation["action"]) {
  switch (action) {
    case "promoteSelectorCandidate":
      return 0;
    case "appendSelectorCandidate":
      return 1;
  }
}

function sourceKindRank(kind: PackCandidateOperation["sourceKinds"][number]) {
  switch (kind) {
    case "regression":
      return 0;
    case "failure":
      return 1;
    case "fixture":
      return 2;
  }
}

function rationaleForOperation(
  action: PackCandidateOperation["action"],
  sourceKinds: ReadonlyArray<PackCandidateOperation["sourceKinds"][number]>,
) {
  const leadKind = [...sourceKinds].sort(
    (left, right) => sourceKindRank(left) - sourceKindRank(right),
  )[0];
  const signalBasis =
    leadKind === "regression"
      ? "regression evidence"
      : leadKind === "failure"
        ? "failure evidence"
        : "fixture evidence";

  return action === "promoteSelectorCandidate"
    ? `Promote selector candidate based on ${signalBasis}.`
    : `Append selector candidate based on ${signalBasis}.`;
}

function mergeUnique(values: ReadonlyArray<string>) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function generatePackCandidate(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(PackCandidateGeneratorInputSchema)(input),
      catch: (cause) =>
        new PolicyViolation({
          message: readCauseMessage(
            cause,
            "Failed to decode pack candidate generator input through shared contracts.",
          ),
        }),
    });
    const selectorsByField = new Map(
      decoded.pack.selectors.map((fieldSelector) => [fieldSelector.field, fieldSelector]),
    );
    const aggregatedOperations = new Map<
      string,
      {
        readonly action: PackCandidateOperation["action"];
        readonly field: string;
        readonly selectorCandidate: PackCandidateOperation["selectorCandidate"];
        readonly evidenceRefs: ReadonlyArray<string>;
        readonly sourceKinds: ReadonlyArray<PackCandidateOperation["sourceKinds"][number]>;
        readonly fixtureIds: ReadonlyArray<string>;
      }
    >();

    for (const signal of decoded.signals) {
      const field = signalField(signal);
      const selectorConfig = selectorsByField.get(field);
      if (selectorConfig === undefined) {
        return yield* Effect.fail(
          new PolicyViolation({
            message: `Pack candidate generation requires declared selector fields. Missing field: ${field}.`,
          }),
        );
      }

      const selectorOrder = selectorConfig.candidates.map(({ path }) => path);
      if (
        signal.kind === "regression" &&
        !selectorOrder.includes(signal.currentPrimarySelectorPath)
      ) {
        return yield* Effect.fail(
          new PolicyViolation({
            message: `Regression signal for field ${field} references an unknown current primary selector path.`,
          }),
        );
      }

      const action = operationAction(selectorOrder, signal.selectorCandidate.path);
      if (action === undefined) {
        continue;
      }

      const operationKey = `${field}:${action}:${signal.selectorCandidate.path}`;
      const existingOperation = aggregatedOperations.get(operationKey);
      const nextEvidenceRefs = mergeUnique([
        ...(existingOperation?.evidenceRefs ?? []),
        ...signal.evidenceRefs,
      ]);
      const nextSourceKinds = Schema.decodeUnknownSync(PackCandidateOperationSourceKindsSchema)(
        mergeUnique([...(existingOperation?.sourceKinds ?? []), signal.kind]),
      );
      const nextFixtureIds = mergeUnique([
        ...(existingOperation?.fixtureIds ?? []),
        ...signalFixtureIds(signal),
      ]);

      aggregatedOperations.set(operationKey, {
        action,
        field,
        selectorCandidate: signal.selectorCandidate,
        evidenceRefs: nextEvidenceRefs,
        sourceKinds: nextSourceKinds,
        fixtureIds: nextFixtureIds,
      });
    }

    const operations = [...aggregatedOperations.values()]
      .map((operation) =>
        Schema.decodeUnknownSync(PackCandidateOperationSchema)({
          ...operation,
          rationale: rationaleForOperation(operation.action, operation.sourceKinds),
        }),
      )
      .sort((left, right) => {
        const fieldOrder = left.field.localeCompare(right.field);
        if (fieldOrder !== 0) {
          return fieldOrder;
        }

        const actionOrder = operationRank(left.action) - operationRank(right.action);
        if (actionOrder !== 0) {
          return actionOrder;
        }

        return left.selectorCandidate.path.localeCompare(right.selectorCandidate.path);
      });

    if (operations.length === 0) {
      return yield* Effect.fail(
        new PolicyViolation({
          message:
            "Pack candidate generation produced no actionable selector candidate delta from the provided signals.",
        }),
      );
    }

    const evidenceRefs = mergeUnique(operations.flatMap((operation) => operation.evidenceRefs));

    return Schema.decodeUnknownSync(PackCandidateProposalSchema)({
      id: sanitizeIdentifierFragment(`candidate-${decoded.pack.pack.id}-${decoded.createdAt}`),
      sourcePackId: decoded.pack.pack.id,
      sourcePackVersion: decoded.pack.pack.version,
      sourcePackState: decoded.pack.pack.state,
      targetPackState: "draft",
      operations,
      evidenceRefs,
      createdAt: decoded.createdAt,
    });
  });
}

export type PackCandidateOperationEncoded = Schema.Codec.Encoded<
  typeof PackCandidateOperationSchema
>;
export type PackCandidateProposalEncoded = Schema.Codec.Encoded<typeof PackCandidateProposalSchema>;
export type PackCandidateSignalEncoded = Schema.Codec.Encoded<typeof PackCandidateSignalSchema>;
