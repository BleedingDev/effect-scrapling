import { describe, expect, it } from "@effect-native/bun-test";
import { Effect } from "effect";
import {
  DEFAULT_EGRESS_PROFILE_ID,
  DEFAULT_IDENTITY_PROFILE_ID,
  DEFAULT_LEASED_EGRESS_PROFILE_ID,
  DEFAULT_LEASED_IDENTITY_PROFILE_ID,
  DEFAULT_LEASED_STEALTH_IDENTITY_PROFILE_ID,
  DEFAULT_STEALTH_IDENTITY_PROFILE_ID,
} from "../../src/sdk/access-profile-runtime.ts";
import { makeDefaultAccessProfileSelectionStrategy } from "../../src/sdk/access-profile-selection-strategy-runtime.ts";
import {
  accessProfileSelectionEgressPluginKey,
  accessProfileSelectionIdentityPluginKey,
  type AccessProfileSelectionHealthSignals,
} from "../../src/sdk/access-profile-selection-health-runtime.ts";

const strategy = makeDefaultAccessProfileSelectionStrategy();
const emptyHealthSignals: AccessProfileSelectionHealthSignals = {
  egressProfiles: {},
  egressPlugins: {},
  identityProfiles: {},
  identityPlugins: {},
  degraded: false,
  egressWarnings: [],
  identityWarnings: [],
};

