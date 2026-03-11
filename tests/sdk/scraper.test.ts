import { describe, expect, it } from "@effect-native/bun-test";
import { mock } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { AccessSelectionPolicyLive } from "../../src/sdk/access-policy-runtime.ts";
import { AccessHealthRuntimeLive } from "../../src/sdk/access-health-runtime-service.ts";
import { AccessProgramLinkerLive } from "../../src/sdk/access-program-linker.ts";
import { AccessSelectionHealthSignalsGatewayLive } from "../../src/sdk/access-selection-health-runtime.ts";
import { AccessSelectionStrategyLive } from "../../src/sdk/access-selection-strategy-runtime.ts";
import {
  AccessExecutionRuntime,
  AccessExecutionRuntimeLive,
  toExecutionMetadata,
  type AccessExecutionInput,
  type ResolvedExecutionIntent,
} from "../../src/sdk/access-runtime.ts";
import {
  EgressBrokerEnvironmentLive,
  EgressBroker,
  IdentityBrokerEnvironmentLive,
  IdentityBroker,
  resetAccessBrokerStateForTests,
  type EgressBrokerAcquireInput,
  type IdentityBrokerAcquireInput,
  type ResolvedEgressLease,
  type ResolvedIdentityLease,
} from "../../src/sdk/access-broker-runtime.ts";
import {
  AccessHealthGateway,
  AccessHealthGatewayLive,
  resetAccessHealthGatewayForTests,
} from "../../src/sdk/access-health-gateway.ts";
import {
  AccessHealthPolicyRegistryLive,
  AccessHealthSubjectStrategyLive,
} from "../../src/sdk/access-health-policy-runtime.ts";
import { AccessExecutionCoordinatorLive } from "../../src/sdk/access-execution-coordinator.ts";
import { AccessExecutionEngineLive } from "../../src/sdk/access-execution-engine.ts";
import { AccessResourceKernelLive } from "../../src/sdk/access-resource-kernel.ts";
import {
  AccessProviderRegistry,
  AccessProviderRegistryLive,
  type AccessProvider,
} from "../../src/sdk/access-provider-runtime.ts";
import {
  AccessQuarantinedError,
  AccessResourceError,
  InvalidInputError,
  NetworkError,
} from "../../src/sdk/errors.ts";
import { AccessProfileSelectionPolicyEnvironmentLive } from "../../src/sdk/access-profile-policy-runtime.ts";
import { AccessProfileRegistryLive } from "../../src/sdk/access-profile-runtime.ts";
import { AccessPreviewRequestSchema, ExtractRunRequestSchema } from "../../src/sdk/schemas.ts";
import { BrowserRuntimeLive, resetBrowserPoolForTests } from "../../src/sdk/browser-pool.ts";
import {
  AccessModuleRegistry,
  makeStaticAccessModuleRegistry,
} from "../../src/sdk/access-module-runtime.ts";
import { provideSdkRuntime } from "../../src/sdk/runtime-layer.ts";
import {
  accessPreview,
  extractRun,
  FetchService,
  type FetchClient,
  renderPreview,
  runDoctor,
} from "../../src/sdk/scraper.ts";

function provideExecutionHarness<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  input?: {
    readonly accessExecutionRuntime?: {
      readonly resolve: (
        input: AccessExecutionInput,
      ) => Effect.Effect<ResolvedExecutionIntent, InvalidInputError>;
    };
    readonly accessProviderRegistry?: {
      readonly resolve: (providerId: string) => Effect.Effect<AccessProvider, InvalidInputError>;
      readonly findDescriptor: (providerId: string) => Effect.Effect<
        | {
            readonly id: string;
            readonly capabilities: AccessProvider["capabilities"];
          }
        | undefined
      >;
      readonly listDescriptors: () => Effect.Effect<
        ReadonlyArray<{
          readonly id: string;
          readonly capabilities: AccessProvider["capabilities"];
        }>
      >;
    };
    readonly egressBroker?: {
      readonly acquire: (
        input: EgressBrokerAcquireInput,
      ) => Effect.Effect<ResolvedEgressLease, InvalidInputError | AccessResourceError>;
    };
    readonly identityBroker?: {
      readonly acquire: (
        input: IdentityBrokerAcquireInput,
      ) => Effect.Effect<ResolvedIdentityLease, InvalidInputError | AccessResourceError>;
    };
    readonly accessHealthGateway?: {
      readonly assertHealthy: () => Effect.Effect<void, AccessQuarantinedError, never>;
      readonly recordSuccess: () => Effect.Effect<void, never, never>;
      readonly recordFailure: () => Effect.Effect<void, never, never>;
    };
  },
): Effect.Effect<A, E, never> {
  const providerRegistryLayer =
    input?.accessProviderRegistry === undefined
      ? AccessProviderRegistryLive
      : Layer.succeed(AccessProviderRegistry, input.accessProviderRegistry);
  const selectionPolicyLayer = AccessSelectionPolicyLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        providerRegistryLayer,
        AccessSelectionStrategyLive,
        AccessSelectionHealthSignalsGatewayLive.pipe(Layer.provide(AccessHealthRuntimeLive)),
      ),
    ),
  );
  const engineLayer = AccessExecutionEngineLive.pipe(Layer.provide(providerRegistryLayer));
  const egressBrokerLayer =
    input?.egressBroker === undefined
      ? EgressBrokerEnvironmentLive
      : Layer.succeed(EgressBroker, input.egressBroker);
  const identityBrokerLayer =
    input?.identityBroker === undefined
      ? IdentityBrokerEnvironmentLive
      : Layer.succeed(IdentityBroker, input.identityBroker);
  const runtimeLayer =
    input?.accessExecutionRuntime === undefined
      ? AccessExecutionRuntimeLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              AccessProgramLinkerLive.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    Layer.succeed(
                      AccessModuleRegistry,
                      makeStaticAccessModuleRegistry({
                        modules: [],
                      }),
                    ),
                    providerRegistryLayer,
                    AccessProfileSelectionPolicyEnvironmentLive,
                    AccessProfileRegistryLive,
                    selectionPolicyLayer,
                  ),
                ),
              ),
              providerRegistryLayer,
              AccessProfileSelectionPolicyEnvironmentLive,
              AccessProfileRegistryLive,
              selectionPolicyLayer,
            ),
          ),
        )
      : Layer.succeed(AccessExecutionRuntime, input.accessExecutionRuntime);
  const healthGatewayLayer =
    input?.accessHealthGateway === undefined
      ? AccessHealthGatewayLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              AccessHealthRuntimeLive,
              AccessHealthPolicyRegistryLive,
              AccessHealthSubjectStrategyLive,
            ),
          ),
        )
      : Layer.succeed(AccessHealthGateway, {
          assertHealthy: (_context) => input.accessHealthGateway?.assertHealthy() ?? Effect.void,
          recordSuccess: (_context) => input.accessHealthGateway?.recordSuccess() ?? Effect.void,
          recordFailure: (_context, _error) =>
            input.accessHealthGateway?.recordFailure() ?? Effect.void,
        });
  const coordinatorLayer = AccessExecutionCoordinatorLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        AccessResourceKernelLive.pipe(
          Layer.provide(Layer.mergeAll(egressBrokerLayer, identityBrokerLayer)),
        ),
        healthGatewayLayer,
        engineLayer,
      ),
    ),
  );

  return effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        AccessHealthRuntimeLive,
        AccessHealthPolicyRegistryLive,
        AccessHealthSubjectStrategyLive,
        BrowserRuntimeLive,
        providerRegistryLayer,
        selectionPolicyLayer,
        engineLayer,
        egressBrokerLayer,
        identityBrokerLayer,
        healthGatewayLayer,
        runtimeLayer,
        coordinatorLayer,
      ),
    ),
  ) as Effect.Effect<A, E, never>;
}

