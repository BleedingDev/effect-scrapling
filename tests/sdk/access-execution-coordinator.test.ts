import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Layer } from "effect";
import { BrowserRuntimeLive } from "../../src/sdk/browser-pool.ts";
import {
  AccessExecutionCoordinator,
  AccessExecutionCoordinatorLive,
} from "../../src/sdk/access-execution-coordinator.ts";
import { AccessExecutionEngine } from "../../src/sdk/access-execution-engine.ts";
import { AccessResourceKernelLive } from "../../src/sdk/access-resource-kernel.ts";
import { EgressBroker, IdentityBroker } from "../../src/sdk/access-broker-runtime.ts";
import { AccessHealthGateway } from "../../src/sdk/access-health-gateway.ts";
import { InvalidInputError } from "../../src/sdk/errors.ts";
import { FetchService } from "../../src/sdk/fetch-service.ts";
import {
  type ResolvedBrowserFallbackExecution,
  type ResolvedExecutionPlan,
} from "../../src/sdk/access-runtime.ts";

const basePlan: ResolvedExecutionPlan = {
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

const { http: _unusedHttpPlan, ...browserFallbackBasePlan } = basePlan;

const browserFallbackPlan: ResolvedBrowserFallbackExecution = {
  ...browserFallbackBasePlan,
  providerId: "browser-basic",
  mode: "browser",
  timeoutMs: 700,
  browser: {
    runtimeProfileId: "patchright-default",
    waitUntil: "domcontentloaded",
    timeoutMs: 700,
    userAgent: "browser-agent",
  },
};

describe("sdk access execution coordinator", () => {
  it.effect("releases the acquired egress lease when identity acquisition fails", () =>
    Effect.gen(function* () {
      let released = 0;
      const failure = yield* Effect.gen(function* () {
        const coordinator = yield* AccessExecutionCoordinator;
        return yield* coordinator.execute({
          url: basePlan.targetUrl,
          intent: basePlan,
        });
      }).pipe(
        Effect.match({
          onSuccess: () => undefined,
          onFailure: (error) => error,
        }),
        Effect.provide(
          AccessExecutionCoordinatorLive.pipe(Layer.provide(AccessResourceKernelLive)),
        ),
        Effect.provideService(EgressBroker, {
          acquire: () =>
            Effect.succeed({
              ...basePlan.egress,
              egressKey: "direct-lease",
              leaseId: "egress-lease-1",
              release: Effect.sync(() => {
                released += 1;
              }),
            }),
        }),
        Effect.provideService(IdentityBroker, {
          acquire: () =>
            Effect.fail(
              new InvalidInputError({
                message: "Identity acquisition failed",
              }),
            ),
        }),
        Effect.provideService(AccessHealthGateway, {
          assertHealthy: () => Effect.void,
          recordSuccess: () => Effect.void,
          recordFailure: () => Effect.void,
        }),
        Effect.provideService(AccessExecutionEngine, {
          execute: () =>
            Effect.die(new Error("Engine should not run when identity acquisition fails")),
        }),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
        Effect.provide(BrowserRuntimeLive),
      );

      expect(failure?._tag).toBe("InvalidInputError");
      expect(released).toBe(1);
    }),
  );

  it.effect("escalates HTTP access-wall results into the browser fallback lane", () => {
    const successContexts: string[] = [];
    const failureContexts: string[] = [];
    const assertedContexts: string[] = [];

    return Effect.gen(function* () {
      const coordinator = yield* AccessExecutionCoordinator;
      const execution = yield* coordinator.execute({
        url: basePlan.targetUrl,
        intent: {
          ...basePlan,
          fallback: {
            browserOnAccessWall: browserFallbackPlan,
          },
        },
      });

      expect(execution.context.providerId).toBe("browser-basic");
      expect(execution.result.finalUrl).toBe("https://example.com/products/sku-1?browser=1");
      expect(execution.warnings).toContain("access-wall:status-403");
      expect(execution.warnings).toContain("access-wall:title-challenge");
      expect(execution.warnings).toContain("access-wall:text-challenge");
      expect(execution.warnings).toContain(
        "Escalated from HTTP to browser after access wall detection.",
      );
      expect(assertedContexts).toEqual(["http-basic"]);
      expect(successContexts).toEqual(["browser-basic"]);
      expect(failureContexts).toEqual(["http-basic"]);
    }).pipe(
      Effect.provide(AccessExecutionCoordinatorLive.pipe(Layer.provide(AccessResourceKernelLive))),
      Effect.provideService(EgressBroker, {
        acquire: ({ plan }) =>
          Effect.succeed({
            ...plan.egress,
            egressKey: `${plan.providerId}-egress`,
            leaseId: `${plan.providerId}-egress-lease`,
            release: Effect.void,
          }),
      }),
      Effect.provideService(IdentityBroker, {
        acquire: ({ plan }) =>
          Effect.succeed({
            ...plan.identity,
            identityKey: `${plan.providerId}-identity`,
            leaseId: `${plan.providerId}-identity-lease`,
            release: Effect.void,
          }),
      }),
      Effect.provideService(AccessHealthGateway, {
        assertHealthy: ({ context }) =>
          Effect.sync(() => {
            assertedContexts.push(context.providerId);
          }),
        recordSuccess: ({ context }) =>
          Effect.sync(() => {
            successContexts.push(context.providerId);
          }),
        recordFailure: ({ context }) =>
          Effect.sync(() => {
            failureContexts.push(context.providerId);
          }),
      }),
      Effect.provideService(AccessExecutionEngine, {
        execute: ({ url, context }) =>
          context.mode === "http"
            ? Effect.succeed({
                url,
                finalUrl: `${url}?wall=1`,
                status: 403,
                contentType: "text/html; charset=utf-8",
                contentLength: 64,
                html: "<html><title>Security Check</title><body>Please verify you are human</body></html>",
                durationMs: 5,
                execution: {
                  providerId: context.providerId,
                  mode: context.mode,
                  egressProfileId: context.egress.profileId,
                  egressPluginId: context.egress.pluginId,
                  egressRouteKind: context.egress.routeKind,
                  egressRouteKey: context.egress.routeKey,
                  egressPoolId: context.egress.poolId,
                  egressRoutePolicyId: context.egress.routePolicyId,
                  egressKey: context.egress.egressKey,
                  identityProfileId: context.identity.profileId,
                  identityPluginId: context.identity.pluginId,
                  identityTenantId: context.identity.tenantId,
                  identityKey: context.identity.identityKey,
                },
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
              })
            : Effect.succeed({
                url,
                finalUrl: `${url}?browser=1`,
                status: 200,
                contentType: "text/html; charset=utf-8",
                contentLength: 64,
                html: "<html><title>OK</title><body>ready</body></html>",
                durationMs: 9,
                execution: {
                  providerId: context.providerId,
                  mode: context.mode,
                  egressProfileId: context.egress.profileId,
                  egressPluginId: context.egress.pluginId,
                  egressRouteKind: context.egress.routeKind,
                  egressRouteKey: context.egress.routeKey,
                  egressPoolId: context.egress.poolId,
                  egressRoutePolicyId: context.egress.routePolicyId,
                  egressKey: context.egress.egressKey,
                  identityProfileId: context.identity.profileId,
                  identityPluginId: context.identity.pluginId,
                  identityTenantId: context.identity.tenantId,
                  identityKey: context.identity.identityKey,
                  browserRuntimeProfileId: context.browser?.runtimeProfileId,
                  browserPoolKey: context.browser?.poolKey,
                },
                timings: {
                  requestCount: 1,
                  redirectCount: 0,
                  blockedRequestCount: 0,
                },
                warnings: [],
              }),
      }),
      Effect.provideService(FetchService, {
        fetch: globalThis.fetch,
      }),
      Effect.provide(BrowserRuntimeLive),
    );
  });

  it.effect(
    "allows browser fallback even when the health gate quarantines the primary HTTP lane",
    () => {
      const assertedContexts: string[] = [];

      return Effect.gen(function* () {
        const coordinator = yield* AccessExecutionCoordinator;
        const execution = yield* coordinator.execute({
          url: basePlan.targetUrl,
          intent: {
            ...basePlan,
            fallback: {
              browserOnAccessWall: browserFallbackPlan,
            },
          },
        });

        expect(execution.context.providerId).toBe("browser-basic");
        expect(execution.result.finalUrl).toBe("https://example.com/products/sku-1?browser=1");
        expect(assertedContexts).toEqual(["http-basic"]);
        expect(execution.warnings).toContain(
          "Escalated from HTTP to browser after access wall detection.",
        );
      }).pipe(
        Effect.provide(
          AccessExecutionCoordinatorLive.pipe(Layer.provide(AccessResourceKernelLive)),
        ),
        Effect.provideService(EgressBroker, {
          acquire: ({ plan }) =>
            Effect.succeed({
              ...plan.egress,
              egressKey: `${plan.providerId}-egress`,
              leaseId: `${plan.providerId}-egress-lease`,
              release: Effect.void,
            }),
        }),
        Effect.provideService(IdentityBroker, {
          acquire: ({ plan }) =>
            Effect.succeed({
              ...plan.identity,
              identityKey: `${plan.providerId}-identity`,
              leaseId: `${plan.providerId}-identity-lease`,
              release: Effect.void,
            }),
        }),
        Effect.provideService(AccessHealthGateway, {
          assertHealthy: ({ context }) =>
            context.providerId === "browser-basic"
              ? Effect.die(new Error("Browser fallback should bypass preflight quarantine checks"))
              : Effect.sync(() => {
                  assertedContexts.push(context.providerId);
                }),
          recordSuccess: () => Effect.void,
          recordFailure: () => Effect.void,
        }),
        Effect.provideService(AccessExecutionEngine, {
          execute: ({ url, context }) =>
            context.mode === "http"
              ? Effect.succeed({
                  url,
                  finalUrl: `${url}?wall=1`,
                  status: 403,
                  contentType: "text/html; charset=utf-8",
                  contentLength: 64,
                  html: "<html><title>Security Check</title><body>Please verify you are human</body></html>",
                  durationMs: 5,
                  execution: {
                    providerId: context.providerId,
                    mode: context.mode,
                    egressProfileId: context.egress.profileId,
                    egressPluginId: context.egress.pluginId,
                    egressRouteKind: context.egress.routeKind,
                    egressRouteKey: context.egress.routeKey,
                    egressPoolId: context.egress.poolId,
                    egressRoutePolicyId: context.egress.routePolicyId,
                    egressKey: context.egress.egressKey,
                    identityProfileId: context.identity.profileId,
                    identityPluginId: context.identity.pluginId,
                    identityTenantId: context.identity.tenantId,
                    identityKey: context.identity.identityKey,
                  },
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
                })
              : Effect.succeed({
                  url,
                  finalUrl: `${url}?browser=1`,
                  status: 200,
                  contentType: "text/html; charset=utf-8",
                  contentLength: 64,
                  html: "<html><title>OK</title><body>ready</body></html>",
                  durationMs: 9,
                  execution: {
                    providerId: context.providerId,
                    mode: context.mode,
                    egressProfileId: context.egress.profileId,
                    egressPluginId: context.egress.pluginId,
                    egressRouteKind: context.egress.routeKind,
                    egressRouteKey: context.egress.routeKey,
                    egressPoolId: context.egress.poolId,
                    egressRoutePolicyId: context.egress.routePolicyId,
                    egressKey: context.egress.egressKey,
                    identityProfileId: context.identity.profileId,
                    identityPluginId: context.identity.pluginId,
                    identityTenantId: context.identity.tenantId,
                    identityKey: context.identity.identityKey,
                    browserRuntimeProfileId: context.browser?.runtimeProfileId,
                    browserPoolKey: context.browser?.poolKey,
                  },
                  timings: {
                    requestCount: 1,
                    redirectCount: 0,
                    blockedRequestCount: 0,
                  },
                  warnings: [],
                }),
        }),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
        Effect.provide(BrowserRuntimeLive),
      );
    },
  );
});