describe("sdk access profile selection strategy", () => {
  it.effect("prefers direct egress before leased egress when no selector is provided", () =>
    Effect.gen(function* () {
      const decision = yield* strategy.selectEgressProfileId({
        availableProfiles: [
          {
            allocationMode: "leased",
            pluginId: "leased-egress",
            profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
            poolId: "leased-pool",
            routePolicyId: "leased-route",
            routeKind: "direct",
            routeKey: "leased-direct",
            requestHeaders: {},
            warnings: [],
          },
          {
            allocationMode: "static",
            pluginId: "direct-egress",
            profileId: DEFAULT_EGRESS_PROFILE_ID,
            poolId: "direct-pool",
            routePolicyId: "direct-route",
            routeKind: "direct",
            routeKey: "direct",
            requestHeaders: {},
            warnings: [],
          },
        ],
        healthSignals: emptyHealthSignals,
      });

      expect(decision.profileId).toBe(DEFAULT_EGRESS_PROFILE_ID);
      expect(decision.rationale).toBe("preferred");
    }),
  );

  it.effect("prefers stealth identities for the stealth browser provider", () =>
    Effect.gen(function* () {
      const decision = yield* strategy.selectIdentityProfileId({
        providerId: "browser-stealth",
        availableProfiles: [
          {
            allocationMode: "leased",
            pluginId: "leased-default-identity",
            profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
            tenantId: "public",
            browserRuntimeProfileId: "patchright-default",
            httpUserAgent: "ua",
            browserUserAgent: "ua",
            warnings: [],
          },
          {
            allocationMode: "static",
            pluginId: "default-identity",
            profileId: DEFAULT_IDENTITY_PROFILE_ID,
            tenantId: "public",
            browserRuntimeProfileId: "patchright-default",
            httpUserAgent: "ua",
            browserUserAgent: "ua",
            warnings: [],
          },
          {
            allocationMode: "static",
            pluginId: "stealth-identity",
            profileId: DEFAULT_STEALTH_IDENTITY_PROFILE_ID,
            tenantId: "public",
            browserRuntimeProfileId: "patchright-stealth",
            browserUserAgent: "ua",
            warnings: [],
          },
          {
            allocationMode: "leased",
            pluginId: "leased-stealth-identity",
            profileId: DEFAULT_LEASED_STEALTH_IDENTITY_PROFILE_ID,
            tenantId: "public",
            browserRuntimeProfileId: "patchright-stealth",
            browserUserAgent: "ua",
            warnings: [],
          },
        ],
        healthSignals: emptyHealthSignals,
      });

      expect(decision.profileId).toBe(DEFAULT_STEALTH_IDENTITY_PROFILE_ID);
      expect(decision.rationale).toBe("preferred");
    }),
  );

  it.effect("honors explicit selectors over default profile preference", () =>
    Effect.gen(function* () {
      const egressDecision = yield* strategy.selectEgressProfileId({
        selector: {
          profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
        },
        availableProfiles: [
          {
            allocationMode: "static",
            pluginId: "direct-egress",
            profileId: DEFAULT_EGRESS_PROFILE_ID,
            poolId: "direct-pool",
            routePolicyId: "direct-route",
            routeKind: "direct",
            routeKey: "direct",
            requestHeaders: {},
            warnings: [],
          },
          {
            allocationMode: "leased",
            pluginId: "leased-egress",
            profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
            poolId: "leased-pool",
            routePolicyId: "leased-route",
            routeKind: "direct",
            routeKey: "leased-direct",
            requestHeaders: {},
            warnings: [],
          },
        ],
        healthSignals: emptyHealthSignals,
      });
      const identityDecision = yield* strategy.selectIdentityProfileId({
        selector: {
          profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
        },
        providerId: "browser-basic",
        availableProfiles: [
          {
            allocationMode: "static",
            pluginId: "default-identity",
            profileId: DEFAULT_IDENTITY_PROFILE_ID,
            tenantId: "public",
            browserRuntimeProfileId: "patchright-default",
            httpUserAgent: "ua",
            browserUserAgent: "ua",
            warnings: [],
          },
          {
            allocationMode: "leased",
            pluginId: "leased-identity",
            profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
            tenantId: "public",
            browserRuntimeProfileId: "patchright-default",
            httpUserAgent: "ua",
            browserUserAgent: "ua",
            warnings: [],
          },
        ],
        healthSignals: emptyHealthSignals,
      });

      expect(egressDecision.profileId).toBe(DEFAULT_LEASED_EGRESS_PROFILE_ID);
      expect(egressDecision.rationale).toBe("preferred");
      expect(identityDecision.profileId).toBe(DEFAULT_LEASED_IDENTITY_PROFILE_ID);
      expect(identityDecision.rationale).toBe("preferred");
    }),
  );

  it.effect(
    "reports strategy-order rationale when the preferred builtin profiles are unavailable",
    () =>
      Effect.gen(function* () {
        const egressDecision = yield* strategy.selectEgressProfileId({
          availableProfiles: [
            {
              allocationMode: "leased",
              pluginId: "leased-egress",
              profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
              poolId: "leased-pool",
              routePolicyId: "leased-route",
              routeKind: "direct",
              routeKey: "leased-direct",
              requestHeaders: {},
              warnings: [],
            },
          ],
          healthSignals: emptyHealthSignals,
        });
        const identityDecision = yield* strategy.selectIdentityProfileId({
          providerId: "browser-basic",
          availableProfiles: [
            {
              allocationMode: "leased",
              pluginId: "leased-identity",
              profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
              tenantId: "public",
              browserRuntimeProfileId: "patchright-default",
              httpUserAgent: "ua",
              browserUserAgent: "ua",
              warnings: [],
            },
          ],
          healthSignals: emptyHealthSignals,
        });

        expect(egressDecision.profileId).toBe(DEFAULT_LEASED_EGRESS_PROFILE_ID);
        expect(egressDecision.rationale).toBe("strategy-order");
        expect(identityDecision.profileId).toBe(DEFAULT_LEASED_IDENTITY_PROFILE_ID);
        expect(identityDecision.rationale).toBe("strategy-order");
      }),
  );

  it.effect(
    "steers away from quarantined or lower-score profiles when no selector is provided",
    () =>
      Effect.gen(function* () {
        const egressDecision = yield* strategy.selectEgressProfileId({
          availableProfiles: [
            {
              allocationMode: "static",
              pluginId: "direct-egress",
              profileId: DEFAULT_EGRESS_PROFILE_ID,
              poolId: "direct-pool",
              routePolicyId: "direct-route",
              routeKind: "direct",
              routeKey: "direct",
              requestHeaders: {},
              warnings: [],
            },
            {
              allocationMode: "leased",
              pluginId: "leased-egress",
              profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
              poolId: "leased-pool",
              routePolicyId: "leased-route",
              routeKind: "direct",
              routeKey: "leased-direct",
              requestHeaders: {},
              warnings: [],
            },
          ],
          healthSignals: {
            egressProfiles: {
              [DEFAULT_EGRESS_PROFILE_ID]: {
                subject: {
                  kind: "egress-profile",
                  poolId: "direct-pool",
                  routePolicyId: "direct-route",
                  profileId: DEFAULT_EGRESS_PROFILE_ID,
                },
                successCount: 0,
                failureCount: 2,
                successStreak: 0,
                failureStreak: 2,
                score: 0,
                quarantinedUntil: "2099-01-01T00:00:00.000Z",
              },
              [DEFAULT_LEASED_EGRESS_PROFILE_ID]: {
                subject: {
                  kind: "egress-profile",
                  poolId: "leased-pool",
                  routePolicyId: "leased-route",
                  profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
                },
                successCount: 2,
                failureCount: 0,
                successStreak: 2,
                failureStreak: 0,
                score: 100,
                quarantinedUntil: null,
              },
            },
            egressPlugins: {},
            identityProfiles: {
              [DEFAULT_IDENTITY_PROFILE_ID]: {
                subject: {
                  kind: "identity-profile",
                  tenantId: "public",
                  domain: "example.com",
                  profileId: DEFAULT_IDENTITY_PROFILE_ID,
                },
                successCount: 1,
                failureCount: 2,
                successStreak: 0,
                failureStreak: 2,
                score: 33.33,
                quarantinedUntil: null,
              },
              [DEFAULT_LEASED_IDENTITY_PROFILE_ID]: {
                subject: {
                  kind: "identity-profile",
                  tenantId: "public",
                  domain: "example.com",
                  profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
                },
                successCount: 3,
                failureCount: 0,
                successStreak: 3,
                failureStreak: 0,
                score: 100,
                quarantinedUntil: null,
              },
            },
            identityPlugins: {},
            degraded: false,
            egressWarnings: [],
            identityWarnings: [],
          },
        });
        const identityDecision = yield* strategy.selectIdentityProfileId({
          providerId: "browser-basic",
          availableProfiles: [
            {
              allocationMode: "static",
              pluginId: "default-identity",
              profileId: DEFAULT_IDENTITY_PROFILE_ID,
              tenantId: "public",
              browserRuntimeProfileId: "patchright-default",
              httpUserAgent: "ua",
              browserUserAgent: "ua",
              warnings: [],
            },
            {
              allocationMode: "leased",
              pluginId: "leased-identity",
              profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
              tenantId: "public",
              browserRuntimeProfileId: "patchright-default",
              httpUserAgent: "ua",
              browserUserAgent: "ua",
              warnings: [],
            },
          ],
          healthSignals: {
            egressProfiles: {},
            egressPlugins: {},
            identityProfiles: {
              [DEFAULT_IDENTITY_PROFILE_ID]: {
                subject: {
                  kind: "identity-profile",
                  tenantId: "public",
                  domain: "example.com",
                  profileId: DEFAULT_IDENTITY_PROFILE_ID,
                },
                successCount: 1,
                failureCount: 3,
                successStreak: 0,
                failureStreak: 3,
                score: 25,
                quarantinedUntil: "2099-01-01T00:00:00.000Z",
              },
              [DEFAULT_LEASED_IDENTITY_PROFILE_ID]: {
                subject: {
                  kind: "identity-profile",
                  tenantId: "public",
                  domain: "example.com",
                  profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
                },
                successCount: 2,
                failureCount: 0,
                successStreak: 2,
                failureStreak: 0,
                score: 100,
                quarantinedUntil: null,
              },
            },
            identityPlugins: {},
            degraded: false,
            egressWarnings: [],
            identityWarnings: [],
          },
        });

        expect(egressDecision.profileId).toBe(DEFAULT_LEASED_EGRESS_PROFILE_ID);
        expect(egressDecision.rationale).toBe("health-signals");
        expect(identityDecision.profileId).toBe(DEFAULT_LEASED_IDENTITY_PROFILE_ID);
        expect(identityDecision.rationale).toBe("health-signals");
      }),
  );

  it.effect(
    "reroutes recovered egress profiles when their health scores remain decisively worse",
    () =>
      Effect.gen(function* () {
        const egressDecision = yield* strategy.selectEgressProfileId({
          availableProfiles: [
            {
              allocationMode: "static",
              pluginId: "direct-egress",
              profileId: DEFAULT_EGRESS_PROFILE_ID,
              poolId: "direct-pool",
              routePolicyId: "direct-route",
              routeKind: "direct",
              routeKey: "direct",
              requestHeaders: {},
              warnings: [],
            },
            {
              allocationMode: "leased",
              pluginId: "leased-egress",
              profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
              poolId: "leased-pool",
              routePolicyId: "leased-route",
              routeKind: "direct",
              routeKey: "leased-direct",
              requestHeaders: {},
              warnings: [],
            },
          ],
          healthSignals: {
            egressProfiles: {
              [DEFAULT_EGRESS_PROFILE_ID]: {
                subject: {
                  kind: "egress-profile",
                  poolId: "direct-pool",
                  routePolicyId: "direct-route",
                  profileId: DEFAULT_EGRESS_PROFILE_ID,
                },
                successCount: 1,
                failureCount: 3,
                successStreak: 1,
                failureStreak: 0,
                score: 25,
                quarantinedUntil: null,
              },
              [DEFAULT_LEASED_EGRESS_PROFILE_ID]: {
                subject: {
                  kind: "egress-profile",
                  poolId: "leased-pool",
                  routePolicyId: "leased-route",
                  profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
                },
                successCount: 0,
                failureCount: 0,
                successStreak: 0,
                failureStreak: 0,
                score: 100,
                quarantinedUntil: null,
              },
            },
            egressPlugins: {},
            identityProfiles: {
              [DEFAULT_IDENTITY_PROFILE_ID]: {
                subject: {
                  kind: "identity-profile",
                  tenantId: "public",
                  domain: "example.com",
                  profileId: DEFAULT_IDENTITY_PROFILE_ID,
                },
                successCount: 1,
                failureCount: 3,
                successStreak: 1,
                failureStreak: 0,
                score: 25,
                quarantinedUntil: null,
              },
              [DEFAULT_LEASED_IDENTITY_PROFILE_ID]: {
                subject: {
                  kind: "identity-profile",
                  tenantId: "public",
                  domain: "example.com",
                  profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
                },
                successCount: 0,
                failureCount: 0,
                successStreak: 0,
                failureStreak: 0,
                score: 100,
                quarantinedUntil: null,
              },
            },
            identityPlugins: {},
            degraded: false,
            egressWarnings: [],
            identityWarnings: [],
          },
        });
        const identityDecision = yield* strategy.selectIdentityProfileId({
          providerId: "browser-basic",
          availableProfiles: [
            {
              allocationMode: "static",
              pluginId: "default-identity",
              profileId: DEFAULT_IDENTITY_PROFILE_ID,
              tenantId: "public",
              browserRuntimeProfileId: "patchright-default",
              httpUserAgent: "ua",
              browserUserAgent: "ua",
              warnings: [],
            },
            {
              allocationMode: "leased",
              pluginId: "leased-identity",
              profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
              tenantId: "public",
              browserRuntimeProfileId: "patchright-default",
              httpUserAgent: "ua",
              browserUserAgent: "ua",
              warnings: [],
            },
          ],
          healthSignals: {
            egressProfiles: {},
            egressPlugins: {},
            identityProfiles: {
              [DEFAULT_IDENTITY_PROFILE_ID]: {
                subject: {
                  kind: "identity-profile",
                  tenantId: "public",
                  domain: "example.com",
                  profileId: DEFAULT_IDENTITY_PROFILE_ID,
                },
                successCount: 1,
                failureCount: 3,
                successStreak: 1,
                failureStreak: 0,
                score: 25,
                quarantinedUntil: null,
              },
              [DEFAULT_LEASED_IDENTITY_PROFILE_ID]: {
                subject: {
                  kind: "identity-profile",
                  tenantId: "public",
                  domain: "example.com",
                  profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
                },
                successCount: 0,
                failureCount: 0,
                successStreak: 0,
                failureStreak: 0,
                score: 100,
                quarantinedUntil: null,
              },
            },
            identityPlugins: {},
            degraded: false,
            egressWarnings: [],
            identityWarnings: [],
          },
        });

        expect(egressDecision.profileId).toBe(DEFAULT_LEASED_EGRESS_PROFILE_ID);
        expect(egressDecision.rationale).toBe("health-signals");
        expect(identityDecision.profileId).toBe(DEFAULT_IDENTITY_PROFILE_ID);
        expect(identityDecision.rationale).toBe("preferred");
      }),
  );

  it.effect("reroutes only egress when plugin scores moderately favor leased alternatives", () =>
    Effect.gen(function* () {
      const egressDecision = yield* strategy.selectEgressProfileId({
        availableProfiles: [
          {
            allocationMode: "static",
            pluginId: "direct-egress",
            profileId: DEFAULT_EGRESS_PROFILE_ID,
            poolId: "direct-pool",
            routePolicyId: "direct-route",
            routeKind: "direct",
            routeKey: "direct",
            requestHeaders: {},
            warnings: [],
          },
          {
            allocationMode: "leased",
            pluginId: "leased-egress",
            profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
            poolId: "leased-pool",
            routePolicyId: "leased-route",
            routeKind: "direct",
            routeKey: "leased-direct",
            requestHeaders: {},
            warnings: [],
          },
        ],
        healthSignals: {
          egressProfiles: {},
          egressPlugins: {
            [accessProfileSelectionEgressPluginKey({
              poolId: "direct-pool",
              routePolicyId: "direct-route",
              pluginId: "direct-egress",
            })]: {
              subject: {
                kind: "egress-plugin",
                poolId: "direct-pool",
                routePolicyId: "direct-route",
                pluginId: "direct-egress",
              },
              successCount: 3,
              failureCount: 1,
              successStreak: 0,
              failureStreak: 0,
              score: 75,
              quarantinedUntil: null,
            },
            [accessProfileSelectionEgressPluginKey({
              poolId: "leased-pool",
              routePolicyId: "leased-route",
              pluginId: "leased-egress",
            })]: {
              subject: {
                kind: "egress-plugin",
                poolId: "leased-pool",
                routePolicyId: "leased-route",
                pluginId: "leased-egress",
              },
              successCount: 8,
              failureCount: 0,
              successStreak: 8,
              failureStreak: 0,
              score: 100,
              quarantinedUntil: null,
            },
          },
          identityProfiles: {},
          identityPlugins: {},
          degraded: false,
          egressWarnings: [],
          identityWarnings: [],
        },
      });
      const identityDecision = yield* strategy.selectIdentityProfileId({
        providerId: "browser-basic",
        availableProfiles: [
          {
            allocationMode: "static",
            pluginId: "default-identity",
            profileId: DEFAULT_IDENTITY_PROFILE_ID,
            tenantId: "public",
            browserRuntimeProfileId: "patchright-default",
            httpUserAgent: "ua",
            browserUserAgent: "ua",
            warnings: [],
          },
          {
            allocationMode: "leased",
            pluginId: "leased-identity",
            profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
            tenantId: "public",
            browserRuntimeProfileId: "patchright-default",
            httpUserAgent: "ua",
            browserUserAgent: "ua",
            warnings: [],
          },
        ],
        healthSignals: {
          egressProfiles: {},
          egressPlugins: {},
          identityProfiles: {},
          identityPlugins: {
            [accessProfileSelectionIdentityPluginKey({
              tenantId: "public",
              pluginId: "default-identity",
            })]: {
              subject: {
                kind: "identity-plugin",
                tenantId: "public",
                domain: "example.com",
                pluginId: "default-identity",
              },
              successCount: 2,
              failureCount: 1,
              successStreak: 0,
              failureStreak: 0,
              score: 66.67,
              quarantinedUntil: null,
            },
            [accessProfileSelectionIdentityPluginKey({
              tenantId: "public",
              pluginId: "leased-identity",
            })]: {
              subject: {
                kind: "identity-plugin",
                tenantId: "public",
                domain: "example.com",
                pluginId: "leased-identity",
              },
              successCount: 5,
              failureCount: 0,
              successStreak: 5,
              failureStreak: 0,
              score: 100,
              quarantinedUntil: null,
            },
          },
          degraded: false,
          egressWarnings: [],
          identityWarnings: [],
        },
      });

      expect(egressDecision.profileId).toBe(DEFAULT_LEASED_EGRESS_PROFILE_ID);
      expect(egressDecision.rationale).toBe("health-signals");
      expect(identityDecision.profileId).toBe(DEFAULT_IDENTITY_PROFILE_ID);
      expect(identityDecision.rationale).toBe("preferred");
    }),
  );

  it.effect("reroutes only egress when profile scores moderately favor leased alternatives", () =>
    Effect.gen(function* () {
      const egressDecision = yield* strategy.selectEgressProfileId({
        availableProfiles: [
          {
            allocationMode: "static",
            pluginId: "direct-egress",
            profileId: DEFAULT_EGRESS_PROFILE_ID,
            poolId: "direct-pool",
            routePolicyId: "direct-route",
            routeKind: "direct",
            routeKey: "direct",
            requestHeaders: {},
            warnings: [],
          },
          {
            allocationMode: "leased",
            pluginId: "leased-egress",
            profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
            poolId: "leased-pool",
            routePolicyId: "leased-route",
            routeKind: "direct",
            routeKey: "leased-direct",
            requestHeaders: {},
            warnings: [],
          },
        ],
        healthSignals: {
          egressProfiles: {
            [DEFAULT_EGRESS_PROFILE_ID]: {
              subject: {
                kind: "egress-profile",
                poolId: "direct-pool",
                routePolicyId: "direct-route",
                profileId: DEFAULT_EGRESS_PROFILE_ID,
              },
              successCount: 3,
              failureCount: 1,
              successStreak: 0,
              failureStreak: 0,
              score: 75,
              quarantinedUntil: null,
            },
            [DEFAULT_LEASED_EGRESS_PROFILE_ID]: {
              subject: {
                kind: "egress-profile",
                poolId: "leased-pool",
                routePolicyId: "leased-route",
                profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
              },
              successCount: 8,
              failureCount: 0,
              successStreak: 8,
              failureStreak: 0,
              score: 100,
              quarantinedUntil: null,
            },
          },
          egressPlugins: {},
          identityProfiles: {},
          identityPlugins: {},
          degraded: false,
          egressWarnings: [],
          identityWarnings: [],
        },
      });
      const identityDecision = yield* strategy.selectIdentityProfileId({
        providerId: "browser-basic",
        availableProfiles: [
          {
            allocationMode: "static",
            pluginId: "default-identity",
            profileId: DEFAULT_IDENTITY_PROFILE_ID,
            tenantId: "public",
            browserRuntimeProfileId: "patchright-default",
            httpUserAgent: "ua",
            browserUserAgent: "ua",
            warnings: [],
          },
          {
            allocationMode: "leased",
            pluginId: "leased-identity",
            profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
            tenantId: "public",
            browserRuntimeProfileId: "patchright-default",
            httpUserAgent: "ua",
            browserUserAgent: "ua",
            warnings: [],
          },
        ],
        healthSignals: {
          egressProfiles: {},
          egressPlugins: {},
          identityProfiles: {
            [DEFAULT_IDENTITY_PROFILE_ID]: {
              subject: {
                kind: "identity-profile",
                tenantId: "public",
                domain: "example.com",
                profileId: DEFAULT_IDENTITY_PROFILE_ID,
              },
              successCount: 2,
              failureCount: 1,
              successStreak: 0,
              failureStreak: 0,
              score: 70,
              quarantinedUntil: null,
            },
            [DEFAULT_LEASED_IDENTITY_PROFILE_ID]: {
              subject: {
                kind: "identity-profile",
                tenantId: "public",
                domain: "example.com",
                profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
              },
              successCount: 5,
              failureCount: 0,
              successStreak: 5,
              failureStreak: 0,
              score: 100,
              quarantinedUntil: null,
            },
          },
          identityPlugins: {},
          degraded: false,
          egressWarnings: [],
          identityWarnings: [],
        },
      });

      expect(egressDecision.profileId).toBe(DEFAULT_LEASED_EGRESS_PROFILE_ID);
      expect(egressDecision.rationale).toBe("health-signals");
      expect(identityDecision.profileId).toBe(DEFAULT_IDENTITY_PROFILE_ID);
      expect(identityDecision.rationale).toBe("preferred");
    }),
  );

  it.effect("reroutes to leased builtin profiles when plugin score drift is decisively worse", () =>
    Effect.gen(function* () {
      const egressDecision = yield* strategy.selectEgressProfileId({
        availableProfiles: [
          {
            allocationMode: "static",
            pluginId: "direct-egress",
            profileId: DEFAULT_EGRESS_PROFILE_ID,
            poolId: "direct-pool",
            routePolicyId: "direct-route",
            routeKind: "direct",
            routeKey: "direct",
            requestHeaders: {},
            warnings: [],
          },
          {
            allocationMode: "leased",
            pluginId: "leased-egress",
            profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
            poolId: "leased-pool",
            routePolicyId: "leased-route",
            routeKind: "direct",
            routeKey: "leased-direct",
            requestHeaders: {},
            warnings: [],
          },
        ],
        healthSignals: {
          egressProfiles: {},
          egressPlugins: {
            [accessProfileSelectionEgressPluginKey({
              poolId: "direct-pool",
              routePolicyId: "direct-route",
              pluginId: "direct-egress",
            })]: {
              subject: {
                kind: "egress-plugin",
                poolId: "direct-pool",
                routePolicyId: "direct-route",
                pluginId: "direct-egress",
              },
              successCount: 1,
              failureCount: 4,
              successStreak: 0,
              failureStreak: 2,
              score: 20,
              quarantinedUntil: null,
            },
            [accessProfileSelectionEgressPluginKey({
              poolId: "leased-pool",
              routePolicyId: "leased-route",
              pluginId: "leased-egress",
            })]: {
              subject: {
                kind: "egress-plugin",
                poolId: "leased-pool",
                routePolicyId: "leased-route",
                pluginId: "leased-egress",
              },
              successCount: 8,
              failureCount: 0,
              successStreak: 8,
              failureStreak: 0,
              score: 100,
              quarantinedUntil: null,
            },
          },
          identityProfiles: {},
          identityPlugins: {},
          degraded: false,
          egressWarnings: [],
          identityWarnings: [],
        },
      });
      const identityDecision = yield* strategy.selectIdentityProfileId({
        providerId: "browser-basic",
        availableProfiles: [
          {
            allocationMode: "static",
            pluginId: "default-identity",
            profileId: DEFAULT_IDENTITY_PROFILE_ID,
            tenantId: "public",
            browserRuntimeProfileId: "patchright-default",
            httpUserAgent: "ua",
            browserUserAgent: "ua",
            warnings: [],
          },
          {
            allocationMode: "leased",
            pluginId: "leased-identity",
            profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
            tenantId: "public",
            browserRuntimeProfileId: "patchright-default",
            httpUserAgent: "ua",
            browserUserAgent: "ua",
            warnings: [],
          },
        ],
        healthSignals: {
          egressProfiles: {},
          egressPlugins: {},
          identityProfiles: {},
          identityPlugins: {
            [accessProfileSelectionIdentityPluginKey({
              tenantId: "public",
              pluginId: "default-identity",
            })]: {
              subject: {
                kind: "identity-plugin",
                tenantId: "public",
                domain: "example.com",
                pluginId: "default-identity",
              },
              successCount: 1,
              failureCount: 4,
              successStreak: 0,
              failureStreak: 2,
              score: 20,
              quarantinedUntil: null,
            },
            [accessProfileSelectionIdentityPluginKey({
              tenantId: "public",
              pluginId: "leased-identity",
            })]: {
              subject: {
                kind: "identity-plugin",
                tenantId: "public",
                domain: "example.com",
                pluginId: "leased-identity",
              },
              successCount: 5,
              failureCount: 0,
              successStreak: 5,
              failureStreak: 0,
              score: 100,
              quarantinedUntil: null,
            },
          },
          degraded: false,
          egressWarnings: [],
          identityWarnings: [],
        },
      });

      expect(egressDecision.profileId).toBe(DEFAULT_LEASED_EGRESS_PROFILE_ID);
      expect(egressDecision.rationale).toBe("health-signals");
      expect(identityDecision.profileId).toBe(DEFAULT_LEASED_IDENTITY_PROFILE_ID);
      expect(identityDecision.rationale).toBe("health-signals");
    }),
  );

  it.effect(
    "keeps builtin identity preference when only profile score drift favors leased variants",
    () =>
      Effect.gen(function* () {
        const egressDecision = yield* strategy.selectEgressProfileId({
          availableProfiles: [
            {
              allocationMode: "static",
              pluginId: "direct-egress",
              profileId: DEFAULT_EGRESS_PROFILE_ID,
              poolId: "direct-pool",
              routePolicyId: "direct-route",
              routeKind: "direct",
              routeKey: "direct",
              requestHeaders: {},
              warnings: [],
            },
            {
              allocationMode: "leased",
              pluginId: "leased-egress",
              profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
              poolId: "leased-pool",
              routePolicyId: "leased-route",
              routeKind: "direct",
              routeKey: "leased-direct",
              requestHeaders: {},
              warnings: [],
            },
          ],
          healthSignals: {
            egressProfiles: {
              [DEFAULT_EGRESS_PROFILE_ID]: {
                subject: {
                  kind: "egress-profile",
                  poolId: "direct-pool",
                  routePolicyId: "direct-route",
                  profileId: DEFAULT_EGRESS_PROFILE_ID,
                },
                successCount: 1,
                failureCount: 4,
                successStreak: 0,
                failureStreak: 2,
                score: 20,
                quarantinedUntil: null,
              },
              [DEFAULT_LEASED_EGRESS_PROFILE_ID]: {
                subject: {
                  kind: "egress-profile",
                  poolId: "leased-pool",
                  routePolicyId: "leased-route",
                  profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
                },
                successCount: 8,
                failureCount: 0,
                successStreak: 8,
                failureStreak: 0,
                score: 100,
                quarantinedUntil: null,
              },
            },
            egressPlugins: {},
            identityProfiles: {},
            identityPlugins: {},
            degraded: false,
            egressWarnings: [],
            identityWarnings: [],
          },
        });
        const identityDecision = yield* strategy.selectIdentityProfileId({
          providerId: "browser-basic",
          availableProfiles: [
            {
              allocationMode: "static",
              pluginId: "default-identity",
              profileId: DEFAULT_IDENTITY_PROFILE_ID,
              tenantId: "public",
              browserRuntimeProfileId: "patchright-default",
              httpUserAgent: "ua",
              browserUserAgent: "ua",
              warnings: [],
            },
            {
              allocationMode: "leased",
              pluginId: "leased-identity",
              profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
              tenantId: "public",
              browserRuntimeProfileId: "patchright-default",
              httpUserAgent: "ua",
              browserUserAgent: "ua",
              warnings: [],
            },
          ],
          healthSignals: {
            egressProfiles: {},
            egressPlugins: {},
            identityProfiles: {
              [DEFAULT_IDENTITY_PROFILE_ID]: {
                subject: {
                  kind: "identity-profile",
                  tenantId: "public",
                  domain: "example.com",
                  profileId: DEFAULT_IDENTITY_PROFILE_ID,
                },
                successCount: 1,
                failureCount: 4,
                successStreak: 0,
                failureStreak: 2,
                score: 20,
                quarantinedUntil: null,
              },
              [DEFAULT_LEASED_IDENTITY_PROFILE_ID]: {
                subject: {
                  kind: "identity-profile",
                  tenantId: "public",
                  domain: "example.com",
                  profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
                },
                successCount: 5,
                failureCount: 0,
                successStreak: 5,
                failureStreak: 0,
                score: 100,
                quarantinedUntil: null,
              },
            },
            identityPlugins: {},
            degraded: false,
            egressWarnings: [],
            identityWarnings: [],
          },
        });

        expect(egressDecision.profileId).toBe(DEFAULT_LEASED_EGRESS_PROFILE_ID);
        expect(egressDecision.rationale).toBe("health-signals");
        expect(identityDecision.profileId).toBe(DEFAULT_IDENTITY_PROFILE_ID);
        expect(identityDecision.rationale).toBe("preferred");
      }),
  );

  it.effect("uses the injected clock for quarantine evaluation", () =>
    Effect.gen(function* () {
      const clockedStrategy = makeDefaultAccessProfileSelectionStrategy({
        now: () => Date.parse("2026-03-11T06:00:00.000Z"),
      });

      const selectedDecision = yield* clockedStrategy.selectEgressProfileId({
        availableProfiles: [
          {
            allocationMode: "static",
            pluginId: "direct-egress",
            profileId: DEFAULT_EGRESS_PROFILE_ID,
            poolId: "direct-pool",
            routePolicyId: "direct-route",
            routeKind: "direct",
            routeKey: "direct",
            requestHeaders: {},
            warnings: [],
          },
          {
            allocationMode: "leased",
            pluginId: "leased-egress",
            profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
            poolId: "leased-pool",
            routePolicyId: "leased-route",
            routeKind: "direct",
            routeKey: "leased-direct",
            requestHeaders: {},
            warnings: [],
          },
        ],
        healthSignals: {
          egressProfiles: {
            [DEFAULT_EGRESS_PROFILE_ID]: {
              subject: {
                kind: "egress-profile",
                poolId: "direct-pool",
                routePolicyId: "direct-route",
                profileId: DEFAULT_EGRESS_PROFILE_ID,
              },
              successCount: 0,
              failureCount: 2,
              successStreak: 0,
              failureStreak: 2,
              score: 0,
              quarantinedUntil: "2026-03-11T06:01:00.000Z",
            },
          },
          egressPlugins: {},
          identityProfiles: {},
          identityPlugins: {},
          degraded: false,
          egressWarnings: [],
          identityWarnings: [],
        },
      });

      expect(selectedDecision.profileId).toBe(DEFAULT_LEASED_EGRESS_PROFILE_ID);
      expect(selectedDecision.rationale).toBe("health-signals");
    }),
  );

  it.effect("steers away from profiles whose shared plugin is quarantined", () =>
    Effect.gen(function* () {
      const egressDecision = yield* strategy.selectEgressProfileId({
        availableProfiles: [
          {
            allocationMode: "static",
            pluginId: "direct-egress",
            profileId: DEFAULT_EGRESS_PROFILE_ID,
            poolId: "direct-pool",
            routePolicyId: "direct-route",
            routeKind: "direct",
            routeKey: "direct",
            requestHeaders: {},
            warnings: [],
          },
          {
            allocationMode: "leased",
            pluginId: "leased-egress",
            profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
            poolId: "leased-pool",
            routePolicyId: "leased-route",
            routeKind: "direct",
            routeKey: "leased-direct",
            requestHeaders: {},
            warnings: [],
          },
        ],
        healthSignals: {
          egressProfiles: {},
          egressPlugins: {
            [accessProfileSelectionEgressPluginKey({
              poolId: "direct-pool",
              routePolicyId: "direct-route",
              pluginId: "direct-egress",
            })]: {
              subject: {
                kind: "egress-plugin",
                poolId: "direct-pool",
                routePolicyId: "direct-route",
                pluginId: "direct-egress",
              },
              successCount: 0,
              failureCount: 2,
              successStreak: 0,
              failureStreak: 2,
              score: 0,
              quarantinedUntil: "2099-01-01T00:00:00.000Z",
            },
            [accessProfileSelectionEgressPluginKey({
              poolId: "leased-pool",
              routePolicyId: "leased-route",
              pluginId: "leased-egress",
            })]: {
              subject: {
                kind: "egress-plugin",
                poolId: "leased-pool",
                routePolicyId: "leased-route",
                pluginId: "leased-egress",
              },
              successCount: 2,
              failureCount: 0,
              successStreak: 2,
              failureStreak: 0,
              score: 100,
              quarantinedUntil: null,
            },
          },
          identityProfiles: {},
          identityPlugins: {},
          degraded: false,
          egressWarnings: [],
          identityWarnings: [],
        },
      });
      const identityDecision = yield* strategy.selectIdentityProfileId({
        providerId: "browser-basic",
        availableProfiles: [
          {
            allocationMode: "static",
            pluginId: "default-identity",
            profileId: DEFAULT_IDENTITY_PROFILE_ID,
            tenantId: "public",
            browserRuntimeProfileId: "patchright-default",
            httpUserAgent: "ua",
            browserUserAgent: "ua",
            warnings: [],
          },
          {
            allocationMode: "leased",
            pluginId: "leased-identity",
            profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
            tenantId: "public",
            browserRuntimeProfileId: "patchright-default",
            httpUserAgent: "ua",
            browserUserAgent: "ua",
            warnings: [],
          },
        ],
        healthSignals: {
          egressProfiles: {},
          egressPlugins: {},
          identityProfiles: {},
          identityPlugins: {
            [accessProfileSelectionIdentityPluginKey({
              tenantId: "public",
              pluginId: "default-identity",
            })]: {
              subject: {
                kind: "identity-plugin",
                tenantId: "public",
                domain: "example.com",
                pluginId: "default-identity",
              },
              successCount: 0,
              failureCount: 2,
              successStreak: 0,
              failureStreak: 2,
              score: 0,
              quarantinedUntil: "2099-01-01T00:00:00.000Z",
            },
            [accessProfileSelectionIdentityPluginKey({
              tenantId: "public",
              pluginId: "leased-identity",
            })]: {
              subject: {
                kind: "identity-plugin",
                tenantId: "public",
                domain: "example.com",
                pluginId: "leased-identity",
              },
              successCount: 2,
              failureCount: 0,
              successStreak: 2,
              failureStreak: 0,
              score: 100,
              quarantinedUntil: null,
            },
          },
          degraded: false,
          egressWarnings: [],
          identityWarnings: [],
        },
      });

      expect(egressDecision.profileId).toBe(DEFAULT_LEASED_EGRESS_PROFILE_ID);
      expect(egressDecision.rationale).toBe("health-signals");
      expect(identityDecision.profileId).toBe(DEFAULT_LEASED_IDENTITY_PROFILE_ID);
      expect(identityDecision.rationale).toBe("health-signals");
    }),
  );
});
