import { Buffer } from "node:buffer";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  BrowserCaptureBundleSchema,
  BrowserNetworkSummarySchema,
  captureBrowserArtifacts,
  type BrowserInstance,
} from "../../libs/foundation/core/src/browser-access-runtime.ts";
import { RunPlanSchema } from "../../libs/foundation/core/src/run-state.ts";

const browserPlan = Schema.decodeUnknownSync(RunPlanSchema)({
  id: "plan-browser-bundle-001",
  targetId: "target-product-001",
  packId: "pack-example-com",
  accessPolicyId: "policy-browser",
  concurrencyBudgetId: "budget-browser-001",
  entryUrl: "https://example.com/products/001",
  maxAttempts: 2,
  timeoutMs: 30_000,
  checkpointInterval: 2,
  steps: [
    {
      id: "step-capture-001",
      stage: "capture",
      requiresBrowser: true,
      artifactKind: "renderedDom",
    },
    {
      id: "step-extract-001",
      stage: "extract",
      requiresBrowser: false,
    },
  ],
  createdAt: "2026-03-06T10:00:00.000Z",
});

const httpPlan = Schema.decodeUnknownSync(RunPlanSchema)({
  ...Schema.encodeSync(RunPlanSchema)(browserPlan),
  id: "plan-http-bundle-001",
  steps: [
    {
      id: "step-capture-001",
      stage: "capture",
      requiresBrowser: false,
      artifactKind: "html",
    },
    {
      id: "step-extract-001",
      stage: "extract",
      requiresBrowser: false,
    },
  ],
});

