import { Effect, Schema } from "effect";
import {
  CanonicalIdentifierSchema,
  CanonicalKeySchema,
  IsoDateTimeSchema,
} from "./schema-primitives.ts";
import { PolicyViolation } from "./tagged-errors.ts";

const BoundedScoreSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);
const PositiveFiniteSchema = Schema.Finite.check(Schema.isGreaterThan(0));
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeFiniteSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const EvidenceRefsSchema = Schema.Array(CanonicalIdentifierSchema).pipe(
  Schema.withDecodingDefault(() => []),
  Schema.refine(
    (evidenceRefs): evidenceRefs is ReadonlyArray<string> =>
      new Set(evidenceRefs).size === evidenceRefs.length,
    {
      message: "Expected unique canonical evidence references for selector trust events.",
    },
  ),
);

const DEFAULT_SELECTOR_TRUST_POLICY = Object.freeze({
  halfLifeHours: 72,
  priorSuccessWeight: 4,
  priorFailureWeight: 1,
  recoverableFailurePenalty: 1.25,
  hardFailurePenalty: 3,
  degradedThreshold: 0.45,
  trustedThreshold: 0.8,
});

export const SelectorTrustBandSchema = Schema.Union([
  Schema.Literal("trusted"),
  Schema.Literal("degraded"),
  Schema.Literal("blocked"),
]);
export const SelectorTrustEventOutcomeSchema = Schema.Union([
  Schema.Literal("success"),
  Schema.Literal("recoverableFailure"),
  Schema.Literal("hardFailure"),
]);

export class SelectorTrustEvent extends Schema.Class<SelectorTrustEvent>("SelectorTrustEvent")({
  selectorPath: CanonicalKeySchema,
  outcome: SelectorTrustEventOutcomeSchema,
  observedAt: IsoDateTimeSchema,
  evidenceRefs: EvidenceRefsSchema,
}) {}

const SelectorTrustPolicyBaseSchema = Schema.Struct({
  halfLifeHours: PositiveIntSchema,
  priorSuccessWeight: PositiveFiniteSchema,
  priorFailureWeight: PositiveFiniteSchema,
  recoverableFailurePenalty: PositiveFiniteSchema,
  hardFailurePenalty: PositiveFiniteSchema,
  degradedThreshold: BoundedScoreSchema,
  trustedThreshold: BoundedScoreSchema,
});

export const SelectorTrustPolicySchema = SelectorTrustPolicyBaseSchema.pipe(
  Schema.refine(
    (policy): policy is Schema.Schema.Type<typeof SelectorTrustPolicyBaseSchema> =>
      policy.trustedThreshold > policy.degradedThreshold,
    {
      message:
        "Expected selector trust thresholds where trustedThreshold is strictly greater than degradedThreshold.",
    },
  ),
);

const SelectorTrustEventsSchema = Schema.Array(SelectorTrustEvent);

export class SelectorTrustRecord extends Schema.Class<SelectorTrustRecord>("SelectorTrustRecord")({
  selectorPath: CanonicalKeySchema,
  score: BoundedScoreSchema,
  band: SelectorTrustBandSchema,
  weightedSuccesses: NonNegativeFiniteSchema,
  weightedFailures: NonNegativeFiniteSchema,
  eventCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lastObservedAt: IsoDateTimeSchema,
  evidenceRefs: EvidenceRefsSchema,
}) {}

const SelectorTrustRecordsSchema = Schema.Array(SelectorTrustRecord).pipe(
  Schema.refine(
    (records): records is ReadonlyArray<SelectorTrustRecord> =>
      new Set(records.map(({ selectorPath }) => selectorPath)).size === records.length,
    {
      message: "Expected selector trust records with unique selector paths.",
    },
  ),
);

export class SelectorTrustSummary extends Schema.Class<SelectorTrustSummary>(
  "SelectorTrustSummary",
)({
  evaluatedAt: IsoDateTimeSchema,
  records: SelectorTrustRecordsSchema,
}) {}

export const SelectorTrustEventSchema = SelectorTrustEvent;
export const SelectorTrustRecordSchema = SelectorTrustRecord;
export const SelectorTrustSummarySchema = SelectorTrustSummary;

const SelectorTrustComputationInputSchema = Schema.Struct({
  events: SelectorTrustEventsSchema,
  evaluatedAt: IsoDateTimeSchema,
  policy: Schema.optional(SelectorTrustPolicySchema),
});

type SelectorTrustPolicy = Schema.Schema.Type<typeof SelectorTrustPolicySchema>;
type SelectorTrustEventType = Schema.Schema.Type<typeof SelectorTrustEventSchema>;
export type SelectorTrustBand = Schema.Schema.Type<typeof SelectorTrustBandSchema>;

