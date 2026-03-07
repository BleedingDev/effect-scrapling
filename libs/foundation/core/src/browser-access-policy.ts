import { Effect, Ref, Schema } from "effect";
import {
  CanonicalHttpUrlSchema,
  CanonicalIdentifierSchema,
  IsoDateTimeSchema,
} from "./schema-primitives.ts";
import { PolicyViolation } from "./tagged-errors.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const BrowserPolicyNameSchema = Schema.Literals(["sessionIsolation", "originRestriction"] as const);
const BrowserPolicySubjectSchema = Schema.Literals(["context", "page", "navigation"] as const);
const BrowserPolicyOutcomeSchema = Schema.Literals(["allowed", "blocked"] as const);

export class BrowserSecuritySession extends Schema.Class<BrowserSecuritySession>(
  "BrowserSecuritySession",
)({
  planId: CanonicalIdentifierSchema,
  sessionId: CanonicalIdentifierSchema,
  expectedOrigin: CanonicalHttpUrlSchema,
}) {}

export class BrowserPolicyDecision extends Schema.Class<BrowserPolicyDecision>(
  "BrowserPolicyDecision",
)({
  planId: CanonicalIdentifierSchema,
  sessionId: CanonicalIdentifierSchema,
  policy: BrowserPolicyNameSchema,
  subject: BrowserPolicySubjectSchema,
  outcome: BrowserPolicyOutcomeSchema,
  ownerSessionId: Schema.NullOr(CanonicalIdentifierSchema),
  expectedOrigin: Schema.NullOr(CanonicalHttpUrlSchema),
  observedOrigin: Schema.NullOr(CanonicalHttpUrlSchema),
  message: NonEmptyStringSchema,
  recordedAt: IsoDateTimeSchema,
}) {}

export const BrowserSecuritySessionSchema = BrowserSecuritySession;
export const BrowserPolicyDecisionSchema = BrowserPolicyDecision;

type BrowserSecuritySessionType = Schema.Schema.Type<typeof BrowserSecuritySessionSchema>;
type BrowserPolicyDecisionType = Schema.Schema.Type<typeof BrowserPolicyDecisionSchema>;
type BrowserPolicySubject = Schema.Schema.Type<typeof BrowserPolicySubjectSchema>;
type BrowserPolicyName = Schema.Schema.Type<typeof BrowserPolicyNameSchema>;
type BrowserSessionCarrier = object;

type BrowserSessionBinding = {
  readonly sessionId: string;
};

export type BrowserAccessSecurityPolicy = {
  readonly beginSession: (
    planId: string,
    entryUrl: string,
  ) => Effect.Effect<BrowserSecuritySessionType, PolicyViolation>;
  readonly verifyContext: (
    session: BrowserSecuritySessionType,
    context: BrowserSessionCarrier,
  ) => Effect.Effect<void, PolicyViolation>;
  readonly verifyPage: (
    session: BrowserSecuritySessionType,
    page: BrowserSessionCarrier,
  ) => Effect.Effect<void, PolicyViolation>;
  readonly verifyOrigin: (
    session: BrowserSecuritySessionType,
    observedUrl: string,
  ) => Effect.Effect<void, PolicyViolation>;
  readonly readDecisions: Effect.Effect<ReadonlyArray<BrowserPolicyDecisionType>>;
};

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function toCanonicalOriginUrl(value: string) {
  return Schema.decodeUnknownSync(CanonicalHttpUrlSchema)(new URL("/", value).toString());
}

const encodeBrowserPolicyDecision = Schema.encodeSync(BrowserPolicyDecisionSchema);

function recordBrowserPolicyDecision(
  decisionsRef: Ref.Ref<ReadonlyArray<BrowserPolicyDecisionType>>,
  decision: BrowserPolicyDecisionType,
) {
  return Ref.update(decisionsRef, (current) => current.concat(decision)).pipe(
    Effect.andThen(
      Effect.log(
        JSON.stringify({
          event: "browser.policy.decision",
          ...encodeBrowserPolicyDecision(decision),
        }),
      ),
    ),
    Effect.as(decision),
  );
}

function buildBrowserPolicyDecision(input: {
  readonly session: BrowserSecuritySessionType;
  readonly policy: BrowserPolicyName;
  readonly subject: BrowserPolicySubject;
  readonly outcome: "allowed" | "blocked";
  readonly ownerSessionId?: string | null;
  readonly expectedOrigin?: string | null;
  readonly observedOrigin?: string | null;
  readonly message: string;
  readonly recordedAt: Date;
}) {
  return Schema.decodeUnknownSync(BrowserPolicyDecisionSchema)({
    planId: input.session.planId,
    sessionId: input.session.sessionId,
    policy: input.policy,
    subject: input.subject,
    outcome: input.outcome,
    ownerSessionId: input.ownerSessionId ?? null,
    expectedOrigin: input.expectedOrigin ?? null,
    observedOrigin: input.observedOrigin ?? null,
    message: input.message,
    recordedAt: input.recordedAt.toISOString(),
  });
}

