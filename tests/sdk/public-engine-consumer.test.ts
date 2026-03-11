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
    providers: {
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
                providerId: "synthetic-browser",
              },
            });

            expect(defaultPreview.data.execution.providerId).toBe("http-basic");
            expect(browserPreview.data.execution.providerId).toBe("synthetic-browser");
          }),
        (engine) => engine.close,
      ),
  );

  it("exports only the public authoring seam and keeps internal helpers out of the public sdk package", async () => {
    const sdk = await import("effect-scrapling/sdk");

    expect(typeof sdk.defineAccessModule).toBe("function");
    expect(typeof sdk.createEngine).toBe("function");
    expect("normalizeCliPayload" in sdk).toBe(false);
    expect("makeAccessCoreRuntimeModule" in sdk).toBe(false);
    expect("makeProxyStaticEgressPlugin" in sdk).toBe(false);
    expect("provideSdkRuntime" in sdk).toBe(false);
    expect("CliOptions" in sdk).toBe(false);
    expect("CliOptionValue" in sdk).toBe(false);
  });
});
