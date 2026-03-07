import { Effect, Match, Schema } from "effect";
import { RunPlanSchema } from "./run-state.ts";
import { CanonicalIdentifierSchema, TimeoutMsSchema } from "./schema-primitives.ts";
import { PolicyViolation, ProviderUnavailable, TimeoutError } from "./tagged-errors.ts";

const AttemptCountSchema = Schema.Int.check(Schema.isGreaterThan(0)).check(
  Schema.isLessThanOrEqualTo(32),
);
const RetryFactorSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(8),
);
const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

export class AccessRetryPolicy extends Schema.Class<AccessRetryPolicy>("AccessRetryPolicy")({
  id: CanonicalIdentifierSchema,
  maxAttempts: AttemptCountSchema,
  baseDelayMs: TimeoutMsSchema,
  maxDelayMs: TimeoutMsSchema,
  backoffFactor: RetryFactorSchema,
}) {}

export class AccessRetryDecision extends Schema.Class<AccessRetryDecision>("AccessRetryDecision")({
  attempt: AttemptCountSchema,
  nextAttempt: AttemptCountSchema,
  delayMs: TimeoutMsSchema,
  reason: NonEmptyStringSchema,
}) {}

export class AccessRetryReport extends Schema.Class<AccessRetryReport>("AccessRetryReport")({
  attempts: AttemptCountSchema,
  exhaustedBudget: Schema.Boolean,
  decisions: Schema.Array(AccessRetryDecision),
}) {}

export const AccessRetryPolicySchema = AccessRetryPolicy;
export const AccessRetryDecisionSchema = AccessRetryDecision;
export const AccessRetryReportSchema = AccessRetryReport;

function liveDelay(delayMs: number) {
  return Effect.callback<void>((resume, signal) => {
    const timeout = setTimeout(() => {
      resume(Effect.void);
    }, delayMs);

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
      },
      { once: true },
    );

    return Effect.sync(() => {
      clearTimeout(timeout);
    });
  });
}

function decodePolicy(input: unknown) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(AccessRetryPolicySchema)(input),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode access-retry policy through shared contracts.",
      }),
  });
}

function buildRetryDecision(
  policy: Schema.Schema.Type<typeof AccessRetryPolicySchema>,
  attempt: number,
  reason: string,
) {
  const unclampedDelayMs = Math.round(
    policy.baseDelayMs * policy.backoffFactor ** Math.max(0, attempt - 1),
  );

  return Schema.decodeUnknownSync(AccessRetryDecisionSchema)({
    attempt,
    nextAttempt: attempt + 1,
    delayMs: Math.min(policy.maxDelayMs, unclampedDelayMs),
    reason,
  });
}

function buildRetryReport(
  attempts: number,
  exhaustedBudget: boolean,
  decisions: ReadonlyArray<Schema.Schema.Type<typeof AccessRetryDecisionSchema>>,
) {
  return Schema.decodeUnknownSync(AccessRetryReportSchema)({
    attempts,
    exhaustedBudget,
    decisions,
  });
}

function readRetryReason(error: unknown) {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    const message = Reflect.get(error, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return "Access operation failed with an unknown retryable cause.";
}

export function deriveAccessRetryPolicy(plan: unknown) {
  return Effect.gen(function* () {
    const decodedPlan = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(RunPlanSchema)(plan),
      catch: () =>
        new PolicyViolation({
          message: "Failed to decode retry policy input from the run plan.",
        }),
    });
    const baseDelayMs = Math.max(100, Math.min(250, decodedPlan.timeoutMs));
    const maxDelayMs = Math.max(baseDelayMs, Math.min(decodedPlan.timeoutMs, 5_000));

    return Schema.decodeUnknownSync(AccessRetryPolicySchema)({
      id: `retry-${decodedPlan.id}`,
      maxAttempts: decodedPlan.maxAttempts,
      baseDelayMs,
      maxDelayMs,
      backoffFactor: 2,
    });
  });
}

export function isRetryableAccessFailure(
  error: ProviderUnavailable | TimeoutError | PolicyViolation,
) {
  return Match.value(error).pipe(
    Match.tag("ProviderUnavailable", () => true),
    Match.tag("TimeoutError", () => true),
    Match.tag("PolicyViolation", () => false),
    Match.exhaustive,
  );
}

export function executeWithAccessRetry<A, E, R>(options: {
  readonly policy: unknown;
  readonly effect: (attempt: number) => Effect.Effect<A, E, R>;
  readonly shouldRetry: (error: E) => boolean;
  readonly onDecision?: (
    decision: Schema.Schema.Type<typeof AccessRetryDecisionSchema>,
  ) => Effect.Effect<void, never, never>;
  readonly onExhausted?: (input: {
    readonly error: E;
    readonly report: Schema.Schema.Type<typeof AccessRetryReportSchema>;
  }) => Effect.Effect<void, never, never>;
  readonly delay?: (delayMs: number) => Effect.Effect<void, never, never>;
}) {
  const onDecision = options.onDecision ?? (() => Effect.void);
  const onExhausted = options.onExhausted ?? (() => Effect.void);
  const delay = options.delay ?? liveDelay;

  return Effect.gen(function* () {
    const policy = yield* decodePolicy(options.policy);

    const loop = (
      attempt: number,
      decisions: ReadonlyArray<Schema.Schema.Type<typeof AccessRetryDecisionSchema>>,
    ): Effect.Effect<
      {
        readonly value: A;
        readonly report: Schema.Schema.Type<typeof AccessRetryReportSchema>;
      },
      E,
      R
    > =>
      options.effect(attempt).pipe(
        Effect.map((value) => ({
          value,
          report: buildRetryReport(attempt, false, decisions),
        })),
        Effect.catch((error: E) => {
          if (!options.shouldRetry(error)) {
            return Effect.fail(error);
          }

          if (attempt >= policy.maxAttempts) {
            const report = buildRetryReport(attempt, true, decisions);

            return onExhausted({
              error,
              report,
            }).pipe(Effect.andThen(Effect.fail(error)));
          }

          const decision = buildRetryDecision(policy, attempt, readRetryReason(error));

          return onDecision(decision).pipe(
            Effect.andThen(delay(decision.delayMs)),
            Effect.andThen(loop(attempt + 1, [...decisions, decision])),
          );
        }),
      );

    return yield* loop(1, []);
  });
}
