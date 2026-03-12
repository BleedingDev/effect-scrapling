import { beforeEach, describe, expect, it } from "@effect-native/bun-test";
import { mock } from "bun:test";
import { Effect, Schema } from "effect";
import { createApiRequestHandler, handleApiRequest } from "../../src/api.ts";
import { runWorkspaceDoctor } from "../../src/e8.ts";
import { resetBrowserPoolForTests } from "../../src/sdk/browser-pool.ts";
import { defineAccessModule } from "../../src/sdk/engine.ts";
import { provideSdkRuntime } from "../../src/sdk/runtime-layer.ts";
import { RenderPreviewResponseSchema } from "../../src/sdk/schemas.ts";
import type { FetchClient } from "../../src/sdk/scraper.ts";

function mockHtmlFetch(body: string): FetchClient {
  return async (input) => {
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    Object.defineProperty(response, "url", {
      value: new Request(input).url,
      configurable: true,
    });
    return response;
  };
}

function resetSdkBrowserPool() {
  return Effect.runPromise(resetBrowserPoolForTests());
}

function makeSyntheticBrowserModule() {
  return defineAccessModule({
    id: "api-host-synthetic-browser-module",
    providers: {
      "synthetic-browser": {
        id: "synthetic-browser",
        capabilities: {
          mode: "browser",
          rendersDom: true,
        },
        execute: ({ url, context }) =>
          Effect.succeed({
            url,
            finalUrl: url,
            status: 200,
            contentType: "text/html; charset=utf-8",
            contentLength: 44,
            html: "<html><body><h1>API Host Browser</h1></body></html>",
            durationMs: 2,
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
      },
    },
  });
}

describe("api app", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("serves doctor status through the HTTP boundary", async () => {
    const response = await handleApiRequest(new Request("http://localhost/doctor"));
    const payload = await response.json();
    const sdkPayload = await Effect.runPromise(provideSdkRuntime(runWorkspaceDoctor()));

    expect(response.status).toBe(200);
    expect(payload.command).toBe("doctor");
    expect(payload.ok).toBe(true);
    expect(payload.data.ok).toBe(true);
    expect(payload.warnings).toEqual([]);
    expect(payload).toEqual(sdkPayload);
  });

  it("normalizes doctor failures through the shared API error envelope", async () => {
    const response = await handleApiRequest(new Request("http://localhost/doctor"), undefined, {
      modules: [
        defineAccessModule({
          id: "duplicate-provider-module-a",
          providers: {
            "duplicate-provider": {
              id: "duplicate-provider",
              capabilities: {
                mode: "http",
                rendersDom: false,
              },
              execute: () =>
                Effect.die(new Error("Execution should not run during module validation")),
            },
          },
        }),
        defineAccessModule({
          id: "duplicate-provider-module-b",
          providers: {
            "duplicate-provider": {
              id: "duplicate-provider",
              capabilities: {
                mode: "http",
                rendersDom: false,
              },
              execute: () =>
                Effect.die(new Error("Execution should not run during module validation")),
            },
          },
        }),
      ],
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.code).toBe("InvalidInputError");
    expect(payload.message).toContain("Duplicate provider id");
  });

  it("maps missing access-preview URLs to a 400 API response", async () => {
    const response = await handleApiRequest(
      new Request("http://localhost/access/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.code).toBe("InvalidInputError");
    expect(payload.message).toContain("Invalid access preview payload");
  });

  it("maps missing render-preview URLs to a 400 API response", async () => {
    const response = await handleApiRequest(
      new Request("http://localhost/render/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.code).toBe("InvalidInputError");
    expect(payload.message).toContain("Invalid render preview payload");
  });

  it("rejects invalid JSON bodies on access preview routes", async () => {
    const response = await handleApiRequest(
      new Request("http://localhost/access/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("InvalidInputError");
    expect(payload.message).toBe("Request body must be valid JSON");
  });

  it("rejects legacy top-level execution fields at the API boundary", async () => {
    const response = await handleApiRequest(
      new Request("http://localhost/access/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://example.com/articles/effect-scrapling",
          providerId: "browser-basic",
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.code).toBe("InvalidInputError");
    expect(payload.message).toContain("unsupported fields");
    expect(payload.details).toContain("providerId");
  });

  it("maps NetworkError failures to a 502 API response", async () => {
    const response = await handleApiRequest(
      new Request("http://localhost/access/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://example.com/start",
        }),
      }),
      async () =>
        new Response("", {
          status: 302,
          headers: {
            location: "http://127.0.0.1/internal",
          },
        }),
    );
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.code).toBe("NetworkError");
    expect(payload.message).toContain("Access failed");
    expect(payload.details).toContain("private or reserved");
  });

  it("executes access preview through the shared runtime with injected fetch", async () => {
    const response = await handleApiRequest(
      new Request("http://localhost/access/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://example.com/articles/effect-scrapling",
        }),
      }),
      mockHtmlFetch("<html><head><title>Effect Scrapling</title></head></html>"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.command).toBe("access preview");
    expect(payload.data.finalUrl).toBe("https://example.com/articles/effect-scrapling");
    expect(payload.warnings).toEqual([]);
  });

  it("assembles host-specific modules for API preview routes", async () => {
    const handler = createApiRequestHandler({
      engine: {
        modules: [makeSyntheticBrowserModule()],
      },
    });
    try {
      const response = await handler(
        new Request("http://localhost/access/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://example.com/browser-only",
            execution: {
              mode: "browser",
              providerId: "synthetic-browser",
            },
          }),
        }),
      );
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.command).toBe("access preview");
      expect(payload.data.execution.providerId).toBe("synthetic-browser");
      expect(payload.data.finalUrl).toBe("https://example.com/browser-only");
    } finally {
      await handler.close();
    }
  });

  it("fails closed after an API request handler is disposed", async () => {
    const handler = createApiRequestHandler();

    await handler.close();

    const response = await handler(new Request("http://localhost/doctor"));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.code).toBe("AccessEngineClosedError");
    expect(payload.message).toContain("handler is closed");
  });

  it("lets in-flight API requests finish before closing the handler", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    let notifyFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const handler = createApiRequestHandler({
      fetchClient: async (input) => {
        notifyFetchStarted?.();

        const response = await pendingResponse;
        Object.defineProperty(response, "url", {
          value: new Request(input).url,
          configurable: true,
        });
        return response;
      },
    });

    const requestPromise = handler(
      new Request("http://localhost/access/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://example.com/articles/effect-scrapling",
        }),
      }),
    );

    await fetchStarted;

    const closePromise = handler.close();

    resolveFetch?.(
      new Response("<html><head><title>Effect Scrapling</title></head></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    const response = await requestPromise;
    const payload = await response.json();

    await closePromise;

    expect(response.status).toBe(200);
    expect(payload.command).toBe("access preview");
    expect(payload.data.finalUrl).toBe("https://example.com/articles/effect-scrapling");
  });

  it("lets accepted API requests finish body parsing before closing the handler", async () => {
    let resolveBody: ((payload: unknown) => void) | undefined;
    let notifyBodyStarted: (() => void) | undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      notifyBodyStarted = resolve;
    });
    const pendingBody = new Promise<unknown>((resolve) => {
      resolveBody = resolve;
    });
    const handler = createApiRequestHandler({
      fetchClient: mockHtmlFetch("<html><head><title>Effect Scrapling</title></head></html>"),
    });
    const request = new Request("http://localhost/access/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ignored: true }),
    });

    Object.defineProperty(request, "json", {
      value: async () => {
        notifyBodyStarted?.();
        return pendingBody;
      },
      configurable: true,
    });

    const requestPromise = handler(request);

    await bodyStarted;

    const closePromise = handler.close();

    resolveBody?.({
      url: "https://example.com/articles/effect-scrapling",
    });

    const response = await requestPromise;
    const payload = await response.json();

    await closePromise;

    expect(response.status).toBe(200);
    expect(payload.command).toBe("access preview");
    expect(payload.data.finalUrl).toBe("https://example.com/articles/effect-scrapling");
  });

  it("maps ExtractionError failures to a 422 API response", async () => {
    const response = await handleApiRequest(
      new Request("http://localhost/extract/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://example.com/articles/effect-scrapling",
          selector: "[",
        }),
      }),
      mockHtmlFetch("<html><body><p>No headings</p></body></html>"),
    );
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.code).toBe("ExtractionError");
    expect(payload.message).toContain('Failed to extract with selector "["');
  });

  it("executes extract run through the canonical API payload contract", async () => {
    const response = await handleApiRequest(
      new Request("http://localhost/extract/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://example.com/articles/effect-scrapling",
          selector: "h1",
          attr: "data-slug",
          all: "TRUE",
          limit: "05",
          timeoutMs: "300",
        }),
      }),
      mockHtmlFetch(
        '<html><body><h1 data-slug="effect-scrapling">Effect Scrapling</h1></body></html>',
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.command).toBe("extract run");
    expect(payload.data.selector).toBe("h1");
    expect(payload.data.attr).toBe("data-slug");
    expect(payload.data.count).toBe(1);
    expect(payload.data.values).toEqual(["effect-scrapling"]);
  });

  it("executes browser access preview through the public route with the explicit execution contract", async () => {
    await resetSdkBrowserPool();
    const seenOptions: {
      readonly userAgent: string;
      readonly waitUntil: string;
      readonly timeout: number;
    }[] = [];

    mock.module("patchright", () => ({
      chromium: {
        launch: async () => ({
          newContext: async (options: { readonly userAgent: string }) => {
            const userAgent = options.userAgent;

            return {
              newPage: async () => ({
                route: async () => {},
                goto: async (
                  _url: string,
                  options: {
                    readonly waitUntil: string;
                    readonly timeout: number;
                  },
                ) => {
                  seenOptions.push({
                    userAgent,
                    waitUntil: options.waitUntil,
                    timeout: options.timeout,
                  });

                  return {
                    status: () => 200,
                    allHeaders: async () => ({
                      "content-type": "text/html; charset=utf-8",
                    }),
                  };
                },
                waitForLoadState: async () => {},
                content: async () =>
                  "<html><head><title>Effect Scrapling</title></head><body></body></html>",
                url: () => "https://example.com/articles/effect-scrapling",
                close: async () => {},
              }),
              close: async () => {},
            };
          },
          close: async () => {},
        }),
      },
    }));

    try {
      const response = await handleApiRequest(
        new Request("http://localhost/access/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://example.com/articles/effect-scrapling",
            execution: {
              mode: "browser",
              browser: {
                waitUntil: "commit",
                timeoutMs: "450",
                userAgent: "Nested Browser",
              },
            },
          }),
        }),
      );
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.command).toBe("access preview");
      expect(payload.data.finalUrl).toBe("https://example.com/articles/effect-scrapling");
      expect(seenOptions).toEqual([
        {
          userAgent: "Nested Browser",
          waitUntil: "commit",
          timeout: 450,
        },
      ]);
    } finally {
      await resetSdkBrowserPool();
      mock.restore();
    }
  });

  it("maps BrowserError failures to a 502 API response", async () => {
    await resetSdkBrowserPool();
    mock.module("patchright", () => ({
      chromium: {
        launch: async () => {
          throw new Error("browser boot failed");
        },
      },
    }));

    try {
      const response = await handleApiRequest(
        new Request("http://localhost/access/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://example.com/articles/effect-scrapling",
            execution: {
              mode: "browser",
              providerId: "browser-basic",
            },
          }),
        }),
      );
      const payload = await response.json();

      expect(response.status).toBe(502);
      expect(payload.code).toBe("BrowserError");
      expect(payload.message).toContain("Browser access failed");
    } finally {
      await resetSdkBrowserPool();
      mock.restore();
    }
  });

  it("executes render preview through the browser runtime with a typed artifact bundle", async () => {
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
                '<html><head><title>Rendered Preview</title></head><body><a href="/products/sku-123">Product</a><input type="hidden" value="secret" /><main> Browser policy preview </main></body></html>',
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
      const response = await handleApiRequest(
        new Request("http://localhost/render/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://example.com/products/sku-123",
            execution: {
              providerId: "browser-basic",
              browser: {
                waitUntil: "commit",
                timeoutMs: "450",
                userAgent: "Nested Browser",
              },
            },
          }),
        }),
      );
      const payload = await response.json();
      const preview = Schema.decodeUnknownSync(RenderPreviewResponseSchema)(payload);

      expect(response.status).toBe(200);
      expect(preview.command).toBe("render preview");
      expect(preview.data.execution.mode).toBe("browser");
      expect(preview.data.status).toEqual({
        code: 200,
        ok: true,
        redirected: false,
        family: "success",
      });
      expect(preview.data.artifacts.map(({ kind }) => kind)).toEqual([
        "navigation",
        "renderedDom",
        "timings",
      ]);
    } finally {
      await resetSdkBrowserPool();
      mock.restore();
    }
  });

  it("maps render-preview browser failures to a 502 API response", async () => {
    await resetSdkBrowserPool();
    mock.module("patchright", () => ({
      chromium: {
        launch: async () => {
          throw new Error("browser boot failed");
        },
      },
    }));

    try {
      const response = await handleApiRequest(
        new Request("http://localhost/render/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: "https://example.com/articles/effect-scrapling",
          }),
        }),
      );
      const payload = await response.json();

      expect(response.status).toBe(502);
      expect(payload.code).toBe("BrowserError");
      expect(payload.message).toContain("Browser access failed");
    } finally {
      await resetSdkBrowserPool();
      mock.restore();
    }
  });

  it("returns a route index on unknown endpoints", async () => {
    const response = await handleApiRequest(new Request("http://localhost/unknown"));
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.ok).toBe(false);
    expect(payload.routes).toEqual([
      "GET /health",
      "GET /doctor",
      "POST /access/preview",
      "POST /render/preview",
      "POST /extract/run",
    ]);
  });
});
