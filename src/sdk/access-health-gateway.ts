import { Effect, Layer, ServiceMap } from "effect";
import {
  type AccessHealthPolicy,
  AccessPathQuarantined,
} from "@effect-scrapling/foundation-core/access-health-runtime";
import {
  AccessHealthRuntime,
  AccessHealthRuntimeLive,
  type AccessHealthRuntimeService,
} from "./access-health-runtime-service.ts";
import {
  type AccessHealthSubjectInput,
  AccessHealthPolicyRegistry,
  AccessHealthPolicyRegistryLive,
  AccessHealthSubjectStrategy,
  AccessHealthSubjectStrategyLive,
} from "./access-health-policy-runtime.ts";
import { type AccessExecutionContext } from "./access-execution-context.ts";
import { AccessQuarantinedError } from "./errors.ts";

export type AccessHealthContext = {
  readonly url: string;
  readonly context: AccessExecutionContext;
};

function toHealthReason(error: {
  readonly _tag?: string;
  readonly message?: string;
  readonly details?: string;
}) {
  const message = error.details ?? error.message ?? "unknown-access-failure";
  return error._tag === undefined ? message : `${error._tag}: ${message}`;
}

function isPolicyGuardrailFailure(error: {
  readonly _tag?: string;
  readonly message?: string;
  readonly details?: string;
}) {
  if (error._tag === "InvalidInputError" || error._tag === "AccessQuarantinedError") {
    return true;
  }

  const diagnostic = `${error.message ?? ""} ${error.details ?? ""}`.toLowerCase();
  return (
    diagnostic.includes("not allowed") ||
    diagnostic.includes("blocked browser request") ||
    diagnostic.includes("localhost") ||
    diagnostic.includes("loopback") ||
    diagnostic.includes("private-network") ||
    diagnostic.includes("private, loopback") ||
    diagnostic.includes("unsafe public-boundary")
  );
}

function toAccessQuarantinedError(error: AccessPathQuarantined) {
  return new AccessQuarantinedError({
    message: error.message,
    details: `subject=${error.subjectKey} quarantinedUntil=${error.quarantinedUntil}`,
  });
}

function makeAccessHealthGateway(input: {
  readonly runtime: AccessHealthRuntimeService;
  readonly policyRegistry: {
    readonly policyFor: (subject: AccessHealthSubjectInput) => AccessHealthPolicy;
  };
  readonly subjectStrategy: {
    readonly subjectsFor: (context: AccessHealthContext) => ReadonlyArray<AccessHealthSubjectInput>;
  };
}) {
  return {
    assertHealthy: (
      context: AccessHealthContext,
    ): Effect.Effect<void, AccessQuarantinedError, never> =>
      Effect.forEach(
        input.subjectStrategy.subjectsFor(context),
        (subject) => input.runtime.assertHealthy(subject).pipe(Effect.asVoid),
        { discard: true },
      ).pipe(
        Effect.asVoid,
        Effect.mapError((error) =>
          error instanceof AccessPathQuarantined
            ? toAccessQuarantinedError(error)
            : new AccessQuarantinedError({
                message: "Access path health verification failed",
                details: String(error),
              }),
        ),
      ),
    recordSuccess: (context: AccessHealthContext): Effect.Effect<void, never, never> =>
      Effect.forEach(
        input.subjectStrategy.subjectsFor(context),
        (subject) =>
          input.runtime
            .recordSuccess(subject, input.policyRegistry.policyFor(subject))
            .pipe(Effect.asVoid),
        { discard: true },
      ).pipe(Effect.asVoid, Effect.ignore),
    recordFailure: (
      context: AccessHealthContext,
      error: { readonly _tag?: string; readonly message?: string; readonly details?: string },
    ): Effect.Effect<void, never, never> =>
      isPolicyGuardrailFailure(error)
        ? Effect.void
        : Effect.forEach(
            input.subjectStrategy.subjectsFor(context),
            (subject) =>
              input.runtime
                .recordFailure(
                  subject,
                  input.policyRegistry.policyFor(subject),
                  toHealthReason(error),
                )
                .pipe(Effect.asVoid),
            { discard: true },
          ).pipe(Effect.asVoid, Effect.ignore),
  } satisfies {
    readonly assertHealthy: (
      context: AccessHealthContext,
    ) => Effect.Effect<void, AccessQuarantinedError, never>;
    readonly recordSuccess: (context: AccessHealthContext) => Effect.Effect<void, never, never>;
    readonly recordFailure: (
      context: AccessHealthContext,
      error: { readonly _tag?: string; readonly message?: string; readonly details?: string },
    ) => Effect.Effect<void, never, never>;
  };
}

export class AccessHealthGateway extends ServiceMap.Service<
  AccessHealthGateway,
  {
    readonly assertHealthy: (
      context: AccessHealthContext,
    ) => Effect.Effect<void, AccessQuarantinedError, never>;
    readonly recordSuccess: (context: AccessHealthContext) => Effect.Effect<void, never, never>;
    readonly recordFailure: (
      context: AccessHealthContext,
      error: { readonly _tag?: string; readonly message?: string; readonly details?: string },
    ) => Effect.Effect<void, never, never>;
  }
>()("@effect-scrapling/sdk/AccessHealthGateway") {}

export function makeAccessHealthGatewayLiveLayer() {
  return Layer.effect(
    AccessHealthGateway,
    Effect.gen(function* () {
      const runtime = yield* AccessHealthRuntime;
      const policyRegistry = yield* AccessHealthPolicyRegistry;
      const subjectStrategy = yield* AccessHealthSubjectStrategy;
      return makeAccessHealthGateway({
        runtime,
        policyRegistry,
        subjectStrategy,
      });
    }),
  );
}

export function makeSharedAccessHealthGatewayLiveLayer() {
  return makeAccessHealthGatewayLiveLayer().pipe(
    Layer.provide(
      Layer.mergeAll(
        AccessHealthRuntimeLive,
        AccessHealthPolicyRegistryLive,
        AccessHealthSubjectStrategyLive,
      ),
    ),
  );
}

export const AccessHealthGatewayLive = makeAccessHealthGatewayLiveLayer();

export function resetAccessHealthGatewayForTests(): Effect.Effect<void> {
  return Effect.void;
}
