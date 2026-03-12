import { Effect, Layer, ServiceMap } from "effect";
import {
  DEFAULT_EGRESS_PROFILE_ID,
  DEFAULT_IDENTITY_PROFILE_ID,
  DEFAULT_LEASED_IDENTITY_PROFILE_ID,
  DEFAULT_LEASED_STEALTH_IDENTITY_PROFILE_ID,
  DEFAULT_STEALTH_IDENTITY_PROFILE_ID,
  type AccessEgressProfileDescriptor,
  type AccessIdentityProfileDescriptor,
} from "./access-profile-runtime.ts";
import {
  accessProfileSelectionEgressPluginKey,
  accessProfileSelectionIdentityPluginKey,
  type AccessProfileSelectionHealthSignals,
} from "./access-profile-selection-health-runtime.ts";
import { type AccessProfileSelector, type AccessProviderId } from "./schemas.ts";

export type AccessEgressProfileSelectionInput = {
  readonly selector?: AccessProfileSelector | undefined;
  readonly availableProfiles: ReadonlyArray<AccessEgressProfileDescriptor>;
  readonly healthSignals: AccessProfileSelectionHealthSignals;
};

export type AccessIdentityProfileSelectionInput = {
  readonly selector?: AccessProfileSelector | undefined;
  readonly providerId: AccessProviderId;
  readonly availableProfiles: ReadonlyArray<AccessIdentityProfileDescriptor>;
  readonly healthSignals: AccessProfileSelectionHealthSignals;
};

export type AccessProfileSelectionDecisionRationale =
  | "preferred"
  | "health-signals"
  | "strategy-order"
  | "custom";

export type AccessProfileSelectionDecision = {
  readonly profileId: string;
  readonly rationale: AccessProfileSelectionDecisionRationale;
};

const EGRESS_PLUGIN_SCORE_DRIFT_TOLERANCE = 20;
const EGRESS_HEALTH_SCORE_DRIFT_TOLERANCE = 20;
const IDENTITY_PLUGIN_SCORE_DRIFT_TOLERANCE = 35;
const IDENTITY_HEALTH_SCORE_DRIFT_TOLERANCE = 35;

function snapshotIsQuarantined(input: {
  readonly quarantinedUntil?: string | null | undefined;
  readonly currentTimeMs: number;
}) {
  const { quarantinedUntil, currentTimeMs } = input;
  return quarantinedUntil !== null && quarantinedUntil !== undefined
    ? Date.parse(quarantinedUntil) > currentTimeMs
    : false;
}

function rankEgressProfile(input: {
  readonly profile: AccessEgressProfileDescriptor;
  readonly healthSignals: AccessProfileSelectionHealthSignals;
  readonly currentTimeMs: number;
}) {
  const profileSnapshot = input.healthSignals.egressProfiles[input.profile.profileId];
  const pluginSnapshot =
    input.healthSignals.egressPlugins[
      accessProfileSelectionEgressPluginKey({
        poolId: input.profile.poolId,
        routePolicyId: input.profile.routePolicyId,
        pluginId: input.profile.pluginId,
      })
    ];

  return {
    quarantined:
      snapshotIsQuarantined({
        quarantinedUntil: pluginSnapshot?.quarantinedUntil,
        currentTimeMs: input.currentTimeMs,
      }) ||
      snapshotIsQuarantined({
        quarantinedUntil: profileSnapshot?.quarantinedUntil,
        currentTimeMs: input.currentTimeMs,
      })
        ? 1
        : 0,
    pluginScore: pluginSnapshot?.score ?? 100,
    score: profileSnapshot?.score ?? 100,
    direct: input.profile.profileId === DEFAULT_EGRESS_PROFILE_ID ? 1 : 0,
  };
}

function comparePreferredBias(input: {
  readonly leftBias: number;
  readonly rightBias: number;
  readonly leftScore: number;
  readonly rightScore: number;
  readonly tolerance: number;
}) {
  if (input.leftBias === input.rightBias) {
    return 0;
  }

  const leftIsPreferred = input.leftBias > input.rightBias;
  const preferredScore = leftIsPreferred ? input.leftScore : input.rightScore;
  const challengerScore = leftIsPreferred ? input.rightScore : input.leftScore;

  return challengerScore - preferredScore <= input.tolerance ? input.rightBias - input.leftBias : 0;
}

function comparePreferredBiasAcrossSignals(input: {
  readonly leftBias: number;
  readonly rightBias: number;
  readonly leftPluginScore: number;
  readonly rightPluginScore: number;
  readonly pluginTolerance: number;
  readonly leftHealthScore: number;
  readonly rightHealthScore: number;
  readonly healthTolerance: number;
}) {
  if (input.leftBias === input.rightBias) {
    return 0;
  }

  const leftIsPreferred = input.leftBias > input.rightBias;
  const preferredPluginScore = leftIsPreferred ? input.leftPluginScore : input.rightPluginScore;
  const challengerPluginScore = leftIsPreferred ? input.rightPluginScore : input.leftPluginScore;
  const preferredHealthScore = leftIsPreferred ? input.leftHealthScore : input.rightHealthScore;
  const challengerHealthScore = leftIsPreferred ? input.rightHealthScore : input.leftHealthScore;

  return challengerPluginScore - preferredPluginScore <= input.pluginTolerance &&
    challengerHealthScore - preferredHealthScore <= input.healthTolerance
    ? input.rightBias - input.leftBias
    : 0;
}

