import { describe, expect, it } from "@effect-native/bun-test";
import { Effect } from "effect";
import {
  createEngine,
  defineAccessModule,
  type CreateAccessEngineOptions,
} from "effect-scrapling/sdk";

const mockFetch = async (input: RequestInfo | URL) => {
  const response = new Response("<html><body><h1>Public Engine</h1></body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  Object.defineProperty(response, "url", {
    value: new Request(input).url,
    configurable: true,
  });
  return response;
};

function makeSyntheticBrowserModule() {
  return defineAccessModule({
    id: "public-consumer-synthetic-browser-module",
    drivers: {
      "synthetic-browser": {
        id: "synthetic-browser",
        capabilities: {
          mode: "browser",
          rendersDom: true,
        },
        execute: ({ url }) =>
          Effect.succeed({
            url,
            finalUrl: url,
            status: 200,
            contentType: "text/html; charset=utf-8",
            contentLength: 47,
            html: "<html><body><h1>Public Browser</h1></body></html>",
            durationMs: 3,
            timings: {
              requestCount: 1,
              redirectCount: 0,
              blockedRequestCount: 0,
            },
            warnings: [],
          }),
      },
    },
  });
}

function makePublicPathModule() {
  return defineAccessModule({
    id: "public-consumer-path-module",
    egressPlugins: {
      "public-static-egress": {
        id: "public-static-egress",
        decodeConfig: () => Effect.succeed({}),
        acquire: ({ profile }) =>
          Effect.succeed({
            ...profile,
            egressKey: "public-static-egress-key",
            release: Effect.void,
          }),
      },
    },
    identityPlugins: {
      "public-static-identity": {
        id: "public-static-identity",
        decodeConfig: () => Effect.succeed({}),
        acquire: ({ profile }) =>
          Effect.succeed({
            ...profile,
            identityKey: "public-static-identity-key",
            release: Effect.void,
          }),
      },
    },
    egressProfiles: {
      "public-egress-profile": {
        allocationMode: "static",
        pluginId: "public-static-egress",
        profileId: "public-egress-profile",
        poolId: "public-egress-pool",
        routePolicyId: "public-egress-route",
        routeKind: "direct",
        routeKey: "public-direct",
        routeConfig: {
          kind: "direct",
        },
        requestHeaders: {
          "x-public-egress": "true",
        },
        warnings: [],
      },
    },
    identityProfiles: {
      "public-identity-profile": {
        allocationMode: "static",
        pluginId: "public-static-identity",
        profileId: "public-identity-profile",
        tenantId: "public-consumer",
        browserRuntimeProfileId: "patchright-default",
        httpUserAgent: "public-consumer-agent",
        browserUserAgent: "Public Consumer Browser",
        warnings: [],
      },
    },
  });
}

function makeMixedDriverModule() {
  return defineAccessModule({
    id: "public-consumer-mixed-driver-module",
    drivers: {
      "mixed-driver": {
        id: "mixed-driver",
        capabilities: {
          mode: "http",
          rendersDom: false,
        },
        execute: ({ url }) =>
          Effect.succeed({
            url,
            finalUrl: url,
            status: 200,
            contentType: "text/html; charset=utf-8",
            contentLength: 45,
            html: "<html><body><h1>Mixed Driver</h1></body></html>",
            durationMs: 2,
            timings: {
              requestCount: 1,
              redirectCount: 0,
              blockedRequestCount: 0,
            },
            warnings: [],
          }),
      },
    },
    providers: {
      "legacy-provider": {
        id: "legacy-provider",
        capabilities: {
          mode: "http",
          rendersDom: false,
        },
        execute: ({ url }) =>
          Effect.succeed({
            url,
            finalUrl: url,
            status: 200,
            contentType: "text/html; charset=utf-8",
            contentLength: 49,
            html: "<html><body><h1>Legacy Provider</h1></body></html>",
            durationMs: 2,
            timings: {
              requestCount: 1,
              redirectCount: 0,
              blockedRequestCount: 0,
            },
            warnings: [],
          }),
      },
    },
  });
}

function makeEngineOptions(
  overrides: Omit<CreateAccessEngineOptions, "fetchClient"> = {},
): CreateAccessEngineOptions {
  return {
    fetchClient: mockFetch,
    ...overrides,
  };
}