describe("foundation-core browser capture bundle", () => {
  it.effect(
    "captures rendered DOM screenshot network summary and timings as a complete bundle",
    () =>
      Effect.gen(function* () {
        const closed = {
          context: 0,
          page: 0,
        };
        const screenshotBytes = Uint8Array.from([10, 11, 12, 13]);
        const browser: BrowserInstance = {
          newContext: async () => ({
            newPage: async () => ({
              goto: async () => undefined,
              content: async () => "<html><body><main>Rendered</main></body></html>",
              screenshot: async () => screenshotBytes,
              evaluate: async () => ({
                navigation: [
                  {
                    url: "https://example.com/products/001?step=2",
                    type: "navigation",
                    startTimeMs: 4,
                    durationMs: 8,
                    transferSize: 1000,
                    encodedBodySize: 800,
                    decodedBodySize: 1600,
                    responseStatus: 200,
                  },
                  {
                    url: "https://example.com/products/001",
                    type: "navigation",
                    startTimeMs: 1,
                    durationMs: 12,
                    transferSize: 900,
                    encodedBodySize: 700,
                    decodedBodySize: 1500,
                    responseStatus: 302,
                  },
                ],
                resources: [
                  {
                    url: "https://cdn.example.com/script.js",
                    initiatorType: "script",
                    startTimeMs: 9,
                    durationMs: 6,
                    transferSize: 450,
                    encodedBodySize: 350,
                    decodedBodySize: 700,
                  },
                  {
                    url: "https://cdn.example.com/app.css",
                    initiatorType: "link",
                    startTimeMs: 2,
                    durationMs: 3,
                    transferSize: 300,
                    encodedBodySize: 250,
                    decodedBodySize: 500,
                  },
                ],
              }),
              close: async () => {
                closed.page += 1;
              },
            }),
            close: async () => {
              closed.context += 1;
            },
          }),
          close: async () => undefined,
        };
        const dates = [new Date("2026-03-06T10:00:05.000Z"), new Date("2026-03-06T10:00:07.000Z")];
        const bundle = yield* captureBrowserArtifacts(
          browserPlan,
          browser,
          () => dates.shift() ?? new Date("2026-03-06T10:00:07.000Z"),
        );
        const encodedBundle = Schema.encodeSync(BrowserCaptureBundleSchema)(bundle);
        const screenshotPayload = bundle.payloads.find(
          ({ mediaType }) => mediaType === "image/png",
        );
        const networkSummaryPayload = bundle.payloads.find(
          ({ locator }) => locator.key === `${browserPlan.id}/network-summary.json`,
        );

        expect(encodedBundle.artifacts.map(({ kind }) => kind)).toEqual([
          "renderedDom",
          "screenshot",
          "networkSummary",
          "timings",
        ]);
        expect(encodedBundle.payloads.map(({ locator }) => locator.namespace)).toEqual([
          `captures/${browserPlan.targetId}`,
          `captures/${browserPlan.targetId}`,
          `captures/${browserPlan.targetId}`,
          `captures/${browserPlan.targetId}`,
        ]);
        expect(encodedBundle.payloads.map(({ locator }) => locator.key)).toEqual([
          `${browserPlan.id}/rendered-dom.html`,
          `${browserPlan.id}/screenshot.png`,
          `${browserPlan.id}/network-summary.json`,
          `${browserPlan.id}/timings.json`,
        ]);
        expect(screenshotPayload?.encoding).toBe("base64");
        expect(screenshotPayload?.body).toBe(Buffer.from(screenshotBytes).toString("base64"));
        expect(encodedBundle.artifacts[1]?.sizeBytes).toBe(screenshotBytes.byteLength);
        expect(encodedBundle.artifacts[1]?.mediaType).toBe("image/png");
        expect(encodedBundle.artifacts[1]?.visibility).toBe("raw");
        expect(encodedBundle.artifacts[2]?.visibility).toBe("redacted");
        expect(
          Schema.decodeUnknownSync(BrowserNetworkSummarySchema)(
            JSON.parse(networkSummaryPayload?.body ?? "{}"),
          ),
        ).toEqual({
          navigation: [
            {
              url: "https://example.com/products/001",
              type: "navigation",
              startTimeMs: 1,
              durationMs: 12,
              transferSize: 900,
              encodedBodySize: 700,
              decodedBodySize: 1500,
              responseStatus: 302,
            },
            {
              url: "https://example.com/products/001?step=2",
              type: "navigation",
              startTimeMs: 4,
              durationMs: 8,
              transferSize: 1000,
              encodedBodySize: 800,
              decodedBodySize: 1600,
              responseStatus: 200,
            },
          ],
          resources: [
            {
              url: "https://cdn.example.com/app.css",
              initiatorType: "link",
              startTimeMs: 2,
              durationMs: 3,
              transferSize: 300,
              encodedBodySize: 250,
              decodedBodySize: 500,
            },
            {
              url: "https://cdn.example.com/script.js",
              initiatorType: "script",
              startTimeMs: 9,
              durationMs: 6,
              transferSize: 450,
              encodedBodySize: 350,
              decodedBodySize: 700,
            },
          ],
        });
        expect(closed.page).toBe(1);
        expect(closed.context).toBe(1);
      }),
  );

  it.effect("rejects non-browser plans before allocating browser context", () =>
    Effect.gen(function* () {
      const openedContexts = { current: 0 };
      const browser: BrowserInstance = {
        newContext: async () => {
          openedContexts.current += 1;
          return {
            newPage: async () => ({
              goto: async () => undefined,
              content: async () => "<html></html>",
              screenshot: async () => Uint8Array.from([1]),
              evaluate: async () => ({ navigation: [], resources: [] }),
              close: async () => undefined,
            }),
            close: async () => undefined,
          };
        },
        close: async () => undefined,
      };
      const error = yield* captureBrowserArtifacts(httpPlan, browser).pipe(Effect.flip);

      expect(error.name).toBe("PolicyViolation");
      expect(error.message).toContain("does not require browser resources");
      expect(openedContexts.current).toBe(0);
    }),
  );

  it.effect(
    "maps browser network summary failures to RenderCrashError and releases scoped resources",
    () =>
      Effect.gen(function* () {
        const closed = {
          context: 0,
          page: 0,
        };
        const browser: BrowserInstance = {
          newContext: async () => ({
            newPage: async () => ({
              goto: async () => undefined,
              content: async () => "<html><body><main>Rendered</main></body></html>",
              screenshot: async () => Uint8Array.from([10, 11, 12, 13]),
              evaluate: async () => {
                throw new Error("devtools protocol closed");
              },
              close: async () => {
                closed.page += 1;
              },
            }),
            close: async () => {
              closed.context += 1;
            },
          }),
          close: async () => undefined,
        };
        const error = yield* captureBrowserArtifacts(browserPlan, browser).pipe(Effect.flip);

        expect(error.name).toBe("RenderCrashError");
        expect(error.message).toContain("failed to capture network summary");
        expect(closed.page).toBe(1);
        expect(closed.context).toBe(1);
      }),
  );
});
