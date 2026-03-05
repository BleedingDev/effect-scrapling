import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { InvalidInputError } from "../../src/sdk/errors";
import { accessPreview, extractRun, FetchService, runDoctor } from "../../src/sdk/scraper";

describe("scraper guardrails", () => {
  const mockFetch: typeof fetch = async (_input, _init) =>
    new Response(`<html><body><h1>Hello</h1><h1>World</h1></body></html>`, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  it("runDoctor reports runtime health", async () => {
    const report = await Effect.runPromise(runDoctor());
    expect(report.ok).toBe(true);
    expect(report.checks.some((check) => !check.ok)).toBe(false);
  });

  it("accessPreview rejects malformed payloads with typed errors", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(accessPreview({})).pipe(
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
      ),
    );
    expect(failure).toBeInstanceOf(InvalidInputError);
  });

  it("extractRun returns deterministic values from HTML", async () => {
    const output = await Effect.runPromise(
      extractRun({
        url: "https://example.com",
        selector: "h1",
        all: true,
        limit: 5,
      }).pipe(
        Effect.provideService(FetchService, {
          fetch: mockFetch,
        }),
      ),
    );

    expect(output.ok).toBe(true);
    expect(output.command).toBe("extract run");
    expect(output.data.count).toBe(2);
    expect(output.data.values).toEqual(["Hello", "World"]);
  });
});
