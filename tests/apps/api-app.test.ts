import { describe, expect, it } from "@effect-native/bun-test";
import { mock } from "bun:test";
import { Effect, Schema } from "effect";
import { handleApiRequest } from "../../src/api.ts";
import { runWorkspaceDoctor } from "../../src/e8.ts";
import { resetBrowserPoolForTests } from "../../src/sdk/browser-pool.ts";
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

describe("api app", () => {
  it("serves doctor status through the HTTP boundary", async () => {
    const response = await handleApiRequest(new Request("http://localhost/doctor"));
    const payload = await response.json();
    const sdkPayload = await Effect.runPromise(runWorkspaceDoctor());

    expect(response.status).toBe(200);
    expect(payload.command).toBe("doctor");
    expect(payload.ok).toBe(true);
    expect(payload.data.ok).toBe(true);
    expect(payload.warnings).toEqual([]);
    expect(payload).toEqual(sdkPayload);
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

  it("normalizes extract-run aliases at the API boundary instead of testing the helper in isolation", async () => {
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
          "timeout-ms": "300",
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

  it("normalizes nested browser aliases through the public access-preview route", async () => {
    await resetSdkBrowserPool();
    const seenOptions: {
      readonly userAgent: string;
      readonly waitUntil: string;
      readonly timeout: number;
    }[] = [];

    mock.module("playwright", () => ({
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
            mode: "browser",
            browser: {
              "wait-until": "commit",
              "timeout-ms": "450",
              "user-agent": "Nested Browser",
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
    mock.module("playwright", () => ({
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
            mode: "browser",
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
    mock.module("playwright", () => ({
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
            browser: {
              "wait-until": "commit",
              "timeout-ms": "450",
              "user-agent": "Nested Browser",
            },
          }),
        }),
      );
      const payload = await response.json();
      const preview = Schema.decodeUnknownSync(RenderPreviewResponseSchema)(payload);

      expect(response.status).toBe(200);
      expect(preview.command).toBe("render preview");
      expect(preview.data.mode).toBe("browser");
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
    mock.module("playwright", () => ({
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
