import { Effect, Schema } from "effect";
import {
  PackCandidateProposal,
  PackCandidateSignalSchema,
  generatePackCandidate,
} from "./pack-candidate-generator.ts";
import {
  CanonicalIdentifierSchema,
  CanonicalKeySchema,
  IsoDateTimeSchema,
} from "./schema-primitives.ts";
import { SitePackDslSchema } from "./site-pack.ts";
import { PolicyViolation } from "./tagged-errors.ts";

const NonEmptyMessageSchema = Schema.Trim.check(Schema.isNonEmpty());
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const NonEmptyEvidenceRefsSchema = Schema.Array(CanonicalIdentifierSchema).pipe(
  Schema.refine(
    (evidenceRefs): evidenceRefs is ReadonlyArray<string> =>
      evidenceRefs.length > 0 && new Set(evidenceRefs).size === evidenceRefs.length,
    {
      message: "Expected non-empty unique evidence references for reflector clusters.",
    },
  ),
);
const FixtureIdsSchema = Schema.Array(CanonicalIdentifierSchema).pipe(
  Schema.withDecodingDefault(() => []),
  Schema.refine(
    (fixtureIds): fixtureIds is ReadonlyArray<string> =>
      new Set(fixtureIds).size === fixtureIds.length,
    {
      message: "Expected unique fixture identifiers for reflector clusters.",
    },
  ),
);
const ReflectorPatternKindSchema = Schema.Union([
  Schema.Literal("missingRequiredFieldPattern"),
  Schema.Literal("businessInvariantPattern"),
  Schema.Literal("selectorRegressionPattern"),
  Schema.Literal("fixtureConsensusPattern"),
]);

export class ReflectorCluster extends Schema.Class<ReflectorCluster>("ReflectorCluster")({
  id: CanonicalIdentifierSchema,
  packId: CanonicalIdentifierSchema,
  field: CanonicalIdentifierSchema,
  selectorPath: CanonicalKeySchema,
  kind: ReflectorPatternKindSchema,
  occurrenceCount: PositiveIntSchema,
  evidenceRefs: NonEmptyEvidenceRefsSchema,
  fixtureIds: FixtureIdsSchema,
  rationale: NonEmptyMessageSchema,
}) {}

const ReflectorClustersSchema = Schema.Array(ReflectorCluster).pipe(
  Schema.refine(
    (clusters): clusters is ReadonlyArray<ReflectorCluster> =>
      clusters.length > 0 && new Set(clusters.map(({ id }) => id)).size === clusters.length,
    {
      message: "Expected at least one unique reflector cluster.",
    },
  ),
);

export class PackReflectionRecommendation extends Schema.Class<PackReflectionRecommendation>(
  "PackReflectionRecommendation",
)({
  id: CanonicalIdentifierSchema,
  packId: CanonicalIdentifierSchema,
  createdAt: IsoDateTimeSchema,
  minimumOccurrenceCount: PositiveIntSchema,
  clusters: ReflectorClustersSchema,
  proposal: PackCandidateProposal,
  rationale: NonEmptyMessageSchema,
}) {}

const ReflectorInputSchema = Schema.Struct({
  pack: SitePackDslSchema,
  signals: Schema.Array(PackCandidateSignalSchema).pipe(
    Schema.refine(
      (signals): signals is ReadonlyArray<Schema.Schema.Type<typeof PackCandidateSignalSchema>> =>
        signals.length > 0,
      {
        message: "Expected at least one typed signal for reflector synthesis.",
      },
    ),
  ),
  createdAt: IsoDateTimeSchema,
  minimumOccurrenceCount: PositiveIntSchema.pipe(Schema.withDecodingDefault(() => 2)),
});

export const ReflectorClusterSchema = ReflectorCluster;
export const PackReflectionRecommendationSchema = PackReflectionRecommendation;

