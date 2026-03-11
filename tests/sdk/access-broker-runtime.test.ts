import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Layer } from "effect";
import { makeInMemoryEgressLeaseManager } from "@effect-scrapling/foundation-core/egress-lease-runtime";
import { makeInMemoryIdentityLeaseManager } from "@effect-scrapling/foundation-core/identity-lease-runtime";
import {
  makeEgressBroker,
  EgressBroker,
  EgressBrokerEnvironmentLive,
  IdentityBroker,
  IdentityBrokerEnvironmentLive,
  makeIdentityBroker,
  resetAccessBrokerStateForTests,
} from "../../src/sdk/access-broker-runtime.ts";
import {
  BUILTIN_HTTP_CONNECT_EGRESS_PLUGIN_ID,
  EgressLeaseManagerLive,
  EgressLeaseManagerService,
  IdentityLeaseManagerService,
  BUILTIN_LEASED_EGRESS_PLUGIN_ID,
  BUILTIN_LEASED_IDENTITY_PLUGIN_ID,
  EgressPluginRegistry,
  makeEgressPluginRegistryLiveLayer,
  type EmptyPluginConfig,
  IdentityPluginRegistry,
  makeIdentityPluginRegistryLiveLayer,
  makeLeaseBackedEgressPlugin,
  makeLeaseBackedIdentityPlugin,
  makeStaticEgressPluginRegistry,
  makeStaticIdentityPluginRegistry,
} from "../../src/sdk/access-allocation-plugin-runtime.ts";
import { type ResolvedExecutionPlan } from "../../src/sdk/access-runtime.ts";

const sharedPlan: ResolvedExecutionPlan = {
  targetUrl: "https://example.com/products/sku-1",
  targetDomain: "example.com",
  providerId: "http-basic",
  mode: "http",
  timeoutMs: 500,
  egress: {
    allocationMode: "static",
    pluginId: "builtin-direct-egress",
    profileId: "direct",
    poolId: "direct-pool",
    routePolicyId: "direct-route",
    routeKind: "direct",
    routeKey: "direct",
    requestHeaders: {},
    warnings: [],
  },
  identity: {
    allocationMode: "static",
    pluginId: "builtin-default-identity",
    profileId: "default",
    tenantId: "public",
    browserRuntimeProfileId: "patchright-default",
    httpUserAgent: "effect-scrapling/0.0.1",
    browserUserAgent: "browser-agent",
    locale: undefined,
    timezoneId: undefined,
    warnings: [],
  },
  http: {
    userAgent: "effect-scrapling/0.0.1",
  },
  warnings: [],
};

async function releaseAll(
  leases: ReadonlyArray<{
    readonly release: Effect.Effect<void, never>;
  }>,
) {
  await Effect.runPromise(
    Effect.forEach(leases, ({ release }) => release, {
      concurrency: "unbounded",
      discard: true,
    }),
  );
}

function decodeEmptyConfig() {
  return Effect.succeed({} satisfies EmptyPluginConfig);
}

