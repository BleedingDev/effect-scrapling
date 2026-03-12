import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Layer } from "effect";
import { AccessHealthRuntimeLive } from "../../src/sdk/access-health-runtime-service.ts";
import { InvalidInputError } from "../../src/sdk/errors.ts";
import {
  AccessProfileSelectionPolicy,
  AccessProfileSelectionPolicyEnvironmentLive,
  AccessProfileSelectionPolicyLive,
} from "../../src/sdk/access-profile-policy-runtime.ts";
import { AccessProfileSelectionHealthSignalsGateway } from "../../src/sdk/access-profile-selection-health-runtime.ts";
import {
  AccessProfileRegistry,
  AccessProfileRegistryLive,
} from "../../src/sdk/access-profile-runtime.ts";
import {
  AccessProfileSelectionStrategy,
  AccessProfileSelectionStrategyLive,
} from "../../src/sdk/access-profile-selection-strategy-runtime.ts";

describe("sdk access profile policy runtime", () => {
  it.effect("resolves default egress and identity profiles for the selected provider", () =>
    Effect.gen(function* () {
      const policy = yield* AccessProfileSelectionPolicy;
      const profiles = yield* policy.resolveProfiles({
        url: "https://example.com/products/sku-1",
        providerId: "browser-stealth",
      });

      expect(profiles.egress.profileId).toBe("direct");
      expect(profiles.identity.profileId).toBe("stealth-default");
      expect(profiles.egress.warnings).toEqual([]);
    }).pipe(Effect.provide(AccessProfileSelectionPolicyEnvironmentLive)),
  );

  it.effect("keeps implicit egress selection on configured-usable builtin profiles only", () =>
    Effect.gen(function* () {
      const policy = yield* AccessProfileSelectionPolicy;
      const profiles = yield* policy.resolveProfiles({
        url: "https://example.com/products/sku-1b",
        providerId: "browser-basic",
      });

      expect(profiles.egress.profileId).toBe("direct");
      expect(profiles.egress.pluginId).toBe("builtin-direct-egress");
      expect(profiles.egress.warnings).toContain(
        'Selected egress profile "direct" is currently quarantined in access health state.',
      );
    }).pipe(
      Effect.provide(
        AccessProfileSelectionPolicyLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              AccessProfileRegistryLive,
              AccessHealthRuntimeLive,
              AccessProfileSelectionStrategyLive,
              Layer.succeed(AccessProfileSelectionHealthSignalsGateway, {
                inspect: () =>
                  Effect.succeed({
                    egressProfiles: {
                      direct: {
                        subject: {
                          kind: "egress-profile",
                          poolId: "direct-pool",
                          routePolicyId: "direct-route",
                          profileId: "direct",
                        },
                        successCount: 0,
                        failureCount: 4,
                        successStreak: 0,
                        failureStreak: 4,
                        score: 0,
                        quarantinedUntil: "2099-01-01T00:00:00.000Z",
                      },
                      "leased-direct": {
                        subject: {
                          kind: "egress-profile",
                          poolId: "leased-direct-pool",
                          routePolicyId: "leased-direct-route",
                          profileId: "leased-direct",
                        },
                        successCount: 0,
                        failureCount: 4,
                        successStreak: 0,
                        failureStreak: 4,
                        score: 0,
                        quarantinedUntil: "2099-01-01T00:00:00.000Z",
                      },
                    },
                    egressPlugins: {},
                    identityProfiles: {},
                    identityPlugins: {},
                    degraded: false,
                    egressWarnings: [],
                    identityWarnings: [],
                  }),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("honors injected profile selection strategy overrides", () =>
    Effect.gen(function* () {
      const policy = yield* AccessProfileSelectionPolicy;
      const profiles = yield* policy.resolveProfiles({
        url: "https://example.com/products/sku-2",
        providerId: "browser-basic",
      });

      expect(profiles.egress.profileId).toBe("leased-direct");
      expect(profiles.identity.profileId).toBe("leased-default");
      expect(profiles.egress.warnings).toEqual([]);
      expect(profiles.identity.warnings).toEqual([]);
    }).pipe(
      Effect.provide(
        AccessProfileSelectionPolicyLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              AccessProfileRegistryLive,
              AccessHealthRuntimeLive,
              AccessProfileSelectionStrategyLive,
              Layer.succeed(AccessProfileSelectionHealthSignalsGateway, {
                inspect: () =>
                  Effect.succeed({
                    egressProfiles: {},
                    egressPlugins: {},
                    identityProfiles: {},
                    identityPlugins: {},
                    degraded: false,
                    egressWarnings: [],
                    identityWarnings: [],
                  }),
              }),
              Layer.succeed(AccessProfileSelectionStrategy, {
                selectEgressProfileId: () =>
                  Effect.succeed({
                    profileId: "leased-direct",
                    rationale: "custom",
                  }),
                selectIdentityProfileId: () =>
                  Effect.succeed({
                    profileId: "leased-default",
                    rationale: "custom",
                  }),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "does not trust custom profile strategies that misreport health-signals rationale",
    () =>
      Effect.gen(function* () {
        const policy = yield* AccessProfileSelectionPolicy;
        const profiles = yield* policy.resolveProfiles({
          url: "https://example.com/products/sku-2b",
          providerId: "browser-basic",
        });

        expect(profiles.egress.profileId).toBe("leased-direct");
        expect(profiles.identity.profileId).toBe("leased-default");
        expect(profiles.egress.warnings).toEqual([]);
        expect(profiles.identity.warnings).toEqual([]);
      }).pipe(
        Effect.provide(
          AccessProfileSelectionPolicyLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                AccessProfileRegistryLive,
                AccessHealthRuntimeLive,
                AccessProfileSelectionStrategyLive,
                Layer.succeed(AccessProfileSelectionHealthSignalsGateway, {
                  inspect: () =>
                    Effect.succeed({
                      egressProfiles: {},
                      egressPlugins: {},
                      identityProfiles: {},
                      identityPlugins: {},
                      degraded: false,
                      egressWarnings: [],
                      identityWarnings: [],
                    }),
                }),
                Layer.succeed(AccessProfileSelectionStrategy, {
                  selectEgressProfileId: () =>
                    Effect.succeed({
                      profileId: "leased-direct",
                      rationale: "health-signals",
                    }),
                  selectIdentityProfileId: () =>
                    Effect.succeed({
                      profileId: "leased-default",
                      rationale: "health-signals",
                    }),
                }),
              ),
            ),
          ),
        ),
      ),
  );

  it.effect("steers away from quarantined profile health signals in the default policy", () =>
    Effect.gen(function* () {
      const policy = yield* AccessProfileSelectionPolicy;
      const profiles = yield* policy.resolveProfiles({
        url: "https://example.com/products/sku-3",
        providerId: "browser-basic",
      });

      expect(profiles.egress.profileId).toBe("leased-direct");
      expect(profiles.identity.profileId).toBe("leased-default");
      expect(profiles.egress.warnings).toContain(
        'Selection policy chose egress "leased-direct" instead of preferred "direct"; access health signals rate the preferred path as less healthy.',
      );
      expect(profiles.identity.warnings).toContain(
        'Selection policy chose identity "leased-default" instead of preferred "default"; access health signals rate the preferred path as less healthy.',
      );
    }).pipe(
      Effect.provide(
        AccessProfileSelectionPolicyLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              AccessProfileRegistryLive,
              AccessHealthRuntimeLive,
              AccessProfileSelectionStrategyLive,
              Layer.succeed(AccessProfileSelectionHealthSignalsGateway, {
                inspect: () =>
                  Effect.succeed({
                    egressProfiles: {
                      direct: {
                        subject: {
                          kind: "egress-profile",
                          poolId: "direct-pool",
                          routePolicyId: "direct-route",
                          profileId: "direct",
                        },
                        successCount: 0,
                        failureCount: 2,
                        successStreak: 0,
                        failureStreak: 2,
                        score: 0,
                        quarantinedUntil: "2099-01-01T00:00:00.000Z",
                      },
                    },
                    egressPlugins: {},
                    identityProfiles: {
                      default: {
                        subject: {
                          kind: "identity-profile",
                          tenantId: "public",
                          domain: "example.com",
                          profileId: "default",
                        },
                        successCount: 0,
                        failureCount: 2,
                        successStreak: 0,
                        failureStreak: 2,
                        score: 0,
                        quarantinedUntil: "2099-01-01T00:00:00.000Z",
                      },
                    },
                    identityPlugins: {},
                    degraded: false,
                    egressWarnings: [],
                    identityWarnings: [],
                  }),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "keeps direct egress when plugin score drift only moderately favors leased variants",
    () =>
      Effect.gen(function* () {
        const policy = yield* AccessProfileSelectionPolicy;
        const profiles = yield* policy.resolveProfiles({
          url: "https://example.com/products/sku-plugin-drift",
          providerId: "browser-basic",
        });

        expect(profiles.egress.profileId).toBe("direct");
        expect(profiles.identity.profileId).toBe("default");
        expect(profiles.egress.warnings).toEqual([]);
        expect(profiles.identity.warnings).toEqual([]);
      }).pipe(
        Effect.provide(
          AccessProfileSelectionPolicyLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                AccessProfileRegistryLive,
                AccessHealthRuntimeLive,
                AccessProfileSelectionStrategyLive,
                Layer.succeed(AccessProfileSelectionHealthSignalsGateway, {
                  inspect: () =>
                    Effect.succeed({
                      egressProfiles: {},
                      egressPlugins: {
                        "direct-pool::direct-route::builtin-direct-egress": {
                          subject: {
                            kind: "egress-plugin",
                            poolId: "direct-pool",
                            routePolicyId: "direct-route",
                            pluginId: "builtin-direct-egress",
                          },
                          successCount: 3,
                          failureCount: 1,
                          successStreak: 0,
                          failureStreak: 0,
                          score: 75,
                          quarantinedUntil: null,
                        },
                        "leased-direct-pool::leased-direct-route::builtin-leased-egress": {
                          subject: {
                            kind: "egress-plugin",
                            poolId: "leased-direct-pool",
                            routePolicyId: "leased-direct-route",
                            pluginId: "builtin-leased-egress",
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
                      identityPlugins: {
                        "public::builtin-default-identity": {
                          subject: {
                            kind: "identity-plugin",
                            tenantId: "public",
                            domain: "example.com",
                            pluginId: "builtin-default-identity",
                          },
                          successCount: 2,
                          failureCount: 1,
                          successStreak: 0,
                          failureStreak: 0,
                          score: 66.67,
                          quarantinedUntil: null,
                        },
                        "public::builtin-leased-identity": {
                          subject: {
                            kind: "identity-plugin",
                            tenantId: "public",
                            domain: "example.com",
                            pluginId: "builtin-leased-identity",
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
                    }),
                }),
              ),
            ),
          ),
        ),
      ),
  );

  it.effect(
    "keeps direct egress when profile score drift only moderately favors leased variants",
    () =>
      Effect.gen(function* () {
        const policy = yield* AccessProfileSelectionPolicy;
        const profiles = yield* policy.resolveProfiles({
          url: "https://example.com/products/sku-profile-drift",
          providerId: "browser-basic",
        });

        expect(profiles.egress.profileId).toBe("direct");
        expect(profiles.identity.profileId).toBe("default");
        expect(profiles.egress.warnings).toEqual([]);
        expect(profiles.identity.warnings).toEqual([]);
      }).pipe(
        Effect.provide(
          AccessProfileSelectionPolicyLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                AccessProfileRegistryLive,
                AccessHealthRuntimeLive,
                AccessProfileSelectionStrategyLive,
                Layer.succeed(AccessProfileSelectionHealthSignalsGateway, {
                  inspect: () =>
                    Effect.succeed({
                      egressProfiles: {
                        direct: {
                          subject: {
                            kind: "egress-profile",
                            poolId: "direct-pool",
                            routePolicyId: "direct-route",
                            profileId: "direct",
                          },
                          successCount: 3,
                          failureCount: 1,
                          successStreak: 0,
                          failureStreak: 0,
                          score: 75,
                          quarantinedUntil: null,
                        },
                        "leased-direct": {
                          subject: {
                            kind: "egress-profile",
                            poolId: "leased-direct-pool",
                            routePolicyId: "leased-direct-route",
                            profileId: "leased-direct",
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
                      identityProfiles: {
                        default: {
                          subject: {
                            kind: "identity-profile",
                            tenantId: "public",
                            domain: "example.com",
                            profileId: "default",
                          },
                          successCount: 2,
                          failureCount: 1,
                          successStreak: 0,
                          failureStreak: 0,
                          score: 70,
                          quarantinedUntil: null,
                        },
                        "leased-default": {
                          subject: {
                            kind: "identity-profile",
                            tenantId: "public",
                            domain: "example.com",
                            profileId: "leased-default",
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
                    }),
                }),
              ),
            ),
          ),
        ),
      ),
  );

  it.effect(
    "surfaces selected-profile quarantine diagnostics when all candidates are unhealthy",
    () =>
      Effect.gen(function* () {
        const policy = yield* AccessProfileSelectionPolicy;
        const profiles = yield* policy.resolveProfiles({
          url: "https://example.com/products/sku-4b",
          providerId: "browser-basic",
        });

        expect(profiles.egress.profileId).toBe("direct");
        expect(profiles.identity.profileId).toBe("default");
        expect(profiles.egress.warnings).toContain(
          'Selected egress profile "direct" is currently quarantined in access health state.',
        );
        expect(profiles.egress.warnings).toContain(
          'Selected egress plugin backend "builtin-direct-egress" is currently quarantined in access health state.',
        );
        expect(profiles.identity.warnings).toContain(
          'Selected identity profile "default" is currently quarantined in access health state.',
        );
        expect(profiles.identity.warnings).toContain(
          'Selected identity plugin backend "builtin-default-identity" is currently quarantined in access health state.',
        );
      }).pipe(
        Effect.provide(
          AccessProfileSelectionPolicyLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                AccessProfileRegistryLive,
                AccessHealthRuntimeLive,
                AccessProfileSelectionStrategyLive,
                Layer.succeed(AccessProfileSelectionHealthSignalsGateway, {
                  inspect: ({ egressProfiles, identityProfiles }) =>
                    Effect.succeed({
                      egressProfiles: Object.fromEntries(
                        egressProfiles.map((profile) => [
                          profile.profileId,
                          {
                            subject: {
                              kind: "egress-profile",
                              poolId: profile.poolId,
                              routePolicyId: profile.routePolicyId,
                              profileId: profile.profileId,
                            },
                            successCount: 0,
                            failureCount: 2,
                            successStreak: 0,
                            failureStreak: 2,
                            score: 0,
                            quarantinedUntil: "2099-01-01T00:00:00.000Z",
                          },
                        ]),
                      ),
                      egressPlugins: Object.fromEntries(
                        egressProfiles.map((profile) => [
                          `${profile.poolId}::${profile.routePolicyId}::${profile.pluginId}`,
                          {
                            subject: {
                              kind: "egress-plugin",
                              poolId: profile.poolId,
                              routePolicyId: profile.routePolicyId,
                              pluginId: profile.pluginId,
                            },
                            successCount: 0,
                            failureCount: 2,
                            successStreak: 0,
                            failureStreak: 2,
                            score: 0,
                            quarantinedUntil: "2099-01-01T00:00:00.000Z",
                          },
                        ]),
                      ),
                      identityProfiles: Object.fromEntries(
                        identityProfiles.map((profile) => [
                          profile.profileId,
                          {
                            subject: {
                              kind: "identity-profile",
                              tenantId: profile.tenantId,
                              domain: "example.com",
                              profileId: profile.profileId,
                            },
                            successCount: 0,
                            failureCount: 2,
                            successStreak: 0,
                            failureStreak: 2,
                            score: 0,
                            quarantinedUntil: "2099-01-01T00:00:00.000Z",
                          },
                        ]),
                      ),
                      identityPlugins: Object.fromEntries(
                        identityProfiles.map((profile) => [
                          `${profile.tenantId}::${profile.pluginId}`,
                          {
                            subject: {
                              kind: "identity-plugin",
                              tenantId: profile.tenantId,
                              domain: "example.com",
                              pluginId: profile.pluginId,
                            },
                            successCount: 0,
                            failureCount: 2,
                            successStreak: 0,
                            failureStreak: 2,
                            score: 0,
                            quarantinedUntil: "2099-01-01T00:00:00.000Z",
                          },
                        ]),
                      ),
                      degraded: false,
                      egressWarnings: [],
                      identityWarnings: [],
                    }),
                }),
              ),
            ),
          ),
        ),
      ),
  );

  it.effect("surfaces degraded health-signal warnings on resolved profiles", () =>
    Effect.gen(function* () {
      const policy = yield* AccessProfileSelectionPolicy;
      const profiles = yield* policy.resolveProfiles({
        url: "https://example.com/products/sku-4",
        providerId: "browser-basic",
      });

      expect(profiles.egress.warnings).toContain(
        "Some egress profile or plugin health signals were unavailable; static profile preference may be used for affected entries.",
      );
      expect(profiles.identity.warnings).toEqual([]);
    }).pipe(
      Effect.provide(
        AccessProfileSelectionPolicyLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              AccessProfileRegistryLive,
              AccessHealthRuntimeLive,
              AccessProfileSelectionStrategyLive,
              Layer.succeed(AccessProfileSelectionHealthSignalsGateway, {
                inspect: () =>
                  Effect.succeed({
                    egressProfiles: {},
                    egressPlugins: {},
                    identityProfiles: {},
                    identityPlugins: {},
                    degraded: true,
                    egressWarnings: [
                      "Some egress profile or plugin health signals were unavailable; static profile preference may be used for affected entries.",
                    ],
                    identityWarnings: [],
                  }),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "keeps the preferred builtin identity when only profile health score drift favors leased variants",
    () =>
      Effect.gen(function* () {
        const policy = yield* AccessProfileSelectionPolicy;
        const profiles = yield* policy.resolveProfiles({
          url: "https://example.com/products/sku-identity-health-drift",
          providerId: "browser-basic",
        });

        expect(profiles.egress.profileId).toBe("direct");
        expect(profiles.identity.profileId).toBe("default");
        expect(profiles.egress.warnings).toEqual([]);
        expect(profiles.identity.warnings).toEqual([]);
      }).pipe(
        Effect.provide(
          AccessProfileSelectionPolicyLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                AccessProfileRegistryLive,
                AccessHealthRuntimeLive,
                AccessProfileSelectionStrategyLive,
                Layer.succeed(AccessProfileSelectionHealthSignalsGateway, {
                  inspect: () =>
                    Effect.succeed({
                      egressProfiles: {},
                      egressPlugins: {},
                      identityProfiles: {
                        default: {
                          subject: {
                            kind: "identity-profile",
                            tenantId: "public",
                            domain: "example.com",
                            profileId: "default",
                          },
                          successCount: 1,
                          failureCount: 4,
                          successStreak: 0,
                          failureStreak: 2,
                          score: 20,
                          quarantinedUntil: null,
                        },
                        "leased-default": {
                          subject: {
                            kind: "identity-profile",
                            tenantId: "public",
                            domain: "example.com",
                            profileId: "leased-default",
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
                    }),
                }),
              ),
            ),
          ),
        ),
      ),
  );

  it.effect("surfaces selected-profile diagnostics for explicit selectors", () =>
    Effect.gen(function* () {
      const policy = yield* AccessProfileSelectionPolicy;
      const profiles = yield* policy.resolveProfiles({
        url: "https://example.com/products/sku-4c",
        providerId: "browser-basic",
        execution: {
          egress: {
            profileId: "direct",
          },
          identity: {
            profileId: "default",
          },
        },
      });

      expect(profiles.egress.profileId).toBe("direct");
      expect(profiles.identity.profileId).toBe("default");
      expect(profiles.egress.warnings).toContain(
        'Selected egress profile "direct" is currently quarantined in access health state.',
      );
      expect(profiles.identity.warnings).toContain(
        'Selected identity profile "default" is currently quarantined in access health state.',
      );
    }).pipe(
      Effect.provide(
        AccessProfileSelectionPolicyLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              AccessProfileRegistryLive,
              AccessHealthRuntimeLive,
              AccessProfileSelectionStrategyLive,
              Layer.succeed(AccessProfileSelectionHealthSignalsGateway, {
                inspect: ({ egressProfiles, identityProfiles }) =>
                  Effect.succeed({
                    egressProfiles: Object.fromEntries(
                      egressProfiles.map((profile) => [
                        profile.profileId,
                        {
                          subject: {
                            kind: "egress-profile",
                            poolId: profile.poolId,
                            routePolicyId: profile.routePolicyId,
                            profileId: profile.profileId,
                          },
                          successCount: 0,
                          failureCount: 2,
                          successStreak: 0,
                          failureStreak: 2,
                          score: 0,
                          quarantinedUntil: "2099-01-01T00:00:00.000Z",
                        },
                      ]),
                    ),
                    egressPlugins: {},
                    identityProfiles: Object.fromEntries(
                      identityProfiles.map((profile) => [
                        profile.profileId,
                        {
                          subject: {
                            kind: "identity-profile",
                            tenantId: profile.tenantId,
                            domain: "example.com",
                            profileId: profile.profileId,
                          },
                          successCount: 0,
                          failureCount: 2,
                          successStreak: 0,
                          failureStreak: 2,
                          score: 0,
                          quarantinedUntil: "2099-01-01T00:00:00.000Z",
                        },
                      ]),
                    ),
                    identityPlugins: {},
                    degraded: false,
                    egressWarnings: [],
                    identityWarnings: [],
                  }),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("rejects duplicate profile ids from injected registries", () =>
    Effect.gen(function* () {
      const policy = yield* AccessProfileSelectionPolicy;
      const error = yield* policy
        .resolveProfiles({
          url: "https://example.com/products/sku-5",
          providerId: "browser-basic",
        })
        .pipe(
          Effect.match({
            onSuccess: () => undefined,
            onFailure: (failure) => failure,
          }),
        );

      expect(error).toBeInstanceOf(InvalidInputError);
      expect(error?.message).toBe("Duplicate egress profile id");
    }).pipe(
      Effect.provide(
        AccessProfileSelectionPolicyLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(AccessProfileSelectionHealthSignalsGateway, {
                inspect: () =>
                  Effect.succeed({
                    egressProfiles: {},
                    egressPlugins: {},
                    identityProfiles: {},
                    identityPlugins: {},
                    degraded: false,
                    egressWarnings: [],
                    identityWarnings: [],
                  }),
              }),
              AccessProfileSelectionStrategyLive,
              Layer.succeed(AccessProfileRegistry, {
                listEgressProfiles: () =>
                  Effect.succeed([
                    {
                      allocationMode: "static",
                      pluginId: "builtin-direct-egress",
                      profileId: "direct",
                      poolId: "direct-pool",
                      routePolicyId: "route-a",
                      routeKind: "direct",
                      routeKey: "direct-a",
                      requestHeaders: {},
                      warnings: [],
                    },
                    {
                      allocationMode: "static",
                      pluginId: "builtin-direct-egress",
                      profileId: "direct",
                      poolId: "direct-pool-b",
                      routePolicyId: "route-b",
                      routeKind: "direct",
                      routeKey: "direct-b",
                      requestHeaders: {},
                      warnings: [],
                    },
                  ]),
                listIdentityProfiles: () => Effect.succeed([]),
                findEgressProfile: () => Effect.succeed(undefined),
                findIdentityProfile: () => Effect.succeed(undefined),
                resolveEgressProfile: () =>
                  Effect.fail(
                    new InvalidInputError({
                      message: "Unexpected profile resolution",
                    }),
                  ),
                resolveIdentityProfile: () =>
                  Effect.fail(
                    new InvalidInputError({
                      message: "Unexpected profile resolution",
                    }),
                  ),
              }),
            ),
          ),
        ),
      ),
    ),
  );
});
