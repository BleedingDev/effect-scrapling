import { Data, Effect, Option, Ref, Schema } from "effect";
import { IdentityLeaseSchema } from "./budget-lease-artifact.ts";
import {
  CanonicalDomainSchema,
  CanonicalIdentifierSchema,
  IsoDateTimeSchema,
  TimeoutMsSchema,
} from "./schema-primitives.ts";
import { PolicyViolation } from "./tagged-errors.ts";

const MaxActiveLeasesSchema = Schema.Int.check(Schema.isGreaterThan(0)).check(
  Schema.isLessThanOrEqualTo(128),
);
const LeaseEventKindSchema = Schema.Literals([
  "allocated",
  "renewed",
  "released",
  "expired",
] as const);

export class IdentityLeaseScope extends Schema.Class<IdentityLeaseScope>("IdentityLeaseScope")({
  ownerId: CanonicalIdentifierSchema,
  tenantId: CanonicalIdentifierSchema,
  domain: CanonicalDomainSchema,
}) {}

export class IdentityLeaseAcquireRequest extends Schema.Class<IdentityLeaseAcquireRequest>(
  "IdentityLeaseAcquireRequest",
)({
  ownerId: CanonicalIdentifierSchema,
  tenantId: CanonicalIdentifierSchema,
  domain: CanonicalDomainSchema,
  identityKey: CanonicalIdentifierSchema,
  ttlMs: TimeoutMsSchema,
  maxActiveLeases: MaxActiveLeasesSchema,
}) {}

export class IdentityLeaseRenewalRequest extends Schema.Class<IdentityLeaseRenewalRequest>(
  "IdentityLeaseRenewalRequest",
)({
  leaseId: CanonicalIdentifierSchema,
  ttlMs: TimeoutMsSchema,
}) {}

export class IdentityLeaseRecord extends Schema.Class<IdentityLeaseRecord>("IdentityLeaseRecord")({
  lease: IdentityLeaseSchema,
  tenantId: CanonicalIdentifierSchema,
  domain: CanonicalDomainSchema,
}) {}

export class IdentityLeaseScopeSnapshot extends Schema.Class<IdentityLeaseScopeSnapshot>(
  "IdentityLeaseScopeSnapshot",
)({
  ownerId: CanonicalIdentifierSchema,
  tenantId: CanonicalIdentifierSchema,
  domain: CanonicalDomainSchema,
  activeLeaseCount: Schema.Int,
  activeLeaseIds: Schema.Array(CanonicalIdentifierSchema),
  identityKeys: Schema.Array(CanonicalIdentifierSchema),
}) {}

export class IdentityLeaseLifecycleEvent extends Schema.Class<IdentityLeaseLifecycleEvent>(
  "IdentityLeaseLifecycleEvent",
)({
  kind: LeaseEventKindSchema,
  leaseId: CanonicalIdentifierSchema,
  ownerId: CanonicalIdentifierSchema,
  tenantId: CanonicalIdentifierSchema,
  domain: CanonicalDomainSchema,
  identityKey: CanonicalIdentifierSchema,
  expiresAt: IsoDateTimeSchema,
  activeLeaseCount: Schema.Int,
  recordedAt: IsoDateTimeSchema,
}) {}

export class IdentityLeaseUnavailable extends Data.TaggedError("IdentityLeaseUnavailable")<{
  readonly ownerId: string;
  readonly tenantId: string;
  readonly domain: string;
  readonly identityKey: string;
  readonly message: string;
}> {}

type IdentityAcquireResult =
  | {
      readonly ok: false;
      readonly error: IdentityLeaseUnavailable;
    }
  | {
      readonly ok: true;
      readonly lease: Schema.Schema.Type<typeof IdentityLeaseSchema>;
      readonly record: Schema.Schema.Type<typeof IdentityLeaseRecord>;
      readonly activeLeaseCount: number;
    };

const decodeIdentityLeaseAcquireRequestSync = Schema.decodeUnknownSync(IdentityLeaseAcquireRequest);
const decodeIdentityLeaseRenewalRequestSync = Schema.decodeUnknownSync(IdentityLeaseRenewalRequest);
const decodeIdentityLeaseScopeSync = Schema.decodeUnknownSync(IdentityLeaseScope);
const decodeCanonicalIdentifierSync = Schema.decodeUnknownSync(CanonicalIdentifierSchema);

function decodeIdentityLeaseAcquireRequest(input: unknown) {
  return Effect.try({
    try: () => decodeIdentityLeaseAcquireRequestSync(input),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode identity-lease request through shared contracts.",
      }),
  });
}

function decodeIdentityLeaseRenewalRequest(input: unknown) {
  return Effect.try({
    try: () => decodeIdentityLeaseRenewalRequestSync(input),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode identity-lease renewal through shared contracts.",
      }),
  });
}

function decodeIdentityLeaseScope(input: unknown) {
  return Effect.try({
    try: () => decodeIdentityLeaseScopeSync(input),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode identity-lease scope through shared contracts.",
      }),
  });
}

