import { describe, expect, it } from "@effect-native/bun-test";
import { Effect } from "effect";
import {
  AccessProfileRegistry,
  AccessProfileRegistryLive,
  DEFAULT_HTTP_CONNECT_EGRESS_PROFILE_ID,
  DEFAULT_LEASED_EGRESS_PROFILE_ID,
  DEFAULT_LEASED_IDENTITY_PROFILE_ID,
  DEFAULT_LEASED_STEALTH_IDENTITY_PROFILE_ID,
  DEFAULT_SOCKS5_EGRESS_PROFILE_ID,
  DEFAULT_TOR_EGRESS_PROFILE_ID,
  DEFAULT_WIREGUARD_EGRESS_PROFILE_ID,
  describeResolvedEgressProfileAutoSelectionEligibility,
  makeStaticAccessProfileRegistry,
} from "../../src/sdk/access-profile-runtime.ts";

describe("sdk access profile runtime", () => {
  it.effect("resolves builtin leased egress and identity profiles", () =>
    Effect.gen(function* () {
      const registry = yield* AccessProfileRegistry;

      const egress = yield* registry.resolveEgressProfile({
        profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
      });
      const wireguard = yield* registry.resolveEgressProfile({
        profileId: DEFAULT_WIREGUARD_EGRESS_PROFILE_ID,
      });
      const httpConnect = yield* registry.findEgressProfile(DEFAULT_HTTP_CONNECT_EGRESS_PROFILE_ID);
      const socks5 = yield* registry.resolveEgressProfile({
        profileId: DEFAULT_SOCKS5_EGRESS_PROFILE_ID,
        pluginConfig: {
          proxyUrl: "socks5://proxy.example.test:9050",
        },
      });
      const tor = yield* registry.resolveEgressProfile({
        profileId: DEFAULT_TOR_EGRESS_PROFILE_ID,
        pluginConfig: {
          proxyUrl: "socks5://127.0.0.1:9050",
        },
      });
      const identity = yield* registry.resolveIdentityProfile({
        selector: {
          profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
        },
        providerId: "http-basic",
      });
      const stealthIdentity = yield* registry.resolveIdentityProfile({
        selector: {
          profileId: DEFAULT_LEASED_STEALTH_IDENTITY_PROFILE_ID,
        },
        providerId: "browser-stealth",
      });

      expect(egress).toMatchObject({
        allocationMode: "leased",
        pluginId: "builtin-leased-egress",
        profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
        routeKey: "leased-direct",
      });
      expect(wireguard).toMatchObject({
        allocationMode: "static",
        pluginId: "builtin-wireguard-egress",
        profileId: DEFAULT_WIREGUARD_EGRESS_PROFILE_ID,
        routeConfig: {
          kind: "wireguard",
        },
      });
      expect(httpConnect).toMatchObject({
        allocationMode: "static",
        pluginId: "builtin-http-connect-egress",
        profileId: DEFAULT_HTTP_CONNECT_EGRESS_PROFILE_ID,
        routeConfig: {
          kind: "http-connect",
        },
      });
      expect(socks5).toMatchObject({
        allocationMode: "static",
        pluginId: "builtin-socks5-egress",
        profileId: DEFAULT_SOCKS5_EGRESS_PROFILE_ID,
        routeConfig: {
          kind: "socks5",
        },
      });
      expect(tor).toMatchObject({
        allocationMode: "static",
        pluginId: "builtin-tor-egress",
        profileId: DEFAULT_TOR_EGRESS_PROFILE_ID,
        routeConfig: {
          kind: "tor",
        },
      });
      expect(identity).toMatchObject({
        allocationMode: "leased",
        pluginId: "builtin-leased-identity",
        profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
        browserRuntimeProfileId: "patchright-default",
      });
      expect(stealthIdentity).toMatchObject({
        allocationMode: "leased",
        pluginId: "builtin-leased-identity",
        profileId: DEFAULT_LEASED_STEALTH_IDENTITY_PROFILE_ID,
        browserRuntimeProfileId: "patchright-stealth",
      });
    }).pipe(Effect.provide(AccessProfileRegistryLive)),
  );

  it("overrides plugin config through nested selectors without mutating the static registry", async () => {
    const registry = makeStaticAccessProfileRegistry();

    const resolved = await Effect.runPromise(
      registry.resolveEgressProfile({
        profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
        pluginConfig: {
          ttlMs: 45_000,
          ownerId: "cli-smoke",
        },
      }),
    );
    const resolvedAgain = await Effect.runPromise(
      registry.resolveEgressProfile({
        profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
      }),
    );

    expect(resolved.pluginConfig).toEqual({
      ttlMs: 45_000,
      ownerId: "cli-smoke",
    });
    expect(resolvedAgain.pluginConfig).toBeUndefined();
  });

  it("rejects explicit proxy-style egress profiles without required proxy config", async () => {
    const registry = makeStaticAccessProfileRegistry();

    const error = await Effect.runPromise(
      registry
        .resolveEgressProfile({
          profileId: DEFAULT_HTTP_CONNECT_EGRESS_PROFILE_ID,
        })
        .pipe(
          Effect.match({
            onSuccess: () => undefined,
            onFailure: (failure) => failure,
          }),
        ),
    );

    expect(error?._tag).toBe("InvalidInputError");
    expect(error?.message).toBe("Invalid egress profile configuration");
    expect(error?.details).toContain(`"${DEFAULT_HTTP_CONNECT_EGRESS_PROFILE_ID}"`);
    expect(error?.details).toContain('"proxyUrl"');
  });

  it("treats proxy-style egress profiles with explicit proxy config as usable", async () => {
    const registry = makeStaticAccessProfileRegistry();

    const resolved = await Effect.runPromise(
      registry.resolveEgressProfile({
        profileId: DEFAULT_HTTP_CONNECT_EGRESS_PROFILE_ID,
        pluginConfig: {
          proxyUrl: "http://proxy.example.test:8080",
        },
      }),
    );
    const eligibility = describeResolvedEgressProfileAutoSelectionEligibility(resolved);

    expect(resolved.pluginConfig).toEqual({
      proxyUrl: "http://proxy.example.test:8080",
    });
    expect(eligibility).toEqual({
      autoSelectable: true,
    });
  });

  it("rejects proxy-style egress auto-selection when proxy config is not an absolute URL", async () => {
    const registry = makeStaticAccessProfileRegistry();

    await expect(
      Effect.runPromise(
        registry.resolveEgressProfile({
          profileId: DEFAULT_HTTP_CONNECT_EGRESS_PROFILE_ID,
          pluginConfig: {
            proxyUrl: "not-a-url",
          },
        }),
      ),
    ).rejects.toMatchObject({
      message: "Invalid egress profile configuration",
      details: expect.stringContaining('"proxyUrl"'),
    });

    const eligibility = describeResolvedEgressProfileAutoSelectionEligibility({
      allocationMode: "static",
      pluginId: "builtin-http-connect-egress",
      profileId: DEFAULT_HTTP_CONNECT_EGRESS_PROFILE_ID,
      poolId: "http-connect-pool",
      routePolicyId: "http-connect-route",
      routeKind: "http-connect",
      routeKey: "http-connect",
      routeConfig: {
        kind: "http-connect",
      },
      pluginConfig: {
        proxyUrl: "not-a-url",
      },
      requestHeaders: {},
      warnings: [],
      autoSelectionConstraint: {
        requiredPluginConfigKeys: ["proxyUrl"],
      },
    });

    expect(eligibility).toEqual({
      autoSelectable: false,
      reason: expect.stringContaining(`"${DEFAULT_HTTP_CONNECT_EGRESS_PROFILE_ID}"`),
    });
  });

  it("honors module-defined auto-selection constraints without hardcoding route kinds", async () => {
    const eligibility = describeResolvedEgressProfileAutoSelectionEligibility({
      allocationMode: "static",
      pluginId: "custom-egress-plugin",
      profileId: "custom-module-egress",
      poolId: "custom-module-pool",
      routePolicyId: "custom-module-policy",
      routeKind: "managed-proxy",
      routeKey: "custom-module-egress",
      routeConfig: {
        kind: "managed-proxy",
      },
      pluginConfig: {
        proxyUrl: "not-a-url",
      },
      requestHeaders: {},
      warnings: [],
      autoSelectionConstraint: {
        requiredPluginConfigKeys: ["proxyUrl"],
      },
    });

    expect(eligibility).toEqual({
      autoSelectable: false,
      reason:
        'Egress profile "custom-module-egress" requires explicit plugin config "proxyUrl" before it can be used.',
    });
  });

  it("accepts module-defined proxy routes when proxyUrl is already present on routeConfig", () => {
    const eligibility = describeResolvedEgressProfileAutoSelectionEligibility({
      allocationMode: "static",
      pluginId: "custom-egress-plugin",
      profileId: "custom-module-egress",
      poolId: "custom-module-pool",
      routePolicyId: "custom-module-policy",
      routeKind: "managed-proxy",
      routeKey: "custom-module-egress",
      routeConfig: {
        kind: "managed-proxy",
        proxyUrl: "http://proxy.example.test:8080",
      },
      requestHeaders: {},
      warnings: [],
      autoSelectionConstraint: {
        requiredPluginConfigKeys: ["proxyUrl"],
      },
    });

    expect(eligibility).toEqual({
      autoSelectable: true,
    });
  });
});
