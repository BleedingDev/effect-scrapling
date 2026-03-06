import { Data, Effect, Option, Ref, Schema } from "effect";
import { EgressLeaseSchema } from "./budget-lease-artifact.ts";
import {
  CanonicalIdentifierSchema,
  IsoDateTimeSchema,
  TimeoutMsSchema,
} from "./schema-primitives.ts";
import { PolicyViolation } from "./tagged-errors.ts";

const MaxActiveLeasesSchema = Schema.Int.check(Schema.isGreaterThan(0)).check(
  Schema.isLessThanOrEqualTo(256),
);
const LeaseEventKindSchema = Schema.Literals([
  "allocated",
  "renewed",
  "released",
  "expired",
] as const);

export class EgressLeaseScope extends Schema.Class<EgressLeaseScope>("EgressLeaseScope")({
  ownerId: CanonicalIdentifierSchema,
  poolId: CanonicalIdentifierSchema,
  routePolicyId: CanonicalIdentifierSchema,
}) {}

export class EgressLeaseAcquireRequest extends Schema.Class<EgressLeaseAcquireRequest>(
  "EgressLeaseAcquireRequest",
)({
  ownerId: CanonicalIdentifierSchema,
  egressKey: CanonicalIdentifierSchema,
  poolId: CanonicalIdentifierSchema,
  routePolicyId: CanonicalIdentifierSchema,
  ttlMs: TimeoutMsSchema,
  maxPoolLeases: MaxActiveLeasesSchema,
  maxRouteLeases: MaxActiveLeasesSchema,
}) {}

export class EgressLeaseRenewalRequest extends Schema.Class<EgressLeaseRenewalRequest>(
  "EgressLeaseRenewalRequest",
)({
  leaseId: CanonicalIdentifierSchema,
  ttlMs: TimeoutMsSchema,
}) {}

export class EgressLeaseRecord extends Schema.Class<EgressLeaseRecord>("EgressLeaseRecord")({
  lease: EgressLeaseSchema,
  poolId: CanonicalIdentifierSchema,
  routePolicyId: CanonicalIdentifierSchema,
}) {}

export class EgressLeaseScopeSnapshot extends Schema.Class<EgressLeaseScopeSnapshot>(
  "EgressLeaseScopeSnapshot",
)({
  ownerId: CanonicalIdentifierSchema,
  poolId: CanonicalIdentifierSchema,
  routePolicyId: CanonicalIdentifierSchema,
  activePoolLeaseCount: Schema.Int,
  activeRouteLeaseCount: Schema.Int,
  activeLeaseIds: Schema.Array(CanonicalIdentifierSchema),
  egressKeys: Schema.Array(CanonicalIdentifierSchema),
}) {}

export class EgressLeaseLifecycleEvent extends Schema.Class<EgressLeaseLifecycleEvent>(
  "EgressLeaseLifecycleEvent",
)({
  kind: LeaseEventKindSchema,
  leaseId: CanonicalIdentifierSchema,
  ownerId: CanonicalIdentifierSchema,
  poolId: CanonicalIdentifierSchema,
  routePolicyId: CanonicalIdentifierSchema,
  egressKey: CanonicalIdentifierSchema,
  expiresAt: IsoDateTimeSchema,
  activePoolLeaseCount: Schema.Int,
  activeRouteLeaseCount: Schema.Int,
  recordedAt: IsoDateTimeSchema,
}) {}

export class EgressLeaseUnavailable extends Data.TaggedError("EgressLeaseUnavailable")<{
  readonly ownerId: string;
  readonly poolId: string;
  readonly routePolicyId: string;
  readonly egressKey: string;
  readonly message: string;
}> {}

type EgressAcquireResult =
  | {
      readonly ok: false;
      readonly error: EgressLeaseUnavailable;
    }
  | {
      readonly ok: true;
      readonly lease: Schema.Schema.Type<typeof EgressLeaseSchema>;
      readonly record: Schema.Schema.Type<typeof EgressLeaseRecord>;
      readonly snapshot: Schema.Schema.Type<typeof EgressLeaseScopeSnapshot>;
    };

