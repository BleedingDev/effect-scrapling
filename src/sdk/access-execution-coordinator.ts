import { Effect, Layer, ServiceMap } from "effect";
import { readAccessWallSignalsFromWarnings } from "./access-wall-detection.ts";
import { type BrowserRuntime } from "./browser-pool.ts";
import { AccessExecutionEngine } from "./access-execution-engine.ts";
import { AccessHealthGateway } from "./access-health-gateway.ts";
import { AccessResourceKernel } from "./access-resource-kernel.ts";
import { type AccessExecutionContext } from "./access-execution-context.ts";
import { type ResolvedExecutionIntent } from "./access-runtime.ts";
import {
  AccessQuarantinedError,
  AccessResourceError,
  BrowserError,
  InvalidInputError,
  NetworkError,
} from "./errors.ts";
import { type FetchService } from "./fetch-service.ts";
import { type AccessExecutionResult } from "./access-provider-runtime.ts";

export type CoordinatedAccessExecution = {
  readonly context: AccessExecutionContext;
  readonly result: AccessExecutionResult;
  readonly warnings: ReadonlyArray<string>;
};

function dedupeWarnings(warnings: ReadonlyArray<string>) {
  return [...new Set(warnings)];
}

const ACCESS_WALL_BROWSER_ESCALATION_WARNING =
  "Escalated from HTTP to browser after access wall detection.";

function formatEscalationWarning(input: {
  readonly error: {
    readonly message?: string;
    readonly details?: string;
  };
}) {
  return `Browser escalation after access wall detection failed: ${input.error.details ?? input.error.message ?? "unknown failure"}`;
}

function toEscalationFailure(input: {
  readonly url: string;
  readonly fromProviderId: string;
  readonly toProviderId: string;
  readonly signals: ReadonlyArray<string>;
}) {
  return new NetworkError({
    message: `HTTP access for ${input.url} required browser fallback`,
    details: `Escalated from provider "${input.fromProviderId}" to "${input.toProviderId}" after ${input.signals.join(", ")}.`,
  });
}

export class AccessExecutionCoordinator extends ServiceMap.Service<
  AccessExecutionCoordinator,
  {
    readonly execute: (input: {
      readonly url: string;
      readonly intent: ResolvedExecutionIntent;
    }) => Effect.Effect<
      CoordinatedAccessExecution,
      | InvalidInputError
      | AccessResourceError
      | AccessQuarantinedError
      | NetworkError
      | BrowserError,
      FetchService | BrowserRuntime
    >;
  }
>()("@effect-scrapling/sdk/AccessExecutionCoordinator") {}

export const AccessExecutionCoordinatorLive = Layer.effect(
  AccessExecutionCoordinator,
  Effect.gen(function* () {
    const healthGateway = yield* AccessHealthGateway;
    const engine = yield* AccessExecutionEngine;
    const resourceKernel = yield* AccessResourceKernel;

    const executeOnce = ({
      url,
      intent,
      recordSuccess,
      skipHealthCheck,
    }: {
      readonly url: string;
      readonly intent: ResolvedExecutionIntent;
      readonly recordSuccess: boolean;
      readonly skipHealthCheck?: boolean;
    }): Effect.Effect<
      CoordinatedAccessExecution,
      | InvalidInputError
      | AccessResourceError
      | AccessQuarantinedError
      | NetworkError
      | BrowserError,
      FetchService | BrowserRuntime
    > =>
      Effect.acquireUseRelease(
        resourceKernel.provision({
          url,
          intent,
        }),
        (path) =>
          Effect.gen(function* () {
            const context = path.context;
            const healthContext = { url, context };
            if (!skipHealthCheck) {
              yield* healthGateway.assertHealthy(healthContext);
            }

            const result = yield* engine
              .execute({
                url,
                context,
              })
              .pipe(Effect.tapError((error) => healthGateway.recordFailure(healthContext, error)));

            if (recordSuccess) {
              yield* healthGateway.recordSuccess(healthContext);
            }

            return {
              context,
              result,
              warnings: dedupeWarnings([...context.warnings, ...result.warnings]),
            } satisfies CoordinatedAccessExecution;
          }),
        (path) => path.release,
      );

    return {
      execute: ({
        url,
        intent,
      }): Effect.Effect<
        CoordinatedAccessExecution,
        | InvalidInputError
        | AccessResourceError
        | AccessQuarantinedError
        | NetworkError
        | BrowserError,
        FetchService | BrowserRuntime
      > =>
        Effect.gen(function* () {
          const primaryExecution = yield* executeOnce({
            url,
            intent,
            recordSuccess: false,
            skipHealthCheck: false,
          });
          const fallbackIntent = intent.fallback?.browserOnAccessWall;
          const accessWallSignals = readAccessWallSignalsFromWarnings(primaryExecution.warnings);
          if (fallbackIntent === undefined || accessWallSignals.length === 0) {
            yield* healthGateway.recordSuccess({
              url,
              context: primaryExecution.context,
            });
            return primaryExecution;
          }

          yield* healthGateway.recordFailure(
            {
              url,
              context: primaryExecution.context,
            },
            toEscalationFailure({
              url,
              fromProviderId: primaryExecution.context.providerId,
              toProviderId: fallbackIntent.providerId,
              signals: accessWallSignals,
            }),
          );

          const fallbackExecution = yield* executeOnce({
            url,
            intent: fallbackIntent,
            recordSuccess: true,
            skipHealthCheck: true,
          }).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          );

          if (!fallbackExecution.ok) {
            return {
              ...primaryExecution,
              warnings: dedupeWarnings([
                ...primaryExecution.warnings,
                ACCESS_WALL_BROWSER_ESCALATION_WARNING,
                formatEscalationWarning({
                  error: fallbackExecution.error,
                }),
              ]),
            } satisfies CoordinatedAccessExecution;
          }

          return {
            ...fallbackExecution.value,
            warnings: dedupeWarnings([
              ...primaryExecution.warnings,
              ...fallbackExecution.value.warnings,
              ACCESS_WALL_BROWSER_ESCALATION_WARNING,
            ]),
          } satisfies CoordinatedAccessExecution;
        }),
    } satisfies {
      readonly execute: (input: {
        readonly url: string;
        readonly intent: ResolvedExecutionIntent;
      }) => Effect.Effect<
        CoordinatedAccessExecution,
        | InvalidInputError
        | AccessResourceError
        | AccessQuarantinedError
        | NetworkError
        | BrowserError,
        FetchService | BrowserRuntime
      >;
    };
  }),
);
