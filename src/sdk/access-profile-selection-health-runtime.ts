import { Effect, Exit, Layer, ServiceMap } from "effect";
import { type AccessHealthSnapshot } from "@effect-scrapling/foundation-core/access-health-runtime";
import { AccessHealthRuntime } from "./access-health-runtime-service.ts";
import {
  type AccessEgressProfileDescriptor,
  type AccessIdentityProfileDescriptor,
} from "./access-profile-runtime.ts";

const INVALID_SELECTION_DOMAIN = "invalid-selection-target.local";

export type AccessProfileSelectionHealthInput = {
  readonly url: string;
  readonly egressProfiles: ReadonlyArray<AccessEgressProfileDescriptor>;
  readonly identityProfiles: ReadonlyArray<AccessIdentityProfileDescriptor>;
};

export function accessProfileSelectionEgressPluginKey(input: {
  readonly poolId: string;
  readonly routePolicyId: string;
  readonly pluginId: string;
}) {
  return `${input.poolId}::${input.routePolicyId}::${input.pluginId}`;
}

export function accessProfileSelectionIdentityPluginKey(input: {
  readonly tenantId: string;
  readonly pluginId: string;
}) {
  return `${input.tenantId}::${input.pluginId}`;
}

export type AccessProfileSelectionHealthSignals = {
  readonly egressProfiles: Readonly<Record<string, AccessHealthSnapshot>>;
  readonly egressPlugins: Readonly<Record<string, AccessHealthSnapshot>>;
  readonly identityProfiles: Readonly<Record<string, AccessHealthSnapshot>>;
  readonly identityPlugins: Readonly<Record<string, AccessHealthSnapshot>>;
  readonly degraded: boolean;
  readonly egressWarnings: ReadonlyArray<string>;
  readonly identityWarnings: ReadonlyArray<string>;
};

function domainFromUrl(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return INVALID_SELECTION_DOMAIN;
  }
}

function unavailableSignalWarnings(scope: "egress" | "identity") {
  return [
    `Some ${scope} profile or plugin health signals were unavailable; static profile preference may be used for affected entries.`,
  ] as const;
}

export class AccessProfileSelectionHealthSignalsGateway extends ServiceMap.Service<
  AccessProfileSelectionHealthSignalsGateway,
  {
    readonly inspect: (
      input: AccessProfileSelectionHealthInput,
    ) => Effect.Effect<AccessProfileSelectionHealthSignals, never, never>;
  }
>()("@effect-scrapling/sdk/AccessProfileSelectionHealthSignalsGateway") {}

