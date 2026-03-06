import { Data, Effect, Ref, Schema } from "effect";
import {
  CanonicalDomainSchema,
  CanonicalIdentifierSchema,
  IsoDateTimeSchema,
  TimeoutMsSchema,
} from "./schema-primitives.ts";
import { PolicyViolation } from "./tagged-errors.ts";

const HealthCounterSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ThresholdSchema = Schema.Int.check(Schema.isGreaterThan(0)).check(
  Schema.isLessThanOrEqualTo(16),
);
const HealthScoreSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(100),
);
const AccessHealthEventKindSchema = Schema.Literals([
  "success",
  "failure",
  "quarantined",
  "restored",
] as const);

export class DomainHealthSubject extends Schema.Class<DomainHealthSubject>("DomainHealthSubject")({
  kind: Schema.Literal("domain"),
  domain: CanonicalDomainSchema,
}) {}

export class ProviderHealthSubject extends Schema.Class<ProviderHealthSubject>(
  "ProviderHealthSubject",
)({
  kind: Schema.Literal("provider"),
  providerId: CanonicalIdentifierSchema,
}) {}

export class IdentityHealthSubject extends Schema.Class<IdentityHealthSubject>(
  "IdentityHealthSubject",
)({
  kind: Schema.Literal("identity"),
  tenantId: CanonicalIdentifierSchema,
  domain: CanonicalDomainSchema,
  identityKey: CanonicalIdentifierSchema,
}) {}

export const AccessHealthSubjectSchema = Schema.Union([
  DomainHealthSubject,
  ProviderHealthSubject,
  IdentityHealthSubject,
]);

export class AccessHealthPolicy extends Schema.Class<AccessHealthPolicy>("AccessHealthPolicy")({
  failureThreshold: ThresholdSchema,
  recoveryThreshold: ThresholdSchema,
  quarantineMs: TimeoutMsSchema,
}) {}

export class AccessHealthSnapshot extends Schema.Class<AccessHealthSnapshot>(
  "AccessHealthSnapshot",
)({
  subject: AccessHealthSubjectSchema,
  successCount: HealthCounterSchema,
  failureCount: HealthCounterSchema,
  successStreak: HealthCounterSchema,
  failureStreak: HealthCounterSchema,
  score: HealthScoreSchema,
  quarantinedUntil: Schema.NullOr(IsoDateTimeSchema),
}) {}

export class AccessHealthEvent extends Schema.Class<AccessHealthEvent>("AccessHealthEvent")({
  kind: AccessHealthEventKindSchema,
  subject: AccessHealthSubjectSchema,
  score: HealthScoreSchema,
  quarantinedUntil: Schema.NullOr(IsoDateTimeSchema),
  reason: Schema.NullOr(Schema.Trim),
  recordedAt: IsoDateTimeSchema,
}) {}

export class AccessPathQuarantined extends Data.TaggedError("AccessPathQuarantined")<{
  readonly message: string;
  readonly subjectKey: string;
  readonly quarantinedUntil: string;
}> {}

type AccessHealthSubject = Schema.Schema.Type<typeof AccessHealthSubjectSchema>;
type AccessHealthState = {
  readonly subject: AccessHealthSubject;
  readonly successCount: number;
  readonly failureCount: number;
  readonly successStreak: number;
  readonly failureStreak: number;
  readonly quarantinedUntil: string | null;
};

const decodeAccessHealthSubjectSync = Schema.decodeUnknownSync(AccessHealthSubjectSchema);
const decodeAccessHealthPolicySync = Schema.decodeUnknownSync(AccessHealthPolicy);

function decodeAccessHealthSubject(input: unknown) {
  return Effect.try({
    try: () => decodeAccessHealthSubjectSync(input),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode access-health subject through shared contracts.",
      }),
  });
}

function decodeAccessHealthPolicy(input: unknown) {
  return Effect.try({
    try: () => decodeAccessHealthPolicySync(input),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode access-health policy through shared contracts.",
      }),
  });
}

function subjectKey(subject: AccessHealthSubject) {
  switch (subject.kind) {
    case "domain": {
      return JSON.stringify([subject.kind, subject.domain]);
    }
    case "provider": {
      return JSON.stringify([subject.kind, subject.providerId]);
    }
    case "identity": {
      return JSON.stringify([subject.kind, subject.tenantId, subject.domain, subject.identityKey]);
    }
  }
}

function computeScore(successCount: number, failureCount: number) {
  const total = successCount + failureCount;
  const score = total === 0 ? 100 : (successCount / total) * 100;
  return Schema.decodeUnknownSync(HealthScoreSchema)(Number(score.toFixed(2)));
}

function buildSnapshot(subject: AccessHealthSubject, state: Omit<AccessHealthState, "subject">) {
  return Schema.decodeUnknownSync(AccessHealthSnapshot)({
    subject,
    successCount: state.successCount,
    failureCount: state.failureCount,
    successStreak: state.successStreak,
    failureStreak: state.failureStreak,
    score: computeScore(state.successCount, state.failureCount),
    quarantinedUntil: state.quarantinedUntil,
  });
}

function buildEvent(
  kind: Schema.Schema.Type<typeof AccessHealthEventKindSchema>,
  snapshot: Schema.Schema.Type<typeof AccessHealthSnapshot>,
  reason: string | null,
  recordedAt: Date,
) {
  return Schema.decodeUnknownSync(AccessHealthEvent)({
    kind,
    subject: snapshot.subject,
    score: snapshot.score,
    quarantinedUntil: snapshot.quarantinedUntil,
    reason,
    recordedAt: recordedAt.toISOString(),
  });
}

