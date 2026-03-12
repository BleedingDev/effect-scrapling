import { Effect } from "effect";
import {
  type AccessEngineDecisionTrace,
  type AccessEngineLinkSnapshot,
  type AccessPreviewResponse,
  createEngine,
  defineAccessModule,
  type ExtractRunResponse,
  type FetchClient,
} from "effect-scrapling/sdk";

/**
 * Minimal public-consumer SDK example.
 *
 * Run:
 *   bun run example:sdk-consumer
 *
 * Prerequisites:
 * - Bun >= 1.3.10
 * - Use `FetchServiceLive` for real network access, or provide your own `FetchService` in tests.
 * - Install Playwright browsers with `bun run browser:install` before using `mode: "browser"`.
 *
 * Pitfalls / expected errors:
 * - SDK commands validate payloads before any fetch happens and fail with `InvalidInputError` for malformed input.
 * - Consumers should import from `effect-scrapling/sdk`, not `src/sdk/*`.
 */

export const consumerExamplePrerequisites = [
  "Bun >= 1.3.10",
  "Use FetchServiceLive for real network access, or provide FetchService explicitly in tests and examples.",
  'Install Playwright browsers with "bun run browser:install" before using mode: "browser".',
] as const;

export const consumerExamplePitfalls = [
  "SDK commands validate payloads before any fetch happens.",
  "Malformed payloads fail with InvalidInputError and should be handled explicitly.",
  "Explain and link-inspection output is for diagnostics and assembly visibility, not for mutating engine internals.",
  "Import from effect-scrapling/sdk instead of src/sdk/* private paths.",
] as const;

export type ConsumerExampleResult = {
  readonly explain: AccessEngineDecisionTrace;
  readonly linking: AccessEngineLinkSnapshot;
  readonly preview: AccessPreviewResponse;
  readonly extract: ExtractRunResponse;
  readonly expectedError: {
    readonly tag: "InvalidInputError";
    readonly message: string;
    readonly details: string | undefined;
  };
};

function resolveMockResponseUrl(input: Parameters<FetchClient>[0]): string {
  return new Request(input).url;
}

const mockFetch: FetchClient = async (input, _init) => {
  const response = new Response(
    `
      <html>
        <body>
          <article data-kind="demo">
            <h1>Effect Scrapling</h1>
            <p>Consumer contract example</p>
          </article>
        </body>
      </html>
    `,
    {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
  Object.defineProperty(response, "url", {
    value: resolveMockResponseUrl(input),
    configurable: true,
  });
  return response;
};

const SyntheticHttpDriverModule = defineAccessModule({
  id: "sdk-consumer-synthetic-http-module",
  drivers: {
    "consumer-http": {
      id: "consumer-http",
      capabilities: {
        mode: "http",
        rendersDom: false,
      },
      execute: ({ url }) =>
        Effect.succeed({
          url,
          finalUrl: url,
          status: 200,
          contentType: "text/html; charset=utf-8",
          contentLength: 104,
          html: "<html><body><h1>Effect Scrapling</h1><p>Consumer contract example</p></body></html>",
          durationMs: 4,
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

export function runConsumerExample(): Effect.Effect<ConsumerExampleResult, never, never> {
  return Effect.acquireUseRelease(
    createEngine({
      fetchClient: mockFetch,
      modules: [SyntheticHttpDriverModule],
    }),
    (engine) =>
      Effect.all({
        explain: engine
          .explainAccessPreview({
            url: "https://consumer.example/articles/effect-scrapling",
            execution: {
              driverId: "consumer-http",
            },
          })
          .pipe(Effect.orDie) as Effect.Effect<AccessEngineDecisionTrace, never, never>,
        linking: engine.inspectLinkSnapshot().pipe(Effect.orDie) as Effect.Effect<
          AccessEngineLinkSnapshot,
          never,
          never
        >,
        preview: engine
          .accessPreview({
            url: "https://consumer.example/articles/effect-scrapling",
            execution: {
              driverId: "consumer-http",
            },
          })
          .pipe(Effect.orDie) as Effect.Effect<AccessPreviewResponse, never, never>,
        extract: engine
          .extractRun({
            url: "https://consumer.example/articles/effect-scrapling",
            selector: "h1",
            execution: {
              driverId: "consumer-http",
            },
          })
          .pipe(Effect.orDie) as Effect.Effect<ExtractRunResponse, never, never>,
        expectedError: engine.accessPreview({}).pipe(
          Effect.flatMap(() => Effect.die(new Error("Expected InvalidInputError failure"))),
          Effect.catchTag("InvalidInputError", ({ message, details }) =>
            Effect.succeed({
              tag: "InvalidInputError" as const,
              message,
              details,
            }),
          ),
          Effect.orDie,
        ),
      }),
    (engine) => engine.close,
  );
}

if (import.meta.main) {
  const payload = await Effect.runPromise(runConsumerExample());
  console.log(
    JSON.stringify(
      {
        importPath: "effect-scrapling/sdk",
        prerequisites: consumerExamplePrerequisites,
        pitfalls: consumerExamplePitfalls,
        payload,
      },
      null,
      2,
    ),
  );
}
