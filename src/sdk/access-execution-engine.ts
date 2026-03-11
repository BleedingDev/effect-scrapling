import { Effect, Layer, ServiceMap } from "effect";
import { type AccessExecutionContext } from "./access-execution-context.ts";
import { AccessProviderRegistry, type AccessExecutionResult } from "./access-provider-runtime.ts";
import { type BrowserRuntime } from "./browser-pool.ts";
import { BrowserError, InvalidInputError, NetworkError } from "./errors.ts";
import { type FetchService } from "./fetch-service.ts";

function invalidExecution(message: string, details?: string) {
  return new InvalidInputError({
    message,
    ...(details === undefined ? {} : { details }),
  });
}

function makeAccessExecutionEngine(providerRegistry: {
  readonly resolve: (
    providerId: AccessExecutionContext["providerId"],
  ) => Effect.Effect<import("./access-provider-runtime.ts").AccessProvider, InvalidInputError>;
}) {
  return {
    execute: ({
      url,
      context,
    }: {
      readonly url: string;
      readonly context: AccessExecutionContext;
    }) =>
      Effect.gen(function* () {
        const provider = yield* providerRegistry.resolve(context.providerId);

        if (provider.capabilities.mode !== context.mode) {
          return yield* Effect.fail(
            invalidExecution(
              "Execution context/provider mode mismatch",
              `Resolved provider "${provider.id}" serves mode "${provider.capabilities.mode}" but context mode is "${context.mode}".`,
            ),
          );
        }

        return yield* provider.execute({ url, context });
      }),
  } satisfies {
    readonly execute: (input: {
      readonly url: string;
      readonly context: AccessExecutionContext;
    }) => Effect.Effect<
      AccessExecutionResult,
      InvalidInputError | NetworkError | BrowserError,
      FetchService | BrowserRuntime
    >;
  };
}

export class AccessExecutionEngine extends ServiceMap.Service<
  AccessExecutionEngine,
  {
    readonly execute: (input: {
      readonly url: string;
      readonly context: AccessExecutionContext;
    }) => Effect.Effect<
      AccessExecutionResult,
      InvalidInputError | NetworkError | BrowserError,
      FetchService | BrowserRuntime
    >;
  }
>()("@effect-scrapling/sdk/AccessExecutionEngine") {}

export const AccessExecutionEngineLive = Layer.effect(
  AccessExecutionEngine,
  Effect.gen(function* () {
    const providerRegistry = yield* AccessProviderRegistry;
    return makeAccessExecutionEngine(providerRegistry);
  }),
);
