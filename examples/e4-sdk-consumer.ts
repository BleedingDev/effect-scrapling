import { mock } from "bun:test";
import { Effect, Schema } from "effect";
import {
  accessPreview,
  AccessPreviewRequestSchema,
  FetchServiceLive,
  renderPreview,
  RenderPreviewRequestSchema,
  type AccessPreviewRequest,
  type AccessPreviewResponse,
  type RenderPreviewRequest,
  type RenderPreviewResponse,
} from "effect-scrapling/sdk";

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

export const e4SdkConsumerPrerequisites = [
  "Bun >= 1.3.10",
  'Install Chromium once with "bun run browser:install" before real browser-mode runs.',
  "Provide FetchServiceLive at the public SDK boundary even when the request mode is browser.",
] as const;

export const e4SdkConsumerPitfalls = [
  "Browser-mode requests still validate URLs up front and reject localhost or private-network targets.",
  'Pages with long-lived connections may need `browser.waitUntil: "commit"` or a larger browser timeout.',
  "Handle InvalidInputError and BrowserError explicitly instead of assuming every failure is a fetch failure.",
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

function provideSdkEnvironment<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.provide(FetchServiceLive));
}

function installSyntheticPlaywrightModule() {
  mock.module("playwright", () => ({
    chromium: {
      launch: async () => ({
        newContext: async (_options: { readonly userAgent: string }) => ({
          newPage: async () => {
            let currentUrl = BROWSER_ACCESS_URL;

            return {
              route: async () => undefined,
              goto: async (
                url: string,
                _gotoOptions: {
                  readonly waitUntil: "load" | "domcontentloaded" | "networkidle" | "commit";
                  readonly timeout: number;
                },
              ) => {
                currentUrl = url;

                return {
                  status: () => 200,
                  allHeaders: async () => ({
                    "content-type": "text/html; charset=utf-8",
                  }),
                };
              },
              content: async () => SYNTHETIC_BROWSER_HTML,
              url: () => currentUrl,
              waitForLoadState: async () => undefined,
              close: async () => undefined,
            };
          },
          close: async () => undefined,
        }),
        close: async () => undefined,
      }),
    },
  }));
}

function withSyntheticPlaywright<A, E>(effect: Effect.Effect<A, E, never>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      installSyntheticPlaywrightModule();
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        mock.restore();
      }),
  );
}

function createAccessRequest(): AccessPreviewRequest {
  return Schema.decodeUnknownSync(AccessPreviewRequestSchema)({
    url: BROWSER_ACCESS_URL,
    mode: "browser",
    timeoutMs: 1_500,
    browser: {
      waitUntil: "commit",
      timeoutMs: 450,
      userAgent: "Consumer Browser Preview",
    },
  });
}

function createRenderRequest(): RenderPreviewRequest {
  return Schema.decodeUnknownSync(RenderPreviewRequestSchema)({
    url: RENDER_PREVIEW_URL,
    timeoutMs: 2_000,
    browser: {
      waitUntil: "networkidle",
      timeoutMs: 900,
      userAgent: "Consumer Browser Render",
    },
  });
}

function runE4SdkConsumerProgram(): Effect.Effect<E4SdkConsumerExampleResult, never, never> {
  return Effect.gen(function* () {
    const accessRequest = createAccessRequest();
    const renderRequest = createRenderRequest();

    const accessPreviewResponse = yield* provideSdkEnvironment(accessPreview(accessRequest)).pipe(
      Effect.orDie,
    );
    const renderPreviewResponse = yield* provideSdkEnvironment(renderPreview(renderRequest)).pipe(
      Effect.orDie,
    );

    const expectedError = yield* provideSdkEnvironment(
      accessPreview({
        url: "https://127.0.0.1/internal",
        mode: "browser",
      }).pipe(
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
      ),
    ).pipe(Effect.orDie);

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
  });
}

export function runE4SdkConsumerExample(options?: { readonly useSyntheticBrowser?: boolean }) {
  const program = runE4SdkConsumerProgram();
  return options?.useSyntheticBrowser ? withSyntheticPlaywright(program) : program;
}

if (import.meta.main) {
  const payload = await Effect.runPromise(
    runE4SdkConsumerExample({
      useSyntheticBrowser: process.env.EFFECT_SCRAPLING_E4_EXAMPLE_SYNTHETIC_BROWSER === "1",
    }),
  );
  console.log(JSON.stringify(payload, null, 2));
}
