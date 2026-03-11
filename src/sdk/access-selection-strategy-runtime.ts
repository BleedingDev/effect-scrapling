import { Effect, Layer, ServiceMap } from "effect";
import { type AccessHealthSnapshot } from "@effect-scrapling/foundation-core/access-health-runtime";
import { type AccessSelectionHealthSignals } from "./access-selection-health-runtime.ts";
import { type AccessMode, type AccessProviderId } from "./schemas.ts";

export type AccessSelectionCandidate = {
  readonly providerId: AccessProviderId;
  readonly mode: AccessMode;
  readonly inputOrder: number;
  readonly preferred: boolean;
};

export type AccessSelectionStrategyInput = {
  readonly url: string;
  readonly mode: AccessMode;
  readonly preferredProviderId: AccessProviderId;
  readonly candidates: ReadonlyArray<AccessSelectionCandidate>;
  readonly healthSignals: AccessSelectionHealthSignals;
};

export type AccessSelectionStrategyDecision = {
  readonly providerId: AccessProviderId;
  readonly rationale: "preferred" | "health-signals" | "input-order" | "custom";
};

function snapshotIsQuarantined(snapshot: AccessHealthSnapshot | undefined) {
  return (
    snapshot !== undefined &&
    snapshot.quarantinedUntil !== null &&
    Date.parse(snapshot.quarantinedUntil) > Date.now()
  );
}

function candidateRank(input: {
  readonly candidate: AccessSelectionCandidate;
  readonly healthSignals: AccessSelectionHealthSignals;
}) {
  const snapshot = input.healthSignals.providers[input.candidate.providerId];

  return {
    quarantined: snapshotIsQuarantined(snapshot) ? 1 : 0,
    score: snapshot?.score ?? 100,
    preferred: input.candidate.preferred ? 1 : 0,
    inputOrder: input.candidate.inputOrder,
  };
}

function candidateIsLessHealthyThan(input: {
  readonly left: AccessSelectionCandidate;
  readonly right: AccessSelectionCandidate;
  readonly healthSignals: AccessSelectionHealthSignals;
}) {
  return compareCandidates(input.left, input.right, input.healthSignals) > 0;
}

function compareCandidates(
  left: AccessSelectionCandidate,
  right: AccessSelectionCandidate,
  healthSignals: AccessSelectionHealthSignals,
) {
  const leftRank = candidateRank({
    candidate: left,
    healthSignals,
  });
  const rightRank = candidateRank({
    candidate: right,
    healthSignals,
  });

  if (leftRank.quarantined !== rightRank.quarantined) {
    return leftRank.quarantined - rightRank.quarantined;
  }

  if (leftRank.score !== rightRank.score) {
    return rightRank.score - leftRank.score;
  }

  if (leftRank.preferred !== rightRank.preferred) {
    return rightRank.preferred - leftRank.preferred;
  }

  return leftRank.inputOrder - rightRank.inputOrder;
}

export function makeHealthyFirstAccessSelectionStrategy() {
  return {
    selectCandidate: (input: AccessSelectionStrategyInput) =>
      Effect.sync(() => {
        const sortedCandidates = [...input.candidates].sort((left, right) =>
          compareCandidates(left, right, input.healthSignals),
        );
        const selectedCandidate = sortedCandidates[0] ?? input.candidates[0];
        if (selectedCandidate === undefined) {
          return {
            providerId: input.preferredProviderId,
            rationale: "preferred",
          } satisfies AccessSelectionStrategyDecision;
        }

        const preferredCandidate = input.candidates.find(
          (candidate) => candidate.providerId === input.preferredProviderId,
        );
        const rationale =
          selectedCandidate.providerId === input.preferredProviderId
            ? "preferred"
            : preferredCandidate !== undefined &&
                candidateIsLessHealthyThan({
                  left: preferredCandidate,
                  right: selectedCandidate,
                  healthSignals: input.healthSignals,
                })
              ? "health-signals"
              : "input-order";

        return {
          providerId: selectedCandidate.providerId,
          rationale,
        } satisfies AccessSelectionStrategyDecision;
      }),
  } satisfies {
    readonly selectCandidate: (
      input: AccessSelectionStrategyInput,
    ) => Effect.Effect<AccessSelectionStrategyDecision, never>;
  };
}

export class AccessSelectionStrategy extends ServiceMap.Service<
  AccessSelectionStrategy,
  {
    readonly selectCandidate: (
      input: AccessSelectionStrategyInput,
    ) => Effect.Effect<AccessSelectionStrategyDecision, never>;
  }
>()("@effect-scrapling/sdk/AccessSelectionStrategy") {}

export const AccessSelectionStrategyLive = Layer.succeed(
  AccessSelectionStrategy,
  makeHealthyFirstAccessSelectionStrategy(),
);
