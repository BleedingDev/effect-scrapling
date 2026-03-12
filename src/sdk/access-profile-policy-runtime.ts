import { Effect, Layer, ServiceMap } from "effect";
import {
  AccessProfileRegistry,
  AccessProfileRegistryLive,
  DEFAULT_EGRESS_PROFILE_ID,
  defaultIdentityProfileIdForProvider,
  describeResolvedEgressProfileAutoSelectionEligibility,
  type ResolvedEgressProfile,
  type ResolvedIdentityProfile,
} from "./access-profile-runtime.ts";
import {
  AccessProfileSelectionHealthSignalsGateway,
  accessProfileSelectionEgressPluginKey,
  accessProfileSelectionIdentityPluginKey,
} from "./access-profile-selection-health-runtime.ts";
import {
  AccessProfileSelectionStrategy,
  AccessProfileSelectionStrategyLive,
  type AccessProfileSelectionDecisionRationale,
  type AccessEgressProfileSelectionInput,
  type AccessIdentityProfileSelectionInput,
} from "./access-profile-selection-strategy-runtime.ts";
import { type AccessExecutionProfile, type AccessProviderId } from "./schemas.ts";
import { InvalidInputError } from "./errors.ts";
import { SharedAccessHealthSignalsLive } from "./access-health-shared-runtime.ts";
import { makePreferredPathOverrideWarning } from "./access-health-warning-runtime.ts";

export type AccessProfileResolutionInput = {
  readonly url: string;
  readonly providerId: AccessProviderId;
  readonly execution?: AccessExecutionProfile | undefined;
};

export type AccessProfileResolution = {
  readonly egress: ResolvedEgressProfile;
  readonly identity: ResolvedIdentityProfile;
};

function ensureUniqueProfileIds<Profile extends { readonly profileId: string }>(
  subject: "egress" | "identity",
  profiles: ReadonlyArray<Profile>,
): Effect.Effect<ReadonlyArray<Profile>, InvalidInputError> {
  const seen = new Set<string>();
  const duplicateProfileId = profiles.find((profile) => {
    if (seen.has(profile.profileId)) {
      return true;
    }

    seen.add(profile.profileId);
    return false;
  })?.profileId;

  return duplicateProfileId === undefined
    ? Effect.succeed(profiles)
    : Effect.fail(
        new InvalidInputError({
          message: `Duplicate ${subject} profile id`,
          details: `Profile registry exposed duplicate ${subject} profile id "${duplicateProfileId}".`,
        }),
      );
}

function snapshotIsQuarantined(quarantinedUntil?: string | null | undefined) {
  return quarantinedUntil !== undefined &&
    quarantinedUntil !== null &&
    Date.parse(quarantinedUntil) > Date.now()
    ? true
    : false;
}

function preferredProfileIsLessHealthy(input: {
  readonly preferredProfileId: string;
  readonly selectedProfileId: string;
  readonly preferredProfileSnapshot:
    | import("./access-profile-selection-health-runtime.ts").AccessProfileSelectionHealthSignals["egressProfiles"][string]
    | import("./access-profile-selection-health-runtime.ts").AccessProfileSelectionHealthSignals["identityProfiles"][string]
    | undefined;
  readonly selectedProfileSnapshot:
    | import("./access-profile-selection-health-runtime.ts").AccessProfileSelectionHealthSignals["egressProfiles"][string]
    | import("./access-profile-selection-health-runtime.ts").AccessProfileSelectionHealthSignals["identityProfiles"][string]
    | undefined;
  readonly preferredPluginSnapshot:
    | import("./access-profile-selection-health-runtime.ts").AccessProfileSelectionHealthSignals["egressPlugins"][string]
    | import("./access-profile-selection-health-runtime.ts").AccessProfileSelectionHealthSignals["identityPlugins"][string]
    | undefined;
  readonly selectedPluginSnapshot:
    | import("./access-profile-selection-health-runtime.ts").AccessProfileSelectionHealthSignals["egressPlugins"][string]
    | import("./access-profile-selection-health-runtime.ts").AccessProfileSelectionHealthSignals["identityPlugins"][string]
    | undefined;
}) {
  if (input.preferredProfileId === input.selectedProfileId) {
    return false;
  }

  if (
    snapshotIsQuarantined(input.preferredProfileSnapshot?.quarantinedUntil) ||
    snapshotIsQuarantined(input.preferredPluginSnapshot?.quarantinedUntil)
  ) {
    return true;
  }

  const preferredCompositeScore =
    (input.preferredProfileSnapshot?.score ?? 100) + (input.preferredPluginSnapshot?.score ?? 100);
  const selectedCompositeScore =
    (input.selectedProfileSnapshot?.score ?? 100) + (input.selectedPluginSnapshot?.score ?? 100);

  return selectedCompositeScore > preferredCompositeScore;
}

