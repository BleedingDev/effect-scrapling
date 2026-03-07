import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { AccessPreviewRequestSchema, ExtractRunRequestSchema } from "../../src/sdk/schemas.ts";
import {
  accessPreview,
  extractRun,
  FetchService,
  type FetchClient,
  runDoctor,
} from "../../src/sdk/scraper.ts";

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
      const report = yield* runDoctor();
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
        Effect.orDie,
      );
      expect(failureMessage).toContain("Invalid access preview payload");
    }),
  );

  it.effect("accessPreview uses the explicit HTTP mode through the public SDK boundary", () =>
    Effect.gen(function* () {
      let requestUrl = "";
      let requestHeaders: HeadersInit | undefined;
      const output = yield* accessPreview({
        url: "https://example.com/http-preview",
        mode: "http",
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
      );

      expect(output.ok).toBe(true);
      expect(output.command).toBe("access preview");
      expect(output.data.url).toBe("https://example.com/http-preview");
      expect(output.data.finalUrl).toBe("https://example.com/http-preview");
      expect(output.data.status).toBe(200);
      expect(output.data.contentType).toBe("text/html; charset=utf-8");
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

  it("trims request string literals before schema validation", () => {
    expect(
      Schema.decodeUnknownSync(AccessPreviewRequestSchema)({
        url: "https://example.com",
        mode: " browser ",
        browser: {
          waitUntil: " load ",
          timeoutMs: "300",
        },
      }),
    ).toEqual({
      url: "https://example.com",
      mode: "browser",
      timeoutMs: 15_000,
      userAgent: undefined,
      browser: {
        waitUntil: "load",
        timeoutMs: 300,
        userAgent: undefined,
      },
    });

    expect(
      Schema.decodeUnknownSync(ExtractRunRequestSchema)({
        url: "https://example.com",
        mode: " http ",
      }),
    ).toEqual({
      url: "https://example.com",
      mode: "http",
      selector: "title",
      attr: undefined,
      all: false,
      limit: 20,
      timeoutMs: 15_000,
      userAgent: undefined,
      browser: undefined,
    });
  });

  it.effect("extractRun returns deterministic values from HTML", () =>
    Effect.gen(function* () {
      const output = yield* extractRun({
        url: "https://example.com",
        selector: "h1",
        all: true,
        limit: 5,
      }).pipe(
        Effect.provideService(FetchService, {
          fetch: mockFetch,
        }),
      );

      expect(output.ok).toBe(true);
      expect(output.command).toBe("extract run");
      expect(output.data.count).toBe(2);
      expect(output.data.values).toEqual(["Hello", "World"]);
    }),
  );

  it.effect("extractRun applies schema defaults for selector, limit, and boolean flags", () =>
    Effect.gen(function* () {
      const output = yield* extractRun({
        url: "https://example.com",
      }).pipe(
        Effect.provideService(FetchService, {
          fetch: mockFetch,
        }),
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
        );

        expect(output.ok).toBe(true);
        expect(output.data.selector).toBe("h1");
        expect(output.data.count).toBe(2);
        expect(output.data.values).toEqual(["Hello", "World"]);
      }),
  );
});
