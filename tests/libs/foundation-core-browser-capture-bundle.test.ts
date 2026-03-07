import { Buffer } from "node:buffer";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  buildRedactedBrowserArtifactExports,
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
              content: async () =>
                `<html><head><title>Rendered Bundle</title><meta content="meta-secret" /></head><body><script>const token = "script-secret";</script><main>Rendered token=dom-secret Bearer bearer-secret</main><a href="https://user:pass@example.com/account?token=link-secret#details"></a><img src="https://user:pass@example.com/account?token=link-secret#details" /><form action="https://example.com/checkout?session=checkout-secret#frag"><input type="hidden" value="csrf-secret" /></form><style>.secret { content: "style-secret"; }</style><noscript>noscript-secret</noscript></body></html>`,
              screenshot: async () => screenshotBytes,
              evaluate: async () => ({
                navigation: [
                  {
                    url: "https://user:pass@example.com/products/001?step=2&token=navigation-secret#frag",
                    type: "navigation",
                    startTimeMs: 4,
                    durationMs: 8,
                    transferSize: 1000,
                    encodedBodySize: 800,
                    decodedBodySize: 1600,
                    responseStatus: 200,
                  },
                  {
                    url: "https://example.com/products/001?session=navigation-session",
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
                    url: "https://cdn.example.com/script.js?api_key=resource-secret",
                    initiatorType: "script",
                    startTimeMs: 9,
                    durationMs: 6,
                    transferSize: 450,
                    encodedBodySize: 350,
                    decodedBodySize: 700,
                  },
                  {
                    url: "https://cdn.example.com/app.css#stylesheet-fragment",
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
        const exportBundle = buildRedactedBrowserArtifactExports(bundle);
        const renderedDomExport = JSON.parse(exportBundle.exports[0]?.body ?? "{}");
        const screenshotExport = JSON.parse(exportBundle.exports[1]?.body ?? "{}");
        const exportedNetworkSummary = Schema.decodeUnknownSync(BrowserNetworkSummarySchema)(
          JSON.parse(exportBundle.exports[2]?.body ?? "{}"),
        );
        const exportedTimings = JSON.parse(exportBundle.exports[3]?.body ?? "{}");
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
        expect(
          exportBundle.exports.map(({ kind, sourceVisibility, mediaType }) => ({
            kind,
            sourceVisibility,
            mediaType,
          })),
        ).toEqual([
          {
            kind: "renderedDom",
            sourceVisibility: "raw",
            mediaType: "application/json",
          },
          {
            kind: "screenshot",
            sourceVisibility: "raw",
            mediaType: "application/json",
          },
          {
            kind: "networkSummary",
            sourceVisibility: "redacted",
            mediaType: "application/json",
          },
          {
            kind: "timings",
            sourceVisibility: "redacted",
            mediaType: "application/json",
          },
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
              url: "https://example.com/products/001?session=%5BREDACTED%5D",
              type: "navigation",
              startTimeMs: 1,
              durationMs: 12,
              transferSize: 900,
              encodedBodySize: 700,
              decodedBodySize: 1500,
              responseStatus: 302,
            },
            {
              url: "https://example.com/products/001?step=2&token=%5BREDACTED%5D",
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
              url: "https://cdn.example.com/script.js?api_key=%5BREDACTED%5D",
              initiatorType: "script",
              startTimeMs: 9,
              durationMs: 6,
              transferSize: 450,
              encodedBodySize: 350,
              decodedBodySize: 700,
            },
          ],
        });
        expect(renderedDomExport).toEqual({
          title: "Rendered Bundle",
          textPreview: "Rendered token=[REDACTED] Bearer [REDACTED]",
          linkTargets: [
            "https://example.com/account?token=%5BREDACTED%5D",
            "https://example.com/checkout?session=%5BREDACTED%5D",
          ],
          hiddenFieldCount: 2,
        });
        expect(exportBundle.exports[0]?.body).not.toContain("script-secret");
        expect(exportBundle.exports[0]?.body).not.toContain("style-secret");
        expect(exportBundle.exports[0]?.body).not.toContain("noscript-secret");
        expect(exportBundle.exports[0]?.body).not.toContain("csrf-secret");
        expect(screenshotExport).toEqual({
          artifactId: `${browserPlan.id}-screenshot`,
          mediaType: "image/png",
          sizeBytes: screenshotBytes.byteLength,
          sha256: encodedBundle.artifacts[1]?.sha256,
          note: "Binary screenshot payload omitted from redacted export.",
        });
        expect(exportBundle.exports[1]?.body).not.toContain(
          Buffer.from(screenshotBytes).toString("base64"),
        );
        expect(exportedNetworkSummary).toEqual({
          navigation: [
            {
              url: "https://example.com/products/001?session=%5BREDACTED%5D",
              type: "navigation",
              startTimeMs: 1,
              durationMs: 12,
              transferSize: 900,
              encodedBodySize: 700,
              decodedBodySize: 1500,
              responseStatus: 302,
            },
            {
              url: "https://example.com/products/001?step=2&token=%5BREDACTED%5D",
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
              url: "https://cdn.example.com/script.js?api_key=%5BREDACTED%5D",
              initiatorType: "script",
              startTimeMs: 9,
              durationMs: 6,
              transferSize: 450,
              encodedBodySize: 350,
              decodedBodySize: 700,
            },
          ],
        });
        expect(exportedTimings).toEqual({
          startedAt: "2026-03-06T10:00:05.000Z",
          completedAt: "2026-03-06T10:00:07.000Z",
          elapsedMs: 2000,
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
      const error = yield* captureBrowserArtifacts(httpPlan, browser).pipe(
        Effect.match({
          onFailure: (failure) => failure,
          onSuccess: () => new Error("unexpected-success"),
        }),
      );

      expect(error.name).toBe("PolicyViolation");
      expect(error.message).toContain("does not require browser resources");
      expect(openedContexts.current).toBe(0);
    }),
  );

  it("re-sanitizes browser payloads before prompt or log export", () => {
    const screenshotBody = Buffer.from(Uint8Array.from([1, 2, 3, 4])).toString("base64");
    const bundle = Schema.decodeUnknownSync(BrowserCaptureBundleSchema)({
      capturedAt: "2026-03-06T10:00:07.000Z",
      artifacts: [
        {
          id: "artifact-rendered-dom-001",
          runId: browserPlan.id,
          artifactId: "artifact-rendered-dom-001",
          kind: "renderedDom",
          visibility: "raw",
          locator: {
            namespace: `captures/${browserPlan.targetId}`,
            key: `${browserPlan.id}/rendered-dom.html`,
          },
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          sizeBytes: 128,
          mediaType: "text/html",
          storedAt: "2026-03-06T10:00:07.000Z",
        },
        {
          id: "artifact-screenshot-001",
          runId: browserPlan.id,
          artifactId: "artifact-screenshot-001",
          kind: "screenshot",
          visibility: "raw",
          locator: {
            namespace: `captures/${browserPlan.targetId}`,
            key: `${browserPlan.id}/screenshot.png`,
          },
          sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          sizeBytes: 4,
          mediaType: "image/png",
          storedAt: "2026-03-06T10:00:07.000Z",
        },
        {
          id: "artifact-network-summary-001",
          runId: browserPlan.id,
          artifactId: "artifact-network-summary-001",
          kind: "networkSummary",
          visibility: "redacted",
          locator: {
            namespace: `captures/${browserPlan.targetId}`,
            key: `${browserPlan.id}/network-summary.json`,
          },
          sha256: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
          sizeBytes: 96,
          mediaType: "application/json",
          storedAt: "2026-03-06T10:00:07.000Z",
        },
        {
          id: "artifact-timings-001",
          runId: browserPlan.id,
          artifactId: "artifact-timings-001",
          kind: "timings",
          visibility: "redacted",
          locator: {
            namespace: `captures/${browserPlan.targetId}`,
            key: `${browserPlan.id}/timings.json`,
          },
          sha256: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
          sizeBytes: 80,
          mediaType: "application/json",
          storedAt: "2026-03-06T10:00:07.000Z",
        },
      ],
      payloads: [
        {
          locator: {
            namespace: `captures/${browserPlan.targetId}`,
            key: `${browserPlan.id}/rendered-dom.html`,
          },
          mediaType: "text/html",
          encoding: "utf8",
          body: `<html><head><title>Prompt Export token=title-secret Bearer title-secret</title></head><body><main>Bearer dom-secret token=prompt-secret</main><a href="/account?session=session-secret#frag">account</a><form action="?token=form-secret#frag"></form></body></html>`,
        },
        {
          locator: {
            namespace: `captures/${browserPlan.targetId}`,
            key: `${browserPlan.id}/screenshot.png`,
          },
          mediaType: "image/png",
          encoding: "base64",
          body: screenshotBody,
        },
        {
          locator: {
            namespace: `captures/${browserPlan.targetId}`,
            key: `${browserPlan.id}/network-summary.json`,
          },
          mediaType: "application/json",
          encoding: "utf8",
          body: `${JSON.stringify(
            {
              navigation: [
                {
                  url: "https://user:pass@example.com/account?token=raw-secret#frag",
                  type: "navigation",
                  startTimeMs: 1,
                  durationMs: 2,
                  transferSize: 3,
                  encodedBodySize: 4,
                  decodedBodySize: 5,
                  responseStatus: 200,
                },
              ],
              resources: [],
            },
            null,
            2,
          )}\n`,
        },
        {
          locator: {
            namespace: `captures/${browserPlan.targetId}`,
            key: `${browserPlan.id}/timings.json`,
          },
          mediaType: "application/json",
          encoding: "utf8",
          body: `${JSON.stringify(
            {
              startedAt: "2026-03-06T10:00:05.000Z",
              completedAt: "2026-03-06T10:00:07.000Z",
              elapsedMs: 2,
            },
            null,
            2,
          )}\n`,
        },
      ],
    });
    const exportBundle = buildRedactedBrowserArtifactExports(bundle);
    const renderedDomExport = JSON.parse(exportBundle.exports[0]?.body ?? "{}");
    const networkExport = JSON.parse(exportBundle.exports[2]?.body ?? "{}");

    expect(exportBundle.exports.map(({ kind }) => kind)).toEqual([
      "renderedDom",
      "screenshot",
      "networkSummary",
      "timings",
    ]);
    expect(exportBundle.exports.map(({ sourceVisibility }) => sourceVisibility)).toEqual([
      "raw",
      "raw",
      "redacted",
      "redacted",
    ]);
    expect(renderedDomExport).toMatchObject({
      title: "Prompt Export token=[REDACTED] Bearer [REDACTED]",
      linkTargets: ["/account?session=%5BREDACTED%5D", "?token=%5BREDACTED%5D"],
    });
    expect(exportBundle.exports[0]?.body).toContain("Bearer [REDACTED]");
    expect(exportBundle.exports[0]?.body).toContain("token=[REDACTED]");
    expect(exportBundle.exports[0]?.body).not.toContain("title-secret");
    expect(exportBundle.exports[0]?.body).not.toContain("session-secret");
    expect(exportBundle.exports[0]?.body).not.toContain("form-secret");
    expect(exportBundle.exports[1]?.body).toContain("Binary screenshot payload omitted");
    expect(exportBundle.exports[1]?.body).not.toContain(screenshotBody);
    expect(networkExport).toEqual({
      navigation: [
        {
          url: "https://example.com/account?token=%5BREDACTED%5D",
          type: "navigation",
          startTimeMs: 1,
          durationMs: 2,
          transferSize: 3,
          encodedBodySize: 4,
          decodedBodySize: 5,
          responseStatus: 200,
        },
      ],
      resources: [],
    });
    expect(exportBundle.exports[3]?.body).toContain('"elapsedMs": 2');
  });

  it("emits a deterministic redacted export fallback when a browser payload is missing", () => {
    const bundle = Schema.decodeUnknownSync(BrowserCaptureBundleSchema)({
      capturedAt: "2026-03-06T10:00:07.000Z",
      artifacts: [
        {
          id: "artifact-rendered-dom-missing-001",
          runId: browserPlan.id,
          artifactId: "artifact-rendered-dom-missing-001",
          kind: "renderedDom",
          visibility: "raw",
          locator: {
            namespace: `captures/${browserPlan.targetId}`,
            key: `${browserPlan.id}/rendered-dom.html`,
          },
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          sizeBytes: 8,
          mediaType: "text/html",
          storedAt: "2026-03-06T10:00:07.000Z",
        },
        {
          id: "artifact-screenshot-missing-001",
          runId: browserPlan.id,
          artifactId: "artifact-screenshot-missing-001",
          kind: "screenshot",
          visibility: "raw",
          locator: {
            namespace: `captures/${browserPlan.targetId}`,
            key: `${browserPlan.id}/screenshot.png`,
          },
          sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          sizeBytes: 8,
          mediaType: "image/png",
          storedAt: "2026-03-06T10:00:07.000Z",
        },
        {
          id: "artifact-network-summary-missing-001",
          runId: browserPlan.id,
          artifactId: "artifact-network-summary-missing-001",
          kind: "networkSummary",
          visibility: "redacted",
          locator: {
            namespace: `captures/${browserPlan.targetId}`,
            key: `${browserPlan.id}/network-summary.json`,
          },
          sha256: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
          sizeBytes: 8,
          mediaType: "application/json",
          storedAt: "2026-03-06T10:00:07.000Z",
        },
        {
          id: "artifact-timings-missing-001",
          runId: browserPlan.id,
          artifactId: "artifact-timings-missing-001",
          kind: "timings",
          visibility: "redacted",
          locator: {
            namespace: `captures/${browserPlan.targetId}`,
            key: `${browserPlan.id}/timings.json`,
          },
          sha256: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
          sizeBytes: 8,
          mediaType: "application/json",
          storedAt: "2026-03-06T10:00:07.000Z",
        },
      ],
      payloads: [],
    });
    const exportBundle = buildRedactedBrowserArtifactExports(bundle);

    expect(exportBundle.exports).toHaveLength(4);
    expect(exportBundle.exports.map(({ kind }) => kind)).toEqual([
      "renderedDom",
      "screenshot",
      "networkSummary",
      "timings",
    ]);
    expect(exportBundle.exports.map(({ body }) => JSON.parse(body))).toEqual([
      {
        artifactId: "artifact-rendered-dom-missing-001",
        note: "Artifact payload was unavailable for redacted export.",
      },
      {
        artifactId: "artifact-screenshot-missing-001",
        note: "Artifact payload was unavailable for redacted export.",
      },
      {
        artifactId: "artifact-network-summary-missing-001",
        note: "Artifact payload was unavailable for redacted export.",
      },
      {
        artifactId: "artifact-timings-missing-001",
        note: "Artifact payload was unavailable for redacted export.",
      },
    ]);
  });

  it("emits a deterministic redacted export fallback when a network summary payload is malformed JSON", () => {
    const bundle = Schema.decodeUnknownSync(BrowserCaptureBundleSchema)({
      capturedAt: "2026-03-06T10:00:07.000Z",
      artifacts: [
        {
          id: "artifact-network-summary-invalid-json-001",
          runId: browserPlan.id,
          artifactId: "artifact-network-summary-invalid-json-001",
          kind: "networkSummary",
          visibility: "redacted",
          locator: {
            namespace: `captures/${browserPlan.targetId}`,
            key: `${browserPlan.id}/network-summary.json`,
          },
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          sizeBytes: 32,
          mediaType: "application/json",
          storedAt: "2026-03-06T10:00:07.000Z",
        },
      ],
      payloads: [
        {
          locator: {
            namespace: `captures/${browserPlan.targetId}`,
            key: `${browserPlan.id}/network-summary.json`,
          },
          mediaType: "application/json",
          encoding: "utf8",
          body: '{"navigation":[{"url":"https://example.com?token=json-secret"}]',
        },
      ],
    });
    const exportBundle = buildRedactedBrowserArtifactExports(bundle);

    expect(JSON.parse(exportBundle.exports[0]?.body ?? "{}")).toEqual({
      artifactId: "artifact-network-summary-invalid-json-001",
      note: "Artifact payload failed redaction validation.",
    });
    expect(exportBundle.exports[0]?.body).not.toContain("json-secret");
  });

  it("emits a deterministic redacted export fallback when a network summary payload fails schema validation", () => {
    const bundle = Schema.decodeUnknownSync(BrowserCaptureBundleSchema)({
      capturedAt: "2026-03-06T10:00:07.000Z",
      artifacts: [
        {
          id: "artifact-network-summary-invalid-shape-001",
          runId: browserPlan.id,
          artifactId: "artifact-network-summary-invalid-shape-001",
          kind: "networkSummary",
          visibility: "redacted",
          locator: {
            namespace: `captures/${browserPlan.targetId}`,
            key: `${browserPlan.id}/network-summary.json`,
          },
          sha256: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
          sizeBytes: 64,
          mediaType: "application/json",
          storedAt: "2026-03-06T10:00:07.000Z",
        },
      ],
      payloads: [
        {
          locator: {
            namespace: `captures/${browserPlan.targetId}`,
            key: `${browserPlan.id}/network-summary.json`,
          },
          mediaType: "application/json",
          encoding: "utf8",
          body: JSON.stringify({
            navigation: [
              {
                url: "https://example.com/products/001?token=schema-secret",
              },
            ],
            resources: [],
          }),
        },
      ],
    });
    const exportBundle = buildRedactedBrowserArtifactExports(bundle);

    expect(JSON.parse(exportBundle.exports[0]?.body ?? "{}")).toEqual({
      artifactId: "artifact-network-summary-invalid-shape-001",
      note: "Artifact payload failed redaction validation.",
    });
    expect(exportBundle.exports[0]?.body).not.toContain("schema-secret");
  });

  it.effect(
    "maps browser rendered DOM failures to RenderCrashError and releases scoped resources",
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
              content: async () => {
                throw new Error("renderer lost execution context");
              },
              screenshot: async () => Uint8Array.from([10, 11, 12, 13]),
              evaluate: async () => ({ navigation: [], resources: [] }),
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
        const error = yield* captureBrowserArtifacts(browserPlan, browser).pipe(
          Effect.match({
            onFailure: (failure) => failure,
            onSuccess: () => new Error("unexpected-success"),
          }),
        );

        expect(error.name).toBe("RenderCrashError");
        expect(error.message).toContain("failed to capture rendered DOM");
        expect(closed.page).toBe(1);
        expect(closed.context).toBe(1);
      }),
  );

  it.effect(
    "maps browser screenshot failures to RenderCrashError and releases scoped resources",
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
              screenshot: async () => {
                throw new Error("capture target closed");
              },
              evaluate: async () => ({ navigation: [], resources: [] }),
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
        const error = yield* captureBrowserArtifacts(browserPlan, browser).pipe(
          Effect.match({
            onFailure: (failure) => failure,
            onSuccess: () => new Error("unexpected-success"),
          }),
        );

        expect(error.name).toBe("RenderCrashError");
        expect(error.message).toContain("failed to capture page screenshot");
        expect(closed.page).toBe(1);
        expect(closed.context).toBe(1);
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
        const error = yield* captureBrowserArtifacts(browserPlan, browser).pipe(
          Effect.match({
            onFailure: (failure) => failure,
            onSuccess: () => new Error("unexpected-success"),
          }),
        );

        expect(error.name).toBe("RenderCrashError");
        expect(error.message).toContain("failed to capture network summary");
        expect(closed.page).toBe(1);
        expect(closed.context).toBe(1);
      }),
  );
});
