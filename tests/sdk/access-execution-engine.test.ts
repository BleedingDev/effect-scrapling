import { describe, expect, it } from "@effect-native/bun-test";
import { Effect } from "effect";
import { BrowserRuntimeLive } from "../../src/sdk/browser-pool.ts";
import {
  AccessExecutionEngine,
  AccessExecutionEngineLive,
} from "../../src/sdk/access-execution-engine.ts";
import { AccessProviderRegistry } from "../../src/sdk/access-provider-runtime.ts";
import { FetchService } from "../../src/sdk/fetch-service.ts";

describe("sdk access execution engine", () => {
  it.effect("executes through an injected provider registry", () =>
    Effect.gen(function* () {
      const output = yield* Effect.gen(function* () {
        const engine = yield* AccessExecutionEngine;
        return yield* engine.execute({
          url: "https://example.com/provider-plugin",
          context: {
            targetUrl: "https://example.com/provider-plugin",
            targetDomain: "example.com",
            providerId: "http-basic",
            mode: "http",
            timeoutMs: 900,
            egress: {
              allocationMode: "leased",
              pluginId: "test-egress",
              profileId: "wireguard-prague",
              poolId: "wireguard-pool",
              routePolicyId: "wireguard-policy",
              routeKind: "wireguard",
              routeKey: "wg://prague",
              egressKey: "prague-egress",
              requestHeaders: {
                "x-egress-route": "wg://prague",
              },
              warnings: ["egress warning"],
              release: Effect.void,
            },
            identity: {
              allocationMode: "leased",
              pluginId: "test-identity",
              profileId: "persona-a",
              tenantId: "tenant-a",
              identityKey: "identity-a",
              browserRuntimeProfileId: "patchright-default",
              httpUserAgent: "Provider Agent",
              warnings: ["identity warning"],
              release: Effect.void,
            },
            http: {
              userAgent: "Provider Agent",
            },
            warnings: ["context warning"],
          },
        });
      }).pipe(
        Effect.provide(AccessExecutionEngineLive),
        Effect.provideService(AccessProviderRegistry, {
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
                  finalUrl: `${url}?via=${context.egress.profileId}`,
                  status: 200,
                  contentType: "text/html; charset=utf-8",
                  contentLength: 17,
                  html: "<html></html>",
                  durationMs: 12.5,
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
                  warnings: [...context.warnings, "provider warning"],
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
        }),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
        Effect.provide(BrowserRuntimeLive),
      );

      expect(output.finalUrl).toBe("https://example.com/provider-plugin?via=wireguard-prague");
      expect(output.warnings).toEqual(["context warning", "provider warning"]);
    }),
  );

  it.effect(
    "rejects registry providers whose capabilities disagree with the resolved context",
    () =>
      Effect.gen(function* () {
        const failure = yield* Effect.gen(function* () {
          const engine = yield* AccessExecutionEngine;
          return yield* engine.execute({
            url: "https://example.com/provider-mismatch",
            context: {
              targetUrl: "https://example.com/provider-mismatch",
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
                profileId: "default",
                tenantId: "tenant-a",
                identityKey: "default",
                browserRuntimeProfileId: "patchright-default",
                warnings: [],
                release: Effect.void,
              },
              warnings: [],
            },
          });
        }).pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => undefined,
          }),
          Effect.provide(AccessExecutionEngineLive),
          Effect.provideService(AccessProviderRegistry, {
            resolve: (providerId) =>
              Effect.succeed({
                id: providerId,
                capabilities: {
                  mode: "browser",
                  rendersDom: true,
                },
                execute: () =>
                  Effect.die(new Error("provider should not execute when capabilities mismatch")),
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
                  id: "http-basic",
                  capabilities: {
                    mode: "browser",
                    rendersDom: true,
                  },
                },
              ]),
          }),
          Effect.provideService(FetchService, {
            fetch: globalThis.fetch,
          }),
          Effect.provide(BrowserRuntimeLive),
        );

        expect(failure?._tag).toBe("InvalidInputError");
        expect(failure?.message).toBe("Execution context/provider mode mismatch");
      }),
  );
});
