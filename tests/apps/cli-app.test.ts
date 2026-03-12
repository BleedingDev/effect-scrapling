import { describe, expect, it } from "@effect-native/bun-test";
import { mock } from "bun:test";
import { Effect, Schema } from "effect";
import { createCliHost, executeCli } from "../../src/standalone.ts";
import { resetBrowserPoolForTests } from "../../src/sdk/browser-pool.ts";
import { defineAccessModule } from "../../src/sdk/engine.ts";
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
    id: "cli-host-synthetic-browser-module",
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
            html: "<html><body><h1>CLI Host Browser</h1></body></html>",
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

describe("cli app", () => {
  it("executes access preview with shared schema decoding instead of manual flag parsing", async () => {
    const result = await executeCli(
      [
        "access",
        "preview",
        "--url",
        "https://example.com/articles/effect-scrapling",
        "--timeout-ms",
        "1500",
        "--http-user-agent",
        "effect-scrapling-test-agent",
      ],
      mockHtmlFetch("<html><head><title>Effect Scrapling</title></head></html>"),
    );
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("access preview");
    expect(payload.data.finalUrl).toBe("https://example.com/articles/effect-scrapling");
  });

  it("supports leased profile modules and nested JSON config through canonical CLI flags", async () => {
    const result = await executeCli(
      [
        "access",
        "preview",
        "--url",
        "https://example.com/articles/effect-scrapling",
        "--egress-profile",
        "leased-direct",
        "--egress-config",
        '{"ttlMs":1000,"maxPoolLeases":1}',
        "--identity-profile",
        "leased-default",
        "--identity-config",
        '{"ttlMs":1000,"maxActiveLeases":1}',
      ],
      mockHtmlFetch("<html><head><title>Effect Scrapling</title></head></html>"),
    );
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("access preview");
    expect(payload.data.execution).toMatchObject({
      egressProfileId: "leased-direct",
      egressPluginId: "builtin-leased-egress",
      identityProfileId: "leased-default",
      identityPluginId: "builtin-leased-identity",
    });
  });

  it("assembles host-specific modules for CLI preview commands", async () => {
    const host = createCliHost({
      engine: {
        modules: [makeSyntheticBrowserModule()],
      },
    });
    const result = await host.execute([
      "access",
      "preview",
      "--url",
      "https://example.com/browser-only",
      "--provider",
      "synthetic-browser",
    ]);
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("access preview");
    expect(payload.data.execution.providerId).toBe("synthetic-browser");
    expect(payload.data.finalUrl).toBe("https://example.com/browser-only");
  });

  it("emits driver-centric decision traces for CLI explain commands", async () => {
    const result = await executeCli([
      "access",
      "explain",
      "--url",
      "https://example.com/browser-only",
      "--provider",
      "browser-basic",
      "--browser-wait-until",
      "domcontentloaded",
    ]);
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("access preview");
    expect(payload.defaultDriverId).toBe("http-basic");
    expect(payload.resolved.driverId).toBe("browser-basic");
    expect(Array.isArray(payload.candidateDriverIds)).toBe(true);
    expect("providerId" in payload.resolved).toBe(false);
    expect(payload.normalizedPayload.execution.driverId).toBe("browser-basic");
    expect("providerId" in payload.normalizedPayload.execution).toBe(false);
  });

  it("runs doctor through the CLI boundary with the expected JSON envelope", async () => {
    const result = await executeCli(["doctor"]);
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("doctor");
    expect(payload.ok).toBe(true);
    expect(payload.data.ok).toBe(true);
    expect(payload.warnings).toEqual([]);
  });

  it("supports the workspace doctor alias through the shared command core", async () => {
    const result = await executeCli(["workspace", "doctor"]);
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("doctor");
    expect(payload.ok).toBe(true);
    expect(payload.data.ok).toBe(true);
    expect(payload.warnings).toEqual([]);
  });

  it("shows deterministic workspace config through the CLI boundary", async () => {
    const result = await executeCli(["workspace", "config", "show"]);
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("config show");
    expect(payload.ok).toBe(true);
    expect(payload.data.package.name).toBe("effect-scrapling");
    expect(payload.data.browserPool).toEqual({
      maxContexts: 4,
      maxPages: 4,
      maxQueue: 16,
    });
    expect(payload.data.sourceOrder).toEqual(["defaults", "sitePack", "targetProfile", "run"]);
    expect(payload.data.runConfigDefaults.mode).toBe("http");
    expect(payload.data.runConfigDefaults.render).toBe("never");
    expect(payload.warnings).toEqual([]);
  });

  it("rejects extra positional segments on workspace config show", async () => {
    const result = await executeCli(["workspace", "config", "show", "extra"]);
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(2);
    expect(payload.code).toBe("InvalidInputError");
    expect(payload.message).toContain("Unexpected positional segment");
  });

  it("supports the scrape alias for extract run", async () => {
    const result = await executeCli(
      ["scrape", "--url", "https://example.com/articles/effect-scrapling", "--selector", "h1"],
      mockHtmlFetch("<html><body><h1>Effect Scrapling</h1></body></html>"),
    );
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("extract run");
    expect(payload.data.selector).toBe("h1");
    expect(payload.data.values).toEqual(["Effect Scrapling"]);
  });

  it("maps NetworkError failures to the CLI error envelope", async () => {
    const result = await executeCli(
      ["access", "preview", "--url", "https://example.com/start"],
      async () =>
        new Response("", {
          status: 302,
          headers: {
            location: "http://127.0.0.1/internal",
          },
        }),
    );
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(1);
    expect(payload.code).toBe("NetworkError");
    expect(payload.message).toContain("Access failed");
    expect(payload.details).toContain("private or reserved");
  });

  it("executes browser access preview through the CLI boundary with the explicit execution flags", async () => {
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
      const result = await executeCli([
        "access",
        "preview",
        "--url",
        "https://example.com/articles/effect-scrapling",
        "--mode",
        "browser",
        "--browser-wait-until",
        "commit",
        "--browser-timeout-ms",
        "450",
        "--browser-user-agent",
        "CLI Browser",
      ]);
      const payload = JSON.parse(result.output);

      expect(result.exitCode).toBe(0);
      expect(payload.command).toBe("access preview");
      expect(payload.data.finalUrl).toBe("https://example.com/articles/effect-scrapling");
      expect(seenOptions).toEqual([
        {
          userAgent: "CLI Browser",
          waitUntil: "commit",
          timeout: 450,
        },
      ]);
    } finally {
      await resetSdkBrowserPool();
      mock.restore();
    }
  });

  it("maps BrowserError failures to the CLI error envelope", async () => {
    await resetSdkBrowserPool();
    mock.module("patchright", () => ({
      chromium: {
        launch: async () => {
          throw new Error("browser boot failed");
        },
      },
    }));

    try {
      const result = await executeCli([
        "access",
        "preview",
        "--url",
        "https://example.com/articles/effect-scrapling",
        "--provider",
        "browser-basic",
      ]);
      const payload = JSON.parse(result.output);

      expect(result.exitCode).toBe(1);
      expect(payload.code).toBe("BrowserError");
      expect(payload.message).toContain("Browser access failed");
    } finally {
      await resetSdkBrowserPool();
      mock.restore();
    }
  });

  it("executes render preview through the CLI boundary with a typed artifact bundle", async () => {
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
      const result = await executeCli([
        "render",
        "preview",
        "--url",
        "https://example.com/products/sku-123",
        "--browser-wait-until",
        "commit",
        "--browser-timeout-ms",
        "450",
        "--browser-user-agent",
        "CLI Browser",
      ]);
      const payload = JSON.parse(result.output);
      const preview = Schema.decodeUnknownSync(RenderPreviewResponseSchema)(payload);

      expect(result.exitCode).toBe(0);
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

  it("maps render-preview BrowserError failures to the CLI error envelope", async () => {
    await resetSdkBrowserPool();
    mock.module("patchright", () => ({
      chromium: {
        launch: async () => {
          throw new Error("browser boot failed");
        },
      },
    }));

    try {
      const result = await executeCli([
        "render",
        "preview",
        "--url",
        "https://example.com/articles/effect-scrapling",
      ]);
      const payload = JSON.parse(result.output);

      expect(result.exitCode).toBe(1);
      expect(payload.code).toBe("BrowserError");
      expect(payload.message).toContain("Browser access failed");
    } finally {
      await resetSdkBrowserPool();
      mock.restore();
    }
  });

  it("maps ExtractionError failures to the CLI error envelope", async () => {
    const result = await executeCli(
      [
        "extract",
        "run",
        "--url",
        "https://example.com/articles/effect-scrapling",
        "--selector",
        "[",
      ],
      mockHtmlFetch("<html><body><p>No headings</p></body></html>"),
    );
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(1);
    expect(payload.code).toBe("ExtractionError");
    expect(payload.message).toContain('Failed to extract with selector "["');
  });

  it("requires --url for public CLI commands", async () => {
    const result = await executeCli(["access", "preview"]);
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(2);
    expect(payload.code).toBe("InvalidInputError");
    expect(payload.message).toBe("Missing required option: --url");
  });

  it("surfaces schema validation failures for invalid numeric flags", async () => {
    const result = await executeCli(
      [
        "extract",
        "run",
        "--url",
        "https://example.com/articles/effect-scrapling",
        "--selector",
        "h1",
        "--limit",
        "not-a-number",
      ],
      mockHtmlFetch("<html><body><h1>Effect Scrapling</h1></body></html>"),
    );
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(2);
    expect(payload.code).toBe("InvalidInputError");
    expect(payload.message).toContain("Invalid extract run payload");
  });

  it("rejects legacy execution aliases instead of silently accepting them", async () => {
    const result = await executeCli([
      "render",
      "preview",
      "--url",
      "https://example.com/products/sku-123",
      "--waitUntil",
      "commit",
    ]);
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(2);
    expect(payload.code).toBe("InvalidInputError");
    expect(payload.message).toContain("Unsupported option for render preview");
    expect(payload.details).toContain("--waitUntil");
  });

  it("rejects malformed JSON config flags before execution starts", async () => {
    const result = await executeCli([
      "access",
      "preview",
      "--url",
      "https://example.com/products/sku-123",
      "--egress-config",
      "not-json",
    ]);
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(2);
    expect(payload.code).toBe("InvalidInputError");
    expect(payload.message).toBe("Option --egress-config must be valid JSON");
  });

  it("reports unknown commands with actionable guidance", async () => {
    const result = await executeCli(["wat"]);
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(2);
    expect(payload.code).toBe("InvalidInputError");
    expect(payload.details).toContain("effect-scrapling help");
  });
});
