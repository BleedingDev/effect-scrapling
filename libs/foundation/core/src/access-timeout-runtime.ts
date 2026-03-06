import { Effect, Schema } from "effect";
import { TimeoutMsSchema } from "./schema-primitives.ts";
import { PolicyViolation, TimeoutError } from "./tagged-errors.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

export class AccessTimeoutPolicy extends Schema.Class<AccessTimeoutPolicy>("AccessTimeoutPolicy")({
  timeoutMs: TimeoutMsSchema,
  timeoutMessage: NonEmptyStringSchema,
}) {}

export const AccessTimeoutPolicySchema = AccessTimeoutPolicy;

function decodePolicy(input: unknown) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(AccessTimeoutPolicySchema)(input),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode access-timeout policy through shared contracts.",
      }),
  });
}

export function withAccessTimeout<A, E, R>(effect: Effect.Effect<A, E, R>, policy: unknown) {
  return Effect.gen(function* () {
    const decodedPolicy = yield* decodePolicy(policy);

    return yield* effect.pipe(
      Effect.timeoutOrElse({
        duration: decodedPolicy.timeoutMs,
        onTimeout: () =>
          Effect.fail(
            new TimeoutError({
              message: decodedPolicy.timeoutMessage,
            }),
          ),
      }),
    );
  });
}

export function tryAbortableAccess<A, E>(options: {
  readonly policy: unknown;
  readonly try: (signal: AbortSignal) => PromiseLike<A>;
  readonly catch: (cause: unknown) => E;
}) {
  return decodePolicy(options.policy).pipe(
    Effect.flatMap((decodedPolicy) =>
      Effect.tryPromise({
        try: options.try,
        catch: options.catch,
      }).pipe(
        Effect.timeoutOrElse({
          duration: decodedPolicy.timeoutMs,
          onTimeout: () =>
            Effect.fail(
              new TimeoutError({
                message: decodedPolicy.timeoutMessage,
              }),
            ),
        }),
      ),
    ),
  );
}