function compareEgressProfiles(
  left: AccessEgressProfileDescriptor,
  right: AccessEgressProfileDescriptor,
  healthSignals: AccessProfileSelectionHealthSignals,
  currentTimeMs: number,
) {
  const leftRank = rankEgressProfile({ profile: left, healthSignals, currentTimeMs });
  const rightRank = rankEgressProfile({ profile: right, healthSignals, currentTimeMs });

  if (leftRank.quarantined !== rightRank.quarantined) {
    return leftRank.quarantined - rightRank.quarantined;
  }

  const preferredDirectBias = comparePreferredBiasAcrossSignals({
    leftBias: leftRank.direct,
    rightBias: rightRank.direct,
    leftPluginScore: leftRank.pluginScore,
    rightPluginScore: rightRank.pluginScore,
    pluginTolerance: EGRESS_PLUGIN_SCORE_DRIFT_TOLERANCE,
    leftHealthScore: leftRank.score,
    rightHealthScore: rightRank.score,
    healthTolerance: EGRESS_HEALTH_SCORE_DRIFT_TOLERANCE,
  });
  if (preferredDirectBias !== 0) {
    return preferredDirectBias;
  }

  if (leftRank.pluginScore !== rightRank.pluginScore) {
    return rightRank.pluginScore - leftRank.pluginScore;
  }

  if (leftRank.score !== rightRank.score) {
    return rightRank.score - leftRank.score;
  }

  if (leftRank.direct !== rightRank.direct) {
    return rightRank.direct - leftRank.direct;
  }

  return left.profileId.localeCompare(right.profileId);
}

function rankIdentityProfile(input: {
  readonly profile: AccessIdentityProfileDescriptor;
  readonly preferredProfileIds: ReadonlyArray<string>;
  readonly healthSignals: AccessProfileSelectionHealthSignals;
  readonly currentTimeMs: number;
}) {
  const profileSnapshot = input.healthSignals.identityProfiles[input.profile.profileId];
  const pluginSnapshot =
    input.healthSignals.identityPlugins[
      accessProfileSelectionIdentityPluginKey({
        tenantId: input.profile.tenantId,
        pluginId: input.profile.pluginId,
      })
    ];
  const preferenceRank = input.preferredProfileIds.indexOf(input.profile.profileId);

  return {
    quarantined:
      snapshotIsQuarantined({
        quarantinedUntil: pluginSnapshot?.quarantinedUntil,
        currentTimeMs: input.currentTimeMs,
      }) ||
      snapshotIsQuarantined({
        quarantinedUntil: profileSnapshot?.quarantinedUntil,
        currentTimeMs: input.currentTimeMs,
      })
        ? 1
        : 0,
    pluginScore: pluginSnapshot?.score ?? 100,
    score: profileSnapshot?.score ?? 100,
    preferenceRank: preferenceRank === -1 ? input.preferredProfileIds.length + 1 : preferenceRank,
  };
}

function compareIdentityProfiles(
  left: AccessIdentityProfileDescriptor,
  right: AccessIdentityProfileDescriptor,
  preferredProfileIds: ReadonlyArray<string>,
  healthSignals: AccessProfileSelectionHealthSignals,
  currentTimeMs: number,
) {
  const leftRank = rankIdentityProfile({
    profile: left,
    preferredProfileIds,
    healthSignals,
    currentTimeMs,
  });
  const rightRank = rankIdentityProfile({
    profile: right,
    preferredProfileIds,
    healthSignals,
    currentTimeMs,
  });

  if (leftRank.quarantined !== rightRank.quarantined) {
    return leftRank.quarantined - rightRank.quarantined;
  }

  const preferredIdentityBias = comparePreferredBias({
    leftBias: -leftRank.preferenceRank,
    rightBias: -rightRank.preferenceRank,
    leftScore: leftRank.pluginScore,
    rightScore: rightRank.pluginScore,
    tolerance: IDENTITY_PLUGIN_SCORE_DRIFT_TOLERANCE,
  });
  if (preferredIdentityBias !== 0) {
    return preferredIdentityBias;
  }

  if (leftRank.pluginScore !== rightRank.pluginScore) {
    return rightRank.pluginScore - leftRank.pluginScore;
  }

  const preferredIdentityHealthBias = comparePreferredBias({
    leftBias: -leftRank.preferenceRank,
    rightBias: -rightRank.preferenceRank,
    leftScore: leftRank.score,
    rightScore: rightRank.score,
    tolerance: IDENTITY_HEALTH_SCORE_DRIFT_TOLERANCE,
  });
  if (preferredIdentityHealthBias !== 0) {
    return preferredIdentityHealthBias;
  }

  if (leftRank.score !== rightRank.score) {
    return rightRank.score - leftRank.score;
  }

  if (leftRank.preferenceRank !== rightRank.preferenceRank) {
    return leftRank.preferenceRank - rightRank.preferenceRank;
  }

  return left.profileId.localeCompare(right.profileId);
}

