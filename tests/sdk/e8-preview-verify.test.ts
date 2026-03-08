import { describe, expect, it } from "@effect-native/bun-test";
import { mock } from "bun:test";
import { Effect, Schema } from "effect";
import { runAccessPreviewOperation, runRenderPreviewOperation } from "effect-scrapling/e8";
import { executeCli } from "../../src/standalone.ts";
import { resetBrowserPoolForTests } from "../../src/sdk/browser-pool.ts";
import { AccessPreviewResponseSchema, RenderPreviewResponseSchema } from "../../src/sdk/schemas.ts";
import { InvalidInputError } from "../../src/sdk/errors.ts";

function mockHtmlFetch(body: string) {
  return async (input: string | URL | Request) => {
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

describe("E8 preview verification", () => {
  it.effect("keeps access and render preview outputs aligned across SDK and CLI", () =>
    Effect.gen(function* () {
      yield* resetBrowserPoolForTests();
      const fetchClient = mockHtmlFetch(
        "<html><head><title>Effect Scrapling</title></head><body><main>Preview</main></body></html>",
      );
      const accessSdk = yield* runAccessPreviewOperation(
        { url: "https://example.com/e8-preview" },
        fetchClient,
      );
      const accessCli = yield* Effect.promise(() =>
        executeCli(["access", "preview", "--url", "https://example.com/e8-preview"], fetchClient),
      );

      mock.module("playwright", () => ({
        chromium: {
          launch: async () => ({
            newContext: async () => ({
              newPage: async () => ({
                route: async () => {},
                goto: async () => ({
                  status: () => 200,
                  allHeaders: async () => ({ "content-type": "text/html; charset=utf-8" }),
                }),
                waitForLoadState: async () => {},
                content: async () =>
                  "<html><body><main>Rendered browser preview</main></body></html>",
                screenshot: async () => Buffer.from("render"),
                evaluate: async () => ({
                  requestCount: 1,
                  responseCount: 1,
                  failedRequestCount: 0,
                }),
                url: () => "https://example.com/e8-preview",
                close: async () => {},
              }),
              close: async () => {},
            }),
            close: async () => {},
          }),
        },
      }));

      try {
        const renderSdk = yield* runRenderPreviewOperation({
          url: "https://example.com/e8-preview",
          browser: {
            waitUntil: "networkidle",
            timeoutMs: 300,
          },
        });
        const renderCli = yield* Effect.promise(() =>
          executeCli([
            "render",
            "preview",
            "--url",
            "https://example.com/e8-preview",
            "--wait-until",
            "networkidle",
            "--wait-ms",
            "300",
          ]),
        );

        expect(Schema.decodeUnknownSync(AccessPreviewResponseSchema)(accessSdk)).toEqual(
          Schema.decodeUnknownSync(AccessPreviewResponseSchema)(JSON.parse(accessCli.output)),
        );
        expect(Schema.decodeUnknownSync(RenderPreviewResponseSchema)(renderSdk)).toEqual(
          Schema.decodeUnknownSync(RenderPreviewResponseSchema)(JSON.parse(renderCli.output)),
        );
        expect(renderSdk.data.status.ok).toBe(true);
        expect(renderSdk.data.artifacts.map(({ kind }) => kind)).toEqual([
          "navigation",
          "renderedDom",
          "timings",
        ]);
      } finally {
        yield* resetBrowserPoolForTests();
        mock.restore();
      }
    }),
  );

  it.effect("rejects malformed preview payloads deterministically across SDK and CLI", () =>
    Effect.gen(function* () {
      const renderSdkError = yield* Effect.flip(
        runRenderPreviewOperation({
          url: "https://example.com/e8-preview",
          browser: {
            waitUntil: "later",
          },
        }),
      );
      const renderCli = yield* Effect.promise(() =>
        executeCli([
          "render",
          "preview",
          "--url",
          "https://example.com/e8-preview",
          "--wait-until",
          "later",
        ]),
      );
      const accessCli = yield* Effect.promise(() =>
        executeCli(["access", "preview", "--mode", "browser"]),
      );

      expect(renderSdkError).toBeInstanceOf(InvalidInputError);
      expect(renderSdkError.message).toContain("Invalid render preview payload");
      expect(renderCli.exitCode).toBe(2);
      expect(JSON.parse(renderCli.output)).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });
      expect(accessCli.exitCode).toBe(2);
      expect(JSON.parse(accessCli.output)).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });
    }),
  );
});