function withResolvedEgressWarnings(input: {
  readonly profile: ResolvedEgressProfile;
  readonly preferredProfileId: string;
  readonly selectedProfileId: string;
  readonly selectionRationale: AccessProfileSelectionDecisionRationale;
  readonly selectedProfileSnapshot:
    | import("./access-profile-selection-health-runtime.ts").AccessProfileSelectionHealthSignals["egressProfiles"][string]
    | undefined;
  readonly preferredProfileSnapshot:
    | import("./access-profile-selection-health-runtime.ts").AccessProfileSelectionHealthSignals["egressProfiles"][string]
    | undefined;
  readonly selectedPluginSnapshot:
    | import("./access-profile-selection-health-runtime.ts").AccessProfileSelectionHealthSignals["egressPlugins"][string]
    | undefined;
  readonly preferredPluginSnapshot:
    | import("./access-profile-selection-health-runtime.ts").AccessProfileSelectionHealthSignals["egressPlugins"][string]
    | undefined;
  readonly healthWarnings: ReadonlyArray<string>;
}) {
  const warnings = [...input.profile.warnings, ...input.healthWarnings];

  if (snapshotIsQuarantined(input.selectedProfileSnapshot?.quarantinedUntil)) {
    warnings.push(
      `Selected egress profile "${input.selectedProfileId}" is currently quarantined in access health state.`,
    );
  }

  if (snapshotIsQuarantined(input.selectedPluginSnapshot?.quarantinedUntil)) {
    warnings.push(
      `Selected egress plugin backend "${input.profile.pluginId}" is currently quarantined in access health state.`,
    );
  }

  if (
    input.selectionRationale === "health-signals" &&
    preferredProfileIsLessHealthy({
      preferredProfileId: input.preferredProfileId,
      selectedProfileId: input.selectedProfileId,
      preferredProfileSnapshot: input.preferredProfileSnapshot,
      selectedProfileSnapshot: input.selectedProfileSnapshot,
      preferredPluginSnapshot: input.preferredPluginSnapshot,
      selectedPluginSnapshot: input.selectedPluginSnapshot,
    })
  ) {
    warnings.push(
      makePreferredPathOverrideWarning({
        kind: "egress",
        selectedId: input.selectedProfileId,
        preferredId: input.preferredProfileId,
      }),
    );
  }

  return {
    ...input.profile,
    warnings: [...new Set(warnings)],
  } satisfies ResolvedEgressProfile;
}

function withResolvedIdentityWarnings(input: {
  readonly profile: ResolvedIdentityProfile;
  readonly preferredProfileId: string;
  readonly selectedProfileId: string;
  readonly selectionRationale: AccessProfileSelectionDecisionRationale;
  readonly selectedProfileSnapshot:
    | import("./access-profile-selection-health-runtime.ts").AccessProfileSelectionHealthSignals["identityProfiles"][string]
    | undefined;
  readonly preferredProfileSnapshot:
    | import("./access-profile-selection-health-runtime.ts").AccessProfileSelectionHealthSignals["identityProfiles"][string]
    | undefined;
  readonly selectedPluginSnapshot:
    | import("./access-profile-selection-health-runtime.ts").AccessProfileSelectionHealthSignals["identityPlugins"][string]
    | undefined;
  readonly preferredPluginSnapshot:
    | import("./access-profile-selection-health-runtime.ts").AccessProfileSelectionHealthSignals["identityPlugins"][string]
    | undefined;
  readonly healthWarnings: ReadonlyArray<string>;
}) {
  const warnings = [...input.profile.warnings, ...input.healthWarnings];

  if (snapshotIsQuarantined(input.selectedProfileSnapshot?.quarantinedUntil)) {
    warnings.push(
      `Selected identity profile "${input.selectedProfileId}" is currently quarantined in access health state.`,
    );
  }

  if (snapshotIsQuarantined(input.selectedPluginSnapshot?.quarantinedUntil)) {
    warnings.push(
      `Selected identity plugin backend "${input.profile.pluginId}" is currently quarantined in access health state.`,
    );
  }

  if (
    input.selectionRationale === "health-signals" &&
    preferredProfileIsLessHealthy({
      preferredProfileId: input.preferredProfileId,
      selectedProfileId: input.selectedProfileId,
      preferredProfileSnapshot: input.preferredProfileSnapshot,
      selectedProfileSnapshot: input.selectedProfileSnapshot,
      preferredPluginSnapshot: input.preferredPluginSnapshot,
      selectedPluginSnapshot: input.selectedPluginSnapshot,
    })
  ) {
    warnings.push(
      makePreferredPathOverrideWarning({
        kind: "identity",
        selectedId: input.selectedProfileId,
        preferredId: input.preferredProfileId,
      }),
    );
  }

  return {
    ...input.profile,
    warnings: [...new Set(warnings)],
  } satisfies ResolvedIdentityProfile;
}

