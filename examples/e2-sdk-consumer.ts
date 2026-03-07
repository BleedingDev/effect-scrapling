import { Effect, Schema } from "effect";
import {
  extractRun,
  ExtractRunRequestSchema,
  ExtractRunResponseSchema,
  FetchService,
  type FetchClient,
} from "effect-scrapling/sdk";

const EXAMPLE_URL = "https://consumer.example/products/sku-42";
const EXAMPLE_HTML = `
  <html>
    <body>
      <article data-sku="sku-42">
        <h1>Effect Scrapling Mug</h1>
        <span data-field="price">$21.49</span>
        <span data-field="availability">In stock</span>
      </article>
    </body>
  </html>
`;

export const e2SdkConsumerPrerequisites = [
  "Bun >= 1.3.10",
  'Run from repository root with "bun run example:e2-sdk-consumer".',
  "Replace the mock FetchService with FetchServiceLive or another public FetchService implementation for real network access.",
] as const;

export const e2SdkConsumerPitfalls = [
  "Import from effect-scrapling/sdk instead of src/sdk/* private paths.",
  "Handle SDK failures with Effect.catchTag instead of manual tag-property branching.",
  "Invalid or incomplete payloads fail with InvalidInputError before any fetch happens.",
  "Empty selector matches are warnings, not failures, so consumers should inspect the warnings array.",
  'Invalid CSS selectors fail with ExtractionError, for example selector "[".',
] as const;

const StringListSchema = Schema.NonEmptyArray(Schema.String);

export class CaughtInvalidInputErrorSummary extends Schema.Class<CaughtInvalidInputErrorSummary>(
  "CaughtInvalidInputErrorSummary",
)({
  caughtTag: Schema.Literal("InvalidInputError"),
  message: Schema.String,
  details: Schema.optional(Schema.String),
}) {}

export class CaughtExtractionErrorSummary extends Schema.Class<CaughtExtractionErrorSummary>(
  "CaughtExtractionErrorSummary",
)({
  caughtTag: Schema.Literal("ExtractionError"),
  message: Schema.String,
  details: Schema.optional(Schema.String),
}) {}

export class E2SdkConsumerPayload extends Schema.Class<E2SdkConsumerPayload>(
  "E2SdkConsumerPayload",
)({
  request: ExtractRunRequestSchema,
  response: ExtractRunResponseSchema,
  noMatchWarning: ExtractRunResponseSchema,
  invalidInputError: CaughtInvalidInputErrorSummary,
  invalidSelectorError: CaughtExtractionErrorSummary,
}) {}

export class E2SdkConsumerExampleResult extends Schema.Class<E2SdkConsumerExampleResult>(
  "E2SdkConsumerExampleResult",
)({
  importPath: Schema.Literal("effect-scrapling/sdk"),
  prerequisites: StringListSchema,
  pitfalls: StringListSchema,
  payload: E2SdkConsumerPayload,
}) {}

export const E2SdkConsumerExampleResultSchema = E2SdkConsumerExampleResult;

function resolveMockResponseUrl(input: Parameters<FetchClient>[0]): string {
  return new Request(input).url;
}

const mockFetch: FetchClient = async (input, _init) => {
  const response = new Response(EXAMPLE_HTML, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  Object.defineProperty(response, "url", {
    value: resolveMockResponseUrl(input),
    configurable: true,
  });
  return response;
};

const failOnFetch: FetchClient = async () => {
  throw new Error("Invalid input examples must fail before any fetch happens.");
};

function provideFetch<A, E>(
  effect: Effect.Effect<A, E, FetchService>,
  fetchClient: FetchClient = mockFetch,
): Effect.Effect<A, E, never> {
  return effect.pipe(
    Effect.provideService(FetchService, {
      fetch: fetchClient,
    }),
  );
}

function createExtractRequest() {
  return Schema.decodeUnknownSync(ExtractRunRequestSchema)({
    url: EXAMPLE_URL,
    selector: '[data-field="price"]',
    timeoutMs: "600",
  });
}

function captureInvalidInputExample() {
  return provideFetch(
    extractRun({
      selector: '[data-field="price"]',
    }).pipe(
      Effect.flatMap(() =>
        Effect.die(new Error('Expected InvalidInputError for extractRun without a "url" field')),
      ),
      Effect.catchTag("InvalidInputError", ({ message, details }) =>
        Effect.succeed({
          caughtTag: "InvalidInputError",
          message,
          details,
        }),
      ),
    ),
    failOnFetch,
  ).pipe(Effect.orDie);
}

function captureInvalidSelectorExample() {
  return provideFetch(
    extractRun({
      url: EXAMPLE_URL,
      selector: "[",
    }).pipe(
      Effect.flatMap(() =>
        Effect.die(new Error('Expected ExtractionError for invalid selector "["')),
      ),
      Effect.catchTag("ExtractionError", ({ message, details }) =>
        Effect.succeed({
          caughtTag: "ExtractionError",
          message,
          details,
        }),
      ),
    ),
  ).pipe(Effect.orDie);
}

export function runE2SdkConsumerExample() {
  return Effect.gen(function* () {
    const request = createExtractRequest();
    const payload = yield* Effect.all({
      response: provideFetch(extractRun(request)).pipe(Effect.orDie),
      noMatchWarning: provideFetch(
        extractRun({
          url: EXAMPLE_URL,
          selector: '[data-field="inventory"]',
        }),
      ).pipe(Effect.orDie),
      invalidInputError: captureInvalidInputExample(),
      invalidSelectorError: captureInvalidSelectorExample(),
    });

    return Schema.decodeUnknownSync(E2SdkConsumerExampleResultSchema)({
      importPath: "effect-scrapling/sdk",
      prerequisites: e2SdkConsumerPrerequisites,
      pitfalls: e2SdkConsumerPitfalls,
      payload: {
        request,
        ...payload,
      },
    });
  });
}

if (import.meta.main) {
  const payload = await Effect.runPromise(runE2SdkConsumerExample());
  console.log(JSON.stringify(payload, null, 2));
}