function decodeCanonicalIdentifier(input: unknown, message: string) {
  return Effect.try({
    try: () => decodeCanonicalIdentifierSync(input),
    catch: () => new PolicyViolation({ message }),
  });
}

function makeScopeKey(scope: Schema.Schema.Type<typeof IdentityLeaseScope>) {
  return JSON.stringify([scope.ownerId, scope.tenantId, scope.domain]);
}

function toScope(record: Schema.Schema.Type<typeof IdentityLeaseRecord>) {
  return Schema.decodeUnknownSync(IdentityLeaseScope)({
    ownerId: record.lease.ownerId,
    tenantId: record.tenantId,
    domain: record.domain,
  });
}

function isExpired(record: Schema.Schema.Type<typeof IdentityLeaseRecord>, now: Date) {
  return Date.parse(record.lease.expiresAt) <= now.valueOf();
}

function buildScopeSnapshot(
  scope: Schema.Schema.Type<typeof IdentityLeaseScope>,
  records: ReadonlyMap<string, Schema.Schema.Type<typeof IdentityLeaseRecord>>,
) {
  const scopedRecords = [...records.values()]
    .filter((record) => makeScopeKey(toScope(record)) === makeScopeKey(scope))
    .toSorted((left, right) => left.lease.id.localeCompare(right.lease.id));

  return Schema.decodeUnknownSync(IdentityLeaseScopeSnapshot)({
    ownerId: scope.ownerId,
    tenantId: scope.tenantId,
    domain: scope.domain,
    activeLeaseCount: scopedRecords.length,
    activeLeaseIds: scopedRecords.map(({ lease }) => lease.id),
    identityKeys: scopedRecords.map(({ lease }) => lease.identityKey),
  });
}

function buildLifecycleEvent(
  kind: Schema.Schema.Type<typeof LeaseEventKindSchema>,
  record: Schema.Schema.Type<typeof IdentityLeaseRecord>,
  activeLeaseCount: number,
  now: Date,
) {
  return Schema.decodeUnknownSync(IdentityLeaseLifecycleEvent)({
    kind,
    leaseId: record.lease.id,
    ownerId: record.lease.ownerId,
    tenantId: record.tenantId,
    domain: record.domain,
    identityKey: record.lease.identityKey,
    expiresAt: record.lease.expiresAt,
    activeLeaseCount,
    recordedAt: now.toISOString(),
  });
}