export function makeAccessProfileSelectionPolicy(input: {
  readonly profileRegistry: {
    readonly listEgressProfiles: () => Effect.Effect<ReadonlyArray<ResolvedEgressProfile>, never>;
    readonly listIdentityProfiles: () => Effect.Effect<
      ReadonlyArray<ResolvedIdentityProfile>,
      never
    >;
    readonly resolveEgressProfile: (
      selector?: AccessExecutionProfile["egress"],
    ) => Effect.Effect<ResolvedEgressProfile, InvalidInputError>;
    readonly resolveIdentityProfile: (input: {
      readonly selector?: AccessExecutionProfile["identity"];
      readonly providerId: AccessProviderId;
    }) => Effect.Effect<ResolvedIdentityProfile, InvalidInputError>;
  };
  readonly selectionStrategy: {
    readonly selectEgressProfileId: (
      input: AccessEgressProfileSelectionInput,
    ) => Effect.Effect<
      import("./access-profile-selection-strategy-runtime.ts").AccessProfileSelectionDecision,
      never
    >;
    readonly selectIdentityProfileId: (
      input: AccessIdentityProfileSelectionInput,
    ) => Effect.Effect<
      import("./access-profile-selection-strategy-runtime.ts").AccessProfileSelectionDecision,
      never
    >;
  };
  readonly healthSignals: {
    readonly inspect: (input: {
      readonly url: string;
      readonly egressProfiles: ReadonlyArray<ResolvedEgressProfile>;
      readonly identityProfiles: ReadonlyArray<ResolvedIdentityProfile>;
    }) => Effect.Effect<
      import("./access-profile-selection-health-runtime.ts").AccessProfileSelectionHealthSignals,
      never
    >;
  };
}) {
  const { profileRegistry, selectionStrategy, healthSignals } = input;

  return {
    resolveProfiles: ({ url, providerId, execution }: AccessProfileResolutionInput) =>
      Effect.gen(function* () {
        const availableEgressProfiles = yield* profileRegistry!
          .listEgressProfiles()
          .pipe(Effect.flatMap((profiles) => ensureUniqueProfileIds("egress", profiles)));
        const availableIdentityProfiles = yield* profileRegistry!
          .listIdentityProfiles()
          .pipe(Effect.flatMap((profiles) => ensureUniqueProfileIds("identity", profiles)));
        const explicitSelectedEgressProfile =
          execution?.egress?.profileId === undefined
            ? undefined
            : yield* profileRegistry!.resolveEgressProfile(execution?.egress);
        const explicitSelectedIdentityProfile =
          execution?.identity?.profileId === undefined
            ? undefined
            : yield* profileRegistry!.resolveIdentityProfile({
                selector: execution.identity,
                providerId,
              });
        const eligibleImplicitEgressProfiles =
          execution?.egress?.profileId === undefined
            ? availableEgressProfiles.filter(
                (profile) =>
                  describeResolvedEgressProfileAutoSelectionEligibility(profile).autoSelectable,
              )
            : availableEgressProfiles;
        if (eligibleImplicitEgressProfiles.length === 0) {
          return yield* Effect.fail(
            new InvalidInputError({
              message: "No eligible egress profiles available",
              details:
                "All implicit egress profiles require explicit plugin configuration before they can be selected.",
            }),
          );
        }
        const inspectEgressHealth = execution?.egress?.profileId === undefined;
        const inspectIdentityHealth = execution?.identity?.profileId === undefined;
        const profileHealthSignals = yield* healthSignals.inspect({
          url,
          egressProfiles: inspectEgressHealth
            ? eligibleImplicitEgressProfiles
            : explicitSelectedEgressProfile === undefined
              ? []
              : [explicitSelectedEgressProfile],
          identityProfiles: inspectIdentityHealth
            ? availableIdentityProfiles
            : explicitSelectedIdentityProfile === undefined
              ? []
              : [explicitSelectedIdentityProfile],
        });
        const selectedEgressDecision = yield* selectionStrategy!.selectEgressProfileId({
          selector: execution?.egress,
          availableProfiles: eligibleImplicitEgressProfiles,
          healthSignals: profileHealthSignals,
        });
        const selectedEgressProfileId = selectedEgressDecision.profileId;
        const preferredEgressProfileId = execution?.egress?.profileId ?? DEFAULT_EGRESS_PROFILE_ID;
        const egress = yield* profileRegistry!.resolveEgressProfile({
          ...execution?.egress,
          profileId: selectedEgressProfileId,
        });
        const preferredEgressProfile = availableEgressProfiles.find(
          (profile) => profile.profileId === preferredEgressProfileId,
        );

        const selectedIdentityDecision = yield* selectionStrategy!.selectIdentityProfileId({
          selector: execution?.identity,
          providerId,
          availableProfiles: availableIdentityProfiles,
          healthSignals: profileHealthSignals,
        });
        const selectedIdentityProfileId = selectedIdentityDecision.profileId;
        const preferredIdentityProfileId =
          execution?.identity?.profileId ?? defaultIdentityProfileIdForProvider(providerId);
        const identity = yield* profileRegistry!.resolveIdentityProfile({
          selector: {
            ...execution?.identity,
            profileId: selectedIdentityProfileId,
          },
          providerId,
        });
        const preferredIdentityProfile = availableIdentityProfiles.find(
          (profile) => profile.profileId === preferredIdentityProfileId,
        );

        return {
          egress: withResolvedEgressWarnings({
            profile: egress,
            preferredProfileId: preferredEgressProfileId,
            selectedProfileId: selectedEgressProfileId,
            selectionRationale: selectedEgressDecision.rationale,
            preferredProfileSnapshot: profileHealthSignals.egressProfiles[preferredEgressProfileId],
            selectedProfileSnapshot: profileHealthSignals.egressProfiles[selectedEgressProfileId],
            preferredPluginSnapshot:
              preferredEgressProfile === undefined
                ? undefined
                : profileHealthSignals.egressPlugins[
                    accessProfileSelectionEgressPluginKey({
                      poolId: preferredEgressProfile.poolId,
                      routePolicyId: preferredEgressProfile.routePolicyId,
                      pluginId: preferredEgressProfile.pluginId,
                    })
                  ],
            selectedPluginSnapshot:
              profileHealthSignals.egressPlugins[
                accessProfileSelectionEgressPluginKey({
                  poolId: egress.poolId,
                  routePolicyId: egress.routePolicyId,
                  pluginId: egress.pluginId,
                })
              ],
            healthWarnings: profileHealthSignals.egressWarnings,
          }),
          identity: withResolvedIdentityWarnings({
            profile: identity,
            preferredProfileId: preferredIdentityProfileId,
            selectedProfileId: selectedIdentityProfileId,
            selectionRationale: selectedIdentityDecision.rationale,
            preferredProfileSnapshot:
              profileHealthSignals.identityProfiles[preferredIdentityProfileId],
            selectedProfileSnapshot:
              profileHealthSignals.identityProfiles[selectedIdentityProfileId],
            preferredPluginSnapshot:
              preferredIdentityProfile === undefined
                ? undefined
                : profileHealthSignals.identityPlugins[
                    accessProfileSelectionIdentityPluginKey({
                      tenantId: preferredIdentityProfile.tenantId,
                      pluginId: preferredIdentityProfile.pluginId,
                    })
                  ],
            selectedPluginSnapshot:
              profileHealthSignals.identityPlugins[
                accessProfileSelectionIdentityPluginKey({
                  tenantId: identity.tenantId,
                  pluginId: identity.pluginId,
                })
              ],
            healthWarnings: profileHealthSignals.identityWarnings,
          }),
        } satisfies AccessProfileResolution;
      }),
  } satisfies {
    readonly resolveProfiles: (
      input: AccessProfileResolutionInput,
    ) => Effect.Effect<AccessProfileResolution, InvalidInputError>;
  };
}

export class AccessProfileSelectionPolicy extends ServiceMap.Service<
  AccessProfileSelectionPolicy,
  {
    readonly resolveProfiles: (
      input: AccessProfileResolutionInput,
    ) => Effect.Effect<AccessProfileResolution, InvalidInputError>;
  }
>()("@effect-scrapling/sdk/AccessProfileSelectionPolicy") {}

export const AccessProfileSelectionPolicyLive = Layer.effect(
  AccessProfileSelectionPolicy,
  Effect.gen(function* () {
    const profileRegistry = yield* AccessProfileRegistry;
    const selectionStrategy = yield* AccessProfileSelectionStrategy;
    const healthSignals = yield* AccessProfileSelectionHealthSignalsGateway;

    return makeAccessProfileSelectionPolicy({
      profileRegistry,
      selectionStrategy,
      healthSignals,
    });
  }),
);

export const AccessProfileSelectionPolicyEnvironmentLive = AccessProfileSelectionPolicyLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      AccessProfileRegistryLive,
      AccessProfileSelectionStrategyLive,
      SharedAccessHealthSignalsLive,
    ),
  ),
);
