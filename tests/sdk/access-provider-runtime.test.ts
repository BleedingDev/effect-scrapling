import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Exit } from "effect";
import { BrowserRuntime } from "../../src/sdk/browser-pool.ts";
import {
  AccessProviderRegistry,
  AccessProviderRegistryLive,
} from "../../src/sdk/access-provider-runtime.ts";
import { BrowserError, InvalidInputError, NetworkError } from "../../src/sdk/errors.ts";
import { FetchService } from "../../src/sdk/fetch-service.ts";

describe("sdk access provider runtime", () => {
  it.effect("wires browser providers through the injected BrowserRuntime service", () =>
    Effect.suspend(() => {
      let runtimeProfileId = "";
      let poolKey = "";
      let userAgent = "";

      return Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("browser-basic");
        const result = yield* provider.execute({
          url: "https://example.com/browser-runtime-plugin",
          context: {
            targetUrl: "https://example.com/browser-runtime-plugin",
            targetDomain: "example.com",
            providerId: "browser-basic",
            mode: "browser",
            timeoutMs: 900,
            egress: {
              allocationMode: "static",
              pluginId: "test-egress",
              profileId: "direct",
              poolId: "direct-pool",
              routePolicyId: "direct-route",
              routeKind: "direct",
              routeKey: "direct",
              egressKey: "direct",
              requestHeaders: {},
              warnings: [],
              release: Effect.void,
            },
            identity: {
              allocationMode: "static",
              pluginId: "test-identity",
              profileId: "persona-a",
              tenantId: "tenant-a",
              identityKey: "identity-a",
              browserRuntimeProfileId: "patchright-default",
              browserUserAgent: "Identity Agent",
              warnings: [],
              release: Effect.void,
            },
            browser: {
              runtimeProfileId: "patchright-default",
              waitUntil: "commit",
              timeoutMs: 900,
              userAgent: "Browser Agent",
              poolKey: "browser-basic::patchright-default::direct::identity-a",
            },
            warnings: ["context warning"],
          },
        });

        expect(runtimeProfileId).toBe("patchright-default");
        expect(poolKey).toBe("browser-basic::patchright-default::direct::identity-a");
        expect(userAgent).toBe("Browser Agent");
        expect(result.status).toBe(200);
        expect(result.finalUrl).toBe("https://example.com/browser-runtime-plugin");
        expect(result.contentLength).toBeGreaterThan(0);
      }).pipe(
        Effect.provide(AccessProviderRegistryLive),
        Effect.provideService(BrowserRuntime, {
          readPoolLimits: () => ({
            maxContexts: 1,
            maxPages: 1,
            maxQueue: 1,
          }),
          withPage: (options, use) => {
            runtimeProfileId = options.runtimeProfileId;
            poolKey = options.poolKey ?? "";
            userAgent = options.userAgent;

            return use({
              goto: async () => ({
                status: () => 200,
                allHeaders: async () => ({
                  "content-type": "text/html; charset=utf-8",
                }),
                request: () => ({
                  url: () => "https://example.com/browser-runtime-plugin",
                  redirectedFrom: () => null,
                }),
              }),
              content: async () =>
                "<html><head><title>Browser Runtime</title></head><body>ok</body></html>",
              url: () => "https://example.com/browser-runtime-plugin",
              waitForLoadState: async () => undefined,
              route: async () => undefined,
              close: async () => undefined,
            }).pipe(
              Effect.map((value) => ({
                value,
                warnings: ["runtime warning"],
              })),
            );
          },
          getSnapshot: () =>
            Effect.succeed({
              limits: {
                maxContexts: 1,
                maxPages: 1,
                maxQueue: 1,
              },
              activeContexts: 0,
              activePages: 0,
              queuedRequests: 0,
              maxObservedActiveContexts: 0,
              maxObservedActivePages: 0,
              maxObservedQueuedRequests: 0,
            }),
          setTestConfig: () => Effect.void,
          close: () => Effect.void,
          resetForTests: () => Effect.void,
        }),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
      ) as Effect.Effect<void, InvalidInputError | NetworkError | BrowserError, never>;
    }),
  );

  it.effect("does not redundantly wait for load state after goto already satisfied it", () =>
    Effect.suspend(() => {
      let waitForLoadStateCalls = 0;

      return Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("browser-basic");
        const result = yield* provider.execute({
          url: "https://example.com/browser-runtime-load-state",
          context: {
            targetUrl: "https://example.com/browser-runtime-load-state",
            targetDomain: "example.com",
            providerId: "browser-basic",
            mode: "browser",
            timeoutMs: 900,
            egress: {
              allocationMode: "static",
              pluginId: "test-egress",
              profileId: "direct",
              poolId: "direct-pool",
              routePolicyId: "direct-route",
              routeKind: "direct",
              routeKey: "direct",
              egressKey: "direct",
              requestHeaders: {},
              warnings: [],
              release: Effect.void,
            },
            identity: {
              allocationMode: "static",
              pluginId: "test-identity",
              profileId: "persona-a",
              tenantId: "tenant-a",
              identityKey: "identity-a",
              browserRuntimeProfileId: "patchright-default",
              browserUserAgent: "Identity Agent",
              warnings: [],
              release: Effect.void,
            },
            browser: {
              runtimeProfileId: "patchright-default",
              waitUntil: "domcontentloaded",
              timeoutMs: 900,
              userAgent: "Browser Agent",
              poolKey: "browser-basic::patchright-default::direct::identity-a",
            },
            warnings: [],
          },
        });

        expect(result.status).toBe(200);
        expect(waitForLoadStateCalls).toBe(0);
      }).pipe(
        Effect.provide(AccessProviderRegistryLive),
        Effect.provideService(BrowserRuntime, {
          readPoolLimits: () => ({
            maxContexts: 1,
            maxPages: 1,
            maxQueue: 1,
          }),
          withPage: (_options, use) =>
            use({
              goto: async () => ({
                status: () => 200,
                allHeaders: async () => ({
                  "content-type": "text/html; charset=utf-8",
                }),
                request: () => ({
                  url: () => "https://example.com/browser-runtime-load-state",
                  redirectedFrom: () => null,
                }),
              }),
              content: async () =>
                "<html><head><title>Browser Runtime</title></head><body>ok</body></html>",
              url: () => "https://example.com/browser-runtime-load-state",
              waitForLoadState: async () => {
                waitForLoadStateCalls += 1;
              },
              route: async () => undefined,
              close: async () => undefined,
            }).pipe(Effect.map((value) => ({ value, warnings: [] }))),
          getSnapshot: () =>
            Effect.succeed({
              limits: {
                maxContexts: 1,
                maxPages: 1,
                maxQueue: 1,
              },
              activeContexts: 0,
              activePages: 0,
              queuedRequests: 0,
              maxObservedActiveContexts: 0,
              maxObservedActivePages: 0,
              maxObservedQueuedRequests: 0,
            }),
          setTestConfig: () => Effect.void,
          close: () => Effect.void,
          resetForTests: () => Effect.void,
        }),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
      ) as Effect.Effect<void, InvalidInputError | NetworkError | BrowserError, never>;
    }),
  );

  it.effect(
    "fails browser providers with a hard timeout when the browser runtime never resolves",
    () =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("browser-basic");
          const failure = yield* provider
            .execute({
              url: "https://example.com/browser-runtime-timeout",
              context: {
                targetUrl: "https://example.com/browser-runtime-timeout",
                targetDomain: "example.com",
                providerId: "browser-basic",
                mode: "browser",
                timeoutMs: 25,
                egress: {
                  allocationMode: "static",
                  pluginId: "test-egress",
                  profileId: "direct",
                  poolId: "direct-pool",
                  routePolicyId: "direct-route",
                  routeKind: "direct",
                  routeKey: "direct",
                  egressKey: "direct",
                  requestHeaders: {},
                  warnings: [],
                  release: Effect.void,
                },
                identity: {
                  allocationMode: "static",
                  pluginId: "test-identity",
                  profileId: "persona-a",
                  tenantId: "tenant-a",
                  identityKey: "identity-a",
                  browserRuntimeProfileId: "patchright-default",
                  browserUserAgent: "Identity Agent",
                  warnings: [],
                  release: Effect.void,
                },
                browser: {
                  runtimeProfileId: "patchright-default",
                  waitUntil: "domcontentloaded",
                  timeoutMs: 25,
                  userAgent: "Browser Agent",
                  poolKey: "browser-basic::patchright-default::direct::identity-a",
                },
                warnings: [],
              },
            })
            .pipe(Effect.flip);

          expect(failure._tag).toBe("BrowserError");
          expect(failure.message).toBe(
            "Browser access failed for https://example.com/browser-runtime-timeout",
          );
          expect(failure.details).toContain("hard timeout");
          expect(failure.details).toContain("browserTimeoutMs=25");
        }).pipe(
          Effect.provide(AccessProviderRegistryLive),
          Effect.provideService(BrowserRuntime, {
            readPoolLimits: () => ({
              maxContexts: 1,
              maxPages: 1,
              maxQueue: 1,
            }),
            withPage: () => Effect.never,
            getSnapshot: () =>
              Effect.succeed({
                limits: {
                  maxContexts: 1,
                  maxPages: 1,
                  maxQueue: 1,
                },
                activeContexts: 0,
                activePages: 0,
                queuedRequests: 0,
                maxObservedActiveContexts: 0,
                maxObservedActivePages: 0,
                maxObservedQueuedRequests: 0,
              }),
            setTestConfig: () => Effect.void,
            close: () => Effect.void,
            resetForTests: () => Effect.void,
          }),
          Effect.provideService(FetchService, {
            fetch: globalThis.fetch,
          }),
        ),
      ),
  );

  it.effect("preserves recovered allocation warnings when a browser hard timeout fires", () =>
    Effect.suspend(() =>
      Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("browser-basic");
        const failure = yield* provider
          .execute({
            url: "https://example.com/browser-runtime-timeout-with-warning",
            context: {
              targetUrl: "https://example.com/browser-runtime-timeout-with-warning",
              targetDomain: "example.com",
              providerId: "browser-basic",
              mode: "browser",
              timeoutMs: 25,
              egress: {
                allocationMode: "static",
                pluginId: "test-egress",
                profileId: "direct",
                poolId: "direct-pool",
                routePolicyId: "direct-route",
                routeKind: "direct",
                routeKey: "direct",
                egressKey: "direct",
                requestHeaders: {},
                warnings: [],
                release: Effect.void,
              },
              identity: {
                allocationMode: "static",
                pluginId: "test-identity",
                profileId: "persona-a",
                tenantId: "tenant-a",
                identityKey: "identity-a",
                browserRuntimeProfileId: "patchright-default",
                browserUserAgent: "Identity Agent",
                warnings: [],
                release: Effect.void,
              },
              browser: {
                runtimeProfileId: "patchright-default",
                waitUntil: "domcontentloaded",
                timeoutMs: 25,
                userAgent: "Browser Agent",
                poolKey: "browser-basic::patchright-default::direct::identity-a",
              },
              warnings: [],
            },
          })
          .pipe(Effect.flip);

        expect(failure._tag).toBe("BrowserError");
        if (failure._tag !== "BrowserError") {
          throw new Error(`Expected BrowserError, received ${failure._tag}`);
        }

        expect(failure.details).toContain("hard timeout");
        expect(failure.warnings).toContain(
          "Recovered browser allocation after retryable protocol error: Protocol error (Page.enable): Internal server error, session closed.",
        );
      }).pipe(
        Effect.provide(AccessProviderRegistryLive),
        Effect.provideService(BrowserRuntime, {
          readPoolLimits: () => ({
            maxContexts: 1,
            maxPages: 1,
            maxQueue: 1,
          }),
          withPage: (_options, use) =>
            use(
              {
                route: async () => undefined,
                goto: async () => new Promise(() => undefined),
              } as never,
              [
                "Recovered browser allocation after retryable protocol error: Protocol error (Page.enable): Internal server error, session closed.",
              ],
            ).pipe(Effect.map((value) => ({ value, warnings: [] }))),
          getSnapshot: () =>
            Effect.succeed({
              limits: {
                maxContexts: 1,
                maxPages: 1,
                maxQueue: 1,
              },
              activeContexts: 0,
              activePages: 0,
              queuedRequests: 0,
              maxObservedActiveContexts: 0,
              maxObservedActivePages: 0,
              maxObservedQueuedRequests: 0,
            }),
          setTestConfig: () => Effect.void,
          close: () => Effect.void,
          resetForTests: () => Effect.void,
        }),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
      ),
    ),
  );

  it.effect("includes the active browser stage in hard-timeout details", () =>
    Effect.suspend(() =>
      Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("browser-basic");
        const failure = yield* provider
          .execute({
            url: "https://example.com/browser-navigation-timeout",
            context: {
              targetUrl: "https://example.com/browser-navigation-timeout",
              targetDomain: "example.com",
              providerId: "browser-basic",
              mode: "browser",
              timeoutMs: 25,
              egress: {
                allocationMode: "static",
                pluginId: "test-egress",
                profileId: "direct",
                poolId: "direct-pool",
                routePolicyId: "direct-route",
                routeKind: "direct",
                routeKey: "direct",
                egressKey: "direct",
                requestHeaders: {},
                warnings: [],
                release: Effect.void,
              },
              identity: {
                allocationMode: "static",
                pluginId: "test-identity",
                profileId: "persona-a",
                tenantId: "tenant-a",
                identityKey: "identity-a",
                browserRuntimeProfileId: "patchright-default",
                browserUserAgent: "Identity Agent",
                warnings: [],
                release: Effect.void,
              },
              browser: {
                runtimeProfileId: "patchright-default",
                waitUntil: "domcontentloaded",
                timeoutMs: 25,
                userAgent: "Browser Agent",
                poolKey: "browser-basic::patchright-default::direct::identity-a",
              },
              warnings: [],
            },
          })
          .pipe(Effect.flip);

        expect(failure._tag).toBe("BrowserError");
        expect(failure.details).toContain("hard timeout");
        expect(failure.details).toContain("stage=navigation");
      }).pipe(
        Effect.provide(AccessProviderRegistryLive),
        Effect.provideService(BrowserRuntime, {
          readPoolLimits: () => ({
            maxContexts: 1,
            maxPages: 1,
            maxQueue: 1,
          }),
          withPage: (_options, use) =>
            use({
              route: async () => {},
              goto: async () => new Promise(() => undefined),
            } as never).pipe(Effect.map((value) => ({ value, warnings: [] }))),
          getSnapshot: () =>
            Effect.succeed({
              limits: {
                maxContexts: 1,
                maxPages: 1,
                maxQueue: 1,
              },
              activeContexts: 0,
              activePages: 0,
              queuedRequests: 0,
              maxObservedActiveContexts: 0,
              maxObservedActivePages: 0,
              maxObservedQueuedRequests: 0,
            }),
          setTestConfig: () => Effect.void,
          close: () => Effect.void,
          resetForTests: () => Effect.void,
        }),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
      ),
    ),
  );

  it.effect("annotates browser provider failures with the operation stage in details", () =>
    Effect.suspend(() =>
      Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("browser-basic");
        const failure = yield* provider
          .execute({
            url: "https://example.com/browser-stage-failure",
            context: {
              targetUrl: "https://example.com/browser-stage-failure",
              targetDomain: "example.com",
              providerId: "browser-basic",
              mode: "browser",
              timeoutMs: 25,
              egress: {
                allocationMode: "static",
                pluginId: "test-egress",
                profileId: "direct",
                poolId: "direct-pool",
                routePolicyId: "direct-route",
                routeKind: "direct",
                routeKey: "direct",
                egressKey: "direct",
                requestHeaders: {},
                warnings: [],
                release: Effect.void,
              },
              identity: {
                allocationMode: "static",
                pluginId: "test-identity",
                profileId: "persona-a",
                tenantId: "tenant-a",
                identityKey: "identity-a",
                browserRuntimeProfileId: "patchright-default",
                browserUserAgent: "Identity Agent",
                warnings: [],
                release: Effect.void,
              },
              browser: {
                runtimeProfileId: "patchright-default",
                waitUntil: "domcontentloaded",
                timeoutMs: 25,
                userAgent: "Browser Agent",
                poolKey: "browser-basic::patchright-default::direct::identity-a",
              },
              warnings: [],
            },
          })
          .pipe(Effect.flip);

        expect(failure._tag).toBe("BrowserError");
        expect(failure.details).toContain("navigation:");
        expect(failure.details).toContain("net::ERR_NAME_NOT_RESOLVED");
      }).pipe(
        Effect.provide(AccessProviderRegistryLive),
        Effect.provideService(BrowserRuntime, {
          readPoolLimits: () => ({
            maxContexts: 1,
            maxPages: 1,
            maxQueue: 1,
          }),
          withPage: (_options, use) =>
            use({
              route: async () => {},
              goto: async () => {
                throw new Error("net::ERR_NAME_NOT_RESOLVED");
              },
            } as never).pipe(Effect.map((value) => ({ value, warnings: [] }))),
          getSnapshot: () =>
            Effect.succeed({
              limits: {
                maxContexts: 1,
                maxPages: 1,
                maxQueue: 1,
              },
              activeContexts: 0,
              activePages: 0,
              queuedRequests: 0,
              maxObservedActiveContexts: 0,
              maxObservedActivePages: 0,
              maxObservedQueuedRequests: 0,
            }),
          setTestConfig: () => Effect.void,
          close: () => Effect.void,
          resetForTests: () => Effect.void,
        }),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
      ),
    ),
  );

  it.effect("annotates route-registration failures with the operation stage in details", () =>
    Effect.suspend(() =>
      Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("browser-basic");
        const failure = yield* provider
          .execute({
            url: "https://example.com/browser-route-registration-failure",
            context: {
              targetUrl: "https://example.com/browser-route-registration-failure",
              targetDomain: "example.com",
              providerId: "browser-basic",
              mode: "browser",
              timeoutMs: 25,
              egress: {
                allocationMode: "static",
                pluginId: "test-egress",
                profileId: "direct",
                poolId: "direct-pool",
                routePolicyId: "direct-route",
                routeKind: "direct",
                routeKey: "direct",
                egressKey: "direct",
                requestHeaders: {},
                warnings: [],
                release: Effect.void,
              },
              identity: {
                allocationMode: "static",
                pluginId: "test-identity",
                profileId: "persona-a",
                tenantId: "tenant-a",
                identityKey: "identity-a",
                browserRuntimeProfileId: "patchright-default",
                browserUserAgent: "Identity Agent",
                warnings: [],
                release: Effect.void,
              },
              browser: {
                runtimeProfileId: "patchright-default",
                waitUntil: "domcontentloaded",
                timeoutMs: 25,
                userAgent: "Browser Agent",
                poolKey: "browser-basic::patchright-default::direct::identity-a",
              },
              warnings: [],
            },
          })
          .pipe(Effect.flip);

        expect(failure._tag).toBe("BrowserError");
        expect(failure.details).toContain("route-registration:");
        expect(failure.details).toContain("route-boom");
      }).pipe(
        Effect.provide(AccessProviderRegistryLive),
        Effect.provideService(BrowserRuntime, {
          readPoolLimits: () => ({
            maxContexts: 1,
            maxPages: 1,
            maxQueue: 1,
          }),
          withPage: (_options, use) =>
            use({
              route: async () => {
                throw new Error("route-boom");
              },
            } as never).pipe(Effect.map((value) => ({ value, warnings: [] }))),
          getSnapshot: () =>
            Effect.succeed({
              limits: {
                maxContexts: 1,
                maxPages: 1,
                maxQueue: 1,
              },
              activeContexts: 0,
              activePages: 0,
              queuedRequests: 0,
              maxObservedActiveContexts: 0,
              maxObservedActivePages: 0,
              maxObservedQueuedRequests: 0,
            }),
          setTestConfig: () => Effect.void,
          close: () => Effect.void,
          resetForTests: () => Effect.void,
        }),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
      ),
    ),
  );

  it.effect("annotates dom-read and header-read failures with the operation stage in details", () =>
    Effect.suspend(() =>
      Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("browser-basic");

        const domReadFailure = yield* provider
          .execute({
            url: "https://example.com/browser-dom-read-failure",
            context: {
              targetUrl: "https://example.com/browser-dom-read-failure",
              targetDomain: "example.com",
              providerId: "browser-basic",
              mode: "browser",
              timeoutMs: 25,
              egress: {
                allocationMode: "static",
                pluginId: "test-egress",
                profileId: "direct",
                poolId: "direct-pool",
                routePolicyId: "direct-route",
                routeKind: "direct",
                routeKey: "direct",
                egressKey: "direct",
                requestHeaders: {},
                warnings: [],
                release: Effect.void,
              },
              identity: {
                allocationMode: "static",
                pluginId: "test-identity",
                profileId: "persona-a",
                tenantId: "tenant-a",
                identityKey: "identity-a",
                browserRuntimeProfileId: "patchright-default",
                browserUserAgent: "Identity Agent",
                warnings: [],
                release: Effect.void,
              },
              browser: {
                runtimeProfileId: "patchright-default",
                waitUntil: "domcontentloaded",
                timeoutMs: 25,
                userAgent: "Browser Agent",
                poolKey: "browser-basic::patchright-default::direct::identity-a",
              },
              warnings: [],
            },
          })
          .pipe(Effect.flip);

        expect(domReadFailure._tag).toBe("BrowserError");
        expect(domReadFailure.details).toContain("dom-read:");

        const headerReadFailure = yield* provider
          .execute({
            url: "https://example.com/browser-header-read-failure",
            context: {
              targetUrl: "https://example.com/browser-header-read-failure",
              targetDomain: "example.com",
              providerId: "browser-basic",
              mode: "browser",
              timeoutMs: 25,
              egress: {
                allocationMode: "static",
                pluginId: "test-egress",
                profileId: "direct",
                poolId: "direct-pool",
                routePolicyId: "direct-route",
                routeKind: "direct",
                routeKey: "direct",
                egressKey: "direct",
                requestHeaders: {},
                warnings: [],
                release: Effect.void,
              },
              identity: {
                allocationMode: "static",
                pluginId: "test-identity",
                profileId: "persona-a",
                tenantId: "tenant-a",
                identityKey: "identity-a",
                browserRuntimeProfileId: "patchright-default",
                browserUserAgent: "Identity Agent",
                warnings: [],
                release: Effect.void,
              },
              browser: {
                runtimeProfileId: "patchright-default",
                waitUntil: "domcontentloaded",
                timeoutMs: 25,
                userAgent: "Browser Agent",
                poolKey: "browser-basic::patchright-default::direct::identity-a",
              },
              warnings: [],
            },
          })
          .pipe(Effect.flip);

        expect(headerReadFailure._tag).toBe("BrowserError");
        expect(headerReadFailure.details).toContain("header-read:");
      }).pipe(
        Effect.provide(AccessProviderRegistryLive),
        Effect.provideService(BrowserRuntime, {
          readPoolLimits: () => ({
            maxContexts: 1,
            maxPages: 1,
            maxQueue: 1,
          }),
          withPage: (_options, use) => {
            let lastGotoUrl = "";

            return use({
              route: async () => {},
              goto: async (url: string) => {
                lastGotoUrl = String(url);
                return {
                  status: () => 200,
                  allHeaders: async () => {
                    if (lastGotoUrl.includes("header-read")) {
                      throw new Error("header-boom");
                    }
                    return {
                      "content-type": "text/html; charset=utf-8",
                    };
                  },
                  request: () => ({
                    redirectedFrom: () => null,
                  }),
                };
              },
              content: async () => {
                if (lastGotoUrl.includes("dom-read")) {
                  throw new Error("dom-boom");
                }
                return "<html><body>ok</body></html>";
              },
              url: () => lastGotoUrl,
            } as never).pipe(Effect.map((value) => ({ value, warnings: [] })));
          },
          getSnapshot: () =>
            Effect.succeed({
              limits: {
                maxContexts: 1,
                maxPages: 1,
                maxQueue: 1,
              },
              activeContexts: 0,
              activePages: 0,
              queuedRequests: 0,
              maxObservedActiveContexts: 0,
              maxObservedActivePages: 0,
              maxObservedQueuedRequests: 0,
            }),
          setTestConfig: () => Effect.void,
          close: () => Effect.void,
          resetForTests: () => Effect.void,
        }),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
      ),
    ),
  );

  it.effect("preserves browser runtime defects instead of misreporting them as hard timeouts", () =>
    Effect.suspend(() =>
      Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("browser-basic");
        const exit = yield* Effect.exit(
          provider.execute({
            url: "https://example.com/browser-runtime-defect",
            context: {
              targetUrl: "https://example.com/browser-runtime-defect",
              targetDomain: "example.com",
              providerId: "browser-basic",
              mode: "browser",
              timeoutMs: 25,
              egress: {
                allocationMode: "static",
                pluginId: "test-egress",
                profileId: "direct",
                poolId: "direct-pool",
                routePolicyId: "direct-route",
                routeKind: "direct",
                routeKey: "direct",
                egressKey: "direct",
                requestHeaders: {},
                warnings: [],
                release: Effect.void,
              },
              identity: {
                allocationMode: "static",
                pluginId: "test-identity",
                profileId: "persona-a",
                tenantId: "tenant-a",
                identityKey: "identity-a",
                browserRuntimeProfileId: "patchright-default",
                browserUserAgent: "Identity Agent",
                warnings: [],
                release: Effect.void,
              },
              browser: {
                runtimeProfileId: "patchright-default",
                waitUntil: "domcontentloaded",
                timeoutMs: 25,
                userAgent: "Browser Agent",
                poolKey: "browser-basic::patchright-default::direct::identity-a",
              },
              warnings: [],
            },
          }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("boom");
          expect(String(exit.cause)).not.toContain("hard timeout");
        }
      }).pipe(
        Effect.provide(AccessProviderRegistryLive),
        Effect.provideService(BrowserRuntime, {
          readPoolLimits: () => ({
            maxContexts: 1,
            maxPages: 1,
            maxQueue: 1,
          }),
          withPage: () => Effect.die(new Error("boom")),
          getSnapshot: () =>
            Effect.succeed({
              limits: {
                maxContexts: 1,
                maxPages: 1,
                maxQueue: 1,
              },
              activeContexts: 0,
              activePages: 0,
              queuedRequests: 0,
              maxObservedActiveContexts: 0,
              maxObservedActivePages: 0,
              maxObservedQueuedRequests: 0,
            }),
          setTestConfig: () => Effect.void,
          close: () => Effect.void,
          resetForTests: () => Effect.void,
        }),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
      ),
    ),
  );

  it.effect(
    "returns HTTP 403 challenge pages with wall warnings instead of throwing them away",
    () =>
      Effect.suspend(
        () =>
          Effect.gen(function* () {
            const registry = yield* AccessProviderRegistry;
            const provider = yield* registry.resolve("http-basic");
            const result = yield* provider.execute({
              url: "https://example.com/products/sku-1",
              context: {
                targetUrl: "https://example.com/products/sku-1",
                targetDomain: "example.com",
                providerId: "http-basic",
                mode: "http",
                timeoutMs: 900,
                egress: {
                  allocationMode: "static",
                  pluginId: "test-egress",
                  profileId: "direct",
                  poolId: "direct-pool",
                  routePolicyId: "direct-route",
                  routeKind: "direct",
                  routeKey: "direct",
                  egressKey: "direct",
                  requestHeaders: {},
                  warnings: [],
                  release: Effect.void,
                },
                identity: {
                  allocationMode: "static",
                  pluginId: "test-identity",
                  profileId: "persona-a",
                  tenantId: "tenant-a",
                  identityKey: "identity-a",
                  browserRuntimeProfileId: "patchright-default",
                  httpUserAgent: "HTTP Agent",
                  browserUserAgent: "Browser Agent",
                  warnings: [],
                  release: Effect.void,
                },
                http: {
                  userAgent: "HTTP Agent",
                },
                warnings: [],
              },
            });

            expect(result.status).toBe(403);
            expect(result.finalUrl).toBe("https://example.com/products/sku-1");
            expect(result.warnings).toContain("access-wall:status-403");
            expect(result.warnings).toContain("access-wall:title-challenge");
            expect(result.warnings).toContain("access-wall:text-challenge");
          }).pipe(
            Effect.provide(AccessProviderRegistryLive),
            Effect.provideService(FetchService, {
              fetch: async () =>
                new Response(
                  "<html><head><title>Attention Required! | Security Check</title></head><body>Please verify you are human.</body></html>",
                  {
                    status: 403,
                    statusText: "Forbidden",
                    headers: {
                      "content-type": "text/html; charset=utf-8",
                    },
                  },
                ),
            }),
          ) as Effect.Effect<void, InvalidInputError | NetworkError | BrowserError, never>,
      ),
  );

  it.effect("passes proxy-aware route config into the injected fetch transport", () =>
    Effect.suspend(() => {
      let proxy:
        | string
        | {
            readonly url: string;
            readonly headers?: HeadersInit | undefined;
          }
        | undefined;

      return Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("http-basic");
        const result = yield* provider.execute({
          url: "https://example.com/products/sku-proxy",
          context: {
            targetUrl: "https://example.com/products/sku-proxy",
            targetDomain: "example.com",
            providerId: "http-basic",
            mode: "http",
            timeoutMs: 900,
            egress: {
              allocationMode: "static",
              pluginId: "builtin-http-connect-egress",
              profileId: "http-connect",
              poolId: "http-connect-pool",
              routePolicyId: "http-connect-route",
              routeKind: "http-connect",
              routeKey: "http-connect",
              routeConfig: {
                kind: "http-connect",
                proxyUrl: "http://proxy.example.test:8080",
                proxyHeaders: {
                  "Proxy-Authorization": "Bearer token",
                },
              },
              egressKey: "proxy.example.test:8080",
              requestHeaders: {},
              warnings: [],
              release: Effect.void,
            },
            identity: {
              allocationMode: "static",
              pluginId: "test-identity",
              profileId: "persona-a",
              tenantId: "tenant-a",
              identityKey: "identity-a",
              browserRuntimeProfileId: "patchright-default",
              httpUserAgent: "HTTP Agent",
              browserUserAgent: "Browser Agent",
              warnings: [],
              release: Effect.void,
            },
            http: {
              userAgent: "HTTP Agent",
            },
            warnings: [],
          },
        });

        expect(result.status).toBe(200);
        expect(proxy).toEqual({
          url: "http://proxy.example.test:8080",
          headers: {
            "Proxy-Authorization": "Bearer token",
          },
        });
      }).pipe(
        Effect.provide(AccessProviderRegistryLive),
        Effect.provideService(FetchService, {
          fetch: async (_input, init) => {
            proxy = init?.proxy;
            return new Response("<html><head><title>proxied</title></head><body>ok</body></html>", {
              status: 200,
              headers: {
                "content-type": "text/html; charset=utf-8",
              },
            });
          },
        }),
      ) as Effect.Effect<void, InvalidInputError | NetworkError | BrowserError, never>;
    }),
  );

  it.effect("passes first-class tor transport bindings into the injected fetch transport", () =>
    Effect.suspend(() => {
      let proxy:
        | string
        | {
            readonly url: string;
            readonly headers?: HeadersInit | undefined;
          }
        | undefined;

      return Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("http-basic");
        const result = yield* provider.execute({
          url: "https://example.com/products/sku-tor",
          context: {
            targetUrl: "https://example.com/products/sku-tor",
            targetDomain: "example.com",
            providerId: "http-basic",
            mode: "http",
            timeoutMs: 900,
            egress: {
              allocationMode: "static",
              pluginId: "builtin-tor-egress",
              profileId: "tor",
              poolId: "tor-pool",
              routePolicyId: "tor-route",
              routeKind: "tor",
              routeKey: "tor",
              routeConfig: {
                kind: "tor",
                proxyUrl: "socks5://127.0.0.1:9050",
              },
              transportBinding: {
                kind: "tor",
                routeKind: "tor",
                proxyUrl: "socks5://127.0.0.1:9050",
                diagnostics: {
                  routeKind: "tor",
                  routeConfigKind: "tor",
                },
              },
              egressKey: "tor-exit-a",
              requestHeaders: {},
              warnings: [],
              release: Effect.void,
            },
            identity: {
              allocationMode: "static",
              pluginId: "test-identity",
              profileId: "persona-a",
              tenantId: "tenant-a",
              identityKey: "identity-a",
              browserRuntimeProfileId: "patchright-default",
              httpUserAgent: "HTTP Agent",
              browserUserAgent: "Browser Agent",
              warnings: [],
              release: Effect.void,
            },
            http: {
              userAgent: "HTTP Agent",
            },
            warnings: [],
          },
        });

        expect(result.status).toBe(200);
        expect(proxy).toBe("socks5://127.0.0.1:9050");
      }).pipe(
        Effect.provide(AccessProviderRegistryLive),
        Effect.provideService(FetchService, {
          fetch: async (_input, init) => {
            proxy = init?.proxy;
            return new Response("<html><head><title>tor</title></head><body>ok</body></html>", {
              status: 200,
              headers: {
                "content-type": "text/html; charset=utf-8",
              },
            });
          },
        }),
      ) as Effect.Effect<void, InvalidInputError | NetworkError | BrowserError, never>;
    }),
  );

  it.effect("fails HTTP execution when a wireguard transport does not expose a proxy bridge", () =>
    Effect.suspend(
      () =>
        Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("http-basic");
          const error = yield* provider
            .execute({
              url: "https://example.com/products/sku-wireguard-missing-bridge",
              context: {
                targetUrl: "https://example.com/products/sku-wireguard-missing-bridge",
                targetDomain: "example.com",
                providerId: "http-basic",
                mode: "http",
                timeoutMs: 900,
                egress: {
                  allocationMode: "static",
                  pluginId: "builtin-wireguard-egress",
                  profileId: "wireguard",
                  poolId: "wireguard-pool",
                  routePolicyId: "wireguard-route",
                  routeKind: "wireguard",
                  routeKey: "wireguard",
                  routeConfig: {
                    kind: "wireguard",
                    endpoint: "wg://edge-a",
                  },
                  egressKey: "wg-edge-a",
                  requestHeaders: {},
                  warnings: [],
                  release: Effect.void,
                },
                identity: {
                  allocationMode: "static",
                  pluginId: "test-identity",
                  profileId: "persona-a",
                  tenantId: "tenant-a",
                  identityKey: "identity-a",
                  browserRuntimeProfileId: "patchright-default",
                  httpUserAgent: "HTTP Agent",
                  browserUserAgent: "Browser Agent",
                  warnings: [],
                  release: Effect.void,
                },
                http: {
                  userAgent: "HTTP Agent",
                },
                warnings: [],
              },
            })
            .pipe(Effect.flip);

          expect(error._tag).toBe("NetworkError");
          expect(error.details).toContain("did not expose a proxy-capable bridge");
        }).pipe(
          Effect.provide(AccessProviderRegistryLive),
          Effect.provideService(FetchService, {
            fetch: globalThis.fetch,
          }),
        ) as Effect.Effect<void, InvalidInputError | NetworkError | BrowserError, never>,
    ),
  );

  it.effect(
    "prefers activated wireguard bridge bindings over legacy route metadata for HTTP execution",
    () =>
      Effect.suspend(() => {
        let proxy:
          | string
          | {
              readonly url: string;
              readonly headers?: HeadersInit | undefined;
            }
          | undefined;

        return Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("http-basic");
          const result = yield* provider.execute({
            url: "https://example.com/products/sku-wireguard",
            context: {
              targetUrl: "https://example.com/products/sku-wireguard",
              targetDomain: "example.com",
              providerId: "http-basic",
              mode: "http",
              timeoutMs: 900,
              egress: {
                allocationMode: "static",
                pluginId: "builtin-wireguard-egress",
                profileId: "wireguard",
                poolId: "wireguard-pool",
                routePolicyId: "wireguard-route",
                routeKind: "wireguard",
                routeKey: "wireguard",
                routeConfig: {
                  kind: "wireguard",
                  endpoint: "wg://legacy-metadata-only",
                },
                transportBinding: {
                  kind: "wireguard",
                  routeKind: "wireguard",
                  endpoint: "wg://edge-a",
                  interfaceName: "wg0",
                  proxyUrl: "socks5://127.0.0.1:9050",
                  proxyHeaders: {
                    "Proxy-Authorization": "Bearer token",
                  },
                  diagnostics: {
                    routeKind: "wireguard",
                    routeConfigKind: "wireguard",
                  },
                },
                egressKey: "wg-edge-a",
                requestHeaders: {},
                warnings: [],
                release: Effect.void,
              },
              identity: {
                allocationMode: "static",
                pluginId: "test-identity",
                profileId: "persona-a",
                tenantId: "tenant-a",
                identityKey: "identity-a",
                browserRuntimeProfileId: "patchright-default",
                httpUserAgent: "HTTP Agent",
                browserUserAgent: "Browser Agent",
                warnings: [],
                release: Effect.void,
              },
              http: {
                userAgent: "HTTP Agent",
              },
              warnings: [],
            },
          });

          expect(result.status).toBe(200);
          expect(proxy).toEqual({
            url: "socks5://127.0.0.1:9050",
            headers: {
              "Proxy-Authorization": "Bearer token",
            },
          });
        }).pipe(
          Effect.provide(AccessProviderRegistryLive),
          Effect.provideService(FetchService, {
            fetch: async (_input, init) => {
              proxy = init?.proxy;
              return new Response("<html><body>proxy-ok</body></html>", {
                status: 200,
                headers: {
                  "content-type": "text/html; charset=utf-8",
                },
              });
            },
          }),
        ) as Effect.Effect<void, InvalidInputError | NetworkError | BrowserError, never>;
      }),
  );

  it.effect(
    "returns browser 429 challenge pages with wall warnings instead of throwing them away",
    () =>
      Effect.suspend(
        () =>
          Effect.gen(function* () {
            const registry = yield* AccessProviderRegistry;
            const provider = yield* registry.resolve("browser-basic");
            const result = yield* provider.execute({
              url: "https://example.com/products/sku-2",
              context: {
                targetUrl: "https://example.com/products/sku-2",
                targetDomain: "example.com",
                providerId: "browser-basic",
                mode: "browser",
                timeoutMs: 900,
                egress: {
                  allocationMode: "static",
                  pluginId: "test-egress",
                  profileId: "direct",
                  poolId: "direct-pool",
                  routePolicyId: "direct-route",
                  routeKind: "direct",
                  routeKey: "direct",
                  egressKey: "direct",
                  requestHeaders: {},
                  warnings: [],
                  release: Effect.void,
                },
                identity: {
                  allocationMode: "static",
                  pluginId: "test-identity",
                  profileId: "persona-a",
                  tenantId: "tenant-a",
                  identityKey: "identity-a",
                  browserRuntimeProfileId: "patchright-default",
                  browserUserAgent: "Browser Agent",
                  warnings: [],
                  release: Effect.void,
                },
                browser: {
                  runtimeProfileId: "patchright-default",
                  waitUntil: "commit",
                  timeoutMs: 900,
                  userAgent: "Browser Agent",
                  poolKey: "browser-basic::patchright-default::direct::identity-a",
                },
                warnings: [],
              },
            });

            expect(result.status).toBe(429);
            expect(result.finalUrl).toBe("https://example.com/challenge");
            expect(result.warnings).toContain("access-wall:status-429");
            expect(result.warnings).toContain("access-wall:title-challenge");
            expect(result.warnings).toContain("access-wall:text-challenge");
          }).pipe(
            Effect.provide(AccessProviderRegistryLive),
            Effect.provideService(BrowserRuntime, {
              readPoolLimits: () => ({
                maxContexts: 1,
                maxPages: 1,
                maxQueue: 1,
              }),
              withPage: (_options, use) =>
                use({
                  goto: async () => ({
                    status: () => 429,
                    allHeaders: async () => ({
                      "content-type": "text/html; charset=utf-8",
                    }),
                    request: () => ({
                      url: () => "https://example.com/challenge",
                      redirectedFrom: () => ({
                        url: () => "https://example.com/challenge",
                        redirectedFrom: () => null,
                      }),
                    }),
                  }),
                  content: async () =>
                    "<html><head><title>Attention Required! | Security Check</title></head><body>Checking your browser before accessing.</body></html>",
                  url: () => "https://example.com/challenge",
                  waitForLoadState: async () => undefined,
                  route: async () => undefined,
                  close: async () => undefined,
                }).pipe(
                  Effect.map((value) => ({
                    value,
                    warnings: [],
                  })),
                ),
              getSnapshot: () =>
                Effect.succeed({
                  limits: {
                    maxContexts: 1,
                    maxPages: 1,
                    maxQueue: 1,
                  },
                  activeContexts: 0,
                  activePages: 0,
                  queuedRequests: 0,
                  maxObservedActiveContexts: 0,
                  maxObservedActivePages: 0,
                  maxObservedQueuedRequests: 0,
                }),
              setTestConfig: () => Effect.void,
              close: () => Effect.void,
              resetForTests: () => Effect.void,
            }),
            Effect.provideService(FetchService, {
              fetch: globalThis.fetch,
            }),
          ) as Effect.Effect<void, InvalidInputError | NetworkError | BrowserError, never>,
      ),
  );

  it.effect("passes proxy-aware route config into the injected browser runtime", () =>
    Effect.suspend(() => {
      let proxy:
        | {
            readonly server: string;
            readonly bypass?: string | undefined;
            readonly username?: string | undefined;
            readonly password?: string | undefined;
          }
        | undefined;

      return Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("browser-basic");
        const result = yield* provider.execute({
          url: "https://example.com/browser-proxy",
          context: {
            targetUrl: "https://example.com/browser-proxy",
            targetDomain: "example.com",
            providerId: "browser-basic",
            mode: "browser",
            timeoutMs: 900,
            egress: {
              allocationMode: "static",
              pluginId: "builtin-socks5-egress",
              profileId: "socks5",
              poolId: "socks5-pool",
              routePolicyId: "socks5-route",
              routeKind: "socks5",
              routeKey: "socks5",
              routeConfig: {
                kind: "socks5",
                proxyUrl: "socks5://user:pass@127.0.0.1:9050",
                bypass: "localhost,127.0.0.1",
              },
              egressKey: "127.0.0.1:9050",
              requestHeaders: {},
              warnings: [],
              release: Effect.void,
            },
            identity: {
              allocationMode: "static",
              pluginId: "test-identity",
              profileId: "persona-a",
              tenantId: "tenant-a",
              identityKey: "identity-a",
              browserRuntimeProfileId: "patchright-default",
              browserUserAgent: "Browser Agent",
              warnings: [],
              release: Effect.void,
            },
            browser: {
              runtimeProfileId: "patchright-default",
              waitUntil: "commit",
              timeoutMs: 900,
              userAgent: "Browser Agent",
              poolKey: "browser-basic::patchright-default::127.0.0.1:9050::identity-a",
            },
            warnings: [],
          },
        });

        expect(result.status).toBe(200);
        expect(proxy).toEqual({
          server: "socks5://127.0.0.1:9050",
          username: "user",
          password: "pass",
          bypass: "localhost,127.0.0.1",
        });
      }).pipe(
        Effect.provide(AccessProviderRegistryLive),
        Effect.provideService(BrowserRuntime, {
          readPoolLimits: () => ({
            maxContexts: 1,
            maxPages: 1,
            maxQueue: 1,
          }),
          withPage: (options, use) => {
            proxy = options.proxy;

            return use({
              goto: async () => ({
                status: () => 200,
                allHeaders: async () => ({
                  "content-type": "text/html; charset=utf-8",
                }),
                request: () => ({
                  url: () => "https://example.com/browser-proxy",
                  redirectedFrom: () => null,
                }),
              }),
              content: async () =>
                "<html><head><title>Browser Runtime</title></head><body>ok</body></html>",
              url: () => "https://example.com/browser-proxy",
              waitForLoadState: async () => undefined,
              route: async () => undefined,
              close: async () => undefined,
            }).pipe(Effect.map((value) => ({ value, warnings: [] })));
          },
          getSnapshot: () =>
            Effect.succeed({
              limits: {
                maxContexts: 1,
                maxPages: 1,
                maxQueue: 1,
              },
              activeContexts: 0,
              activePages: 0,
              queuedRequests: 0,
              maxObservedActiveContexts: 0,
              maxObservedActivePages: 0,
              maxObservedQueuedRequests: 0,
            }),
          setTestConfig: () => Effect.void,
          close: () => Effect.void,
          resetForTests: () => Effect.void,
        }),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
      ) as Effect.Effect<void, InvalidInputError | NetworkError | BrowserError, never>;
    }),
  );

  it.effect("passes first-class tor transport bindings into the injected browser runtime", () =>
    Effect.suspend(() => {
      let proxy:
        | {
            readonly server: string;
            readonly bypass?: string | undefined;
            readonly username?: string | undefined;
            readonly password?: string | undefined;
          }
        | undefined;

      return Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("browser-basic");
        const result = yield* provider.execute({
          url: "https://example.com/browser-tor",
          context: {
            targetUrl: "https://example.com/browser-tor",
            targetDomain: "example.com",
            providerId: "browser-basic",
            mode: "browser",
            timeoutMs: 900,
            egress: {
              allocationMode: "static",
              pluginId: "builtin-tor-egress",
              profileId: "tor",
              poolId: "tor-pool",
              routePolicyId: "tor-route",
              routeKind: "tor",
              routeKey: "tor",
              routeConfig: {
                kind: "tor",
                proxyUrl: "socks5://127.0.0.1:9050",
                bypass: "localhost,127.0.0.1",
              },
              transportBinding: {
                kind: "tor",
                routeKind: "tor",
                proxyUrl: "socks5://127.0.0.1:9050",
                bypass: "localhost,127.0.0.1",
                diagnostics: {
                  routeKind: "tor",
                  routeConfigKind: "tor",
                },
              },
              egressKey: "tor-exit-a",
              requestHeaders: {},
              warnings: [],
              release: Effect.void,
            },
            identity: {
              allocationMode: "static",
              pluginId: "test-identity",
              profileId: "persona-a",
              tenantId: "tenant-a",
              identityKey: "identity-a",
              browserRuntimeProfileId: "patchright-default",
              browserUserAgent: "Browser Agent",
              warnings: [],
              release: Effect.void,
            },
            browser: {
              runtimeProfileId: "patchright-default",
              waitUntil: "commit",
              timeoutMs: 900,
              userAgent: "Browser Agent",
              poolKey: "browser-basic::patchright-default::tor-exit-a::identity-a",
            },
            warnings: [],
          },
        });

        expect(result.status).toBe(200);
        expect(proxy).toEqual({
          server: "socks5://127.0.0.1:9050",
          bypass: "localhost,127.0.0.1",
        });
      }).pipe(
        Effect.provide(AccessProviderRegistryLive),
        Effect.provideService(BrowserRuntime, {
          readPoolLimits: () => ({
            maxContexts: 1,
            maxPages: 1,
            maxQueue: 1,
          }),
          withPage: (options, use) => {
            proxy = options.proxy;

            return use({
              goto: async () => ({
                status: () => 200,
                allHeaders: async () => ({
                  "content-type": "text/html; charset=utf-8",
                }),
                request: () => ({
                  url: () => "https://example.com/browser-tor",
                  redirectedFrom: () => null,
                }),
              }),
              content: async () =>
                "<html><head><title>Browser Tor</title></head><body>ok</body></html>",
              url: () => "https://example.com/browser-tor",
              waitForLoadState: async () => undefined,
              route: async () => undefined,
              close: async () => undefined,
            }).pipe(Effect.map((value) => ({ value, warnings: [] })));
          },
          getSnapshot: () =>
            Effect.succeed({
              limits: {
                maxContexts: 1,
                maxPages: 1,
                maxQueue: 1,
              },
              activeContexts: 0,
              activePages: 0,
              queuedRequests: 0,
              maxObservedActiveContexts: 0,
              maxObservedActivePages: 0,
              maxObservedQueuedRequests: 0,
            }),
          setTestConfig: () => Effect.void,
          close: () => Effect.void,
          resetForTests: () => Effect.void,
        }),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
      ) as Effect.Effect<void, InvalidInputError | NetworkError | BrowserError, never>;
    }),
  );

  it.effect(
    "fails browser execution when a wireguard transport does not expose a proxy bridge",
    () =>
      Effect.suspend(
        () =>
          Effect.gen(function* () {
            const registry = yield* AccessProviderRegistry;
            const provider = yield* registry.resolve("browser-basic");
            const error = yield* provider
              .execute({
                url: "https://example.com/browser-wireguard-missing-bridge",
                context: {
                  targetUrl: "https://example.com/browser-wireguard-missing-bridge",
                  targetDomain: "example.com",
                  providerId: "browser-basic",
                  mode: "browser",
                  timeoutMs: 900,
                  egress: {
                    allocationMode: "static",
                    pluginId: "builtin-wireguard-egress",
                    profileId: "wireguard",
                    poolId: "wireguard-pool",
                    routePolicyId: "wireguard-route",
                    routeKind: "wireguard",
                    routeKey: "wireguard",
                    routeConfig: {
                      kind: "wireguard",
                      endpoint: "wg://edge-a",
                    },
                    egressKey: "wg-edge-a",
                    requestHeaders: {},
                    warnings: [],
                    release: Effect.void,
                  },
                  identity: {
                    allocationMode: "static",
                    pluginId: "test-identity",
                    profileId: "persona-a",
                    tenantId: "tenant-a",
                    identityKey: "identity-a",
                    browserRuntimeProfileId: "patchright-default",
                    browserUserAgent: "Browser Agent",
                    warnings: [],
                    release: Effect.void,
                  },
                  browser: {
                    runtimeProfileId: "patchright-default",
                    waitUntil: "commit",
                    timeoutMs: 900,
                    userAgent: "Browser Agent",
                    poolKey: "browser-basic::patchright-default::wg-edge-a::identity-a",
                  },
                  warnings: [],
                },
              })
              .pipe(Effect.flip);

            expect(error._tag).toBe("BrowserError");
            expect(error.details).toContain("did not expose a proxy-capable bridge");
          }).pipe(
            Effect.provide(AccessProviderRegistryLive),
            Effect.provideService(BrowserRuntime, {
              readPoolLimits: () => ({
                maxContexts: 1,
                maxPages: 1,
                maxQueue: 1,
              }),
              withPage: (_options, use) =>
                use({
                  goto: async () => ({
                    status: () => 200,
                    allHeaders: async () => ({
                      "content-type": "text/html; charset=utf-8",
                    }),
                    request: () => ({
                      url: () => "https://example.com/browser-wireguard-missing-bridge",
                      redirectedFrom: () => null,
                    }),
                  }),
                  content: async () =>
                    "<html><head><title>Browser Runtime</title></head><body>ok</body></html>",
                  url: () => "https://example.com/browser-wireguard-missing-bridge",
                  waitForLoadState: async () => undefined,
                  route: async () => undefined,
                  close: async () => undefined,
                }).pipe(Effect.map((value) => ({ value, warnings: [] }))),
              getSnapshot: () =>
                Effect.succeed({
                  limits: {
                    maxContexts: 1,
                    maxPages: 1,
                    maxQueue: 1,
                  },
                  activeContexts: 0,
                  activePages: 0,
                  queuedRequests: 0,
                  maxObservedActiveContexts: 0,
                  maxObservedActivePages: 0,
                  maxObservedQueuedRequests: 0,
                }),
              setTestConfig: () => Effect.void,
              close: () => Effect.void,
              resetForTests: () => Effect.void,
            }),
            Effect.provideService(FetchService, {
              fetch: globalThis.fetch,
            }),
          ) as Effect.Effect<void, InvalidInputError | NetworkError | BrowserError, never>,
      ),
  );

  it.effect("passes activated wireguard bridge bindings into the injected browser runtime", () =>
    Effect.suspend(() => {
      let proxy:
        | {
            readonly server: string;
            readonly bypass?: string | undefined;
            readonly username?: string | undefined;
            readonly password?: string | undefined;
          }
        | undefined;

      return Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("browser-basic");
        const result = yield* provider.execute({
          url: "https://example.com/browser-wireguard",
          context: {
            targetUrl: "https://example.com/browser-wireguard",
            targetDomain: "example.com",
            providerId: "browser-basic",
            mode: "browser",
            timeoutMs: 900,
            egress: {
              allocationMode: "static",
              pluginId: "builtin-wireguard-egress",
              profileId: "wireguard",
              poolId: "wireguard-pool",
              routePolicyId: "wireguard-route",
              routeKind: "wireguard",
              routeKey: "wireguard",
              routeConfig: {
                kind: "wireguard",
                endpoint: "wg://legacy-metadata-only",
              },
              transportBinding: {
                kind: "wireguard",
                routeKind: "wireguard",
                endpoint: "wg://edge-a",
                proxyUrl: "socks5://user:pass@127.0.0.1:9050",
                bypass: "localhost,127.0.0.1",
                diagnostics: {
                  routeKind: "wireguard",
                  routeConfigKind: "wireguard",
                },
              },
              egressKey: "wg-edge-a",
              requestHeaders: {},
              warnings: [],
              release: Effect.void,
            },
            identity: {
              allocationMode: "static",
              pluginId: "test-identity",
              profileId: "persona-a",
              tenantId: "tenant-a",
              identityKey: "identity-a",
              browserRuntimeProfileId: "patchright-default",
              browserUserAgent: "Browser Agent",
              warnings: [],
              release: Effect.void,
            },
            browser: {
              runtimeProfileId: "patchright-default",
              waitUntil: "commit",
              timeoutMs: 900,
              userAgent: "Browser Agent",
              poolKey: "browser-basic::patchright-default::wg-edge-a::identity-a",
            },
            warnings: [],
          },
        });

        expect(result.status).toBe(200);
        expect(proxy).toEqual({
          server: "socks5://127.0.0.1:9050",
          username: "user",
          password: "pass",
          bypass: "localhost,127.0.0.1",
        });
      }).pipe(
        Effect.provide(AccessProviderRegistryLive),
        Effect.provideService(BrowserRuntime, {
          readPoolLimits: () => ({
            maxContexts: 1,
            maxPages: 1,
            maxQueue: 1,
          }),
          withPage: (options, use) => {
            proxy = options.proxy;

            return use({
              goto: async () => ({
                status: () => 200,
                allHeaders: async () => ({
                  "content-type": "text/html; charset=utf-8",
                }),
                request: () => ({
                  url: () => "https://example.com/browser-wireguard",
                  redirectedFrom: () => null,
                }),
              }),
              content: async () =>
                "<html><head><title>Browser Runtime</title></head><body>ok</body></html>",
              url: () => "https://example.com/browser-wireguard",
              waitForLoadState: async () => undefined,
              route: async () => undefined,
              close: async () => undefined,
            }).pipe(Effect.map((value) => ({ value, warnings: [] })));
          },
          getSnapshot: () =>
            Effect.succeed({
              limits: {
                maxContexts: 1,
                maxPages: 1,
                maxQueue: 1,
              },
              activeContexts: 0,
              activePages: 0,
              queuedRequests: 0,
              maxObservedActiveContexts: 0,
              maxObservedActivePages: 0,
              maxObservedQueuedRequests: 0,
            }),
          setTestConfig: () => Effect.void,
          close: () => Effect.void,
          resetForTests: () => Effect.void,
        }),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
      ) as Effect.Effect<void, InvalidInputError | NetworkError | BrowserError, never>;
    }),
  );

  it.effect("maps malformed injected browser proxy route config to BrowserError", () =>
    Effect.suspend(
      () =>
        Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("browser-basic");
          const error = yield* provider
            .execute({
              url: "https://example.com/browser-proxy-invalid",
              context: {
                targetUrl: "https://example.com/browser-proxy-invalid",
                targetDomain: "example.com",
                providerId: "browser-basic",
                mode: "browser",
                timeoutMs: 900,
                egress: {
                  allocationMode: "static",
                  pluginId: "builtin-http-connect-egress",
                  profileId: "http-connect",
                  poolId: "http-connect-pool",
                  routePolicyId: "http-connect-route",
                  routeKind: "http-connect",
                  routeKey: "http-connect",
                  routeConfig: {
                    kind: "http-connect",
                    proxyUrl: "not-a-url",
                  },
                  egressKey: "invalid-route",
                  requestHeaders: {},
                  warnings: [],
                  release: Effect.void,
                },
                identity: {
                  allocationMode: "static",
                  pluginId: "test-identity",
                  profileId: "persona-a",
                  tenantId: "tenant-a",
                  identityKey: "identity-a",
                  browserRuntimeProfileId: "patchright-default",
                  browserUserAgent: "Browser Agent",
                  warnings: [],
                  release: Effect.void,
                },
                browser: {
                  runtimeProfileId: "patchright-default",
                  waitUntil: "commit",
                  timeoutMs: 900,
                  userAgent: "Browser Agent",
                  poolKey: "browser-basic::patchright-default::invalid-route::identity-a",
                },
                warnings: [],
              },
            })
            .pipe(
              Effect.match({
                onSuccess: () => undefined,
                onFailure: (error) => error,
              }),
            );

          expect(error?._tag).toBe("BrowserError");
          expect(error?.message).toContain("Browser access failed");
          expect(error?.details).toContain("cannot be parsed as a URL");
        }).pipe(
          Effect.provide(AccessProviderRegistryLive),
          Effect.provideService(BrowserRuntime, {
            readPoolLimits: () => ({
              maxContexts: 1,
              maxPages: 1,
              maxQueue: 1,
            }),
            withPage: () => Effect.die("withPage should not run for invalid proxy config"),
            getSnapshot: () =>
              Effect.succeed({
                limits: {
                  maxContexts: 1,
                  maxPages: 1,
                  maxQueue: 1,
                },
                activeContexts: 0,
                activePages: 0,
                queuedRequests: 0,
                maxObservedActiveContexts: 0,
                maxObservedActivePages: 0,
                maxObservedQueuedRequests: 0,
              }),
            setTestConfig: () => Effect.void,
            close: () => Effect.void,
            resetForTests: () => Effect.void,
          }),
          Effect.provideService(FetchService, {
            fetch: globalThis.fetch,
          }),
        ) as Effect.Effect<void, InvalidInputError | NetworkError | BrowserError, never>,
    ),
  );
});