export function makeDefaultAccessProfileSelectionStrategy(input?: {
  readonly now?: (() => number) | undefined;
}) {
  const now = input?.now ?? Date.now;

  return {
    selectEgressProfileId: ({
      selector,
      availableProfiles,
      healthSignals,
    }: AccessEgressProfileSelectionInput) =>
      Effect.sync(() => {
        if (selector?.profileId !== undefined) {
          return {
            profileId: selector.profileId,
            rationale: "preferred",
          } satisfies AccessProfileSelectionDecision;
        }

        const currentTimeMs = now();
        const sortedProfiles = [...availableProfiles].sort((left, right) =>
          compareEgressProfiles(left, right, healthSignals, currentTimeMs),
        );
        const selectedProfileId = sortedProfiles[0]?.profileId ?? DEFAULT_EGRESS_PROFILE_ID;
        const preferredProfile = availableProfiles.find(
          (profile) => profile.profileId === DEFAULT_EGRESS_PROFILE_ID,
        );

        return {
          profileId: selectedProfileId,
          rationale:
            selectedProfileId === DEFAULT_EGRESS_PROFILE_ID
              ? "preferred"
              : preferredProfile !== undefined &&
                  compareEgressProfiles(
                    preferredProfile,
                    sortedProfiles[0] ?? preferredProfile,
                    healthSignals,
                    currentTimeMs,
                  ) > 0
                ? "health-signals"
                : "strategy-order",
        } satisfies AccessProfileSelectionDecision;
      }),
    selectIdentityProfileId: ({
      selector,
      providerId,
      availableProfiles,
      healthSignals,
    }: AccessIdentityProfileSelectionInput) =>
      Effect.sync(() => {
        if (selector?.profileId !== undefined) {
          return {
            profileId: selector.profileId,
            rationale: "preferred",
          } satisfies AccessProfileSelectionDecision;
        }

        const preferredProfileIds =
          providerId === "browser-stealth"
            ? [
                DEFAULT_STEALTH_IDENTITY_PROFILE_ID,
                DEFAULT_LEASED_STEALTH_IDENTITY_PROFILE_ID,
                DEFAULT_IDENTITY_PROFILE_ID,
                DEFAULT_LEASED_IDENTITY_PROFILE_ID,
              ]
            : [
                DEFAULT_IDENTITY_PROFILE_ID,
                DEFAULT_LEASED_IDENTITY_PROFILE_ID,
                DEFAULT_STEALTH_IDENTITY_PROFILE_ID,
                DEFAULT_LEASED_STEALTH_IDENTITY_PROFILE_ID,
              ];

        const currentTimeMs = now();
        const sortedProfiles = [...availableProfiles].sort((left, right) =>
          compareIdentityProfiles(left, right, preferredProfileIds, healthSignals, currentTimeMs),
        );
        const selectedProfileId = sortedProfiles[0]?.profileId ?? DEFAULT_IDENTITY_PROFILE_ID;
        const preferredProfile = availableProfiles.find(
          (profile) => profile.profileId === preferredProfileIds[0],
        );

        return {
          profileId: selectedProfileId,
          rationale:
            selectedProfileId === preferredProfileIds[0]
              ? "preferred"
              : preferredProfile !== undefined &&
                  compareIdentityProfiles(
                    preferredProfile,
                    sortedProfiles[0] ?? preferredProfile,
                    preferredProfileIds,
                    healthSignals,
                    currentTimeMs,
                  ) > 0
                ? "health-signals"
                : "strategy-order",
        } satisfies AccessProfileSelectionDecision;
      }),
  } satisfies {
    readonly selectEgressProfileId: (
      input: AccessEgressProfileSelectionInput,
    ) => Effect.Effect<AccessProfileSelectionDecision, never>;
    readonly selectIdentityProfileId: (
      input: AccessIdentityProfileSelectionInput,
    ) => Effect.Effect<AccessProfileSelectionDecision, never>;
  };
}

export class AccessProfileSelectionStrategy extends ServiceMap.Service<
  AccessProfileSelectionStrategy,
  {
    readonly selectEgressProfileId: (
      input: AccessEgressProfileSelectionInput,
    ) => Effect.Effect<AccessProfileSelectionDecision, never>;
    readonly selectIdentityProfileId: (
      input: AccessIdentityProfileSelectionInput,
    ) => Effect.Effect<AccessProfileSelectionDecision, never>;
  }
>()("@effect-scrapling/sdk/AccessProfileSelectionStrategy") {}

export const AccessProfileSelectionStrategyLive = Layer.succeed(
  AccessProfileSelectionStrategy,
  makeDefaultAccessProfileSelectionStrategy(),
);