const decodeEgressLeaseAcquireRequestSync = Schema.decodeUnknownSync(EgressLeaseAcquireRequest);
const decodeEgressLeaseRenewalRequestSync = Schema.decodeUnknownSync(EgressLeaseRenewalRequest);
const decodeEgressLeaseScopeSync = Schema.decodeUnknownSync(EgressLeaseScope);
const decodeCanonicalIdentifierSync = Schema.decodeUnknownSync(CanonicalIdentifierSchema);

function decodeEgressLeaseAcquireRequest(input: unknown) {
  return Effect.try({
    try: () => decodeEgressLeaseAcquireRequestSync(input),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode egress-lease request through shared contracts.",
      }),
  });
}

function decodeEgressLeaseRenewalRequest(input: unknown) {
  return Effect.try({
    try: () => decodeEgressLeaseRenewalRequestSync(input),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode egress-lease renewal through shared contracts.",
      }),
  });
}

function decodeEgressLeaseScope(input: unknown) {
  return Effect.try({
    try: () => decodeEgressLeaseScopeSync(input),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode egress-lease scope through shared contracts.",
      }),
  });
}

function decodeCanonicalIdentifier(input: unknown, message: string) {
  return Effect.try({
    try: () => decodeCanonicalIdentifierSync(input),
    catch: () => new PolicyViolation({ message }),
  });
}

function toScope(record: Schema.Schema.Type<typeof EgressLeaseRecord>) {
  return Schema.decodeUnknownSync(EgressLeaseScope)({
    ownerId: record.lease.ownerId,
    poolId: record.poolId,
    routePolicyId: record.routePolicyId,
  });
}

function isExpired(record: Schema.Schema.Type<typeof EgressLeaseRecord>, now: Date) {
  return Date.parse(record.lease.expiresAt) <= now.valueOf();
}

function buildScopeSnapshot(
  scope: Schema.Schema.Type<typeof EgressLeaseScope>,
  records: ReadonlyMap<string, Schema.Schema.Type<typeof EgressLeaseRecord>>,
) {
  const poolRecords = [...records.values()]
    .filter((record) => record.lease.ownerId === scope.ownerId && record.poolId === scope.poolId)
    .toSorted((left, right) => left.lease.id.localeCompare(right.lease.id));
  const routeRecords = poolRecords.filter((record) => record.routePolicyId === scope.routePolicyId);

  return Schema.decodeUnknownSync(EgressLeaseScopeSnapshot)({
    ownerId: scope.ownerId,
    poolId: scope.poolId,
    routePolicyId: scope.routePolicyId,
    activePoolLeaseCount: poolRecords.length,
    activeRouteLeaseCount: routeRecords.length,
    activeLeaseIds: routeRecords.map(({ lease }) => lease.id),
    egressKeys: routeRecords.map(({ lease }) => lease.egressKey),
  });
}

function buildLifecycleEvent(
  kind: Schema.Schema.Type<typeof LeaseEventKindSchema>,
  record: Schema.Schema.Type<typeof EgressLeaseRecord>,
  snapshot: Schema.Schema.Type<typeof EgressLeaseScopeSnapshot>,
  now: Date,
) {
  return Schema.decodeUnknownSync(EgressLeaseLifecycleEvent)({
    kind,
    leaseId: record.lease.id,
    ownerId: record.lease.ownerId,
    poolId: record.poolId,
    routePolicyId: record.routePolicyId,
    egressKey: record.lease.egressKey,
    expiresAt: record.lease.expiresAt,
    activePoolLeaseCount: snapshot.activePoolLeaseCount,
    activeRouteLeaseCount: snapshot.activeRouteLeaseCount,
    recordedAt: now.toISOString(),
  });
}

