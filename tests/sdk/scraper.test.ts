import { describe, expect, it } from "@effect-native/bun-test";
import { Effect } from "effect";
import {
  accessPreview,
  extractRun,
  FetchService,
  type FetchClient,
  runDoctor,
} from "../../src/sdk/scraper";

describe("scraper guardrails", () => {
  const mockFetch: FetchClient = async (_input, _init) =>
    new Response(`<html><body><h1>Hello</h1><h1>World</h1></body></html>`, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

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
});