export function makeInMemoryAccessHealthRuntime(now: () => Date = () => new Date()) {
  return Effect.gen(function* () {
    const statesRef = yield* Ref.make(new Map<string, AccessHealthState>());
    const eventsRef = yield* Ref.make(new Array<Schema.Schema.Type<typeof AccessHealthEvent>>());

    const recordEvent = Effect.fn("InMemoryAccessHealthRuntime.recordEvent")(function* (
      kind: Schema.Schema.Type<typeof AccessHealthEventKindSchema>,
      snapshot: Schema.Schema.Type<typeof AccessHealthSnapshot>,
      reason: string | null,
      recordedAt: Date,
    ) {
      yield* Ref.update(eventsRef, (current) =>
        current.concat(buildEvent(kind, snapshot, reason, recordedAt)),
      );
    });

    const mutate = Effect.fn("InMemoryAccessHealthRuntime.mutate")(function* (
      subject: AccessHealthSubject,
      update: (current: AccessHealthState) => Omit<AccessHealthState, "subject">,
    ) {
      const key = subjectKey(subject);
      return yield* Ref.modify(statesRef, (current) => {
        const existing = current.get(key) ?? {
          subject,
          successCount: 0,
          failureCount: 0,
          successStreak: 0,
          failureStreak: 0,
          quarantinedUntil: null,
        };
        const nextState = {
          subject,
          ...update(existing),
        };
        const next = new Map(current);
        next.set(key, nextState);
        return [buildSnapshot(subject, nextState), next] as const;
      });
    });

    const recordFailure = Effect.fn("InMemoryAccessHealthRuntime.recordFailure")(function* (
      subjectInput: unknown,
      policyInput: unknown,
      reason: string,
    ) {
      const subject = yield* decodeAccessHealthSubject(subjectInput);
      const policy = yield* decodeAccessHealthPolicy(policyInput);
      const currentNow = now();
      const snapshot = yield* mutate(subject, (current) => {
        const failureCount = current.failureCount + 1;
        const failureStreak = current.failureStreak + 1;
        const quarantinedUntil =
          failureStreak >= policy.failureThreshold
            ? new Date(currentNow.valueOf() + policy.quarantineMs).toISOString()
            : current.quarantinedUntil;

        return {
          successCount: current.successCount,
          failureCount,
          successStreak: 0,
          failureStreak,
          quarantinedUntil,
        };
      });

      yield* recordEvent("failure", snapshot, reason, currentNow);
      if (snapshot.quarantinedUntil !== null) {
        yield* recordEvent("quarantined", snapshot, reason, currentNow);
      }
      return snapshot;
    });

    const recordSuccess = Effect.fn("InMemoryAccessHealthRuntime.recordSuccess")(function* (
      subjectInput: unknown,
      policyInput: unknown,
    ) {
      const subject = yield* decodeAccessHealthSubject(subjectInput);
      const policy = yield* decodeAccessHealthPolicy(policyInput);
      const currentNow = now();
      const previousSnapshot = yield* inspect(subject);
      const snapshot = yield* mutate(subject, (current) => {
        const successCount = current.successCount + 1;
        const successStreak = current.successStreak + 1;
        const quarantineExpired =
          current.quarantinedUntil !== null &&
          Date.parse(current.quarantinedUntil) <= currentNow.valueOf();

        return {
          successCount,
          failureCount: current.failureCount,
          successStreak,
          failureStreak: 0,
          quarantinedUntil:
            quarantineExpired && successStreak >= policy.recoveryThreshold
              ? null
              : current.quarantinedUntil,
        };
      });

      yield* recordEvent("success", snapshot, null, currentNow);
      if (
        previousSnapshot.quarantinedUntil !== null &&
        snapshot.quarantinedUntil === null &&
        snapshot.successStreak >= policy.recoveryThreshold
      ) {
        yield* recordEvent("restored", snapshot, null, currentNow);
      }
      return snapshot;
    });

    const inspect = Effect.fn("InMemoryAccessHealthRuntime.inspect")(function* (
      subjectInput: unknown,
    ) {
      const subject = yield* decodeAccessHealthSubject(subjectInput);
      const key = subjectKey(subject);
      const state = (yield* Ref.get(statesRef)).get(key) ?? {
        subject,
        successCount: 0,
        failureCount: 0,
        successStreak: 0,
        failureStreak: 0,
        quarantinedUntil: null,
      };
      return buildSnapshot(subject, state);
    });

    const assertHealthy = Effect.fn("InMemoryAccessHealthRuntime.assertHealthy")(function* (
      subjectInput: unknown,
    ) {
      const snapshot = yield* inspect(subjectInput);
      const currentNow = now();

      if (
        snapshot.quarantinedUntil !== null &&
        Date.parse(snapshot.quarantinedUntil) > currentNow.valueOf()
      ) {
        return yield* Effect.fail(
          new AccessPathQuarantined({
            subjectKey: subjectKey(snapshot.subject),
            quarantinedUntil: snapshot.quarantinedUntil,
            message: `Access path ${subjectKey(snapshot.subject)} is quarantined until ${snapshot.quarantinedUntil}.`,
          }),
        );
      }

      return snapshot;
    });

    const events = Effect.fn("InMemoryAccessHealthRuntime.events")(function* () {
      return yield* Ref.get(eventsRef);
    });

    return {
      recordFailure,
      recordSuccess,
      inspect,
      assertHealthy,
      events,
    };
  });
}
