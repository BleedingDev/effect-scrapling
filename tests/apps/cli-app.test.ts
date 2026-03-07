import { describe, expect, it } from "@effect-native/bun-test";
import { mock } from "bun:test";
import { Effect } from "effect";
import { executeCli } from "../../src/standalone.ts";
import { resetBrowserPoolForTests } from "../../src/sdk/browser-pool.ts";
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
        "--user-agent",
        "effect-scrapling-test-agent",
      ],
      mockHtmlFetch("<html><head><title>Effect Scrapling</title></head></html>"),
    );
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("access preview");
    expect(payload.data.finalUrl).toBe("https://example.com/articles/effect-scrapling");
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

  it("normalizes browser-mode aliases through the CLI boundary", async () => {
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
      const result = await executeCli([
        "access",
        "preview",
        "--url",
        "https://example.com/articles/effect-scrapling",
        "--mode",
        "browser",
        "--waitUntil",
        "commit",
        "--browserTimeoutMs",
        "450",
        "--browserUserAgent",
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
    mock.module("playwright", () => ({
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
        "--mode",
        "browser",
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

  it("reports unknown commands with actionable guidance", async () => {
    const result = await executeCli(["wat"]);
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(2);
    expect(payload.code).toBe("InvalidInputError");
    expect(payload.details).toContain("effect-scrapling help");
  });
});