describe("sdk access broker runtime", () => {
  it.effect("shares identity lease state across broker instances backed by one manager", () =>
    Effect.gen(function* () {
      yield* resetAccessBrokerStateForTests();
      const manager = yield* makeInMemoryIdentityLeaseManager();
      const plugin = yield* makeLeaseBackedIdentityPlugin({ manager });
      const firstBroker = makeIdentityBroker(
        makeStaticIdentityPluginRegistry({
          plugins: {
            [plugin.id]: plugin,
          },
        }),
      );
      const secondBroker = makeIdentityBroker(
        makeStaticIdentityPluginRegistry({
          plugins: {
            [plugin.id]: plugin,
          },
        }),
      );
      const leases = new Array<{
        readonly release: Effect.Effect<void, never>;
      }>();

      try {
        for (let index = 0; index < 64; index += 1) {
          const broker = index % 2 === 0 ? firstBroker : secondBroker;
          const lease = yield* broker.acquire({
            url: sharedPlan.targetUrl,
            plan: {
              ...sharedPlan,
              identity: {
                ...sharedPlan.identity,
                allocationMode: "leased",
                pluginId: BUILTIN_LEASED_IDENTITY_PLUGIN_ID,
                profileId: `identity-${index}`,
              },
            },
          });
          leases.push(lease);
        }

        const exhausted = yield* secondBroker
          .acquire({
            url: sharedPlan.targetUrl,
            plan: {
              ...sharedPlan,
              identity: {
                ...sharedPlan.identity,
                allocationMode: "leased",
                pluginId: BUILTIN_LEASED_IDENTITY_PLUGIN_ID,
                profileId: "identity-64",
              },
            },
          })
          .pipe(
            Effect.match({
              onSuccess: () => undefined,
              onFailure: (error) => error,
            }),
          );

        expect(exhausted?._tag).toBe("AccessResourceError");
        expect(exhausted?.message).toContain("identity lease");
        expect(exhausted?.details).toContain("exhausted");
      } finally {
        yield* Effect.promise(() => releaseAll(leases));
        yield* resetAccessBrokerStateForTests();
      }
    }),
  );

  it.effect("shares egress lease state across broker instances backed by one manager", () =>
    Effect.gen(function* () {
      yield* resetAccessBrokerStateForTests();
      const manager = yield* makeInMemoryEgressLeaseManager();
      const plugin = yield* makeLeaseBackedEgressPlugin({ manager });
      const firstBroker = makeEgressBroker(
        makeStaticEgressPluginRegistry({
          plugins: {
            [plugin.id]: plugin,
          },
        }),
      );
      const secondBroker = makeEgressBroker(
        makeStaticEgressPluginRegistry({
          plugins: {
            [plugin.id]: plugin,
          },
        }),
      );
      const leases = new Array<{
        readonly release: Effect.Effect<void, never>;
      }>();

      try {
        for (let index = 0; index < 64; index += 1) {
          const broker = index % 2 === 0 ? firstBroker : secondBroker;
          const lease = yield* broker.acquire({
            url: sharedPlan.targetUrl,
            plan: {
              ...sharedPlan,
              egress: {
                ...sharedPlan.egress,
                allocationMode: "leased",
                pluginId: BUILTIN_LEASED_EGRESS_PLUGIN_ID,
                routeKey: `direct-${index}`,
              },
            },
          });
          leases.push(lease);
        }

        const exhausted = yield* firstBroker
          .acquire({
            url: sharedPlan.targetUrl,
            plan: {
              ...sharedPlan,
              egress: {
                ...sharedPlan.egress,
                allocationMode: "leased",
                pluginId: BUILTIN_LEASED_EGRESS_PLUGIN_ID,
                routeKey: "direct-64",
              },
            },
          })
          .pipe(
            Effect.match({
              onSuccess: () => undefined,
              onFailure: (error) => error,
            }),
          );

        expect(exhausted?._tag).toBe("AccessResourceError");
        expect(exhausted?.message).toContain("egress lease");
        expect(exhausted?.details).toContain("exhausted");
      } finally {
        yield* Effect.promise(() => releaseAll(leases));
        yield* resetAccessBrokerStateForTests();
      }
    }),
  );

  it.effect("plugin registry live layer uses an injected egress lease manager service", () => {
    let acquisitions = 0;

    return Effect.gen(function* () {
      const registry = yield* EgressPluginRegistry;
      const plugin = yield* registry.resolve(BUILTIN_LEASED_EGRESS_PLUGIN_ID);
      const lease = yield* plugin.acquire({
        url: sharedPlan.targetUrl,
        profile: {
          ...sharedPlan.egress,
          allocationMode: "leased",
          pluginId: BUILTIN_LEASED_EGRESS_PLUGIN_ID,
          profileId: "leased-direct",
          poolId: "custom-egress-pool",
          routePolicyId: "custom-egress-policy",
          routeKey: "custom-egress",
        },
        config: {},
        plan: {
          ...sharedPlan,
          egress: {
            ...sharedPlan.egress,
            allocationMode: "leased",
            pluginId: BUILTIN_LEASED_EGRESS_PLUGIN_ID,
            profileId: "leased-direct",
            poolId: "custom-egress-pool",
            routePolicyId: "custom-egress-policy",
            routeKey: "custom-egress",
          },
        },
      });

      expect(acquisitions).toBe(1);
      expect(lease.leaseId).toBe("egress-lease-1");
      expect(lease.egressKey).toBe("ignored-by-plugin");
    }).pipe(
      Effect.provide(
        makeEgressPluginRegistryLiveLayer().pipe(
          Layer.provide(
            Layer.succeed(EgressLeaseManagerService, {
              acquire: (_input: unknown) =>
                Effect.sync(() => {
                  acquisitions += 1;
                  return {
                    id: "egress-lease-1",
                    egressKey: "ignored-by-plugin",
                  };
                }),
              release: (_leaseId: unknown) => Effect.succeed(undefined),
            }),
          ),
        ),
      ),
    );
  });

  it.effect(
    "builtin proxy egress plugins materialize route config from selector plugin config",
    () =>
      Effect.gen(function* () {
        const registry = yield* EgressPluginRegistry;
        const plugin = yield* registry.resolve(BUILTIN_HTTP_CONNECT_EGRESS_PLUGIN_ID);
        const lease = yield* plugin.acquire({
          url: sharedPlan.targetUrl,
          profile: {
            ...sharedPlan.egress,
            pluginId: BUILTIN_HTTP_CONNECT_EGRESS_PLUGIN_ID,
            profileId: "http-connect",
            poolId: "http-connect-pool",
            routePolicyId: "http-connect-route",
            routeKind: "http-connect",
            routeKey: "http-connect",
            routeConfig: {
              kind: "http-connect",
            },
          },
          config: {
            proxyUrl: "http://proxy.example.test:8080",
            proxyHeaders: {
              "Proxy-Authorization": "Bearer token",
            },
            egressKey: "proxy-route-a",
          },
          plan: {
            ...sharedPlan,
            egress: {
              ...sharedPlan.egress,
              pluginId: BUILTIN_HTTP_CONNECT_EGRESS_PLUGIN_ID,
              profileId: "http-connect",
              poolId: "http-connect-pool",
              routePolicyId: "http-connect-route",
              routeKind: "http-connect",
              routeKey: "http-connect",
              routeConfig: {
                kind: "http-connect",
              },
            },
          },
        });

        expect(lease.egressKey).toBe("proxy-route-a");
        expect(lease.routeConfig).toEqual({
          kind: "http-connect",
          proxyUrl: "http://proxy.example.test:8080",
          proxyHeaders: {
            "Proxy-Authorization": "Bearer token",
          },
        });
      }).pipe(
        Effect.provide(
          makeEgressPluginRegistryLiveLayer().pipe(Layer.provide(EgressLeaseManagerLive)),
        ),
      ),
  );

  it.effect("plugin registry live layer uses an injected identity lease manager service", () => {
    let acquisitions = 0;

    return Effect.gen(function* () {
      const registry = yield* IdentityPluginRegistry;
      const plugin = yield* registry.resolve(BUILTIN_LEASED_IDENTITY_PLUGIN_ID);
      const lease = yield* plugin.acquire({
        url: sharedPlan.targetUrl,
        profile: {
          ...sharedPlan.identity,
          allocationMode: "leased",
          pluginId: BUILTIN_LEASED_IDENTITY_PLUGIN_ID,
          profileId: "leased-default",
          tenantId: "tenant-a",
        },
        config: {},
        plan: {
          ...sharedPlan,
          identity: {
            ...sharedPlan.identity,
            allocationMode: "leased",
            pluginId: BUILTIN_LEASED_IDENTITY_PLUGIN_ID,
            profileId: "leased-default",
            tenantId: "tenant-a",
          },
        },
      });

      expect(acquisitions).toBe(1);
      expect(lease.leaseId).toBe("identity-lease-1");
      expect(lease.identityKey).toBe("ignored-by-plugin");
    }).pipe(
      Effect.provide(
        makeIdentityPluginRegistryLiveLayer().pipe(
          Layer.provide(
            Layer.succeed(IdentityLeaseManagerService, {
              acquire: (_input: unknown) =>
                Effect.sync(() => {
                  acquisitions += 1;
                  return {
                    id: "identity-lease-1",
                    identityKey: "ignored-by-plugin",
                  };
                }),
              release: (_leaseId: unknown) => Effect.succeed(undefined),
            }),
          ),
        ),
      ),
    );
  });

  it.effect("allows parallel static profiles while preserving stable resource keys", () =>
    Effect.gen(function* () {
      yield* resetAccessBrokerStateForTests();
      const directEgressBroker = makeEgressBroker(
        makeStaticEgressPluginRegistry({
          plugins: {
            [sharedPlan.egress.pluginId]: {
              id: sharedPlan.egress.pluginId,
              decodeConfig: () => decodeEmptyConfig(),
              acquire: ({ profile }) =>
                Effect.succeed({
                  ...profile,
                  egressKey: profile.routeKey,
                  release: Effect.void,
                }),
            },
          },
        }),
      );
      const defaultIdentityBroker = makeIdentityBroker(
        makeStaticIdentityPluginRegistry({
          plugins: {
            [sharedPlan.identity.pluginId]: {
              id: sharedPlan.identity.pluginId,
              decodeConfig: () => decodeEmptyConfig(),
              acquire: ({ profile }) =>
                Effect.succeed({
                  ...profile,
                  identityKey: profile.profileId,
                  release: Effect.void,
                }),
            },
          },
        }),
      );

      const [firstEgressLease, secondEgressLease, firstIdentityLease, secondIdentityLease] =
        yield* Effect.all(
          [
            directEgressBroker.acquire({
              url: sharedPlan.targetUrl,
              plan: sharedPlan,
            }),
            directEgressBroker.acquire({
              url: sharedPlan.targetUrl,
              plan: sharedPlan,
            }),
            defaultIdentityBroker.acquire({
              url: sharedPlan.targetUrl,
              plan: sharedPlan,
            }),
            defaultIdentityBroker.acquire({
              url: sharedPlan.targetUrl,
              plan: sharedPlan,
            }),
          ],
          { concurrency: "unbounded" },
        );

      expect(firstEgressLease.egressKey).toBe("direct");
      expect(secondEgressLease.egressKey).toBe("direct");
      expect(firstIdentityLease.identityKey).toBe("default");
      expect(secondIdentityLease.identityKey).toBe("default");
      expect(firstEgressLease.leaseId).toBeUndefined();
      expect(secondEgressLease.leaseId).toBeUndefined();
      expect(firstIdentityLease.leaseId).toBeUndefined();
      expect(secondIdentityLease.leaseId).toBeUndefined();
      yield* resetAccessBrokerStateForTests();
    }),
  );

  it.effect("rejects malformed builtin proxy plugin config before allocation", () =>
    Effect.gen(function* () {
      const broker = makeEgressBroker(yield* EgressPluginRegistry);
      const error = yield* broker
        .acquire({
          url: sharedPlan.targetUrl,
          plan: {
            ...sharedPlan,
            egress: {
              ...sharedPlan.egress,
              pluginId: BUILTIN_HTTP_CONNECT_EGRESS_PLUGIN_ID,
              profileId: "http-connect",
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
            },
          },
        })
        .pipe(
          Effect.match({
            onSuccess: () => undefined,
            onFailure: (error) => error,
          }),
        );

      expect(error?._tag).toBe("InvalidInputError");
      expect(error?.details).toContain("absolute URL");
    }).pipe(
      Effect.provide(
        makeEgressPluginRegistryLiveLayer().pipe(Layer.provide(EgressLeaseManagerLive)),
      ),
    ),
  );

  it.effect("fails malformed leased identity broker URLs with a typed invalid-input error", () =>
    Effect.gen(function* () {
      yield* resetAccessBrokerStateForTests();
      const plugin = yield* makeLeaseBackedIdentityPlugin({
        manager: yield* makeInMemoryIdentityLeaseManager(),
      });
      const broker = makeIdentityBroker(
        makeStaticIdentityPluginRegistry({
          plugins: {
            [plugin.id]: plugin,
          },
        }),
      );

      const failure = yield* broker
        .acquire({
          url: "not-a-valid-url",
          plan: {
            ...sharedPlan,
            identity: {
              ...sharedPlan.identity,
              allocationMode: "leased",
              pluginId: BUILTIN_LEASED_IDENTITY_PLUGIN_ID,
            },
          },
        })
        .pipe(
          Effect.match({
            onSuccess: () => undefined,
            onFailure: (error) => error,
          }),
        );

      expect(failure?._tag).toBe("InvalidInputError");
      expect(failure?.message).toBe("Invalid target URL");
      yield* resetAccessBrokerStateForTests();
    }),
  );

  it.effect("allows leased plugins to override manager settings from profile config", () =>
    Effect.gen(function* () {
      yield* resetAccessBrokerStateForTests();
      const plugin = yield* makeLeaseBackedEgressPlugin({
        manager: yield* makeInMemoryEgressLeaseManager(),
        ttlMs: 100,
      });
      const broker = makeEgressBroker(
        makeStaticEgressPluginRegistry({
          plugins: {
            [plugin.id]: plugin,
          },
        }),
      );

      const firstLease = yield* broker.acquire({
        url: sharedPlan.targetUrl,
        plan: {
          ...sharedPlan,
          egress: {
            ...sharedPlan.egress,
            allocationMode: "leased",
            pluginId: BUILTIN_LEASED_EGRESS_PLUGIN_ID,
            profileId: "leased-a",
            routeKey: "leased-a",
            pluginConfig: {
              ttlMs: 100,
              maxPoolLeases: 1,
            },
          },
        },
      });

      const exhausted = yield* broker
        .acquire({
          url: sharedPlan.targetUrl,
          plan: {
            ...sharedPlan,
            egress: {
              ...sharedPlan.egress,
              allocationMode: "leased",
              pluginId: BUILTIN_LEASED_EGRESS_PLUGIN_ID,
              profileId: "leased-b",
              routeKey: "leased-b",
              pluginConfig: {
                ttlMs: 100,
                maxPoolLeases: 1,
              },
            },
          },
        })
        .pipe(
          Effect.match({
            onSuccess: () => undefined,
            onFailure: (error) => error,
          }),
        );

      expect(firstLease.leaseId).toBeDefined();
      expect(exhausted?._tag).toBe("AccessResourceError");
      expect(exhausted?.details).toContain("exhausted");

      yield* firstLease.release;
      yield* resetAccessBrokerStateForTests();
    }),
  );

  it.effect("rejects invalid plugin config before allocation starts", () =>
    Effect.gen(function* () {
      yield* resetAccessBrokerStateForTests();
      const plugin = yield* makeLeaseBackedIdentityPlugin({
        manager: yield* makeInMemoryIdentityLeaseManager(),
      });
      const broker = makeIdentityBroker(
        makeStaticIdentityPluginRegistry({
          plugins: {
            [plugin.id]: plugin,
          },
        }),
      );

      const failure = yield* broker
        .acquire({
          url: sharedPlan.targetUrl,
          plan: {
            ...sharedPlan,
            identity: {
              ...sharedPlan.identity,
              allocationMode: "leased",
              pluginId: BUILTIN_LEASED_IDENTITY_PLUGIN_ID,
              profileId: "leased-identity",
              pluginConfig: {
                ttlMs: 0,
              },
            },
          },
        })
        .pipe(
          Effect.match({
            onSuccess: () => undefined,
            onFailure: (error) => error,
          }),
        );

      expect(failure?._tag).toBe("InvalidInputError");
      expect(failure?.message).toBe("Invalid identity plugin config");
      expect(failure?.details).toContain("ttlMs");
      yield* resetAccessBrokerStateForTests();
    }),
  );

  it.effect("broker environment layers wire leased egress and identity brokers end to end", () =>
    Effect.gen(function* () {
      yield* resetAccessBrokerStateForTests();

      const egressBroker = yield* EgressBroker;
      const identityBroker = yield* IdentityBroker;
      const egressLease = yield* egressBroker.acquire({
        url: sharedPlan.targetUrl,
        plan: {
          ...sharedPlan,
          egress: {
            ...sharedPlan.egress,
            allocationMode: "leased",
            pluginId: BUILTIN_LEASED_EGRESS_PLUGIN_ID,
            profileId: "leased-direct",
            poolId: "leased-direct-pool",
            routePolicyId: "leased-direct-route",
            routeKey: "leased-direct",
          },
        },
      });
      const identityLease = yield* identityBroker.acquire({
        url: sharedPlan.targetUrl,
        plan: {
          ...sharedPlan,
          identity: {
            ...sharedPlan.identity,
            allocationMode: "leased",
            pluginId: BUILTIN_LEASED_IDENTITY_PLUGIN_ID,
            profileId: "leased-default",
          },
        },
      });

      expect(egressLease.leaseId).toBeDefined();
      expect(egressLease.egressKey).toContain("leased-direct-lease-");
      expect(identityLease.leaseId).toBeDefined();
      expect(identityLease.identityKey).toContain("leased-default-lease-");
      yield* egressLease.release;
      yield* identityLease.release;
      yield* resetAccessBrokerStateForTests();
    }).pipe(
      Effect.provide(Layer.mergeAll(EgressBrokerEnvironmentLive, IdentityBrokerEnvironmentLive)),
    ),
  );
});
