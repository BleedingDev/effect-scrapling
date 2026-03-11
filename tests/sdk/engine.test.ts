import { describe, expect, it } from "@effect-native/bun-test";
import { Cause, Effect, Exit, Option } from "effect";
import { createEngine } from "../../src/sdk/engine.ts";
import { defineAccessRuntimeModule } from "../../src/sdk/access-module-runtime.ts";
import {
  makeStaticEgressPlugin,
  makeStaticIdentityPlugin,
} from "../../src/sdk/access-allocation-plugin-runtime.ts";

const mockFetch = async (input: RequestInfo | URL) => {
  const response = new Response("<html><body><h1>Engine</h1></body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  Object.defineProperty(response, "url", {
    value: new Request(input).url,
    configurable: true,
  });
  return response;
};

describe("sdk engine", () => {
  it.effect("explains normalized access execution without running capture", () =>
    Effect.acquireUseRelease(
      createEngine(),
      (engine) =>
        Effect.gen(function* () {
          const trace = yield* engine.explainAccessPreview({
            url: "https://example.com/trace",
          });

          expect(trace.command).toBe("access preview");
          expect(trace.normalizedPayload).toEqual({
            url: "https://example.com/trace",
          });
          expect(trace.resolved.providerId).toBe("http-basic");
          expect(trace.resolved.mode).toBe("http");
        }),
      (engine) => engine.close,
    ),
  );

  it.effect("links custom modules through the public engine creation seam", () =>
    Effect.acquireUseRelease(
      createEngine({
        fetchClient: mockFetch,
        modules: [
          defineAccessRuntimeModule({
            id: "managed-module",
            providers: {
              "managed-browser": {
                id: "managed-browser",
                capabilities: {
                  mode: "browser",
                  rendersDom: true,
                },
                execute: () =>
                  Effect.die(
                    new Error(
                      "Custom provider execution is not expected during link/explain tests",
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
                routePolicyId: "managed-route",
                routeKind: "direct",
                routeKey: "managed-direct",
                routeConfig: {
                  kind: "direct",
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
                tenantId: "managed",
                browserRuntimeProfileId: "patchright-default",
                browserUserAgent: "Managed Browser",
                warnings: [],
              },
            },
          }),
        ],
      }),
      (engine) =>
        Effect.gen(function* () {
          const linking = yield* engine.inspectLinkSnapshot();
          const trace = yield* engine.explainRenderPreview({
            url: "https://example.com/managed",
            execution: {
              providerId: "managed-browser",
              egress: {
                profileId: "managed-egress",
              },
              identity: {
                profileId: "managed-identity",
              },
            },
          });

          expect(linking.moduleIds).toContain("managed-module");
          expect(linking.providerIds).toContain("http-basic");
          expect(linking.linkedProgramIds).toEqual([
            "access-preview",
            "extract-run",
            "render-preview",
          ]);
          expect(linking.providers.map((provider) => provider.id)).toContain("managed-browser");
          expect(linking.egressProfileIds).toContain("managed-egress");
          expect(linking.identityProfileIds).toContain("managed-identity");
          expect(trace.resolved.providerId).toBe("managed-browser");
          expect(trace.resolved.mode).toBe("browser");
        }),
      (engine) => engine.close,
    ),
  );

  it("uses the same normalization boundary for explain and execute operations", async () => {
    const engine = await Effect.runPromise(
      createEngine({
        fetchClient: mockFetch,
      }),
    );

    try {
      const explainExit = await Effect.runPromiseExit(engine.explainAccessPreview(42));
      const executeExit = await Effect.runPromiseExit(engine.accessPreview(42));
      if (Exit.isSuccess(explainExit) || Exit.isSuccess(executeExit)) {
        throw new Error("Expected InvalidInputError for primitive SDK input");
      }
      const explainError = Option.getOrUndefined(Cause.findErrorOption(explainExit.cause));
      const executeError = Option.getOrUndefined(Cause.findErrorOption(executeExit.cause));
      if (
        explainError?._tag !== "InvalidInputError" ||
        executeError?._tag !== "InvalidInputError"
      ) {
        throw new Error("Expected InvalidInputError for primitive SDK input");
      }

      expect(explainError.message).toBe("Request body must be a JSON object");
      expect(executeError.message).toBe("Request body must be a JSON object");
      expect(explainError.details).toBe("received type: number");
      expect(executeError.details).toBe("received type: number");
    } finally {
      await Effect.runPromise(engine.close);
    }
  });

  it.effect("fails fast after the engine is closed", () =>
    Effect.gen(function* () {
      const engine = yield* createEngine();
      const doctor = yield* engine.runDoctor();
      yield* engine.close;

      const tag = yield* engine.runDoctor().pipe(
        Effect.flatMap(() => Effect.die(new Error("Expected closed engine failure"))),
        Effect.catchTag("AccessEngineClosedError", () =>
          Effect.succeed("AccessEngineClosedError" as const),
        ),
        Effect.orDie,
      );

      expect(doctor.command).toBe("doctor");
      expect(doctor.data.ok).toBe(true);
      expect(doctor.warnings).toEqual([]);
      expect(tag).toBe("AccessEngineClosedError");
    }),
  );
});
