import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Exit } from "effect";
import { BrowserRuntime } from "../../src/sdk/browser-pool.ts";
import {
  AccessProviderRegistry,
  AccessProviderRegistryLive,
  makeAccessProviderRegistryLive,
  resolveBrowserHardTimeoutMs,
} from "../../src/sdk/access-provider-runtime.ts";
import { BrowserMediationRuntime } from "../../src/sdk/browser-mediation-runtime.ts";
import { BrowserError, InvalidInputError, NetworkError } from "../../src/sdk/errors.ts";
import { FetchService } from "../../src/sdk/fetch-service.ts";

type TestPatchrightRequest = {
  readonly url: () => string;
  readonly redirectedFrom: () => TestPatchrightRequest | null;
};

function makeRedirectRequest(url: string, redirectCount: number) {
  let current: TestPatchrightRequest | null = null;

  for (let index = 0; index < redirectCount; index += 1) {
    const previous: TestPatchrightRequest | null = current;
    current = {
      url: () => url,
      redirectedFrom: () => previous,
    };
  }

  return {
    url: () => url,
    redirectedFrom: () => current,
  };
}

describe("sdk access provider runtime", () => {
  it("allocates a multi-stage hard-timeout envelope for Cloudflare solver flows", () => {
    expect(
      resolveBrowserHardTimeoutMs({
        browserTimeoutMs: 25,
      }),
    ).toBe(1_025);
    expect(
      resolveBrowserHardTimeoutMs({
        browserTimeoutMs: 25,
        challengeHandling: {
          solveCloudflare: true,
        },
      }),
    ).toBe(61_000);
  });

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

  it.effect("uses an upstream-compatible Google referer for browser navigations by default", () =>
    Effect.suspend(() => {
      let receivedReferer: string | undefined;

      return Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("browser-basic");
        const result = yield* provider.execute({
          url: "https://example.com/browser-default-referer",
          context: {
            targetUrl: "https://example.com/browser-default-referer",
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
            warnings: [],
          },
        });

        expect(receivedReferer).toBe("https://www.google.com/");
        expect(result.status).toBe(200);
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
              goto: async (_url, options) => {
                receivedReferer = options.referer;
                return {
                  status: () => 200,
                  allHeaders: async () => ({
                    "content-type": "text/html; charset=utf-8",
                  }),
                  request: () => ({
                    url: () => "https://example.com/browser-default-referer",
                    redirectedFrom: () => null,
                  }),
                };
              },
              content: async () =>
                "<html><head><title>Browser Runtime</title></head><body>ok</body></html>",
              url: () => "https://example.com/browser-default-referer",
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
      ) as Effect.Effect<void, InvalidInputError | NetworkError | BrowserError, never>;
    }),
  );

  it.effect(
    "applies configured browser wait delay and selector gating before final DOM capture",
    () =>
      Effect.suspend(() => {
        const waitCalls = new Array<number>();
        let selectorReady = false;
        let domReadCount = 0;

        return Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("browser-basic");
          const result = yield* provider.execute({
            url: "https://example.com/post-navigation-wait",
            context: {
              targetUrl: "https://example.com/post-navigation-wait",
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
                waitMs: 200,
                waitSelector: "h1",
                userAgent: "Browser Agent",
                poolKey: "browser-basic::patchright-default::direct::identity-a",
              },
              warnings: [],
            },
          });

          expect(waitCalls).toContain(200);
          expect(domReadCount).toBe(2);
          expect(result.html).toContain("<h1>Final</h1>");
          expect(result.timings.postNavigationWaitDurationMs).toBeDefined();
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
                    url: () => "https://example.com/post-navigation-wait",
                    redirectedFrom: () => null,
                  }),
                }),
                content: async () => {
                  domReadCount += 1;
                  return selectorReady
                    ? "<html><head><title>Final</title></head><body><h1>Final</h1></body></html>"
                    : "<html><head><title>Initial</title></head><body><div>loading</div></body></html>";
                },
                url: () => "https://example.com/post-navigation-wait",
                waitForLoadState: async () => undefined,
                waitForTimeout: async (timeoutMs) => {
                  waitCalls.push(timeoutMs);
                  selectorReady = true;
                },
                locator: () => ({
                  last: () => ({
                    isVisible: async () => selectorReady,
                    boundingBox: async () =>
                      selectorReady
                        ? {
                            x: 10,
                            y: 10,
                            width: 50,
                            height: 20,
                          }
                        : null,
                  }),
                  isVisible: async () => selectorReady,
                  boundingBox: async () =>
                    selectorReady
                      ? {
                          x: 10,
                          y: 10,
                          width: 50,
                          height: 20,
                        }
                      : null,
                }),
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

  it.effect("treats a wait selector as ready when any matched node is visible", () =>
    Effect.suspend(() => {
      let domReadCount = 0;

      return Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("browser-basic");
        const result = yield* provider.execute({
          url: "https://example.com/post-navigation-wait-any-match",
          context: {
            targetUrl: "https://example.com/post-navigation-wait-any-match",
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
              waitSelector: "h1",
              userAgent: "Browser Agent",
              poolKey: "browser-basic::patchright-default::direct::identity-a",
            },
            warnings: [],
          },
        });

        expect(domReadCount).toBeGreaterThanOrEqual(1);
        expect(result.html).toContain("<h1>Visible</h1>");
        expect(result.timings.postNavigationWaitDurationMs).toBeDefined();
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
                  url: () => "https://example.com/post-navigation-wait-any-match",
                  redirectedFrom: () => null,
                }),
              }),
              content: async () => {
                domReadCount += 1;
                return "<html><head><title>Final</title></head><body><h1>Visible</h1><h1 hidden>Hidden</h1></body></html>";
              },
              url: () => "https://example.com/post-navigation-wait-any-match",
              waitForLoadState: async () => undefined,
              waitForTimeout: async () => undefined,
              locator: () => ({
                count: async () => 2,
                nth: (index) => ({
                  isVisible: async () => index === 0,
                  boundingBox: async () =>
                    index === 0
                      ? {
                          x: 10,
                          y: 10,
                          width: 50,
                          height: 20,
                        }
                      : null,
                }),
                last: () => ({
                  isVisible: async () => false,
                  boundingBox: async () => null,
                }),
                isVisible: async () => false,
                boundingBox: async () => null,
              }),
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

  it.effect("fails browser execution when a configured wait selector never resolves", () =>
    Effect.suspend(
      () =>
        Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("browser-basic");
          const exit = yield* provider
            .execute({
              url: "https://example.com/wait-selector-timeout",
              context: {
                targetUrl: "https://example.com/wait-selector-timeout",
                targetDomain: "example.com",
                providerId: "browser-basic",
                mode: "browser",
                timeoutMs: 300,
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
                  timeoutMs: 300,
                  waitSelector: "h1",
                  userAgent: "Browser Agent",
                  poolKey: "browser-basic::patchright-default::direct::identity-a",
                },
                warnings: [],
              },
            })
            .pipe(Effect.exit);

          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const defect = exit.cause.toJSON();
            expect(JSON.stringify(defect)).toContain("post-navigation-wait");
            expect(JSON.stringify(defect)).toContain("selector-wait-timeout:h1");
          }
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
                    url: () => "https://example.com/wait-selector-timeout",
                    redirectedFrom: () => null,
                  }),
                }),
                content: async () =>
                  "<html><head><title>Initial</title></head><body><div>loading</div></body></html>",
                url: () => "https://example.com/wait-selector-timeout",
                waitForLoadState: async () => undefined,
                waitForTimeout: async () => undefined,
                locator: () => ({
                  last: () => ({
                    isVisible: async () => false,
                    boundingBox: async () => null,
                  }),
                  isVisible: async () => false,
                  boundingBox: async () => null,
                }),
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

  it.effect(
    "refreshes browser metadata through a follow-up navigation when mediation requests metadata refresh",
    () =>
      Effect.suspend(() => {
        let gotoCount = 0;
        let domReadCount = 0;

        return Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("browser-stealth");
          const result = yield* provider.execute({
            url: "https://example.com/weak-interstitial-auto-clear",
            context: {
              targetUrl: "https://example.com/weak-interstitial-auto-clear",
              targetDomain: "example.com",
              providerId: "browser-stealth",
              mode: "browser",
              timeoutMs: 5_000,
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
                browserRuntimeProfileId: "patchright-stealth",
                browserUserAgent: "Identity Agent",
                warnings: [],
                release: Effect.void,
              },
              browser: {
                runtimeProfileId: "patchright-stealth",
                waitUntil: "domcontentloaded",
                timeoutMs: 5_000,
                userAgent: "Browser Agent",
                poolKey: "browser-stealth::patchright-stealth::direct::identity-a",
                challengeHandling: {
                  solveCloudflare: true,
                },
              },
              warnings: [],
            },
          });

          expect(result.status).toBe(200);
          expect(result.contentType).toBe("text/html; charset=utf-8");
          expect(result.html).toContain("<title>Solved</title>");
          expect(result.timings.requestCount).toBe(3);
          expect(result.timings.redirectCount).toBe(1);
          expect(result.warnings).toEqual(
            expect.arrayContaining([
              "cloudflare-solver:weak-interstitial-cleared-before-marker-detection",
              "cloudflare-solver:post-clearance-strategy:reload-target",
            ]),
          );
          expect(domReadCount).toBe(2);
          expect(gotoCount).toBe(2);
        }).pipe(
          Effect.provide(makeAccessProviderRegistryLive()),
          Effect.provideService(BrowserMediationRuntime, {
            mediate: () =>
              Effect.succeed({
                policy: {
                  mode: "solve",
                  vendors: ["cloudflare"],
                  maxAttempts: 4,
                  timeBudgetMs: 60_000,
                  postClearanceStrategy: "reload-target",
                  captureEvidence: true,
                },
                outcome: {
                  kind: "none",
                  status: "none",
                  attemptCount: 0,
                  evidence: {
                    signals: [],
                  },
                  timings: {},
                },
                followUpNavigationRequired: true,
                currentPageRefreshRequired: false,
                postClearanceStrategy: "reload-target",
                warnings: ["cloudflare-solver:weak-interstitial-cleared-before-marker-detection"],
              }),
          }),
          Effect.provideService(BrowserRuntime, {
            readPoolLimits: () => ({
              maxContexts: 1,
              maxPages: 1,
              maxQueue: 1,
            }),
            withPage: (_options, use) =>
              use({
                goto: async () => {
                  gotoCount += 1;
                  return gotoCount === 1
                    ? {
                        status: () => 403,
                        allHeaders: async () => ({
                          "content-type": "text/html; charset=us-ascii",
                        }),
                        request: () => ({
                          url: () => "https://example.com/weak-interstitial-auto-clear",
                          redirectedFrom: () => null,
                        }),
                      }
                    : {
                        status: () => 200,
                        allHeaders: async () => ({
                          "content-type": "text/html; charset=utf-8",
                        }),
                        request: () => ({
                          url: () => "https://example.com/weak-interstitial-auto-clear",
                          redirectedFrom: () => ({
                            url: () => "https://example.com/weak-interstitial-auto-clear",
                            redirectedFrom: () => null,
                          }),
                        }),
                      };
                },
                content: async () => {
                  domReadCount += 1;
                  return gotoCount === 1
                    ? "<html><head><title>Just a moment...</title></head><body>Booting challenge...</body></html>"
                    : "<html><head><title>Solved</title></head><body>ok</body></html>";
                },
                url: () => "https://example.com/weak-interstitial-auto-clear",
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
        expect(result.timings.loadStateDurationMs).toBeUndefined();
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
    "solves Cloudflare turnstile challenges before collecting the final browser response",
    () =>
      Effect.suspend(() => {
        let gotoCount = 0;
        let clickCount = 0;
        let challengeCleared = false;
        const gotoWaitUntil: Array<string> = [];
        const loadStateCalls: Array<string> = [];

        return Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("browser-stealth");
          const result = yield* provider.execute({
            url: "https://example.com/alza-like",
            context: {
              targetUrl: "https://example.com/alza-like",
              targetDomain: "example.com",
              providerId: "browser-stealth",
              mode: "browser",
              timeoutMs: 5_000,
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
                browserRuntimeProfileId: "patchright-stealth",
                browserUserAgent: "Identity Agent",
                warnings: [],
                release: Effect.void,
              },
              browser: {
                runtimeProfileId: "patchright-stealth",
                waitUntil: "domcontentloaded",
                timeoutMs: 60_000,
                userAgent: "Browser Agent",
                poolKey: "browser-stealth::patchright-stealth::direct::identity-a",
                challengeHandling: {
                  solveCloudflare: true,
                },
              },
              warnings: [],
            },
          });

          expect(gotoCount).toBe(2);
          expect(clickCount).toBe(1);
          expect(result.status).toBe(200);
          expect(result.finalUrl).toBe("https://example.com/alza-like");
          expect(result.html).toContain("Final");
          expect(result.mediation).toMatchObject({
            kind: "challenge",
            status: "cleared",
            vendor: "cloudflare",
            resolutionKind: "click",
            attemptCount: 1,
          });
          expect(result.mediation?.evidence.preNavigation?.status).toBe(403);
          expect(result.mediation?.evidence.preNavigation?.contentType).toBe(
            "text/html; charset=utf-8",
          );
          expect(result.mediation?.evidence.postNavigation?.status).toBe(200);
          expect(result.mediation?.evidence.postNavigation?.title).toBe("Final");
          expect(result.timings.loadStateDurationMs).toBeDefined();
          expect(gotoWaitUntil).toEqual(["domcontentloaded", "domcontentloaded"]);
          expect(loadStateCalls).toEqual(expect.arrayContaining(["networkidle"]));
          expect(loadStateCalls.at(-1)).toBe("networkidle");
          expect(result.warnings).toEqual(
            expect.arrayContaining([
              "cloudflare-solver:detected:embedded",
              "cloudflare-solver:click-dispatched:embedded",
              "cloudflare-solver:clearance-observed:embedded",
            ]),
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
              use({
                goto: async (_url, options) => {
                  gotoCount += 1;
                  gotoWaitUntil.push(options.waitUntil);

                  if (gotoCount === 1) {
                    return {
                      status: () => 403,
                      allHeaders: async () => ({
                        "content-type": "text/html; charset=utf-8",
                      }),
                      request: () => ({
                        url: () => "https://example.com/alza-like",
                        redirectedFrom: () => null,
                      }),
                    };
                  }

                  return {
                    status: () => 200,
                    allHeaders: async () => ({
                      "content-type": "text/html; charset=utf-8",
                    }),
                    request: () => ({
                      url: () => "https://example.com/alza-like",
                      redirectedFrom: () => null,
                    }),
                  };
                },
                content: async () => {
                  if (!challengeCleared) {
                    return '<html><head><title>Just a moment...</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body><div class="turnstile"><div><div></div></div></div></body></html>';
                  }

                  return gotoCount >= 2
                    ? "<html><head><title>Final</title></head><body>ok</body></html>"
                    : "<html><head><title>Interim</title></head><body>post-click</body></html>";
                },
                url: () => "https://example.com/alza-like",
                waitForLoadState: async (state) => {
                  loadStateCalls.push(state);
                },
                waitForTimeout: async () => undefined,
                locator: () => ({
                  last: () => ({
                    boundingBox: async () => ({
                      x: 100,
                      y: 100,
                      width: 40,
                      height: 40,
                    }),
                  }),
                  boundingBox: async () => ({
                    x: 100,
                    y: 100,
                    width: 40,
                    height: 40,
                  }),
                }),
                mouse: {
                  click: async () => {
                    clickCount += 1;
                    challengeCleared = true;
                  },
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
    "falls back to reload-target when a mediator requests current-page refresh under reuse-current",
    () =>
      Effect.suspend(() => {
        let gotoCount = 0;

        return Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("browser-stealth");
          const result = yield* provider.execute({
            url: "https://example.com/reuse-current-refresh",
            context: {
              targetUrl: "https://example.com/reuse-current-refresh",
              targetDomain: "example.com",
              providerId: "browser-stealth",
              mode: "browser",
              timeoutMs: 5_000,
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
                browserRuntimeProfileId: "patchright-stealth",
                browserUserAgent: "Identity Agent",
                warnings: [],
                release: Effect.void,
              },
              browser: {
                runtimeProfileId: "patchright-stealth",
                waitUntil: "domcontentloaded",
                timeoutMs: 5_000,
                userAgent: "Browser Agent",
                poolKey: "browser-stealth::patchright-stealth::direct::identity-a",
                challengeHandling: {
                  solveCloudflare: true,
                },
              },
              warnings: [],
            },
          });

          expect(gotoCount).toBe(2);
          expect(result.status).toBe(200);
          expect(result.contentType).toBe("text/html; charset=utf-8");
          expect(result.warnings).toEqual(
            expect.arrayContaining([
              "cloudflare-solver:post-clearance-strategy-fallback:reload-target",
              "cloudflare-solver:post-clearance-strategy:reload-target",
            ]),
          );
        }).pipe(
          Effect.provide(makeAccessProviderRegistryLive()),
          Effect.provideService(BrowserMediationRuntime, {
            mediate: () =>
              Effect.succeed({
                policy: {
                  mode: "solve",
                  vendors: ["cloudflare"],
                  maxAttempts: 4,
                  timeBudgetMs: 60_000,
                  postClearanceStrategy: "reuse-current",
                  captureEvidence: true,
                },
                outcome: {
                  kind: "challenge",
                  status: "cleared",
                  vendor: "cloudflare",
                  resolutionKind: "wait",
                  attemptCount: 0,
                  evidence: {
                    signals: [],
                  },
                  timings: {},
                },
                followUpNavigationRequired: false,
                currentPageRefreshRequired: true,
                postClearanceStrategy: "reuse-current",
                warnings: [],
              }),
          }),
          Effect.provideService(BrowserRuntime, {
            readPoolLimits: () => ({
              maxContexts: 1,
              maxPages: 1,
              maxQueue: 1,
            }),
            withPage: (_options, use) =>
              use({
                goto: async () => {
                  gotoCount += 1;
                  return gotoCount === 1
                    ? {
                        status: () => 403,
                        allHeaders: async () => ({
                          "content-type": "text/html; charset=us-ascii",
                        }),
                        request: () => ({
                          url: () => "https://example.com/reuse-current-refresh",
                          redirectedFrom: () => null,
                        }),
                      }
                    : {
                        status: () => 200,
                        allHeaders: async () => ({
                          "content-type": "text/html; charset=utf-8",
                        }),
                        request: () => ({
                          url: () => "https://example.com/reuse-current-refresh",
                          redirectedFrom: () => null,
                        }),
                      };
                },
                content: async () =>
                  gotoCount >= 2
                    ? "<html><head><title>Recovered</title></head><body>ok</body></html>"
                    : "<html><head><title>Just a moment...</title></head><body>challenge</body></html>",
                url: () => "https://example.com/reuse-current-refresh",
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
        ) as Effect.Effect<void, InvalidInputError | NetworkError | BrowserError, never>;
      }),
  );

  it.effect(
    "persists multi-attempt Cloudflare clears through the browser provider mediation path",
    () =>
      Effect.suspend(() => {
        let gotoCount = 0;
        let clickCount = 0;

        return Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("browser-stealth");
          const result = yield* provider.execute({
            url: "https://example.com/alza-like-retry",
            context: {
              targetUrl: "https://example.com/alza-like-retry",
              targetDomain: "example.com",
              providerId: "browser-stealth",
              mode: "browser",
              timeoutMs: 5_000,
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
                browserRuntimeProfileId: "patchright-stealth",
                browserUserAgent: "Identity Agent",
                warnings: [],
                release: Effect.void,
              },
              browser: {
                runtimeProfileId: "patchright-stealth",
                waitUntil: "domcontentloaded",
                timeoutMs: 60_000,
                userAgent: "Browser Agent",
                poolKey: "browser-stealth::patchright-stealth::direct::identity-a",
                challengeHandling: {
                  solveCloudflare: true,
                },
              },
              warnings: [],
            },
          });

          expect(gotoCount).toBe(2);
          expect(clickCount).toBe(2);
          expect(result.status).toBe(200);
          expect(result.finalUrl).toBe("https://example.com/alza-like-retry");
          expect(result.html).toContain("Solved");
          expect(result.mediation).toMatchObject({
            kind: "challenge",
            status: "cleared",
            vendor: "cloudflare",
            resolutionKind: "click",
            attemptCount: 2,
          });
          expect(result.warnings).toEqual(
            expect.arrayContaining([
              "cloudflare-solver:retrying:embedded",
              "cloudflare-solver:clearance-observed:embedded",
            ]),
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
              use({
                goto: async () => {
                  gotoCount += 1;
                  return {
                    status: () => (gotoCount >= 2 ? 200 : 403),
                    allHeaders: async () => ({
                      "content-type": "text/html; charset=utf-8",
                    }),
                    request: () => ({
                      url: () => "https://example.com/alza-like-retry",
                      redirectedFrom: () => null,
                    }),
                  };
                },
                content: async () =>
                  clickCount >= 2
                    ? "<html><head><title>Solved</title></head><body>ok</body></html>"
                    : '<html><head><title>Just a moment...</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body><div class="turnstile"><div><div></div></div></div></body></html>',
                url: () => "https://example.com/alza-like-retry",
                waitForLoadState: async () => undefined,
                waitForTimeout: async () => undefined,
                locator: () => ({
                  last: () => ({
                    boundingBox: async () => ({
                      x: 100,
                      y: 100,
                      width: 40,
                      height: 40,
                    }),
                  }),
                  boundingBox: async () => ({
                    x: 100,
                    y: 100,
                    width: 40,
                    height: 40,
                  }),
                }),
                mouse: {
                  click: async () => {
                    clickCount += 1;
                  },
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
    "retries Cloudflare turnstile clicks before the follow-up navigation when the first click does not clear",
    () =>
      Effect.suspend(() => {
        let gotoCount = 0;
        let clickCount = 0;

        return Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("browser-stealth");
          const result = yield* provider.execute({
            url: "https://example.com/alza-retry-like",
            context: {
              targetUrl: "https://example.com/alza-retry-like",
              targetDomain: "example.com",
              providerId: "browser-stealth",
              mode: "browser",
              timeoutMs: 5_000,
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
                browserRuntimeProfileId: "patchright-stealth",
                browserUserAgent: "Identity Agent",
                warnings: [],
                release: Effect.void,
              },
              browser: {
                runtimeProfileId: "patchright-stealth",
                waitUntil: "domcontentloaded",
                timeoutMs: 60_000,
                userAgent: "Browser Agent",
                poolKey: "browser-stealth::patchright-stealth::direct::identity-a",
                challengeHandling: {
                  solveCloudflare: true,
                },
              },
              warnings: [],
            },
          });

          expect(gotoCount).toBe(2);
          expect(clickCount).toBe(2);
          expect(result.status).toBe(200);
          expect(result.finalUrl).toBe("https://example.com/alza-retry-like");
          expect(result.html).toContain("Solved");
          expect(result.mediation).toMatchObject({
            kind: "challenge",
            status: "cleared",
            vendor: "cloudflare",
            resolutionKind: "click",
            attemptCount: 2,
          });
          expect(result.warnings).toEqual(
            expect.arrayContaining([
              "cloudflare-solver:retrying:embedded",
              "cloudflare-solver:clearance-observed:embedded",
            ]),
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
              use({
                goto: async () => {
                  gotoCount += 1;

                  return {
                    status: () => (gotoCount >= 2 ? 200 : 403),
                    allHeaders: async () => ({
                      "content-type": "text/html; charset=utf-8",
                    }),
                    request: () => ({
                      url: () => "https://example.com/alza-retry-like",
                      redirectedFrom: () => null,
                    }),
                  };
                },
                content: async () =>
                  clickCount >= 2
                    ? "<html><head><title>Solved</title></head><body>ok</body></html>"
                    : '<html><head><title>Just a moment...</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body><div class="turnstile"><div><div></div></div></div></body></html>',
                url: () => "https://example.com/alza-retry-like",
                waitForLoadState: async () => undefined,
                waitForTimeout: async () => undefined,
                locator: () => ({
                  last: () => ({
                    boundingBox: async () => ({
                      x: 100,
                      y: 100,
                      width: 40,
                      height: 40,
                    }),
                  }),
                  boundingBox: async () => ({
                    x: 100,
                    y: 100,
                    width: 40,
                    height: 40,
                  }),
                }),
                mouse: {
                  click: async () => {
                    clickCount += 1;
                  },
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
    "treats post-clearance networkidle settling as best-effort instead of failing the follow-up page",
    () =>
      Effect.suspend(() => {
        let gotoCount = 0;
        let challengeCleared = false;

        return Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("browser-stealth");
          const result = yield* provider.execute({
            url: "https://example.com/alza-like-soft-settle",
            context: {
              targetUrl: "https://example.com/alza-like-soft-settle",
              targetDomain: "example.com",
              providerId: "browser-stealth",
              mode: "browser",
              timeoutMs: 5_000,
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
                browserRuntimeProfileId: "patchright-stealth",
                browserUserAgent: "Identity Agent",
                warnings: [],
                release: Effect.void,
              },
              browser: {
                runtimeProfileId: "patchright-stealth",
                waitUntil: "domcontentloaded",
                timeoutMs: 60_000,
                userAgent: "Browser Agent",
                poolKey: "browser-stealth::patchright-stealth::direct::identity-a",
                challengeHandling: {
                  solveCloudflare: true,
                },
              },
              warnings: [],
            },
          });

          expect(gotoCount).toBe(2);
          expect(result.status).toBe(200);
          expect(result.html).toContain("Final");
          expect(result.warnings).toEqual(
            expect.arrayContaining(["cloudflare-solver:post-clearance-networkidle-unreached"]),
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
              use({
                goto: async () => {
                  gotoCount += 1;

                  return {
                    status: () => (gotoCount >= 2 ? 200 : 403),
                    allHeaders: async () => ({
                      "content-type": "text/html; charset=utf-8",
                    }),
                    request: () => ({
                      url: () => "https://example.com/alza-like-soft-settle",
                      redirectedFrom: () => null,
                    }),
                  };
                },
                content: async () =>
                  challengeCleared
                    ? "<html><head><title>Final</title></head><body>ok</body></html>"
                    : '<html><head><title>Just a moment...</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body><div class="turnstile"><div><div></div></div></div></body></html>',
                url: () => "https://example.com/alza-like-soft-settle",
                waitForLoadState: async (state) => {
                  if (gotoCount >= 2 && state === "networkidle") {
                    throw new Error("networkidle-never-settles");
                  }
                },
                waitForTimeout: async () => undefined,
                locator: () => ({
                  last: () => ({
                    boundingBox: async () => ({
                      x: 100,
                      y: 100,
                      width: 40,
                      height: 40,
                    }),
                  }),
                  boundingBox: async () => ({
                    x: 100,
                    y: 100,
                    width: 40,
                    height: 40,
                  }),
                }),
                mouse: {
                  click: async () => {
                    challengeCleared = true;
                  },
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

  it.effect("waits for a managed Cloudflare page to settle before the first follow-up reload", () =>
    Effect.suspend(() => {
      let gotoCount = 0;
      let settleReadCount = 0;
      let currentPageCleared = false;

      return Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("browser-stealth");
        const result = yield* provider.execute({
          url: "https://example.com/challenge-settles-before-follow-up",
          context: {
            targetUrl: "https://example.com/challenge-settles-before-follow-up",
            targetDomain: "example.com",
            providerId: "browser-stealth",
            mode: "browser",
            timeoutMs: 5_000,
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
              browserRuntimeProfileId: "patchright-stealth",
              browserUserAgent: "Identity Agent",
              warnings: [],
              release: Effect.void,
            },
            browser: {
              runtimeProfileId: "patchright-stealth",
              waitUntil: "domcontentloaded",
              timeoutMs: 60_000,
              userAgent: "Browser Agent",
              poolKey: "browser-stealth::patchright-stealth::direct::identity-a",
              challengeHandling: {
                solveCloudflare: true,
              },
            },
            warnings: [],
          },
        });

        expect(gotoCount).toBe(1);
        expect(result.status).toBe(200);
        expect(result.mediation).toMatchObject({
          kind: "challenge",
          status: "cleared",
          resolutionKind: "click",
        });
        expect(result.warnings).toEqual(
          expect.arrayContaining([
            "cloudflare-solver:post-clearance-settle-before-follow-up",
            "cloudflare-solver:post-clearance-settled-before-follow-up",
            "cloudflare-solver:post-clearance-strategy-override:reuse-current",
          ]),
        );
      }).pipe(
        Effect.provide(makeAccessProviderRegistryLive()),
        Effect.provideService(BrowserMediationRuntime, {
          mediate: () =>
            Effect.succeed({
              policy: {
                mode: "solve",
                vendors: ["cloudflare"],
                maxAttempts: 4,
                timeBudgetMs: 60_000,
                postClearanceStrategy: "reload-target",
                captureEvidence: true,
              },
              outcome: {
                kind: "challenge",
                status: "cleared",
                vendor: "cloudflare",
                resolutionKind: "click",
                attemptCount: 1,
                evidence: {
                  signals: [],
                },
                timings: {},
              },
              followUpNavigationRequired: true,
              currentPageRefreshRequired: false,
              postClearanceStrategy: "reload-target",
              warnings: ["cloudflare-solver:clearance-observed:managed"],
            }),
        }),
        Effect.provideService(BrowserRuntime, {
          readPoolLimits: () => ({
            maxContexts: 1,
            maxPages: 1,
            maxQueue: 1,
          }),
          withPage: (_options, use) =>
            use({
              goto: async () => {
                gotoCount += 1;
                return {
                  status: () => (gotoCount >= 2 && currentPageCleared ? 200 : 403),
                  allHeaders: async () => ({
                    "content-type": "text/html; charset=utf-8",
                  }),
                  request: () => ({
                    url: () => "https://example.com/challenge-settles-before-follow-up",
                    redirectedFrom: () => null,
                  }),
                };
              },
              content: async () => {
                if (currentPageCleared) {
                  return "<html><head><title>Solved</title></head><body>ok</body></html>";
                }

                if (gotoCount === 1 && !currentPageCleared) {
                  settleReadCount += 1;
                  if (settleReadCount >= 3) {
                    currentPageCleared = true;
                    return "<html><head><title>Solved</title></head><body>ok</body></html>";
                  }
                }

                return "<html><head><title>Just a moment...</title></head><body>cType: 'managed'</body></html>";
              },
              url: () => "https://example.com/challenge-settles-before-follow-up",
              waitForLoadState: async () => undefined,
              waitForTimeout: async () => undefined,
              locator: () => ({
                last: () => ({
                  boundingBox: async () => ({
                    x: 100,
                    y: 100,
                    width: 40,
                    height: 40,
                  }),
                }),
                boundingBox: async () => ({
                  x: 100,
                  y: 100,
                  width: 40,
                  height: 40,
                }),
              }),
              mouse: {
                click: async () => undefined,
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

  it.effect("skips current-page reuse when the settled page is a Chromium block error", () =>
    Effect.suspend(() => {
      let gotoCount = 0;
      let settleReadCount = 0;
      let currentPageCleared = false;

      return Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("browser-stealth");
        const result = yield* provider.execute({
          url: "https://example.com/challenge-clears-on-current-page",
          context: {
            targetUrl: "https://example.com/challenge-clears-on-current-page",
            targetDomain: "example.com",
            providerId: "browser-stealth",
            mode: "browser",
            timeoutMs: 5_000,
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
              browserRuntimeProfileId: "patchright-stealth",
              browserUserAgent: "Identity Agent",
              warnings: [],
              release: Effect.void,
            },
            browser: {
              runtimeProfileId: "patchright-stealth",
              waitUntil: "domcontentloaded",
              timeoutMs: 60_000,
              userAgent: "Browser Agent",
              poolKey: "browser-stealth::patchright-stealth::direct::identity-a",
              challengeHandling: {
                solveCloudflare: true,
              },
            },
            warnings: [],
          },
        });

        expect(gotoCount).toBe(2);
        expect(result.status).toBe(200);
        expect(result.finalUrl).toBe("https://example.com/challenge-clears-on-current-page");
        expect(result.mediation).toMatchObject({
          kind: "challenge",
          status: "cleared",
          resolutionKind: "click",
        });
        expect(result.warnings).toEqual(
          expect.arrayContaining([
            "cloudflare-solver:post-clearance-strategy-override-skipped:browser-error:ERR_BLOCKED_BY_CLIENT",
          ]),
        );
      }).pipe(
        Effect.provide(makeAccessProviderRegistryLive()),
        Effect.provideService(BrowserMediationRuntime, {
          mediate: () =>
            Effect.succeed({
              policy: {
                mode: "solve",
                vendors: ["cloudflare"],
                maxAttempts: 4,
                timeBudgetMs: 60_000,
                postClearanceStrategy: "reload-target",
                captureEvidence: true,
              },
              outcome: {
                kind: "challenge",
                status: "cleared",
                vendor: "cloudflare",
                resolutionKind: "click",
                attemptCount: 1,
                evidence: {
                  signals: [],
                },
                timings: {},
              },
              followUpNavigationRequired: true,
              currentPageRefreshRequired: false,
              postClearanceStrategy: "reload-target",
              warnings: ["cloudflare-solver:clearance-observed:managed"],
            }),
        }),
        Effect.provideService(BrowserRuntime, {
          readPoolLimits: () => ({
            maxContexts: 1,
            maxPages: 1,
            maxQueue: 1,
          }),
          withPage: (_options, use) =>
            use({
              goto: async () => {
                gotoCount += 1;
                return {
                  status: () => (gotoCount >= 2 ? 200 : 403),
                  allHeaders: async () => ({
                    "content-type": "text/html; charset=utf-8",
                  }),
                  request: () => ({
                    url: () => "https://example.com/challenge-clears-on-current-page",
                    redirectedFrom: () => null,
                  }),
                };
              },
              content: async () => {
                if (gotoCount >= 2) {
                  return "<html><head><title>Solved</title></head><body>ok</body></html>";
                }

                if (currentPageCleared) {
                  return `<html><head><title>www.example.com</title></head><body>This page has been blocked by Chromium ERR_BLOCKED_BY_CLIENT Reload</body></html>`;
                }

                settleReadCount += 1;
                if (settleReadCount >= 3) {
                  currentPageCleared = true;
                  return "<html><head><title>Solved</title></head><body>ok</body></html>";
                }

                return "<html><head><title>Just a moment...</title></head><body>cType: 'managed'</body></html>";
              },
              url: () =>
                currentPageCleared
                  ? "chrome-error://chromewebdata/"
                  : "https://example.com/challenge-clears-on-current-page",
              waitForLoadState: async () => undefined,
              waitForTimeout: async () => undefined,
              locator: () => ({
                last: () => ({
                  boundingBox: async () => ({
                    x: 100,
                    y: 100,
                    width: 40,
                    height: 40,
                  }),
                }),
                boundingBox: async () => ({
                  x: 100,
                  y: 100,
                  width: 40,
                  height: 40,
                }),
              }),
              mouse: {
                click: async () => undefined,
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

  it.effect("reuses the current page after delayed Chromium block-page recovery", () =>
    Effect.suspend(() => {
      let gotoCount = 0;
      let settleReadCount = 0;
      let recoveryReadCount = 0;
      let currentPageCleared = false;

      return Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("browser-stealth");
        const result = yield* provider.execute({
          url: "https://example.com/challenge-clears-after-delayed-browser-error",
          context: {
            targetUrl: "https://example.com/challenge-clears-after-delayed-browser-error",
            targetDomain: "example.com",
            providerId: "browser-stealth",
            mode: "browser",
            timeoutMs: 5_000,
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
              browserRuntimeProfileId: "patchright-stealth",
              browserUserAgent: "Identity Agent",
              warnings: [],
              release: Effect.void,
            },
            browser: {
              runtimeProfileId: "patchright-stealth",
              waitUntil: "domcontentloaded",
              timeoutMs: 60_000,
              userAgent: "Browser Agent",
              poolKey: "browser-stealth::patchright-stealth::direct::identity-a",
              challengeHandling: {
                solveCloudflare: true,
              },
            },
            warnings: [],
          },
        });

        expect(gotoCount).toBe(1);
        expect(result.status).toBe(200);
        expect(result.html).toContain("Solved");
        expect(result.mediation).toMatchObject({
          kind: "challenge",
          status: "cleared",
          resolutionKind: "click",
        });
        expect(result.warnings).toEqual(
          expect.arrayContaining([
            "cloudflare-solver:post-clearance-browser-error-recovery",
            "cloudflare-solver:post-clearance-browser-error-recovered",
            "cloudflare-solver:post-clearance-strategy-override:reuse-current",
          ]),
        );
      }).pipe(
        Effect.provide(makeAccessProviderRegistryLive()),
        Effect.provideService(BrowserMediationRuntime, {
          mediate: () =>
            Effect.succeed({
              policy: {
                mode: "solve",
                vendors: ["cloudflare"],
                maxAttempts: 4,
                timeBudgetMs: 60_000,
                postClearanceStrategy: "reload-target",
                captureEvidence: true,
              },
              outcome: {
                kind: "challenge",
                status: "cleared",
                vendor: "cloudflare",
                resolutionKind: "click",
                attemptCount: 1,
                evidence: {
                  signals: [],
                },
                timings: {},
              },
              followUpNavigationRequired: true,
              currentPageRefreshRequired: false,
              postClearanceStrategy: "reload-target",
              warnings: ["cloudflare-solver:clearance-observed:managed"],
            }),
        }),
        Effect.provideService(BrowserRuntime, {
          readPoolLimits: () => ({
            maxContexts: 1,
            maxPages: 1,
            maxQueue: 1,
          }),
          withPage: (_options, use) =>
            use({
              goto: async () => {
                gotoCount += 1;
                return {
                  status: () => (gotoCount >= 2 ? 200 : 403),
                  allHeaders: async () => ({
                    "content-type": "text/html; charset=utf-8",
                  }),
                  request: () => ({
                    url: () => "https://example.com/challenge-clears-after-delayed-browser-error",
                    redirectedFrom: () => null,
                  }),
                };
              },
              content: async () => {
                if (gotoCount >= 2) {
                  return "<html><head><title>Reloaded</title></head><body>unexpected follow-up</body></html>";
                }

                if (currentPageCleared) {
                  recoveryReadCount += 1;
                  return recoveryReadCount >= 18
                    ? "<html><head><title>Solved</title></head><body>ok</body></html>"
                    : "<html><head><title>www.example.com</title></head><body>This page has been blocked by Chromium ERR_BLOCKED_BY_CLIENT Reload</body></html>";
                }

                settleReadCount += 1;
                if (settleReadCount >= 3) {
                  currentPageCleared = true;
                  recoveryReadCount += 1;
                  return "<html><head><title>www.example.com</title></head><body>This page has been blocked by Chromium ERR_BLOCKED_BY_CLIENT Reload</body></html>";
                }

                return "<html><head><title>Just a moment...</title></head><body>cType: 'managed'</body></html>";
              },
              url: () =>
                currentPageCleared && recoveryReadCount < 18
                  ? "chrome-error://chromewebdata/"
                  : "https://example.com/challenge-clears-after-delayed-browser-error",
              waitForLoadState: async () => undefined,
              waitForTimeout: async () => undefined,
              locator: () => ({
                last: () => ({
                  boundingBox: async () => ({
                    x: 100,
                    y: 100,
                    width: 40,
                    height: 40,
                  }),
                }),
                boundingBox: async () => ({
                  x: 100,
                  y: 100,
                  width: 40,
                  height: 40,
                }),
              }),
              mouse: {
                click: async () => undefined,
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

  it.effect("caps Chromium block-page recovery waits to the configured browser timeout", () =>
    Effect.suspend(() => {
      const originalNow = Date.now;
      let fakeNow = 0;
      let gotoCount = 0;
      let contentReadCount = 0;
      const recoveryWaitCalls: number[] = [];

      Date.now = () => fakeNow;
      try {
        return Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("browser-stealth");
          const result = yield* provider.execute({
            url: "https://example.com/challenge-clears-with-short-recovery-budget",
            context: {
              targetUrl: "https://example.com/challenge-clears-with-short-recovery-budget",
              targetDomain: "example.com",
              providerId: "browser-stealth",
              mode: "browser",
              timeoutMs: 5_000,
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
                browserRuntimeProfileId: "patchright-stealth",
                browserUserAgent: "Identity Agent",
                warnings: [],
                release: Effect.void,
              },
              browser: {
                runtimeProfileId: "patchright-stealth",
                waitUntil: "domcontentloaded",
                timeoutMs: 25,
                userAgent: "Browser Agent",
                poolKey: "browser-stealth::patchright-stealth::direct::identity-a",
                challengeHandling: {
                  solveCloudflare: true,
                },
              },
              warnings: [],
            },
          });

          expect(gotoCount).toBe(1);
          expect(result.status).toBe(200);
          expect(result.warnings).toEqual(
            expect.arrayContaining([
              "cloudflare-solver:post-clearance-browser-error-recovered",
              "cloudflare-solver:post-clearance-strategy-override:reuse-current",
            ]),
          );
          expect(Math.max(...recoveryWaitCalls)).toBeLessThanOrEqual(25);
        }).pipe(
          Effect.provide(makeAccessProviderRegistryLive()),
          Effect.provideService(BrowserMediationRuntime, {
            mediate: () =>
              Effect.succeed({
                policy: {
                  mode: "solve",
                  vendors: ["cloudflare"],
                  maxAttempts: 4,
                  timeBudgetMs: 60_000,
                  postClearanceStrategy: "reload-target",
                  captureEvidence: true,
                },
                outcome: {
                  kind: "challenge",
                  status: "cleared",
                  vendor: "cloudflare",
                  resolutionKind: "click",
                  attemptCount: 1,
                  evidence: {
                    signals: [],
                  },
                  timings: {},
                },
                followUpNavigationRequired: true,
                currentPageRefreshRequired: false,
                postClearanceStrategy: "reload-target",
                warnings: ["cloudflare-solver:clearance-observed:managed"],
              }),
          }),
          Effect.provideService(BrowserRuntime, {
            readPoolLimits: () => ({
              maxContexts: 1,
              maxPages: 1,
              maxQueue: 1,
            }),
            withPage: (_options, use) =>
              use({
                goto: async () => {
                  gotoCount += 1;
                  return {
                    status: () => (gotoCount >= 2 ? 200 : 403),
                    allHeaders: async () => ({
                      "content-type": "text/html; charset=utf-8",
                    }),
                    request: () => ({
                      url: () => "https://example.com/challenge-clears-with-short-recovery-budget",
                      redirectedFrom: () => null,
                    }),
                  };
                },
                content: async () => {
                  contentReadCount += 1;
                  if (contentReadCount === 1) {
                    return "<html><head><title>Just a moment...</title></head><body>cType: 'managed'</body></html>";
                  }
                  if (contentReadCount <= 3) {
                    return "<html><head><title>www.example.com</title></head><body>This page has been blocked by Chromium ERR_BLOCKED_BY_CLIENT Reload</body></html>";
                  }
                  return "<html><head><title>Solved</title></head><body>ok</body></html>";
                },
                url: () => "https://example.com/challenge-clears-with-short-recovery-budget",
                waitForLoadState: async () => undefined,
                waitForTimeout: async (timeoutMs) => {
                  recoveryWaitCalls.push(timeoutMs);
                  fakeNow += timeoutMs;
                },
                locator: () => ({
                  last: () => ({
                    boundingBox: async () => ({
                      x: 100,
                      y: 100,
                      width: 40,
                      height: 40,
                    }),
                  }),
                  boundingBox: async () => ({
                    x: 100,
                    y: 100,
                    width: 40,
                    height: 40,
                  }),
                }),
                mouse: {
                  click: async () => undefined,
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
      } finally {
        Date.now = originalNow;
      }
    }),
  );

  it.effect(
    "downgrades cleared mediation outcomes when the follow-up navigation still lands on an access wall",
    () =>
      Effect.suspend(() => {
        let gotoCount = 0;
        let challengeCleared = false;

        return Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("browser-stealth");
          const result = yield* provider.execute({
            url: "https://example.com/challenge-persists",
            context: {
              targetUrl: "https://example.com/challenge-persists",
              targetDomain: "example.com",
              providerId: "browser-stealth",
              mode: "browser",
              timeoutMs: 5_000,
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
                browserRuntimeProfileId: "patchright-stealth",
                browserUserAgent: "Identity Agent",
                warnings: [],
                release: Effect.void,
              },
              browser: {
                runtimeProfileId: "patchright-stealth",
                waitUntil: "domcontentloaded",
                timeoutMs: 60_000,
                userAgent: "Browser Agent",
                poolKey: "browser-stealth::patchright-stealth::direct::identity-a",
                challengeHandling: {
                  solveCloudflare: true,
                },
              },
              warnings: [],
            },
          });

          expect(gotoCount).toBe(3);
          expect(result.status).toBe(403);
          expect(result.mediation).toMatchObject({
            kind: "challenge",
            status: "unresolved",
            failureReason: "no-progress",
          });
          expect(result.warnings).toEqual(
            expect.arrayContaining([
              "cloudflare-solver:clearance-confirmation-retry",
              "cloudflare-solver:clearance-unconfirmed",
            ]),
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
              use({
                goto: async () => {
                  gotoCount += 1;
                  return {
                    status: () => (gotoCount >= 2 ? 403 : 403),
                    allHeaders: async () => ({
                      "content-type": "text/html; charset=utf-8",
                    }),
                    request: () => ({
                      url: () => "https://example.com/challenge-persists",
                      redirectedFrom: () => null,
                    }),
                  };
                },
                content: async () => {
                  if (!challengeCleared) {
                    return '<html><head><title>Just a moment...</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body><div class="turnstile"><div><div></div></div></div></body></html>';
                  }

                  if (gotoCount >= 2) {
                    return '<html><head><title>Just a moment...</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body>still blocked</body></html>';
                  }

                  return "<html><head><title>Solved</title></head><body>ok</body></html>";
                },
                url: () => "https://example.com/challenge-persists",
                waitForLoadState: async () => undefined,
                waitForTimeout: async () => undefined,
                locator: () => ({
                  last: () => ({
                    boundingBox: async () => ({
                      x: 100,
                      y: 100,
                      width: 40,
                      height: 40,
                    }),
                  }),
                  boundingBox: async () => ({
                    x: 100,
                    y: 100,
                    width: 40,
                    height: 40,
                  }),
                }),
                mouse: {
                  click: async () => {
                    challengeCleared = true;
                  },
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
    "confirms clearance on a second follow-up navigation when the first reload stays blocked",
    () =>
      Effect.suspend(() => {
        let gotoCount = 0;

        return Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("browser-stealth");
          const result = yield* provider.execute({
            url: "https://example.com/challenge-confirmed-on-retry",
            context: {
              targetUrl: "https://example.com/challenge-confirmed-on-retry",
              targetDomain: "example.com",
              providerId: "browser-stealth",
              mode: "browser",
              timeoutMs: 5_000,
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
                browserRuntimeProfileId: "patchright-stealth",
                browserUserAgent: "Identity Agent",
                warnings: [],
                release: Effect.void,
              },
              browser: {
                runtimeProfileId: "patchright-stealth",
                waitUntil: "domcontentloaded",
                timeoutMs: 60_000,
                userAgent: "Browser Agent",
                poolKey: "browser-stealth::patchright-stealth::direct::identity-a",
                challengeHandling: {
                  solveCloudflare: true,
                },
              },
              warnings: [],
            },
          });

          expect(gotoCount).toBe(3);
          expect(result.status).toBe(200);
          expect(result.mediation).toMatchObject({
            kind: "challenge",
            status: "cleared",
            resolutionKind: "click",
          });
          expect(result.warnings).toEqual(
            expect.arrayContaining([
              "cloudflare-solver:clearance-confirmation-retry",
              "cloudflare-solver:clearance-confirmed-on-retry",
            ]),
          );
        }).pipe(
          Effect.provide(makeAccessProviderRegistryLive()),
          Effect.provideService(BrowserMediationRuntime, {
            mediate: () =>
              Effect.succeed({
                policy: {
                  mode: "solve",
                  vendors: ["cloudflare"],
                  maxAttempts: 4,
                  timeBudgetMs: 60_000,
                  postClearanceStrategy: "reload-target",
                  captureEvidence: true,
                },
                outcome: {
                  kind: "challenge",
                  status: "cleared",
                  vendor: "cloudflare",
                  resolutionKind: "click",
                  attemptCount: 1,
                  evidence: {
                    signals: [],
                  },
                  timings: {},
                },
                followUpNavigationRequired: true,
                currentPageRefreshRequired: false,
                postClearanceStrategy: "reload-target",
                warnings: ["cloudflare-solver:clearance-observed:managed"],
              }),
          }),
          Effect.provideService(BrowserRuntime, {
            readPoolLimits: () => ({
              maxContexts: 1,
              maxPages: 1,
              maxQueue: 1,
            }),
            withPage: (_options, use) =>
              use({
                goto: async () => {
                  gotoCount += 1;
                  return {
                    status: () => (gotoCount >= 3 ? 200 : 403),
                    allHeaders: async () => ({
                      "content-type": "text/html; charset=utf-8",
                    }),
                    request: () => ({
                      url: () => "https://example.com/challenge-confirmed-on-retry",
                      redirectedFrom: () => null,
                    }),
                  };
                },
                content: async () =>
                  gotoCount >= 3
                    ? "<html><head><title>Recovered</title></head><body>ok</body></html>"
                    : "<html><head><title>Still blocked</title></head><body>cookies wall</body></html>",
                url: () => "https://example.com/challenge-confirmed-on-retry",
                waitForLoadState: async () => undefined,
                waitForTimeout: async () => undefined,
                locator: () => undefined,
                mouse: undefined,
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
    "fails follow-up challenge navigations when the route policy blocks a newly requested URL",
    () =>
      Effect.suspend(() => {
        let gotoCount = 0;
        let challengeCleared = false;
        let routeHandler:
          | ((route: {
              readonly request: () => {
                readonly url: () => string;
              };
              readonly abort: (_reason?: string) => Promise<void>;
              readonly continue: () => Promise<void>;
            }) => void | Promise<void>)
          | undefined;

        return Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("browser-stealth");
          const failure = yield* provider
            .execute({
              url: "https://example.com/challenge-follow-up-blocked",
              context: {
                targetUrl: "https://example.com/challenge-follow-up-blocked",
                targetDomain: "example.com",
                providerId: "browser-stealth",
                mode: "browser",
                timeoutMs: 5_000,
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
                  browserRuntimeProfileId: "patchright-stealth",
                  browserUserAgent: "Identity Agent",
                  warnings: [],
                  release: Effect.void,
                },
                browser: {
                  runtimeProfileId: "patchright-stealth",
                  waitUntil: "domcontentloaded",
                  timeoutMs: 60_000,
                  userAgent: "Browser Agent",
                  poolKey: "browser-stealth::patchright-stealth::direct::identity-a",
                  challengeHandling: {
                    solveCloudflare: true,
                  },
                },
                warnings: [],
              },
            })
            .pipe(Effect.flip);

          expect(failure._tag).toBe("BrowserError");
          expect(failure.details).toContain("Blocked browser request to http://127.0.0.1/internal");
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
                goto: async () => {
                  gotoCount += 1;
                  if (gotoCount >= 2 && routeHandler !== undefined) {
                    await routeHandler({
                      request: () => ({
                        url: () => "http://127.0.0.1/internal",
                      }),
                      abort: async () => undefined,
                      continue: async () => undefined,
                    });
                  }

                  return {
                    status: () => 200,
                    allHeaders: async () => ({
                      "content-type": "text/html; charset=utf-8",
                    }),
                    request: () => ({
                      url: () => "https://example.com/challenge-follow-up-blocked",
                      redirectedFrom: () => null,
                    }),
                  };
                },
                content: async () =>
                  challengeCleared
                    ? "<html><head><title>Solved</title></head><body>ok</body></html>"
                    : '<html><head><title>Just a moment...</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body><div class="turnstile"><div><div></div></div></div></body></html>',
                url: () => "https://example.com/challenge-follow-up-blocked",
                waitForLoadState: async () => undefined,
                waitForTimeout: async () => undefined,
                locator: () => ({
                  last: () => ({
                    boundingBox: async () => ({
                      x: 100,
                      y: 100,
                      width: 40,
                      height: 40,
                    }),
                  }),
                  boundingBox: async () => ({
                    x: 100,
                    y: 100,
                    width: 40,
                    height: 40,
                  }),
                }),
                mouse: {
                  click: async () => {
                    challengeCleared = true;
                  },
                },
                route: async (_pattern, handler) => {
                  routeHandler = handler;
                },
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

  it.effect("counts redirects across both the challenge navigation and follow-up navigation", () =>
    Effect.suspend(() => {
      let gotoCount = 0;
      let challengeCleared = false;

      return Effect.gen(function* () {
        const registry = yield* AccessProviderRegistry;
        const provider = yield* registry.resolve("browser-stealth");
        const result = yield* provider.execute({
          url: "https://example.com/challenge-redirect-chain",
          context: {
            targetUrl: "https://example.com/challenge-redirect-chain",
            targetDomain: "example.com",
            providerId: "browser-stealth",
            mode: "browser",
            timeoutMs: 5_000,
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
              browserRuntimeProfileId: "patchright-stealth",
              browserUserAgent: "Identity Agent",
              warnings: [],
              release: Effect.void,
            },
            browser: {
              runtimeProfileId: "patchright-stealth",
              waitUntil: "domcontentloaded",
              timeoutMs: 60_000,
              userAgent: "Browser Agent",
              poolKey: "browser-stealth::patchright-stealth::direct::identity-a",
              challengeHandling: {
                solveCloudflare: true,
              },
            },
            warnings: [],
          },
        });

        expect(result.timings.redirectCount).toBe(3);
        expect(result.timings.requestCount).toBe(5);
        expect(result.mediation?.evidence.preNavigation?.redirectCount).toBe(2);
        expect(result.mediation?.evidence.postNavigation?.redirectCount).toBe(1);
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
              goto: async () => {
                gotoCount += 1;

                if (gotoCount === 1) {
                  return {
                    status: () => 403,
                    allHeaders: async () => ({
                      "content-type": "text/html; charset=utf-8",
                    }),
                    request: () =>
                      makeRedirectRequest("https://example.com/challenge-redirect-chain", 2),
                  };
                }

                return {
                  status: () => 200,
                  allHeaders: async () => ({
                    "content-type": "text/html; charset=utf-8",
                  }),
                  request: () =>
                    makeRedirectRequest("https://example.com/challenge-redirect-chain", 1),
                };
              },
              content: async () => {
                if (!challengeCleared) {
                  return '<html><head><title>Just a moment...</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body><div class="turnstile"><div><div></div></div></div></body></html>';
                }

                return gotoCount >= 2
                  ? "<html><head><title>Final</title></head><body>ok</body></html>"
                  : "<html><head><title>Interim</title></head><body>post-click</body></html>";
              },
              url: () => "https://example.com/challenge-redirect-chain",
              waitForLoadState: async () => undefined,
              waitForTimeout: async () => undefined,
              locator: () => ({
                last: () => ({
                  boundingBox: async () => ({
                    x: 100,
                    y: 100,
                    width: 40,
                    height: 40,
                  }),
                }),
                boundingBox: async () => ({
                  x: 100,
                  y: 100,
                  width: 40,
                  height: 40,
                }),
              }),
              mouse: {
                click: async () => {
                  challengeCleared = true;
                },
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

  it.effect(
    "does not let the outer hard timeout preempt the elevated Cloudflare mediation budget",
    () =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("browser-stealth");
          const failure = yield* provider
            .execute({
              url: "https://example.com/browser-runtime-timeout-with-solver-budget",
              context: {
                targetUrl: "https://example.com/browser-runtime-timeout-with-solver-budget",
                targetDomain: "example.com",
                providerId: "browser-stealth",
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
                  browserRuntimeProfileId: "patchright-stealth",
                  browserUserAgent: "Identity Agent",
                  warnings: [],
                  release: Effect.void,
                },
                browser: {
                  runtimeProfileId: "patchright-stealth",
                  waitUntil: "domcontentloaded",
                  timeoutMs: 25,
                  userAgent: "Browser Agent",
                  poolKey: "browser-stealth::patchright-stealth::direct::identity-a",
                  challengeHandling: {
                    solveCloudflare: true,
                  },
                },
                warnings: [],
              },
            })
            .pipe(Effect.flip);

          expect(failure._tag).toBe("BrowserError");
          expect(failure.details).not.toContain("hard timeout");
          expect(failure.details).toContain("browser boot failed after solver budget uplift");
        }).pipe(
          Effect.provide(AccessProviderRegistryLive),
          Effect.provideService(BrowserRuntime, {
            readPoolLimits: () => ({
              maxContexts: 1,
              maxPages: 1,
              maxQueue: 1,
            }),
            withPage: () =>
              Effect.sleep(50).pipe(
                Effect.flatMap(() =>
                  Effect.fail(
                    new BrowserError({
                      message:
                        "Browser access failed for https://example.com/browser-runtime-timeout-with-solver-budget",
                      details: "browser boot failed after solver budget uplift",
                    }),
                  ),
                ),
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

  it.effect(
    "fails cleanup hangs after the page callback finishes instead of stalling indefinitely",
    () =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          const registry = yield* AccessProviderRegistry;
          const provider = yield* registry.resolve("browser-basic");
          const failure = yield* provider
            .execute({
              url: "https://example.com/browser-runtime-cleanup-timeout",
              context: {
                targetUrl: "https://example.com/browser-runtime-cleanup-timeout",
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
          expect(failure.details).toContain("stage=unknown");
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
                route: async () => undefined,
                goto: async () => ({
                  status: () => 200,
                  allHeaders: async () => ({
                    "content-type": "text/html; charset=utf-8",
                  }),
                  request: () => ({
                    url: () => "https://example.com/browser-runtime-cleanup-timeout",
                    redirectedFrom: () => null,
                  }),
                }),
                content: async () => "<html><head><title>ok</title></head><body>ok</body></html>",
                url: () => "https://example.com/browser-runtime-cleanup-timeout",
                waitForLoadState: async () => undefined,
                close: async () => undefined,
              } as never).pipe(Effect.flatMap(() => Effect.never)),
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