function roundToSix(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function resolvePolicy(policy: SelectorTrustPolicy | undefined) {
  return (
    policy ?? Schema.decodeUnknownSync(SelectorTrustPolicySchema)(DEFAULT_SELECTOR_TRUST_POLICY)
  );
}

function toDecayWeight(evaluatedAt: string, observedAt: string, halfLifeHours: number) {
  const ageMs = Math.max(0, Date.parse(evaluatedAt) - Date.parse(observedAt));
  const halfLifeMs = halfLifeHours * 60 * 60 * 1_000;
  return roundToSix(0.5 ** (ageMs / halfLifeMs));
}

function trustBandForScore(score: number, policy: SelectorTrustPolicy): SelectorTrustBand {
  if (score >= policy.trustedThreshold) {
    return "trusted";
  }

  if (score >= policy.degradedThreshold) {
    return "degraded";
  }

  return "blocked";
}

function trustBandRank(band: SelectorTrustBand) {
  switch (band) {
    case "blocked":
      return 0;
    case "degraded":
      return 1;
    case "trusted":
      return 2;
  }
}

function weightedFailureContribution(
  outcome: SelectorTrustEventType["outcome"],
  policy: SelectorTrustPolicy,
) {
  switch (outcome) {
    case "success":
      return 0;
    case "recoverableFailure":
      return policy.recoverableFailurePenalty;
    case "hardFailure":
      return policy.hardFailurePenalty;
  }
}

function buildRecord(
  selectorPath: string,
  events: ReadonlyArray<SelectorTrustEventType>,
  evaluatedAt: string,
  policy: SelectorTrustPolicy,
) {
  let weightedSuccesses = policy.priorSuccessWeight;
  let weightedFailures = policy.priorFailureWeight;

  for (const event of events) {
    const decayWeight = toDecayWeight(evaluatedAt, event.observedAt, policy.halfLifeHours);
    if (event.outcome === "success") {
      weightedSuccesses += decayWeight;
      continue;
    }

    weightedFailures += decayWeight * weightedFailureContribution(event.outcome, policy);
  }

  const score = roundToSix(weightedSuccesses / (weightedSuccesses + weightedFailures));
  const evidenceRefs = [...new Set(events.flatMap((event) => event.evidenceRefs))].sort(
    (left, right) => left.localeCompare(right),
  );
  const lastObservedAt = [...events]
    .map(({ observedAt }) => observedAt)
    .sort((left, right) => right.localeCompare(left))[0];

  return Schema.decodeUnknownSync(SelectorTrustRecordSchema)({
    selectorPath,
    score,
    band: trustBandForScore(score, policy),
    weightedSuccesses: roundToSix(weightedSuccesses),
    weightedFailures: roundToSix(weightedFailures),
    eventCount: events.length,
    lastObservedAt: lastObservedAt ?? evaluatedAt,
    evidenceRefs,
  });
}

export function summarizeSelectorTrust(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(SelectorTrustComputationInputSchema)(input),
      catch: (cause) =>
        new PolicyViolation({
          message: readCauseMessage(
            cause,
            "Failed to decode selector trust computation input through shared contracts.",
          ),
        }),
    });
    const policy = resolvePolicy(decoded.policy);
    const eventsBySelector = new Map<string, Array<SelectorTrustEventType>>();

    for (const event of decoded.events) {
      const selectorEvents = eventsBySelector.get(event.selectorPath) ?? [];
      selectorEvents.push(event);
      eventsBySelector.set(event.selectorPath, selectorEvents);
    }

    const records = [...eventsBySelector.entries()]
      .map(([selectorPath, events]) =>
        buildRecord(selectorPath, events, decoded.evaluatedAt, policy),
      )
      .sort((left, right) => {
        const bandOrder = trustBandRank(left.band) - trustBandRank(right.band);
        if (bandOrder !== 0) {
          return bandOrder;
        }

        const scoreOrder = left.score - right.score;
        if (scoreOrder !== 0) {
          return scoreOrder;
        }

        return left.selectorPath.localeCompare(right.selectorPath);
      });

    return Schema.decodeUnknownSync(SelectorTrustSummarySchema)({
      evaluatedAt: decoded.evaluatedAt,
      records,
    });
  });
}

export type SelectorTrustEventEncoded = Schema.Codec.Encoded<typeof SelectorTrustEventSchema>;
export type SelectorTrustPolicyEncoded = Schema.Codec.Encoded<typeof SelectorTrustPolicySchema>;
export type SelectorTrustRecordEncoded = Schema.Codec.Encoded<typeof SelectorTrustRecordSchema>;
export type SelectorTrustSummaryEncoded = Schema.Codec.Encoded<typeof SelectorTrustSummarySchema>;