type PackCandidateSignal = Schema.Schema.Type<typeof PackCandidateSignalSchema>;
type ReflectorPatternKind = Schema.Schema.Type<typeof ReflectorPatternKindSchema>;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function encodeIdentifierFragment(value: string) {
  return encodeURIComponent(value);
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

function clusterKindForSignal(signal: PackCandidateSignal): ReflectorPatternKind {
  switch (signal.kind) {
    case "failure":
      return signal.failure.kind === "missingRequiredField"
        ? "missingRequiredFieldPattern"
        : "businessInvariantPattern";
    case "regression":
      return "selectorRegressionPattern";
    case "fixture":
      return "fixtureConsensusPattern";
  }
}

function clusterRationale(kind: ReflectorPatternKind, field: string, selectorPath: string) {
  switch (kind) {
    case "missingRequiredFieldPattern":
      return `Recurring missing required field failures suggest pack-level selector drift for ${field} toward ${selectorPath}.`;
    case "businessInvariantPattern":
      return `Recurring business invariant failures suggest pack-level normalization drift for ${field} near ${selectorPath}.`;
    case "selectorRegressionPattern":
      return `Recurring selector regressions suggest pack-level fallback drift for ${field} toward ${selectorPath}.`;
    case "fixtureConsensusPattern":
      return `Recurring fixture consensus supports pack-level promotion for ${field} via ${selectorPath}.`;
  }
}

function clusterKey(signal: PackCandidateSignal) {
  const field = signalField(signal);
  const kind = clusterKindForSignal(signal);

  switch (signal.kind) {
    case "failure":
      return `${field}:${kind}:${signal.failure.kind}:${signal.selectorCandidate.path}`;
    case "regression":
      return `${field}:${kind}:${signal.currentPrimarySelectorPath}:${signal.selectorCandidate.path}`;
    case "fixture":
      return `${field}:${kind}:${signal.selectorCandidate.path}`;
  }
}

function kindRank(kind: ReflectorPatternKind) {
  switch (kind) {
    case "selectorRegressionPattern":
      return 0;
    case "missingRequiredFieldPattern":
      return 1;
    case "businessInvariantPattern":
      return 2;
    case "fixtureConsensusPattern":
      return 3;
  }
}

function mergeUnique(values: ReadonlyArray<string>) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function synthesizePackReflection(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(ReflectorInputSchema)(input),
      catch: (cause) =>
        new PolicyViolation({
          message: readCauseMessage(
            cause,
            "Failed to decode reflector synthesis input through shared contracts.",
          ),
        }),
    });

    const aggregatedSignals = new Map<
      string,
      {
        readonly field: string;
        readonly selectorPath: string;
        readonly kind: ReflectorPatternKind;
        readonly signals: Array<PackCandidateSignal>;
        readonly evidenceRefs: Array<string>;
        readonly fixtureIds: Array<string>;
      }
    >();

    for (const signal of decoded.signals) {
      const key = clusterKey(signal);
      const existing = aggregatedSignals.get(key);
      aggregatedSignals.set(key, {
        field: signalField(signal),
        selectorPath: signal.selectorCandidate.path,
        kind: clusterKindForSignal(signal),
        signals: [...(existing?.signals ?? []), signal],
        evidenceRefs: mergeUnique([...(existing?.evidenceRefs ?? []), ...signal.evidenceRefs]),
        fixtureIds: mergeUnique([...(existing?.fixtureIds ?? []), ...signalFixtureIds(signal)]),
      });
    }

    const recurringClusters = [...aggregatedSignals.values()]
      .filter(({ signals }) => signals.length >= decoded.minimumOccurrenceCount)
      .sort((left, right) => {
        const fieldOrder = left.field.localeCompare(right.field);
        if (fieldOrder !== 0) {
          return fieldOrder;
        }

        const kindOrder = kindRank(left.kind) - kindRank(right.kind);
        if (kindOrder !== 0) {
          return kindOrder;
        }

        return left.selectorPath.localeCompare(right.selectorPath);
      });

    const clusters = recurringClusters.map((cluster) =>
      Schema.decodeUnknownSync(ReflectorClusterSchema)({
        id: encodeIdentifierFragment(
          `cluster-${decoded.pack.pack.id}-${cluster.field}-${cluster.selectorPath}-${cluster.kind}`,
        ),
        packId: decoded.pack.pack.id,
        field: cluster.field,
        selectorPath: cluster.selectorPath,
        kind: cluster.kind,
        occurrenceCount: cluster.signals.length,
        evidenceRefs: cluster.evidenceRefs,
        fixtureIds: cluster.fixtureIds,
        rationale: clusterRationale(cluster.kind, cluster.field, cluster.selectorPath),
      }),
    );

    if (clusters.length === 0) {
      return yield* Effect.fail(
        new PolicyViolation({
          message:
            "Reflector synthesis found no recurring pack-level patterns above the configured occurrence threshold.",
        }),
      );
    }

    const proposal = yield* generatePackCandidate({
      pack: decoded.pack,
      signals: recurringClusters.flatMap(({ signals }) => signals),
      createdAt: decoded.createdAt,
    });

    return Schema.decodeUnknownSync(PackReflectionRecommendationSchema)({
      id: encodeIdentifierFragment(`reflection-${decoded.pack.pack.id}-${decoded.createdAt}`),
      packId: decoded.pack.pack.id,
      createdAt: decoded.createdAt,
      minimumOccurrenceCount: decoded.minimumOccurrenceCount,
      clusters,
      proposal,
      rationale: `Synthesize one pack-level candidate proposal from ${clusters.length} recurring drift pattern(s).`,
    });
  });
}

export type PackReflectionRecommendationEncoded = Schema.Codec.Encoded<
  typeof PackReflectionRecommendationSchema
>;
export type ReflectorClusterEncoded = Schema.Codec.Encoded<typeof ReflectorClusterSchema>;