export const AccessProfileSelectionHealthSignalsGatewayLive = Layer.effect(
  AccessProfileSelectionHealthSignalsGateway,
  Effect.gen(function* () {
    const runtime = yield* AccessHealthRuntime;

    return {
      inspect: ({ url, egressProfiles, identityProfiles }: AccessProfileSelectionHealthInput) =>
        Effect.gen(function* () {
          const domain = domainFromUrl(url);
          const egressProfileSnapshots = yield* Effect.forEach(
            egressProfiles,
            (profile) =>
              runtime
                .inspect({
                  kind: "egress-profile",
                  poolId: profile.poolId,
                  routePolicyId: profile.routePolicyId,
                  profileId: profile.profileId,
                })
                .pipe(
                  Effect.map((snapshot) => [profile.profileId, snapshot] as const),
                  Effect.exit,
                ),
            {
              concurrency: "unbounded",
            },
          );
          const egressPluginSnapshots = yield* Effect.forEach(
            [
              ...new Map(
                egressProfiles.map(
                  (profile) =>
                    [
                      accessProfileSelectionEgressPluginKey({
                        poolId: profile.poolId,
                        routePolicyId: profile.routePolicyId,
                        pluginId: profile.pluginId,
                      }),
                      profile,
                    ] as const,
                ),
              ).values(),
            ],
            (profile) =>
              runtime
                .inspect({
                  kind: "egress-plugin",
                  poolId: profile.poolId,
                  routePolicyId: profile.routePolicyId,
                  pluginId: profile.pluginId,
                })
                .pipe(
                  Effect.map(
                    (snapshot) =>
                      [
                        accessProfileSelectionEgressPluginKey({
                          poolId: profile.poolId,
                          routePolicyId: profile.routePolicyId,
                          pluginId: profile.pluginId,
                        }),
                        snapshot,
                      ] as const,
                  ),
                  Effect.exit,
                ),
            {
              concurrency: "unbounded",
            },
          );
          const identityProfileSnapshots = yield* Effect.forEach(
            identityProfiles,
            (profile) =>
              runtime
                .inspect({
                  kind: "identity-profile",
                  tenantId: profile.tenantId,
                  domain,
                  profileId: profile.profileId,
                })
                .pipe(
                  Effect.map((snapshot) => [profile.profileId, snapshot] as const),
                  Effect.exit,
                ),
            {
              concurrency: "unbounded",
            },
          );
          const identityPluginSnapshots = yield* Effect.forEach(
            [
              ...new Map(
                identityProfiles.map(
                  (profile) =>
                    [
                      accessProfileSelectionIdentityPluginKey({
                        tenantId: profile.tenantId,
                        pluginId: profile.pluginId,
                      }),
                      profile,
                    ] as const,
                ),
              ).values(),
            ],
            (profile) =>
              runtime
                .inspect({
                  kind: "identity-plugin",
                  tenantId: profile.tenantId,
                  domain,
                  pluginId: profile.pluginId,
                })
                .pipe(
                  Effect.map(
                    (snapshot) =>
                      [
                        accessProfileSelectionIdentityPluginKey({
                          tenantId: profile.tenantId,
                          pluginId: profile.pluginId,
                        }),
                        snapshot,
                      ] as const,
                  ),
                  Effect.exit,
                ),
            {
              concurrency: "unbounded",
            },
          );

          const egressSignals = egressProfileSnapshots
            .filter(Exit.isSuccess)
            .map((exit) => exit.value);
          const egressPluginSignals = egressPluginSnapshots
            .filter(Exit.isSuccess)
            .map((exit) => exit.value);
          const identitySignals = identityProfileSnapshots
            .filter(Exit.isSuccess)
            .map((exit) => exit.value);
          const identityPluginSignals = identityPluginSnapshots
            .filter(Exit.isSuccess)
            .map((exit) => exit.value);
          const egressWarnings =
            egressProfileSnapshots.some(Exit.isFailure) ||
            egressPluginSnapshots.some(Exit.isFailure)
              ? unavailableSignalWarnings("egress")
              : [];
          const identityWarnings =
            identityProfileSnapshots.some(Exit.isFailure) ||
            identityPluginSnapshots.some(Exit.isFailure)
              ? unavailableSignalWarnings("identity")
              : [];

          return {
            egressProfiles: Object.fromEntries(egressSignals) as Readonly<
              Record<string, AccessHealthSnapshot>
            >,
            egressPlugins: Object.fromEntries(egressPluginSignals) as Readonly<
              Record<string, AccessHealthSnapshot>
            >,
            identityProfiles: Object.fromEntries(identitySignals) as Readonly<
              Record<string, AccessHealthSnapshot>
            >,
            identityPlugins: Object.fromEntries(identityPluginSignals) as Readonly<
              Record<string, AccessHealthSnapshot>
            >,
            degraded: egressWarnings.length > 0 || identityWarnings.length > 0,
            egressWarnings,
            identityWarnings,
          } satisfies AccessProfileSelectionHealthSignals;
        }),
    } satisfies {
      readonly inspect: (
        input: AccessProfileSelectionHealthInput,
      ) => Effect.Effect<AccessProfileSelectionHealthSignals, never, never>;
    };
  }),
);