function verifySessionCarrier(options: {
  readonly bindings: WeakMap<BrowserSessionCarrier, BrowserSessionBinding>;
  readonly decisionsRef: Ref.Ref<ReadonlyArray<BrowserPolicyDecisionType>>;
  readonly now: () => Date;
  readonly session: BrowserSecuritySessionType;
  readonly subject: "context" | "page";
  readonly carrier: BrowserSessionCarrier;
}) {
  return Effect.gen(function* () {
    const existing = options.bindings.get(options.carrier);

    if (existing !== undefined && existing.sessionId !== options.session.sessionId) {
      const decision = buildBrowserPolicyDecision({
        session: options.session,
        policy: "sessionIsolation",
        subject: options.subject,
        outcome: "blocked",
        ownerSessionId: existing.sessionId,
        message: `Blocked ${options.subject} reuse across browser sessions; ${existing.sessionId} already owns the carrier.`,
        recordedAt: options.now(),
      });
      yield* recordBrowserPolicyDecision(options.decisionsRef, decision);
      return yield* Effect.fail(
        new PolicyViolation({
          message: decision.message,
        }),
      );
    }

    options.bindings.set(options.carrier, {
      sessionId: options.session.sessionId,
    });

    const decision = buildBrowserPolicyDecision({
      session: options.session,
      policy: "sessionIsolation",
      subject: options.subject,
      outcome: "allowed",
      ownerSessionId: existing?.sessionId ?? null,
      message:
        existing === undefined
          ? `Bound ${options.subject} to isolated browser session ${options.session.sessionId}.`
          : `Confirmed ${options.subject} ownership remains within browser session ${options.session.sessionId}.`,
      recordedAt: options.now(),
    });
    yield* recordBrowserPolicyDecision(options.decisionsRef, decision);
  });
}

export function makeInMemoryBrowserAccessSecurityPolicy(options?: { readonly now?: () => Date }) {
  const now = options?.now ?? (() => new Date());

  return Effect.gen(function* () {
    const decisionsRef = yield* Ref.make<ReadonlyArray<BrowserPolicyDecisionType>>([]);
    const sessionCounterRef = yield* Ref.make(0);
    const contextBindings = new WeakMap<BrowserSessionCarrier, BrowserSessionBinding>();
    const pageBindings = new WeakMap<BrowserSessionCarrier, BrowserSessionBinding>();

    const beginSession = Effect.fn("BrowserAccessSecurityPolicy.beginSession")(function* (
      planId: string,
      entryUrl: string,
    ) {
      const sequence = yield* Ref.updateAndGet(sessionCounterRef, (current) => current + 1);

      return yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(BrowserSecuritySessionSchema)({
            planId,
            sessionId: `${planId}-browser-session-${sequence}`,
            expectedOrigin: toCanonicalOriginUrl(entryUrl),
          }),
        catch: (cause) =>
          new PolicyViolation({
            message: readCauseMessage(
              cause,
              "Failed to derive browser security session from the run plan.",
            ),
          }),
      });
    });

    const verifyOrigin = Effect.fn("BrowserAccessSecurityPolicy.verifyOrigin")(function* (
      session: BrowserSecuritySessionType,
      observedUrl: string,
    ) {
      return yield* Effect.try({
        try: () => toCanonicalOriginUrl(observedUrl),
        catch: (cause) =>
          new PolicyViolation({
            message: readCauseMessage(
              cause,
              "Browser navigation produced an invalid origin observation.",
            ),
          }),
      }).pipe(
        Effect.flatMap((observedOrigin) => {
          const outcome = observedOrigin === session.expectedOrigin ? "allowed" : "blocked";
          const decision = buildBrowserPolicyDecision({
            session,
            policy: "originRestriction",
            subject: "navigation",
            outcome,
            expectedOrigin: session.expectedOrigin,
            observedOrigin,
            message:
              outcome === "allowed"
                ? `Confirmed browser navigation stayed on the expected origin ${session.expectedOrigin}.`
                : `Blocked browser navigation from expected origin ${session.expectedOrigin} to ${observedOrigin}.`,
            recordedAt: now(),
          });

          return recordBrowserPolicyDecision(decisionsRef, decision).pipe(
            Effect.flatMap((recordedDecision) =>
              recordedDecision.outcome === "blocked"
                ? Effect.fail(
                    new PolicyViolation({
                      message: recordedDecision.message,
                    }),
                  )
                : Effect.void,
            ),
          );
        }),
      );
    });

    return {
      beginSession,
      verifyContext: (session, context) =>
        verifySessionCarrier({
          bindings: contextBindings,
          decisionsRef,
          now,
          session,
          subject: "context",
          carrier: context,
        }),
      verifyPage: (session, page) =>
        verifySessionCarrier({
          bindings: pageBindings,
          decisionsRef,
          now,
          session,
          subject: "page",
          carrier: page,
        }),
      verifyOrigin,
      readDecisions: Ref.get(decisionsRef),
    } satisfies BrowserAccessSecurityPolicy;
  });
}
