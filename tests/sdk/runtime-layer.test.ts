import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Layer } from "effect";
import { EgressBroker, IdentityBroker } from "../../src/sdk/access-broker-runtime.ts";
import {
  AccessModuleRegistry,
  makeStaticAccessModuleRegistry,
} from "../../src/sdk/access-module-runtime.ts";
import {
  makeStaticEgressPlugin,
  makeStaticIdentityPlugin,
} from "../../src/sdk/access-allocation-plugin-runtime.ts";
import { AccessHealthGateway } from "../../src/sdk/access-health-gateway.ts";
import { AccessProfileSelectionPolicy } from "../../src/sdk/access-profile-policy-runtime.ts";
import {
  EgressLeaseManagerService,
  IdentityLeaseManagerService,
} from "../../src/sdk/access-allocation-plugin-runtime.ts";
import {
  AccessSelectionPolicy,
  AccessSelectionPolicyLive,
} from "../../src/sdk/access-policy-runtime.ts";
import { AccessSelectionHealthSignalsGateway } from "../../src/sdk/access-selection-health-runtime.ts";
import { AccessSelectionStrategy } from "../../src/sdk/access-selection-strategy-runtime.ts";
import { AccessExecutionCoordinator } from "../../src/sdk/access-execution-coordinator.ts";
import { AccessProviderRegistry } from "../../src/sdk/access-provider-runtime.ts";
import { BrowserRuntime } from "../../src/sdk/browser-pool.ts";
import { makeSdkRuntimeHandle, provideSdkRuntime } from "../../src/sdk/runtime-layer.ts";