describe("public sdk engine consumer", () => {
  it.effect("creates an engine from the package entrypoint and executes preview requests", () =>
    Effect.acquireUseRelease(
      createEngine(makeEngineOptions()),
      (engine) =>
        Effect.gen(function* () {
          const preview = yield* engine.accessPreview({
            url: "https://consumer.example/public-engine",
          });

          expect(preview.command).toBe("access preview");
          expect(preview.data.finalUrl).toBe("https://consumer.example/public-engine");
          expect(preview.data.execution.providerId).toBe("http-basic");
        }),
      (engine) => engine.close,
    ),
  );

  it.effect(
    "extends builtin modules instead of replacing them when linking custom public modules",
    () =>
      Effect.acquireUseRelease(
        createEngine(
          makeEngineOptions({
            modules: [makeSyntheticBrowserModule()],
          }),
        ),
        (engine) =>
          Effect.gen(function* () {
            const defaultPreview = yield* engine.accessPreview({
              url: "https://consumer.example/default-preview",
            });
            const browserPreview = yield* engine.accessPreview({
              url: "https://consumer.example/browser-preview",
              execution: {
                driverId: "synthetic-browser",
              },
            });

            expect(defaultPreview.data.execution.providerId).toBe("http-basic");
            expect(browserPreview.data.execution.providerId).toBe("synthetic-browser");
          }),
        (engine) => engine.close,
      ),
  );

  it.effect("exposes public decision traces and link snapshots with driver-centric fields", () =>
    Effect.acquireUseRelease(
      createEngine(
        makeEngineOptions({
          modules: [makeSyntheticBrowserModule()],
        }),
      ),
      (engine) =>
        Effect.gen(function* () {
          const normalizedTrace = yield* engine.traceInput("access", {
            url: "https://consumer.example/browser-preview",
            execution: {
              driverId: "synthetic-browser",
            },
          });
          const trace = yield* engine.explainAccessPreview({
            url: "https://consumer.example/browser-preview",
            execution: {
              driverId: "synthetic-browser",
            },
          });
          const linking = yield* engine.inspectLinkSnapshot();
          const linkingAlias = yield* engine.inspectLinking();
          const normalizedExecution = normalizedTrace.normalizedPayload.execution;

          expect(normalizedTrace.resolved.driverId).toBe("synthetic-browser");
          expect(normalizedExecution).toMatchObject({
            driverId: "synthetic-browser",
          });
          expect(
            typeof normalizedExecution === "object" &&
              normalizedExecution !== null &&
              "providerId" in normalizedExecution,
          ).toBe(false);
          expect(trace.defaultDriverId).toBe("http-basic");
          expect(trace.candidateDriverIds).toContain("synthetic-browser");
          expect(trace.resolved.driverId).toBe("synthetic-browser");
          expect("providerId" in trace.resolved).toBe(false);
          expect(linking.driverIds).toContain("synthetic-browser");
          expect(linking.drivers.map((driver) => driver.id)).toContain("synthetic-browser");
          expect("providerIds" in linking).toBe(false);
          expect(linkingAlias.driverIds).toEqual(linking.driverIds);
        }),
      (engine) => engine.close,
    ),
  );

  it.effect("merges legacy providers with drivers during public module migration", () =>
    Effect.acquireUseRelease(
      createEngine(
        makeEngineOptions({
          modules: [makeMixedDriverModule()],
        }),
      ),
      (engine) =>
        Effect.gen(function* () {
          const linking = yield* engine.inspectLinkSnapshot();
          const legacyPreview = yield* engine.accessPreview({
            url: "https://consumer.example/legacy-provider",
            execution: {
              driverId: "legacy-provider",
            },
          });
          const mixedPreview = yield* engine.accessPreview({
            url: "https://consumer.example/mixed-driver",
            execution: {
              driverId: "mixed-driver",
            },
          });

          expect(linking.driverIds).toContain("legacy-provider");
          expect(linking.driverIds).toContain("mixed-driver");
          expect(legacyPreview.data.execution.providerId).toBe("legacy-provider");
          expect(mixedPreview.data.execution.providerId).toBe("mixed-driver");
        }),
      (engine) => engine.close,
    ),
  );

  it.effect(
    "authors custom transport and identity contributions through the public module seam",
    () =>
      Effect.acquireUseRelease(
        createEngine(
          makeEngineOptions({
            modules: [makePublicPathModule()],
          }),
        ),
        (engine) =>
          Effect.gen(function* () {
            const preview = yield* engine.accessPreview({
              url: "https://consumer.example/public-path",
              execution: {
                egress: {
                  profileId: "public-egress-profile",
                },
                identity: {
                  profileId: "public-identity-profile",
                },
              },
            });

            expect(preview.data.execution.egressProfileId).toBe("public-egress-profile");
            expect(preview.data.execution.egressPluginId).toBe("public-static-egress");
            expect(preview.data.execution.identityProfileId).toBe("public-identity-profile");
            expect(preview.data.execution.identityPluginId).toBe("public-static-identity");
          }),
        (engine) => engine.close,
      ),
  );

  it("exports only the public authoring seam and keeps internal helpers out of the public sdk package", async () => {
    const sdk = await import("effect-scrapling/sdk");

    expect(typeof sdk.defineAccessModule).toBe("function");
    expect(typeof sdk.createEngine).toBe("function");
    expect(typeof sdk.AccessPreviewRequestSchema).toBe("object");
    expect("normalizeCliPayload" in sdk).toBe(false);
    expect("AccessModuleRegistry" in sdk).toBe(false);
    expect("AccessProviderRegistry" in sdk).toBe(false);
    expect("EgressPluginRegistry" in sdk).toBe(false);
    expect("IdentityPluginRegistry" in sdk).toBe(false);
    expect("makeAccessCoreRuntimeModule" in sdk).toBe(false);
    expect("makeProxyStaticEgressPlugin" in sdk).toBe(false);
    expect("provideSdkRuntime" in sdk).toBe(false);
    expect("SdkRuntimeLive" in sdk).toBe(false);
    expect("CliOptions" in sdk).toBe(false);
    expect("CliOptionValue" in sdk).toBe(false);
  });
});
