import { Effect, Schema } from "effect";
import {
  AccessPreviewRequestSchema,
  RenderPreviewRequestSchema,
  createEngine,
  defineAccessModule,
  type AccessPreviewRequest,
  type AccessPreviewResponse,
  type RenderPreviewRequest,
  type RenderPreviewResponse,
} from "effect-scrapling/sdk";

const SYNTHETIC_BROWSER_PROVIDER_ID = "synthetic-browser";
const BROWSER_ACCESS_URL = "https://consumer.example/products/sku-42";
const RENDER_PREVIEW_URL = "https://consumer.example/products/sku-42?view=full";
const SYNTHETIC_BROWSER_HTML = `
  <html>
    <head>
      <title>Selective Browser Preview</title>
    </head>
    <body>
      <main data-runtime="browser">
        <h1>Effect Scrapling browser preview</h1>
        <p>Selective browser execution for high-friction targets.</p>
        <a href="/offers/sku-42?ref=browser">View offer</a>
        <input type="hidden" name="session" value="consumer-session" />
      </main>
    </body>
  </html>
`;

const SyntheticBrowserAccessModule = defineAccessModule({
  id: "synthetic-browser-access-module",
  providers: {
    [SYNTHETIC_BROWSER_PROVIDER_ID]: {
      id: SYNTHETIC_BROWSER_PROVIDER_ID,
      capabilities: {
        mode: "browser",
        rendersDom: true,
      },
      execute: ({ url }) =>
        Effect.succeed({
          url,
          finalUrl: url,
          status: 200,
          contentType: "text/html; charset=utf-8",
          contentLength: SYNTHETIC_BROWSER_HTML.length,
          html: SYNTHETIC_BROWSER_HTML,
          durationMs: 5,
          timings: {
            requestCount: 1,
            redirectCount: 0,
            blockedRequestCount: 0,
            gotoDurationMs: 2,
            loadStateDurationMs: 1,
            domReadDurationMs: 1,
            headerReadDurationMs: 1,
          },
          warnings: [],
        }),
    },
  },
});

export const e4SdkConsumerPrerequisites = [
  "Bun >= 1.3.10",
  "Use only the public effect-scrapling/sdk package subpath from downstream projects.",
  "Author browser integrations as access modules instead of importing repository-private runtime hooks.",
] as const;

export const e4SdkConsumerPitfalls = [
  "Browser-mode requests still validate URLs up front and reject localhost or private-network targets.",
  "Custom browser providers should return normalized HTML/status/timing data and let the engine attach canonical execution metadata.",
  "Link custom modules additively so builtin HTTP and profile defaults stay available unless you intentionally disable them.",
] as const;

type ExampleExpectedError = {
  readonly tag: "InvalidInputError";
  readonly message: string;
  readonly details: string | undefined;
};

export type E4SdkConsumerExampleResult = {
  readonly importPath: "effect-scrapling/sdk";
  readonly prerequisites: typeof e4SdkConsumerPrerequisites;
  readonly pitfalls: typeof e4SdkConsumerPitfalls;
  readonly payload: {
    readonly accessRequest: AccessPreviewRequest;
    readonly accessPreview: AccessPreviewResponse;
    readonly renderRequest: RenderPreviewRequest;
    readonly renderPreview: RenderPreviewResponse;
    readonly expectedError: ExampleExpectedError;
  };
};

function createAccessRequest(): AccessPreviewRequest {
  return Schema.decodeUnknownSync(AccessPreviewRequestSchema)({
    url: BROWSER_ACCESS_URL,
    timeoutMs: 1_500,
    execution: {
      providerId: SYNTHETIC_BROWSER_PROVIDER_ID,
      browser: {
        waitUntil: "commit",
        timeoutMs: 450,
        userAgent: "Consumer Browser Preview",
      },
    },
  });
}

function createRenderRequest(): RenderPreviewRequest {
  return Schema.decodeUnknownSync(RenderPreviewRequestSchema)({
    url: RENDER_PREVIEW_URL,
    timeoutMs: 2_000,
    execution: {
      providerId: SYNTHETIC_BROWSER_PROVIDER_ID,
      browser: {
        waitUntil: "networkidle",
        timeoutMs: 900,
        userAgent: "Consumer Browser Render",
      },
    },
  });
}

function runE4SdkConsumerProgram(): Effect.Effect<E4SdkConsumerExampleResult, never, never> {
  return Effect.acquireUseRelease(
    createEngine({
      modules: [SyntheticBrowserAccessModule],
    }),
    (engine) =>
      Effect.gen(function* () {
        const accessRequest = createAccessRequest();
        const renderRequest = createRenderRequest();

        const accessPreviewResponse = yield* engine.accessPreview(accessRequest).pipe(Effect.orDie);
        const renderPreviewResponse = yield* engine.renderPreview(renderRequest).pipe(Effect.orDie);

        const expectedError = yield* engine
          .accessPreview({
            url: "https://127.0.0.1/internal",
            execution: {
              providerId: SYNTHETIC_BROWSER_PROVIDER_ID,
            },
          })
          .pipe(
            Effect.flatMap(() =>
              Effect.die(
                new Error("Expected InvalidInputError for a private-network browser preview URL"),
              ),
            ),
            Effect.catchTag("InvalidInputError", ({ message, details }) =>
              Effect.succeed<ExampleExpectedError>({
                tag: "InvalidInputError",
                message,
                details,
              }),
            ),
            Effect.orDie,
          );

        return {
          importPath: "effect-scrapling/sdk",
          prerequisites: e4SdkConsumerPrerequisites,
          pitfalls: e4SdkConsumerPitfalls,
          payload: {
            accessRequest,
            accessPreview: accessPreviewResponse,
            renderRequest,
            renderPreview: renderPreviewResponse,
            expectedError,
          },
        };
      }),
    (engine) => engine.close,
  );
}

export function runE4SdkConsumerExample() {
  return runE4SdkConsumerProgram();
}

if (import.meta.main) {
  const payload = await Effect.runPromise(runE4SdkConsumerExample());
  console.log(JSON.stringify(payload, null, 2));
}