export function makeInMemoryIdentityLeaseManager(now: () => Date = () => new Date()) {
  return Effect.gen(function* () {
    const recordsRef = yield* Ref.make(
      new Map<string, Schema.Schema.Type<typeof IdentityLeaseRecord>>(),
    );
    const eventsRef = yield* Ref.make(
      new Array<Schema.Schema.Type<typeof IdentityLeaseLifecycleEvent>>(),
    );

    const recordEvent = Effect.fn("InMemoryIdentityLeaseManager.recordEvent")(function* (
      kind: Schema.Schema.Type<typeof LeaseEventKindSchema>,
      record: Schema.Schema.Type<typeof IdentityLeaseRecord>,
      activeLeaseCount: number,
      recordedAt: Date,
    ) {
      yield* Ref.update(eventsRef, (current) =>
        current.concat(buildLifecycleEvent(kind, record, activeLeaseCount, recordedAt)),
      );
    });

    const sweepExpired = Effect.fn("InMemoryIdentityLeaseManager.sweepExpired")(function* () {
      const currentNow = now();
      const { expired, records } = yield* Ref.modify(recordsRef, (current) => {
        const next = new Map(current);
        const expired = new Array<Schema.Schema.Type<typeof IdentityLeaseRecord>>();

        for (const [leaseId, record] of current) {
          if (isExpired(record, currentNow)) {
            next.delete(leaseId);
            expired.push(record);
          }
        }

        return [{ expired, records: next }, next] as const;
      });

      for (const expiredRecord of expired) {
        const snapshot = buildScopeSnapshot(toScope(expiredRecord), records);
        yield* recordEvent("expired", expiredRecord, snapshot.activeLeaseCount, currentNow);
      }
    });

    const acquire = Effect.fn("InMemoryIdentityLeaseManager.acquire")(function* (input: unknown) {
      const request = yield* decodeIdentityLeaseAcquireRequest(input);
      yield* sweepExpired();
      const currentNow = now();

      const scope = Schema.decodeUnknownSync(IdentityLeaseScope)(request);
      const scopeKey = makeScopeKey(scope);
      const result = yield* Ref.modify<
        Map<string, Schema.Schema.Type<typeof IdentityLeaseRecord>>,
        IdentityAcquireResult
      >(recordsRef, (current) => {
        const scopedRecords = [...current.values()].filter(
          (record) => makeScopeKey(toScope(record)) === scopeKey,
        );

        if (scopedRecords.length >= request.maxActiveLeases) {
          return [
            {
              ok: false as const,
              error: new IdentityLeaseUnavailable({
                ownerId: request.ownerId,
                tenantId: request.tenantId,
                domain: request.domain,
                identityKey: request.identityKey,
                message: `Identity lease scope ${scopeKey} exhausted its ${request.maxActiveLeases} active lease budget.`,
              }),
            },
            current,
          ] as const satisfies readonly [IdentityAcquireResult, typeof current];
        }

        if (scopedRecords.some((record) => record.lease.identityKey === request.identityKey)) {
          return [
            {
              ok: false as const,
              error: new IdentityLeaseUnavailable({
                ownerId: request.ownerId,
                tenantId: request.tenantId,
                domain: request.domain,
                identityKey: request.identityKey,
                message: `Identity key ${request.identityKey} is already leased inside scope ${scopeKey}.`,
              }),
            },
            current,
          ] as const satisfies readonly [IdentityAcquireResult, typeof current];
        }

        const lease = Schema.decodeUnknownSync(IdentityLeaseSchema)({
          id: `identity-lease-${request.ownerId}-${request.identityKey}-${currentNow.valueOf()}`,
          ownerId: request.ownerId,
          identityKey: request.identityKey,
          expiresAt: new Date(currentNow.valueOf() + request.ttlMs).toISOString(),
        });
        const record = Schema.decodeUnknownSync(IdentityLeaseRecord)({
          lease,
          tenantId: request.tenantId,
          domain: request.domain,
        });
        const next = new Map(current);
        next.set(lease.id, record);
        const activeLeaseCount = buildScopeSnapshot(scope, next).activeLeaseCount;
        return [
          { ok: true as const, lease, record, activeLeaseCount },
          next,
        ] as const satisfies readonly [IdentityAcquireResult, typeof next];
      });

      if (!result.ok) {
        return yield* Effect.fail(result.error);
      }

      yield* recordEvent("allocated", result.record, result.activeLeaseCount, currentNow);
      return result.lease;
    });

    const renew = Effect.fn("InMemoryIdentityLeaseManager.renew")(function* (input: unknown) {
      const request = yield* decodeIdentityLeaseRenewalRequest(input);
      yield* sweepExpired();

      const currentNow = now();
      const updatedRecord = yield* Ref.modify(recordsRef, (current) => {
        const existing = current.get(request.leaseId);
        if (existing === undefined) {
          return [
            Option.none<{
              readonly record: Schema.Schema.Type<typeof IdentityLeaseRecord>;
              readonly activeLeaseCount: number;
            }>(),
            current,
          ] as const;
        }

        const renewed = Schema.decodeUnknownSync(IdentityLeaseRecord)({
          lease: {
            ...existing.lease,
            expiresAt: new Date(currentNow.valueOf() + request.ttlMs).toISOString(),
          },
          tenantId: existing.tenantId,
          domain: existing.domain,
        });
        const next = new Map(current);
        next.set(request.leaseId, renewed);
        return [
          Option.some({
            record: renewed,
            activeLeaseCount: buildScopeSnapshot(toScope(renewed), next).activeLeaseCount,
          }),
          next,
        ] as const;
      });

      if (Option.isNone(updatedRecord)) {
        return yield* Effect.fail(
          new PolicyViolation({
            message: `Identity lease ${request.leaseId} cannot be renewed because it is no longer active.`,
          }),
        );
      }

      yield* recordEvent(
        "renewed",
        updatedRecord.value.record,
        updatedRecord.value.activeLeaseCount,
        currentNow,
      );
      return updatedRecord.value.record.lease;
    });

    const release = Effect.fn("InMemoryIdentityLeaseManager.release")(function* (leaseId: unknown) {
      const decodedLeaseId = yield* decodeCanonicalIdentifier(
        leaseId,
        "Failed to decode identity-lease id through shared contracts.",
      );
      yield* sweepExpired();

      const currentNow = now();
      const released = yield* Ref.modify(recordsRef, (current) => {
        const existing = current.get(decodedLeaseId);
        if (existing === undefined) {
          return [
            Option.none<{
              readonly record: Schema.Schema.Type<typeof IdentityLeaseRecord>;
              readonly activeLeaseCount: number;
            }>(),
            current,
          ] as const;
        }

        const next = new Map(current);
        next.delete(decodedLeaseId);
        return [
          Option.some({
            record: existing,
            activeLeaseCount: buildScopeSnapshot(toScope(existing), next).activeLeaseCount,
          }),
          next,
        ] as const;
      });

      if (Option.isSome(released)) {
        yield* recordEvent(
          "released",
          released.value.record,
          released.value.activeLeaseCount,
          currentNow,
        );
        return Option.some(released.value.record.lease);
      }

      return Option.none<Schema.Schema.Type<typeof IdentityLeaseSchema>>();
    });

    const inspectScope = Effect.fn("InMemoryIdentityLeaseManager.inspectScope")(function* (
      input: unknown,
    ) {
      const scope = yield* decodeIdentityLeaseScope(input);
      yield* sweepExpired();
      return buildScopeSnapshot(scope, yield* Ref.get(recordsRef));
    });

    const events = Effect.fn("InMemoryIdentityLeaseManager.events")(function* () {
      yield* sweepExpired();
      return yield* Ref.get(eventsRef);
    });

    return {
      acquire,
      renew,
      release,
      inspectScope,
      events,
    };
  });
}