export function makeInMemoryEgressLeaseManager(now: () => Date = () => new Date()) {
  return Effect.gen(function* () {
    const recordsRef = yield* Ref.make(
      new Map<string, Schema.Schema.Type<typeof EgressLeaseRecord>>(),
    );
    const eventsRef = yield* Ref.make(
      new Array<Schema.Schema.Type<typeof EgressLeaseLifecycleEvent>>(),
    );

    const recordEvent = Effect.fn("InMemoryEgressLeaseManager.recordEvent")(function* (
      kind: Schema.Schema.Type<typeof LeaseEventKindSchema>,
      record: Schema.Schema.Type<typeof EgressLeaseRecord>,
      snapshot: Schema.Schema.Type<typeof EgressLeaseScopeSnapshot>,
      recordedAt: Date,
    ) {
      yield* Ref.update(eventsRef, (current) =>
        current.concat(buildLifecycleEvent(kind, record, snapshot, recordedAt)),
      );
    });

    const sweepExpired = Effect.fn("InMemoryEgressLeaseManager.sweepExpired")(function* () {
      const currentNow = now();
      const { expired, records } = yield* Ref.modify(recordsRef, (current) => {
        const next = new Map(current);
        const expired = new Array<Schema.Schema.Type<typeof EgressLeaseRecord>>();

        for (const [leaseId, record] of current) {
          if (isExpired(record, currentNow)) {
            next.delete(leaseId);
            expired.push(record);
          }
        }

        return [{ expired, records: next }, next] as const;
      });

      for (const expiredRecord of expired) {
        yield* recordEvent(
          "expired",
          expiredRecord,
          buildScopeSnapshot(toScope(expiredRecord), records),
          currentNow,
        );
      }
    });

    const acquire = Effect.fn("InMemoryEgressLeaseManager.acquire")(function* (input: unknown) {
      const request = yield* decodeEgressLeaseAcquireRequest(input);
      yield* sweepExpired();

      const currentNow = now();
      const scope = Schema.decodeUnknownSync(EgressLeaseScope)(request);
      const result = yield* Ref.modify<
        Map<string, Schema.Schema.Type<typeof EgressLeaseRecord>>,
        EgressAcquireResult
      >(recordsRef, (current) => {
        const poolRecords = [...current.values()].filter(
          (record) => record.lease.ownerId === request.ownerId && record.poolId === request.poolId,
        );
        const routeRecords = poolRecords.filter(
          (record) => record.routePolicyId === request.routePolicyId,
        );

        if (poolRecords.length >= request.maxPoolLeases) {
          return [
            {
              ok: false as const,
              error: new EgressLeaseUnavailable({
                ownerId: request.ownerId,
                poolId: request.poolId,
                routePolicyId: request.routePolicyId,
                egressKey: request.egressKey,
                message: `Egress pool ${request.poolId} exhausted its ${request.maxPoolLeases} active lease budget.`,
              }),
            },
            current,
          ] as const satisfies readonly [EgressAcquireResult, typeof current];
        }

        if (routeRecords.length >= request.maxRouteLeases) {
          return [
            {
              ok: false as const,
              error: new EgressLeaseUnavailable({
                ownerId: request.ownerId,
                poolId: request.poolId,
                routePolicyId: request.routePolicyId,
                egressKey: request.egressKey,
                message: `Route policy ${request.routePolicyId} exhausted its ${request.maxRouteLeases} active egress leases.`,
              }),
            },
            current,
          ] as const satisfies readonly [EgressAcquireResult, typeof current];
        }

        if (routeRecords.some((record) => record.lease.egressKey === request.egressKey)) {
          return [
            {
              ok: false as const,
              error: new EgressLeaseUnavailable({
                ownerId: request.ownerId,
                poolId: request.poolId,
                routePolicyId: request.routePolicyId,
                egressKey: request.egressKey,
                message: `Egress key ${request.egressKey} is already allocated for route ${request.routePolicyId}.`,
              }),
            },
            current,
          ] as const satisfies readonly [EgressAcquireResult, typeof current];
        }

        const lease = Schema.decodeUnknownSync(EgressLeaseSchema)({
          id: `egress-lease-${request.ownerId}-${request.egressKey}-${currentNow.valueOf()}`,
          ownerId: request.ownerId,
          egressKey: request.egressKey,
          expiresAt: new Date(currentNow.valueOf() + request.ttlMs).toISOString(),
        });
        const record = Schema.decodeUnknownSync(EgressLeaseRecord)({
          lease,
          poolId: request.poolId,
          routePolicyId: request.routePolicyId,
        });
        const next = new Map(current);
        next.set(lease.id, record);
        const snapshot = buildScopeSnapshot(scope, next);
        return [{ ok: true as const, lease, record, snapshot }, next] as const satisfies readonly [
          EgressAcquireResult,
          typeof next,
        ];
      });

      if (!result.ok) {
        return yield* Effect.fail(result.error);
      }

      yield* recordEvent("allocated", result.record, result.snapshot, currentNow);
      return result.lease;
    });

    const renew = Effect.fn("InMemoryEgressLeaseManager.renew")(function* (input: unknown) {
      const request = yield* decodeEgressLeaseRenewalRequest(input);
      yield* sweepExpired();

      const currentNow = now();
      const updatedRecord = yield* Ref.modify(recordsRef, (current) => {
        const existing = current.get(request.leaseId);
        if (existing === undefined) {
          return [
            Option.none<{
              readonly record: Schema.Schema.Type<typeof EgressLeaseRecord>;
              readonly snapshot: Schema.Schema.Type<typeof EgressLeaseScopeSnapshot>;
            }>(),
            current,
          ] as const;
        }

        const renewed = Schema.decodeUnknownSync(EgressLeaseRecord)({
          lease: {
            ...existing.lease,
            expiresAt: new Date(currentNow.valueOf() + request.ttlMs).toISOString(),
          },
          poolId: existing.poolId,
          routePolicyId: existing.routePolicyId,
        });
        const next = new Map(current);
        next.set(request.leaseId, renewed);
        return [
          Option.some({
            record: renewed,
            snapshot: buildScopeSnapshot(toScope(renewed), next),
          }),
          next,
        ] as const;
      });

      if (Option.isNone(updatedRecord)) {
        return yield* Effect.fail(
          new PolicyViolation({
            message: `Egress lease ${request.leaseId} cannot be renewed because it is no longer active.`,
          }),
        );
      }

      yield* recordEvent(
        "renewed",
        updatedRecord.value.record,
        updatedRecord.value.snapshot,
        currentNow,
      );
      return updatedRecord.value.record.lease;
    });

    const release = Effect.fn("InMemoryEgressLeaseManager.release")(function* (leaseId: unknown) {
      const decodedLeaseId = yield* decodeCanonicalIdentifier(
        leaseId,
        "Failed to decode egress-lease id through shared contracts.",
      );
      yield* sweepExpired();

      const currentNow = now();
      const released = yield* Ref.modify(recordsRef, (current) => {
        const existing = current.get(decodedLeaseId);
        if (existing === undefined) {
          return [
            Option.none<{
              readonly record: Schema.Schema.Type<typeof EgressLeaseRecord>;
              readonly snapshot: Schema.Schema.Type<typeof EgressLeaseScopeSnapshot>;
            }>(),
            current,
          ] as const;
        }

        const next = new Map(current);
        next.delete(decodedLeaseId);
        return [
          Option.some({
            record: existing,
            snapshot: buildScopeSnapshot(toScope(existing), next),
          }),
          next,
        ] as const;
      });

      if (Option.isSome(released)) {
        yield* recordEvent("released", released.value.record, released.value.snapshot, currentNow);
        return Option.some(released.value.record.lease);
      }

      return Option.none<Schema.Schema.Type<typeof EgressLeaseSchema>>();
    });

    const inspectScope = Effect.fn("InMemoryEgressLeaseManager.inspectScope")(function* (
      input: unknown,
    ) {
      const scope = yield* decodeEgressLeaseScope(input);
      yield* sweepExpired();
      return buildScopeSnapshot(scope, yield* Ref.get(recordsRef));
    });

    const events = Effect.fn("InMemoryEgressLeaseManager.events")(function* () {
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