describe("sdk runtime layer", () => {
  it.effect(
    "provideSdkRuntime wires both dependency and derived services through one root layer",
    () =>
      Effect.gen(function* () {
        const browserRuntime = yield* BrowserRuntime;
        const selectionPolicy = yield* AccessSelectionPolicy;
        const providerRegistry = yield* AccessProviderRegistry;
        const coordinator = yield* AccessExecutionCoordinator;
        const snapshot = yield* browserRuntime.getSnapshot();
        const provider = yield* providerRegistry.resolve("http-basic");
        const selection = yield* selectionPolicy.resolveSelection({
          url: "https://example.com/root-runtime-selection",
          defaultProviderId: "http-basic",
        });

        expect(typeof coordinator.execute).toBe("function");
        expect(provider.id).toBe("http-basic");
        expect(selection.mode).toBe("http");
        expect(snapshot.limits.maxContexts).toBeGreaterThan(0);
      }).pipe(provideSdkRuntime),
  );

  it.effect(
    "provideSdkRuntime shares one health runtime across gateway and selection signals",
    () =>
      Effect.gen(function* () {
        const gateway = yield* AccessHealthGateway;
        const healthSignals = yield* AccessSelectionHealthSignalsGateway;

        yield* gateway.recordFailure(
          {
            url: "https://example.com/health-sharing",
            context: {
              targetUrl: "https://example.com/health-sharing",
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
                egressKey: "direct",
                release: Effect.void,
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
                identityKey: "default",
                release: Effect.void,
              },
              http: {
                userAgent: "effect-scrapling/0.0.1",
              },
              warnings: [],
            },
          },
          {
            _tag: "NetworkError",
            message: "Access failed",
          },
        );

        const signals = yield* healthSignals.inspect({
          url: "https://example.com/health-sharing",
          providerIds: ["http-basic"],
        });

        expect(signals.providers["http-basic"]?.failureCount).toBe(1);
      }).pipe(provideSdkRuntime),
  );

  it.effect(
    "provideSdkRuntime shares one health runtime across gateway and profile selection signals",
    () =>
      Effect.gen(function* () {
        const gateway = yield* AccessHealthGateway;
        const profileSelectionPolicy = yield* AccessProfileSelectionPolicy;
        const healthContext = {
          url: "https://example.com/profile-health-sharing",
          context: {
            targetUrl: "https://example.com/profile-health-sharing",
            targetDomain: "example.com",
            providerId: "browser-basic",
            mode: "browser" as const,
            timeoutMs: 500,
            egress: {
              allocationMode: "static" as const,
              pluginId: "builtin-direct-egress",
              profileId: "direct",
              poolId: "direct-pool",
              routePolicyId: "direct-route",
              routeKind: "direct" as const,
              routeKey: "direct",
              requestHeaders: {},
              warnings: [],
              egressKey: "direct",
              release: Effect.void,
            },
            identity: {
              allocationMode: "static" as const,
              pluginId: "builtin-default-identity",
              profileId: "default",
              tenantId: "public",
              browserRuntimeProfileId: "patchright-default",
              httpUserAgent: "effect-scrapling/0.0.1",
              browserUserAgent: "browser-agent",
              locale: undefined,
              timezoneId: undefined,
              warnings: [],
              identityKey: "default",
              release: Effect.void,
            },
            browser: {
              runtimeProfileId: "patchright-default",
              waitUntil: "commit" as const,
              timeoutMs: 500,
              poolKey: "browser-basic|patchright-default|public|default|direct",
            },
            warnings: [],
          },
        };

        yield* gateway.recordFailure(healthContext, {
          _tag: "NetworkError",
          message: "Access failed",
        });
        yield* gateway.recordFailure(healthContext, {
          _tag: "NetworkError",
          message: "Access failed",
        });

        const profiles = yield* profileSelectionPolicy.resolveProfiles({
          url: "https://example.com/profile-health-sharing",
          providerId: "browser-basic",
        });

        expect(profiles.egress.profileId).toBe("leased-direct");
        expect(profiles.identity.profileId).toBe("leased-default");
      }).pipe(provideSdkRuntime),
  );

  it.effect(
    "provideSdkRuntime rehydrates selection policy from an overridden provider registry",
    () =>
      provideSdkRuntime(
        Effect.gen(function* () {
          const selectionPolicy = yield* AccessSelectionPolicy;
          const selection = yield* selectionPolicy.resolveSelection({
            url: "https://example.com/managed-runtime-selection",
            defaultProviderId: "managed-unblocker",
          });

          expect(selection.providerId).toBe("managed-unblocker");
          expect(selection.mode).toBe("browser");
        }),
        Layer.succeed(AccessProviderRegistry, {
          resolve: (providerId) =>
            Effect.succeed({
              id: providerId,
              capabilities: {
                mode: "browser",
                rendersDom: true,
              },
              execute: () =>
                Effect.die(
                  new Error("Execution should not run during selection-policy resolution test"),
                ),
            }),
          findDescriptor: (providerId) =>
            Effect.succeed({
              id: providerId,
              capabilities: {
                mode: "browser",
                rendersDom: true,
              },
            }),
          listDescriptors: () =>
            Effect.succeed([
              {
                id: "managed-unblocker",
                capabilities: {
                  mode: "browser",
                  rendersDom: true,
                },
              },
            ]),
        }),
      ),
  );

  it.effect(
    "provideSdkRuntime rehydrates registries from an overridden access module registry",
    () =>
      provideSdkRuntime(
        Effect.gen(function* () {
          const providerRegistry = yield* AccessProviderRegistry;
          const profileSelectionPolicy = yield* AccessProfileSelectionPolicy;
          const egressBroker = yield* EgressBroker;
          const identityBroker = yield* IdentityBroker;
          const provider = yield* providerRegistry.resolve("managed-unblocker");
          const profiles = yield* profileSelectionPolicy.resolveProfiles({
            url: "https://example.com/module-registry-override",
            providerId: "managed-unblocker",
            execution: {
              egress: {
                profileId: "managed-egress",
              },
              identity: {
                profileId: "managed-identity",
              },
            },
          });
          const plan = {
            targetUrl: "https://example.com/module-registry-override",
            targetDomain: "example.com",
            providerId: "managed-unblocker" as const,
            mode: "browser" as const,
            timeoutMs: 500,
            egress: profiles.egress,
            identity: profiles.identity,
            browser: {
              runtimeProfileId: "patchright-default" as const,
              waitUntil: "commit" as const,
              timeoutMs: 500,
            },
            warnings: [],
          };
          const egress = yield* egressBroker.acquire({
            url: plan.targetUrl,
            plan,
          });
          const identity = yield* identityBroker.acquire({
            url: plan.targetUrl,
            plan,
          });

          expect(provider.id).toBe("managed-unblocker");
          expect(profiles.egress.pluginId).toBe("managed-egress-plugin");
          expect(profiles.identity.pluginId).toBe("managed-identity-plugin");
          expect(egress.egressKey).toBe("managed-egress");
          expect(identity.identityKey).toBe("managed-identity");
        }),
        Layer.succeed(
          AccessModuleRegistry,
          makeStaticAccessModuleRegistry({
            modules: [
              {
                id: "managed-access-module",
                providers: {
                  "managed-unblocker": {
                    id: "managed-unblocker",
                    capabilities: {
                      mode: "browser",
                      rendersDom: true,
                    },
                    execute: () =>
                      Effect.die(
                        new Error(
                          "Execution should not run during access module registry override test",
                        ),
                      ),
                  },
                },
                egressPlugins: {
                  "managed-egress-plugin": makeStaticEgressPlugin("managed-egress-plugin"),
                },
                identityPlugins: {
                  "managed-identity-plugin": makeStaticIdentityPlugin("managed-identity-plugin"),
                },
                egressProfiles: {
                  "managed-egress": {
                    allocationMode: "static",
                    pluginId: "managed-egress-plugin",
                    profileId: "managed-egress",
                    poolId: "managed-pool",
                    routePolicyId: "managed-policy",
                    routeKind: "managed-direct",
                    routeKey: "managed-egress",
                    routeConfig: {
                      kind: "managed-direct",
                    },
                    requestHeaders: {},
                    warnings: [],
                  },
                },
                identityProfiles: {
                  "managed-identity": {
                    allocationMode: "static",
                    pluginId: "managed-identity-plugin",
                    profileId: "managed-identity",
                    tenantId: "managed-tenant",
                    browserRuntimeProfileId: "patchright-default",
                    browserUserAgent: "managed-browser-agent",
                    locale: undefined,
                    timezoneId: undefined,
                    warnings: [],
                  },
                },
              },
            ],
          }),
        ),
      ),
  );

  it.effect(
    "provideSdkRuntime rehydrates allocation registries from overridden lease manager services",
    () =>
      provideSdkRuntime(
        Effect.gen(function* () {
          const egressBroker = yield* EgressBroker;
          const identityBroker = yield* IdentityBroker;
          const plan = {
            targetUrl: "https://example.com/leased-runtime-selection",
            targetDomain: "example.com",
            providerId: "browser-basic" as const,
            mode: "browser" as const,
            timeoutMs: 500,
            egress: {
              allocationMode: "leased" as const,
              pluginId: "builtin-leased-egress",
              profileId: "leased-direct",
              poolId: "leased-direct-pool",
              routePolicyId: "leased-direct-route",
              routeKind: "direct" as const,
              routeKey: "leased-direct",
              requestHeaders: {},
              warnings: [],
            },
            identity: {
              allocationMode: "leased" as const,
              pluginId: "builtin-leased-identity",
              profileId: "leased-default",
              tenantId: "tenant-a",
              browserRuntimeProfileId: "patchright-default",
              httpUserAgent: "effect-scrapling/0.0.1",
              browserUserAgent: "browser-agent",
              locale: undefined,
              timezoneId: undefined,
              warnings: [],
            },
            browser: {
              runtimeProfileId: "patchright-default",
              waitUntil: "commit" as const,
              timeoutMs: 500,
            },
            warnings: [],
          };

          const egressLease = yield* egressBroker.acquire({
            url: plan.targetUrl,
            plan,
          });
          const identityLease = yield* identityBroker.acquire({
            url: plan.targetUrl,
            plan,
          });

          expect(egressLease.leaseId).toBe("override-egress-lease");
          expect(identityLease.leaseId).toBe("override-identity-lease");
        }),
        Layer.mergeAll(
          Layer.succeed(EgressLeaseManagerService, {
            acquire: (_input: unknown) =>
              Effect.succeed({
                id: "override-egress-lease",
                egressKey: "override-egress-key",
              }),
            release: (_leaseId: unknown) => Effect.succeed(undefined),
          }),
          Layer.succeed(IdentityLeaseManagerService, {
            acquire: (_input: unknown) =>
              Effect.succeed({
                id: "override-identity-lease",
                identityKey: "override-identity-key",
              }),
            release: (_leaseId: unknown) => Effect.succeed(undefined),
          }),
        ),
      ),
  );

  it.effect(
    "provideSdkRuntime rehydrates selection policy from an overridden selection strategy",
    () =>
      provideSdkRuntime(
        Effect.gen(function* () {
          const selectionPolicy = yield* AccessSelectionPolicy;
          const selection = yield* selectionPolicy.resolveSelection({
            url: "https://example.com/strategy-runtime-selection",
            defaultProviderId: "managed-browser",
            execution: {
              mode: "browser",
            },
          });

          expect(selection.providerId).toBe("browser-basic");
        }),
        Layer.mergeAll(
          Layer.succeed(AccessProviderRegistry, {
            resolve: (providerId) =>
              Effect.succeed({
                id: providerId,
                capabilities: {
                  mode: "browser",
                  rendersDom: true,
                },
                execute: () =>
                  Effect.die(
                    new Error("Execution should not run during selection-policy resolution test"),
                  ),
              }),
            findDescriptor: (providerId) =>
              Effect.succeed({
                id: providerId,
                capabilities: {
                  mode: "browser",
                  rendersDom: true,
                },
              }),
            listDescriptors: () =>
              Effect.succeed([
                {
                  id: "managed-browser",
                  capabilities: {
                    mode: "browser",
                    rendersDom: true,
                  },
                },
                {
                  id: "browser-basic",
                  capabilities: {
                    mode: "browser",
                    rendersDom: true,
                  },
                },
              ]),
          }),
          Layer.succeed(AccessSelectionStrategy, {
            selectCandidate: () =>
              Effect.succeed({
                providerId: "browser-basic",
                rationale: "custom",
              }),
          }),
        ),
      ),
  );

  it.effect("provideSdkRuntime lets override layers depend on the default SDK runtime", () =>
    provideSdkRuntime(
      Effect.gen(function* () {
        const selectionPolicy = yield* AccessSelectionPolicy;
        const selection = yield* selectionPolicy.resolveSelection({
          url: "https://example.com/dependent-override-selection",
          defaultProviderId: "http-basic",
          execution: {
            mode: "browser",
          },
        });

        expect(selection.providerId).toBe("browser-basic");
      }),
      AccessSelectionPolicyLive.pipe(
        Layer.provide(
          Layer.succeed(AccessSelectionStrategy, {
            selectCandidate: () =>
              Effect.succeed({
                providerId: "browser-basic",
                rationale: "custom",
              }),
          }),
        ),
      ),
    ),
  );

  it.effect("makeSdkRuntimeHandle shares runtime state across separate provide calls", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* makeSdkRuntimeHandle();

        yield* handle.provideRuntime(
          Effect.gen(function* () {
            const gateway = yield* AccessHealthGateway;
            return yield* gateway.recordFailure(
              {
                url: "https://example.com/handle-shared-health",
                context: {
                  targetUrl: "https://example.com/handle-shared-health",
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
                    egressKey: "direct",
                    release: Effect.void,
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
                    identityKey: "default",
                    release: Effect.void,
                  },
                  http: {
                    userAgent: "effect-scrapling/0.0.1",
                  },
                  warnings: [],
                },
              },
              {
                _tag: "NetworkError",
                message: "Access failed",
              },
            );
          }),
        );

        const signals = yield* handle.provideEnvironment(
          Effect.gen(function* () {
            const healthSignals = yield* AccessSelectionHealthSignalsGateway;
            return yield* healthSignals.inspect({
              url: "https://example.com/handle-shared-health",
              providerIds: ["http-basic"],
            });
          }),
        );

        expect(signals.providers["http-basic"]?.failureCount).toBe(1);
      }),
    ),
  );
});