function resetSdkBrowserPool() {
  return Effect.runPromise(resetBrowserPoolForTests());
}

describe("scraper guardrails", () => {
  const mockFetch: FetchClient = async (_input, _init) =>
    new Response(
      `<html><head><title>Example title</title></head><body><h1>Hello</h1><h1>World</h1></body></html>`,
      {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );

  it.effect("runDoctor reports runtime health", () =>
    Effect.gen(function* () {
      const report = yield* provideSdkRuntime(runDoctor());
      expect(report.ok).toBe(true);
      expect(report.checks.some((check) => !check.ok)).toBe(false);
    }),
  );

  it.effect("accessPreview rejects malformed payloads with typed errors", () =>
    Effect.gen(function* () {
      const failureMessage = yield* accessPreview({}).pipe(
        Effect.flatMap(() => Effect.die(new Error("Expected InvalidInputError failure"))),
        Effect.catchTag("InvalidInputError", ({ message }) => Effect.succeed(message)),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
        provideSdkRuntime,
        Effect.orDie,
      );
      expect(failureMessage).toContain("Invalid access preview payload");
    }),
  );

  it.effect("accessPreview rejects inherited object keys that bypass exact-shape validation", () =>
    Effect.gen(function* () {
      const failureDetails = yield* accessPreview({
        url: "https://example.com/object-shape",
        toString: 123,
      }).pipe(
        Effect.flatMap(() => Effect.die(new Error("Expected InvalidInputError failure"))),
        Effect.catchTag("InvalidInputError", ({ details }) => Effect.succeed(details ?? "")),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
        provideSdkRuntime,
        Effect.orDie,
      );

      expect(failureDetails).toContain('Unknown property "toString"');
    }),
  );

  it.effect("accessPreview persists health feedback within one explicitly provided runtime", () =>
    Effect.gen(function* () {
      yield* resetAccessHealthGatewayForTests();
      yield* resetAccessBrokerStateForTests();

      const failingRequest = accessPreview({
        url: "https://example.com/quarantined-preview",
        execution: {
          mode: "http",
        },
      }).pipe(
        Effect.match({
          onSuccess: () => "unexpected-success" as const,
          onFailure: (error) => error,
        }),
      );
      const healthState = { failureCount: 0 };

      try {
        const [firstFailure, secondFailure, quarantined] = yield* Effect.gen(function* () {
          const first = yield* failingRequest;
          const second = yield* failingRequest;
          const third = yield* failingRequest;
          return [first, second, third] as const;
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: globalThis.fetch,
          }),
          (next) =>
            provideExecutionHarness(next, {
              accessProviderRegistry: {
                resolve: (providerId) =>
                  Effect.succeed({
                    id: providerId,
                    capabilities: {
                      mode: "http",
                      rendersDom: false,
                    },
                    execute: ({ url }) =>
                      Effect.fail(
                        new NetworkError({
                          message: `Access failed for ${url}`,
                        }),
                      ),
                  }),
                findDescriptor: (providerId) =>
                  Effect.succeed({
                    id: providerId,
                    capabilities: {
                      mode: "http",
                      rendersDom: false,
                    },
                  }),
                listDescriptors: () =>
                  Effect.succeed([
                    {
                      id: "http-basic",
                      capabilities: {
                        mode: "http",
                        rendersDom: false,
                      },
                    },
                  ]),
              },
              accessHealthGateway: {
                assertHealthy: () =>
                  healthState.failureCount >= 2
                    ? Effect.fail(
                        new AccessQuarantinedError({
                          message: "Access path is quarantined",
                          details: "test-gateway",
                        }),
                      )
                    : Effect.void,
                recordSuccess: () => Effect.void,
                recordFailure: () =>
                  Effect.sync(() => {
                    healthState.failureCount += 1;
                  }),
              },
            }),
        );

        expect(firstFailure).toBeInstanceOf(NetworkError);
        expect(secondFailure).toBeInstanceOf(NetworkError);
        expect(quarantined).toBeInstanceOf(AccessQuarantinedError);
      } finally {
        yield* resetAccessHealthGatewayForTests();
        yield* resetAccessBrokerStateForTests();
      }
    }),
  );

  it.effect("accessPreview uses the explicit HTTP mode through the public SDK boundary", () =>
    Effect.gen(function* () {
      yield* resetAccessHealthGatewayForTests();
      yield* resetAccessBrokerStateForTests();
      let requestUrl = "";
      let requestHeaders: HeadersInit | undefined;
      const output = yield* accessPreview({
        url: "https://example.com/http-preview",
        execution: {
          mode: "http",
        },
      }).pipe(
        Effect.provideService(FetchService, {
          fetch: async (input, init) => {
            requestUrl = String(input);
            requestHeaders = init?.headers;

            return new Response(
              "<html><head><title>HTTP Preview</title></head><body></body></html>",
              {
                status: 200,
                headers: { "content-type": "text/html; charset=utf-8" },
              },
            );
          },
        }),
        provideSdkRuntime,
      );

      expect(output.ok).toBe(true);
      expect(output.command).toBe("access preview");
      expect(output.data.url).toBe("https://example.com/http-preview");
      expect(output.data.finalUrl).toBe("https://example.com/http-preview");
      expect(output.data.status).toBe(200);
      expect(output.data.contentType).toBe("text/html; charset=utf-8");
      expect(output.data.execution).toMatchObject({
        providerId: "http-basic",
        mode: "http",
        egressProfileId: "direct",
        egressPluginId: "builtin-direct-egress",
        egressPoolId: "direct-pool",
        egressRoutePolicyId: "direct-route",
        egressRouteKind: "direct",
        egressRouteKey: "direct",
        egressKey: "direct",
        identityProfileId: "default",
        identityPluginId: "builtin-default-identity",
        identityTenantId: "public",
        identityKey: "default",
      });
      expect(output.data.timings).toMatchObject({
        requestCount: 1,
        redirectCount: 0,
        blockedRequestCount: 0,
      });
      expect(output.data.timings?.responseHeadersDurationMs).toBeGreaterThanOrEqual(0);
      expect(output.data.timings?.bodyReadDurationMs).toBeGreaterThanOrEqual(0);
      expect(output.warnings).toEqual([]);
      expect(requestUrl).toBe("https://example.com/http-preview");
      expect(requestHeaders).toEqual(
        expect.objectContaining({
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "user-agent": "effect-scrapling/0.0.1",
        }),
      );
    }),
  );

  it.effect("accessPreview warns when a request resolves to a consent interstitial", () =>
    Effect.gen(function* () {
      const output = yield* accessPreview({
        url: "https://store.example.test/products/sku-1",
        execution: {
          mode: "http",
        },
      }).pipe(
        Effect.provideService(FetchService, {
          fetch: async (input) => {
            const currentUrl = String(input);
            if (currentUrl === "https://store.example.test/products/sku-1") {
              return new Response("", {
                status: 302,
                headers: {
                  location:
                    "https://privacy.example.test/consent/preferences?return_url=%2Fproducts%2Fsku-1",
                },
              });
            }

            return new Response(
              "<html><head><title>Your privacy choices</title></head><body>Before you continue, manage your privacy choices and cookie preferences.</body></html>",
              {
                status: 200,
                headers: { "content-type": "text/html; charset=utf-8" },
              },
            );
          },
        }),
        provideSdkRuntime,
      );

      expect(output.data.finalUrl).toContain("/consent/preferences");
      expect(output.warnings).toContain("access-wall:url-consent");
      expect(output.warnings).toContain("access-wall:title-consent");
      expect(output.warnings).toContain("access-wall:text-consent");
    }),
  );

  it.effect("accessPreview preserves zero-length bodies in metadata", () =>
    Effect.gen(function* () {
      const output = yield* accessPreview({
        url: "https://example.com/empty-preview",
        execution: {
          mode: "http",
        },
      }).pipe(
        Effect.provideService(FetchService, {
          fetch: async () =>
            new Response("", {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
        }),
        provideSdkRuntime,
      );

      expect(output.data.contentLength).toBe(0);
    }),
  );

  it.effect("accessPreview preserves warnings for non-2xx HTML access walls", () =>
    Effect.gen(function* () {
      const output = yield* accessPreview({
        url: "https://store.example.test/products/sku-2",
        execution: {
          mode: "http",
        },
      }).pipe(
        Effect.provideService(FetchService, {
          fetch: async () =>
            new Response(
              "<html><head><title>Attention Required | Security Check</title></head><body>Please verify you are human before continuing.</body></html>",
              {
                status: 403,
                headers: {
                  "content-type": "text/html; charset=utf-8",
                },
              },
            ),
        }),
        provideSdkRuntime,
      );

      expect(output.data.status).toBe(403);
      expect(output.warnings).toContain("access-wall:status-403");
      expect(output.warnings).toContain("access-wall:title-challenge");
      expect(output.warnings).toContain("access-wall:text-challenge");
    }),
  );

  it("accessPreview stays on the explicit HTTP lane when browser fallback is omitted", async () => {
    await resetSdkBrowserPool();
    mock.module("patchright", () => ({
      chromium: {
        launch: async () => {
          throw new Error("browser fallback should stay disabled");
        },
      },
    }));

    try {
      const output = await Effect.runPromise(
        accessPreview({
          url: "https://store.example.test/products/http-only-sku",
          execution: {
            mode: "http",
          },
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: async () =>
              new Response(
                "<html><head><title>Attention Required | Security Check</title></head><body>Please verify you are human before continuing.</body></html>",
                {
                  status: 403,
                  headers: { "content-type": "text/html; charset=utf-8" },
                },
              ),
          }),
          provideSdkRuntime,
        ),
      );

      expect(output.data.execution).toMatchObject({
        providerId: "http-basic",
        mode: "http",
      });
      expect(output.data.status).toBe(403);
      expect(output.warnings).toContain("access-wall:status-403");
      expect(output.warnings).not.toContain(
        "Escalated from HTTP to browser after access wall detection.",
      );
    } finally {
      await resetSdkBrowserPool();
      mock.restore();
    }
  });

  it("accessPreview can escalate from HTTP to browser after detecting an access wall", async () => {
    await resetSdkBrowserPool();
    mock.module("patchright", () => ({
      chromium: {
        launch: async () => ({
          newContext: async (_options: { readonly userAgent: string }) => ({
            newPage: async () => ({
              route: async () => {},
              goto: async () => ({
                status: () => 200,
                allHeaders: async () => ({
                  "content-type": "text/html; charset=utf-8",
                }),
              }),
              waitForLoadState: async () => {},
              content: async () =>
                "<html><head><title>Recovered product page</title></head><body><main>Recovered browser page</main></body></html>",
              url: () => "https://store.example.test/products/sku-3?browser=1",
              close: async () => {},
            }),
            close: async () => {},
          }),
          close: async () => {},
        }),
      },
    }));

    try {
      const output = await Effect.runPromise(
        accessPreview({
          url: "https://store.example.test/products/sku-3",
          execution: {
            mode: "http",
            fallback: {
              browserOnAccessWall: true,
            },
          },
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: async () =>
              new Response(
                "<html><head><title>Your privacy choices</title></head><body>Before you continue, manage your privacy choices and cookie preferences.</body></html>",
                {
                  status: 200,
                  headers: { "content-type": "text/html; charset=utf-8" },
                },
              ),
          }),
          provideSdkRuntime,
        ),
      );

      expect(output.data.execution).toMatchObject({
        providerId: "browser-basic",
        mode: "browser",
      });
      expect(output.data.finalUrl).toBe("https://store.example.test/products/sku-3?browser=1");
      expect(output.warnings).toContain("access-wall:title-consent");
      expect(output.warnings).toContain("access-wall:text-consent");
      expect(output.warnings).toContain(
        "Escalated from HTTP to browser after access wall detection.",
      );
    } finally {
      await resetSdkBrowserPool();
      mock.restore();
    }
  });

  it("accessPreview preserves the original HTTP result when browser escalation fails", async () => {
    await resetSdkBrowserPool();
    mock.module("patchright", () => ({
      chromium: {
        launch: async () => {
          throw new Error("browser bootstrap failed");
        },
      },
    }));

    try {
      const output = await Effect.runPromise(
        accessPreview({
          url: "https://store.example.test/products/sku-4",
          execution: {
            mode: "http",
            fallback: {
              browserOnAccessWall: true,
            },
          },
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: async () =>
              new Response(
                "<html><head><title>Attention Required | Security Check</title></head><body>Please verify you are human before continuing.</body></html>",
                {
                  status: 403,
                  headers: { "content-type": "text/html; charset=utf-8" },
                },
              ),
          }),
          provideSdkRuntime,
        ),
      );

      expect(output.data.execution).toMatchObject({
        providerId: "http-basic",
        mode: "http",
      });
      expect(output.data.status).toBe(403);
      expect(output.warnings).toContain("access-wall:status-403");
      expect(output.warnings).toContain(
        "Escalated from HTTP to browser after access wall detection.",
      );
      expect(
        output.warnings.some((warning) =>
          warning.includes("Browser escalation after access wall detection failed:"),
        ),
      ).toBe(true);
      expect(output.warnings.some((warning) => warning.includes("browser bootstrap failed"))).toBe(
        true,
      );
    } finally {
      await resetSdkBrowserPool();
      mock.restore();
    }
  });

  it.effect("accessPreview escalates generic access walls into the browser lane by default", () =>
    Effect.gen(function* () {
      const output = yield* accessPreview({
        url: "https://store.example.test/products/sku-3",
      }).pipe(
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
        (next) =>
          provideExecutionHarness(next, {
            accessProviderRegistry: {
              resolve: (providerId) =>
                providerId === "http-basic"
                  ? Effect.succeed({
                      id: providerId,
                      capabilities: {
                        mode: "http",
                        rendersDom: false,
                      },
                      execute: ({ url, context }) =>
                        Effect.succeed({
                          url,
                          finalUrl: `${url}?wall=1`,
                          status: 403,
                          contentType: "text/html; charset=utf-8",
                          contentLength: 96,
                          html: "<html><head><title>Attention Required | Security Check</title></head><body>Please verify you are human before continuing.</body></html>",
                          durationMs: 4.5,
                          execution: toExecutionMetadata(context),
                          timings: {
                            requestCount: 1,
                            redirectCount: 0,
                            blockedRequestCount: 0,
                          },
                          warnings: [
                            "access-wall:status-403",
                            "access-wall:title-challenge",
                            "access-wall:text-challenge",
                          ],
                        }),
                    })
                  : Effect.succeed({
                      id: providerId,
                      capabilities: {
                        mode: "browser",
                        rendersDom: true,
                      },
                      execute: ({ url, context }) =>
                        Effect.succeed({
                          url,
                          finalUrl: `${url}?browser=1`,
                          status: 200,
                          contentType: "text/html; charset=utf-8",
                          contentLength: 48,
                          html: "<html><head><title>Browser Recovery</title></head></html>",
                          durationMs: 8.5,
                          execution: toExecutionMetadata(context),
                          timings: {
                            requestCount: 1,
                            redirectCount: 0,
                            blockedRequestCount: 0,
                          },
                          warnings: [],
                        }),
                    }),
              findDescriptor: (providerId) =>
                Effect.succeed(
                  providerId === "http-basic"
                    ? {
                        id: providerId,
                        capabilities: {
                          mode: "http",
                          rendersDom: false,
                        },
                      }
                    : {
                        id: providerId,
                        capabilities: {
                          mode: "browser",
                          rendersDom: true,
                        },
                      },
                ),
              listDescriptors: () =>
                Effect.succeed([
                  {
                    id: "http-basic",
                    capabilities: {
                      mode: "http",
                      rendersDom: false,
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
            },
          }),
      );

      expect(output.data.status).toBe(200);
      expect(output.data.finalUrl).toBe("https://store.example.test/products/sku-3?browser=1");
      expect(output.data.execution.mode).toBe("browser");
      expect(output.data.execution.providerId).toBe("browser-basic");
      expect(output.warnings).toContain("access-wall:status-403");
      expect(output.warnings).toContain("access-wall:title-challenge");
      expect(output.warnings).toContain("access-wall:text-challenge");
      expect(output.warnings).toContain(
        "Escalated from HTTP to browser after access wall detection.",
      );
    }),
  );

  it.effect("accessPreview honors injected execution runtime overrides", () =>
    Effect.gen(function* () {
      yield* resetAccessHealthGatewayForTests();
      yield* resetAccessBrokerStateForTests();
      let requestHeaders: HeadersInit | undefined;

      const output = yield* accessPreview({
        url: "https://example.com/runtime-override",
        timeoutMs: 700,
      }).pipe(
        Effect.provideService(AccessExecutionRuntime, {
          resolve: () =>
            Effect.succeed({
              targetUrl: "https://example.com/runtime-override",
              targetDomain: "example.com",
              providerId: "http-impersonated",
              mode: "http",
              timeoutMs: 700,
              egress: {
                allocationMode: "static",
                pluginId: "test-egress",
                profileId: "vpn-rotator",
                poolId: "vpn-pool",
                routePolicyId: "vpn-policy",
                routeKind: "wireguard",
                routeKey: "wg://prague-1",
                routeConfig: {
                  kind: "wireguard",
                  endpoint: "wg://prague-1",
                  proxyUrl: "socks5://127.0.0.1:9050",
                },
                requestHeaders: {
                  "x-egress-route": "wg://prague-1",
                },
                warnings: [],
              },
              identity: {
                allocationMode: "static",
                pluginId: "test-identity",
                profileId: "persona-a",
                tenantId: "tenant-a",
                browserRuntimeProfileId: "patchright-default",
                httpUserAgent: "Injected Runtime Agent",
                warnings: [],
              },
              http: {
                userAgent: "Injected Runtime Agent",
              },
              warnings: ["runtime override"],
            }),
        }),
        Effect.provideService(FetchService, {
          fetch: async (_input, init) => {
            requestHeaders = init?.headers;

            return new Response("<html><head><title>Runtime Override</title></head></html>", {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          },
        }),
        (next) =>
          provideExecutionHarness(next, {
            accessExecutionRuntime: {
              resolve: () =>
                Effect.succeed({
                  targetUrl: "https://example.com/runtime-override",
                  targetDomain: "example.com",
                  providerId: "http-impersonated",
                  mode: "http",
                  timeoutMs: 700,
                  egress: {
                    allocationMode: "static",
                    pluginId: "test-egress",
                    profileId: "vpn-rotator",
                    poolId: "vpn-pool",
                    routePolicyId: "vpn-policy",
                    routeKind: "wireguard",
                    routeKey: "wg://prague-1",
                    routeConfig: {
                      kind: "wireguard",
                      endpoint: "wg://prague-1",
                      proxyUrl: "socks5://127.0.0.1:9050",
                    },
                    requestHeaders: {
                      "x-egress-route": "wg://prague-1",
                    },
                    warnings: [],
                  },
                  identity: {
                    allocationMode: "static",
                    pluginId: "test-identity",
                    profileId: "persona-a",
                    tenantId: "tenant-a",
                    browserRuntimeProfileId: "patchright-default",
                    httpUserAgent: "Injected Runtime Agent",
                    warnings: [],
                  },
                  http: {
                    userAgent: "Injected Runtime Agent",
                  },
                  warnings: ["runtime override"],
                }),
            },
            egressBroker: {
              acquire: ({ plan }) =>
                Effect.succeed({
                  ...plan.egress,
                  transportBinding: {
                    kind: "wireguard",
                    routeKind: "wireguard",
                    endpoint: "wg://prague-1",
                    proxyUrl: "socks5://127.0.0.1:9050",
                    diagnostics: {
                      routeKind: "wireguard",
                      routeConfigKind: "wireguard",
                    },
                  },
                  egressKey: plan.egress.routeKey,
                  release: Effect.void,
                }),
            },
            identityBroker: {
              acquire: ({ plan }) =>
                Effect.succeed({
                  ...plan.identity,
                  identityKey: plan.identity.profileId,
                  release: Effect.void,
                }),
            },
          }),
      );

      expect(output.data.execution).toMatchObject({
        providerId: "http-impersonated",
        mode: "http",
        egressProfileId: "vpn-rotator",
        egressPluginId: "test-egress",
        egressRouteKind: "wireguard",
        egressRouteKey: "wg://prague-1",
        egressPoolId: "vpn-pool",
        egressRoutePolicyId: "vpn-policy",
        identityProfileId: "persona-a",
        identityPluginId: "test-identity",
        identityTenantId: "tenant-a",
      });
      expect(output.data.execution.egressKey).toBe("wg://prague-1");
      expect(output.data.execution.identityKey).toBe("persona-a");
      expect(output.warnings).toEqual(["runtime override"]);
      expect(requestHeaders).toEqual(
        expect.objectContaining({
          "user-agent": "Injected Runtime Agent",
          "x-egress-route": "wg://prague-1",
        }),
      );
    }),
  );

  it.effect("extractRun passes the dedicated extract command into the execution runtime", () =>
    Effect.gen(function* () {
      yield* resetAccessHealthGatewayForTests();
      yield* resetAccessBrokerStateForTests();
      let seenCommand: AccessExecutionInput["command"] | undefined;

      const output = yield* extractRun({
        url: "https://example.com/extract-runtime-command",
        selector: "h1",
      }).pipe(
        Effect.provideService(FetchService, {
          fetch: async (_input) =>
            new Response("<html><body><h1>Extract Runtime Command</h1></body></html>", {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
        }),
        (next) =>
          provideExecutionHarness(next, {
            accessExecutionRuntime: {
              resolve: (input) => {
                seenCommand = input.command;
                return Effect.succeed({
                  targetUrl: input.url,
                  targetDomain: "example.com",
                  providerId: "http-basic",
                  mode: "http",
                  timeoutMs: input.defaultTimeoutMs,
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
                    warnings: [],
                  },
                  http: {
                    userAgent: "effect-scrapling/0.0.1",
                  },
                  warnings: [],
                });
              },
            },
            egressBroker: {
              acquire: ({ plan }) =>
                Effect.succeed({
                  ...plan.egress,
                  egressKey: plan.egress.routeKey,
                  release: Effect.void,
                }),
            },
            identityBroker: {
              acquire: ({ plan }) =>
                Effect.succeed({
                  ...plan.identity,
                  identityKey: plan.identity.profileId,
                  release: Effect.void,
                }),
            },
          }),
      );

      expect(seenCommand).toBe("extract");
      expect(output.command).toBe("extract run");
      expect(output.data.values).toEqual(["Extract Runtime Command"]);
    }),
  );

  it.effect(
    "accessPreview honors injected provider registry without replacing the whole engine",
    () =>
      Effect.gen(function* () {
        yield* resetAccessHealthGatewayForTests();
        yield* resetAccessBrokerStateForTests();
        const output = yield* accessPreview({
          url: "https://example.com/provider-registry-override",
          execution: {
            mode: "http",
          },
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: globalThis.fetch,
          }),
          (next) =>
            provideExecutionHarness(next, {
              accessProviderRegistry: {
                resolve: (providerId) =>
                  Effect.succeed({
                    id: providerId,
                    capabilities: {
                      mode: "http",
                      rendersDom: false,
                    },
                    execute: ({ url, context }) =>
                      Effect.succeed({
                        url,
                        finalUrl: `${url}?provider=${providerId}`,
                        status: 200,
                        contentType: "text/html; charset=utf-8",
                        contentLength: 13,
                        html: "<html></html>",
                        durationMs: 6.5,
                        execution: toExecutionMetadata(context),
                        timings: {
                          requestCount: 1,
                          redirectCount: 0,
                          blockedRequestCount: 0,
                        },
                        warnings: [...context.warnings, "provider registry override"],
                      }),
                  }),
                findDescriptor: (providerId) =>
                  Effect.succeed({
                    id: providerId,
                    capabilities: {
                      mode: "http",
                      rendersDom: false,
                    },
                  }),
                listDescriptors: () =>
                  Effect.succeed([
                    {
                      id: "http-basic",
                      capabilities: {
                        mode: "http",
                        rendersDom: false,
                      },
                    },
                  ]),
              },
            }),
        );

        expect(output.data.finalUrl).toBe(
          "https://example.com/provider-registry-override?provider=http-basic",
        );
        expect(output.warnings).toEqual(["provider registry override"]);
      }),
  );

  it.effect("provideSdkRuntime accepts explicit override layers for provider registry", () =>
    Effect.gen(function* () {
      const providerOverrideLayer = Layer.succeed(AccessProviderRegistry, {
        resolve: (providerId) =>
          Effect.succeed({
            id: providerId,
            capabilities: {
              mode: "http",
              rendersDom: false,
            },
            execute: ({ url, context }) =>
              Effect.succeed({
                url,
                finalUrl: `${url}?root=override`,
                status: 200,
                contentType: "text/html; charset=utf-8",
                contentLength: 13,
                html: "<html></html>",
                durationMs: 3.5,
                execution: toExecutionMetadata(context),
                timings: {
                  requestCount: 1,
                  redirectCount: 0,
                  blockedRequestCount: 0,
                },
                warnings: ["root provider override"],
              }),
          }),
        findDescriptor: (providerId) =>
          Effect.succeed({
            id: providerId,
            capabilities: {
              mode: "http",
              rendersDom: false,
            },
          }),
        listDescriptors: () =>
          Effect.succeed([
            {
              id: "http-basic",
              capabilities: {
                mode: "http",
                rendersDom: false,
              },
            },
          ]),
      });
      const output = yield* accessPreview({
        url: "https://example.com/root-provider-override",
        execution: {
          mode: "http",
        },
      }).pipe(
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
        (next) => provideSdkRuntime(next, providerOverrideLayer),
      );

      expect(output.data.finalUrl).toBe("https://example.com/root-provider-override?root=override");
      expect(output.warnings).toEqual(["root provider override"]);
    }),
  );

  it("renderPreview produces a typed browser status envelope and deterministic artifact bundle", async () => {
    await resetSdkBrowserPool();
    mock.module("patchright", () => ({
      chromium: {
        launch: async () => ({
          newContext: async (_options: { readonly userAgent: string }) => ({
            newPage: async () => ({
              route: async () => {},
              goto: async () => ({
                status: () => 200,
                allHeaders: async () => ({
                  "content-type": "text/html; charset=utf-8",
                }),
              }),
              waitForLoadState: async () => {},
              content: async () =>
                '<html><head><title>Effect Scrapling</title></head><body><a href="/products/sku-123">Product</a><input type="hidden" value="secret" /><main> Rendered browser preview body </main></body></html>',
              url: () => "https://example.com/products/sku-123",
              close: async () => {},
            }),
            close: async () => {},
          }),
          close: async () => {},
        }),
      },
    }));

    try {
      const output = await Effect.runPromise(
        renderPreview({
          url: "https://example.com/products/sku-123",
          execution: {
            providerId: "browser-basic",
            browser: {
              waitUntil: "commit",
              timeoutMs: "450",
              userAgent: "SDK Browser",
            },
          },
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: globalThis.fetch,
          }),
          provideSdkRuntime,
        ),
      );

      expect(output.ok).toBe(true);
      expect(output.command).toBe("render preview");
      expect(output.data.execution).toMatchObject({
        providerId: "browser-basic",
        mode: "browser",
        egressProfileId: "direct",
        egressPluginId: "builtin-direct-egress",
        egressPoolId: "direct-pool",
        egressRoutePolicyId: "direct-route",
        egressRouteKind: "direct",
        egressRouteKey: "direct",
        egressKey: "direct",
        identityProfileId: "default",
        identityPluginId: "builtin-default-identity",
        identityTenantId: "public",
        identityKey: "default",
        browserRuntimeProfileId: "patchright-default",
        browserPoolKey: "browser-basic::patchright-default::direct::default",
      });
      expect(output.data.status).toEqual({
        code: 200,
        ok: true,
        redirected: false,
        family: "success",
      });
      expect(output.data.artifacts.map(({ kind }) => kind)).toEqual([
        "navigation",
        "renderedDom",
        "timings",
      ]);
      expect(output.data.artifacts[0]).toEqual({
        kind: "navigation",
        mediaType: "application/json",
        finalUrl: "https://example.com/products/sku-123",
        contentType: "text/html; charset=utf-8",
        contentLength: 191,
      });
      expect(output.data.artifacts[1]).toEqual({
        kind: "renderedDom",
        mediaType: "application/json",
        title: "Effect Scrapling",
        textPreview: "Product Rendered browser preview body",
        linkTargets: ["https://example.com/products/sku-123"],
        hiddenFieldCount: 1,
      });
      expect(output.data.artifacts[2]).toMatchObject({
        kind: "timings",
        mediaType: "application/json",
        requestCount: 1,
        redirectCount: 0,
        blockedRequestCount: 0,
      });
      expect(output.data.artifacts[2]?.durationMs).toBeGreaterThan(0);
      expect(output.data.artifacts[2]?.routeRegistrationDurationMs).toBeGreaterThanOrEqual(0);
      expect(output.data.artifacts[2]?.gotoDurationMs).toBeGreaterThanOrEqual(0);
      expect(output.data.artifacts[2]?.loadStateDurationMs).toBeUndefined();
      expect(output.data.artifacts[2]?.domReadDurationMs).toBeGreaterThanOrEqual(0);
      expect(output.data.artifacts[2]?.headerReadDurationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await resetSdkBrowserPool();
      mock.restore();
    }
  });

  it("renderPreview warns when the browser lands on a challenge interstitial", async () => {
    await resetSdkBrowserPool();
    mock.module("patchright", () => ({
      chromium: {
        launch: async () => ({
          newContext: async (_options: { readonly userAgent: string }) => ({
            newPage: async () => ({
              route: async () => {},
              goto: async () => ({
                status: () => 200,
                allHeaders: async () => ({
                  "content-type": "text/html; charset=utf-8",
                }),
              }),
              waitForLoadState: async () => {},
              content: async () =>
                "<html><head><title>Attention Required! | Security Check</title></head><body>Please verify you are human before continuing.</body></html>",
              url: () => "https://edge.example.test/challenge?return_url=%2Fproducts%2Fsku-123",
              close: async () => {},
            }),
            close: async () => {},
          }),
          close: async () => {},
        }),
      },
    }));

    try {
      const output = await Effect.runPromise(
        renderPreview({
          url: "https://store.example.test/products/sku-123",
          execution: {
            providerId: "browser-basic",
          },
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: globalThis.fetch,
          }),
          provideSdkRuntime,
        ),
      );

      expect(output.data.status.code).toBe(200);
      expect(output.warnings).toContain("access-wall:url-challenge");
      expect(output.warnings).toContain("access-wall:title-challenge");
      expect(output.warnings).toContain("access-wall:text-challenge");
    } finally {
      await resetSdkBrowserPool();
      mock.restore();
    }
  });

  it("renderPreview reports redirect responses as non-ok", async () => {
    await resetSdkBrowserPool();
    mock.module("patchright", () => ({
      chromium: {
        launch: async () => ({
          newContext: async (_options: { readonly userAgent: string }) => ({
            newPage: async () => ({
              route: async () => {},
              goto: async () => ({
                status: () => 302,
                allHeaders: async () => ({
                  "content-type": "text/html; charset=utf-8",
                }),
              }),
              waitForLoadState: async () => {},
              content: async () =>
                "<html><head><title>Redirected</title></head><body>Redirect target</body></html>",
              url: () => "https://example.com/products/sku-redirected",
              close: async () => {},
            }),
            close: async () => {},
          }),
          close: async () => {},
        }),
      },
    }));

    try {
      const output = await Effect.runPromise(
        renderPreview({
          url: "https://example.com/products/sku-redirect",
          execution: {
            providerId: "browser-basic",
          },
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: globalThis.fetch,
          }),
          provideSdkRuntime,
        ),
      );

      expect(output.data.status).toEqual({
        code: 302,
        ok: false,
        redirected: true,
        family: "redirect",
      });
    } finally {
      await resetSdkBrowserPool();
      mock.restore();
    }
  });

  it("trims request string literals before schema validation", () => {
    expect(
      Schema.decodeUnknownSync(AccessPreviewRequestSchema)({
        url: "https://example.com",
        timeoutMs: "300",
        execution: {
          mode: " browser ",
          providerId: " browser-stealth ",
          egress: {
            profileId: " direct ",
          },
          identity: {
            profileId: " stealth-default ",
          },
          browserRuntimeProfileId: " patchright-stealth ",
          http: {
            userAgent: " Agent ",
          },
          browser: {
            waitUntil: " load ",
          },
        },
      }),
    ).toEqual({
      url: "https://example.com",
      timeoutMs: 300,
      execution: {
        mode: "browser",
        providerId: "browser-stealth",
        egress: {
          profileId: "direct",
          pluginConfig: undefined,
        },
        identity: {
          profileId: "stealth-default",
          pluginConfig: undefined,
        },
        browserRuntimeProfileId: "patchright-stealth",
        http: {
          userAgent: "Agent",
        },
        browser: {
          waitUntil: "load",
          timeoutMs: undefined,
          userAgent: undefined,
        },
      },
    });

    expect(
      Schema.decodeUnknownSync(ExtractRunRequestSchema)({
        url: "https://example.com",
        execution: {
          providerId: " http-impersonated ",
        },
      }),
    ).toEqual({
      url: "https://example.com",
      selector: "title",
      attr: undefined,
      all: false,
      limit: 20,
      timeoutMs: 15_000,
      execution: {
        providerId: "http-impersonated",
        http: undefined,
        browser: undefined,
        egress: undefined,
        identity: undefined,
        browserRuntimeProfileId: undefined,
      },
    });
  });

  it.effect("extractRun returns deterministic values from HTML", () =>
    Effect.gen(function* () {
      yield* resetAccessHealthGatewayForTests();
      yield* resetAccessBrokerStateForTests();
      const output = yield* extractRun({
        url: "https://example.com",
        selector: "h1",
        all: true,
        limit: 5,
      }).pipe(
        Effect.provideService(FetchService, {
          fetch: mockFetch,
        }),
        provideSdkRuntime,
      );

      expect(output.ok).toBe(true);
      expect(output.command).toBe("extract run");
      expect(output.data.count).toBe(2);
      expect(output.data.values).toEqual(["Hello", "World"]);
    }),
  );

  it.effect("extractRun applies schema defaults for selector, limit, and boolean flags", () =>
    Effect.gen(function* () {
      yield* resetAccessHealthGatewayForTests();
      yield* resetAccessBrokerStateForTests();
      const output = yield* extractRun({
        url: "https://example.com",
      }).pipe(
        Effect.provideService(FetchService, {
          fetch: mockFetch,
        }),
        provideSdkRuntime,
      );

      expect(output.ok).toBe(true);
      expect(output.data.selector).toBe("title");
      expect(output.data.count).toBe(1);
      expect(output.data.values).toEqual(["Example title"]);
      expect(output.warnings).toEqual([]);
    }),
  );

  it.effect(
    "extractRun accepts stringified numeric and boolean inputs through the shared schema",
    () =>
      Effect.gen(function* () {
        yield* resetAccessHealthGatewayForTests();
        yield* resetAccessBrokerStateForTests();
        const output = yield* extractRun({
          url: "https://example.com",
          selector: "h1",
          all: "TRUE",
          limit: "05",
          timeoutMs: "300",
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: mockFetch,
          }),
          provideSdkRuntime,
        );

        expect(output.ok).toBe(true);
        expect(output.data.selector).toBe("h1");
        expect(output.data.count).toBe(2);
        expect(output.data.values).toEqual(["Hello", "World"]);
      }),
  );

  it("extractRun can escalate from HTTP to browser after detecting an access wall", async () => {
    await resetSdkBrowserPool();
    mock.module("patchright", () => ({
      chromium: {
        launch: async () => ({
          newContext: async (_options: { readonly userAgent: string }) => ({
            newPage: async () => ({
              route: async () => {},
              goto: async () => ({
                status: () => 200,
                allHeaders: async () => ({
                  "content-type": "text/html; charset=utf-8",
                }),
              }),
              waitForLoadState: async () => {},
              content: async () =>
                "<html><head><title>Recovered extract page</title></head><body><h1>Recovered browser value</h1></body></html>",
              url: () => "https://store.example.test/products/sku-5?browser=1",
              close: async () => {},
            }),
            close: async () => {},
          }),
          close: async () => {},
        }),
      },
    }));

    try {
      const output = await Effect.runPromise(
        extractRun({
          url: "https://store.example.test/products/sku-5",
          selector: "h1",
          execution: {
            mode: "http",
            fallback: {
              browserOnAccessWall: true,
            },
          },
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: async () =>
              new Response(
                "<html><head><title>Your privacy choices</title></head><body>Before you continue, manage your privacy choices and cookie preferences.</body></html>",
                {
                  status: 200,
                  headers: { "content-type": "text/html; charset=utf-8" },
                },
              ),
          }),
          provideSdkRuntime,
        ),
      );

      expect(output.data.execution).toMatchObject({
        providerId: "browser-basic",
        mode: "browser",
      });
      expect(output.data.count).toBe(1);
      expect(output.data.values).toEqual(["Recovered browser value"]);
      expect(output.warnings).toContain("access-wall:title-consent");
      expect(output.warnings).toContain(
        "Escalated from HTTP to browser after access wall detection.",
      );
    } finally {
      await resetSdkBrowserPool();
      mock.restore();
    }
  });

  it.effect("renderPreview rejects malformed payloads with typed errors", () =>
    Effect.gen(function* () {
      const failureMessage = yield* renderPreview({}).pipe(
        Effect.flatMap(() => Effect.die(new Error("Expected InvalidInputError failure"))),
        Effect.catchTag("InvalidInputError", ({ message }) => Effect.succeed(message)),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
        provideSdkRuntime,
        Effect.orDie,
      );
      expect(failureMessage).toContain("Invalid render preview payload");
    }),
  );
});
