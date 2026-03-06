import { Effect, Ref, Schema } from "effect";
import {
  CanonicalIdentifierSchema,
  IsoDateTimeSchema,
  TimeoutMsSchema,
} from "./schema-primitives.ts";
import {
  CoreErrorEnvelopeSchema,
  PolicyViolation,
  toCoreErrorEnvelope,
  type CoreErrorEnvelope,
  type CoreTaggedError,
} from "./tagged-errors.ts";

const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveLimitSchema = Schema.Int.check(Schema.isGreaterThan(0)).check(
  Schema.isLessThanOrEqualTo(1024),
);
const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

export class BrowserLeakPolicy extends Schema.Class<BrowserLeakPolicy>("BrowserLeakPolicy")({
  maxOpenBrowsers: PositiveLimitSchema,
  maxOpenContexts: PositiveLimitSchema,
  maxOpenPages: PositiveLimitSchema,
  consecutiveViolationThreshold: PositiveLimitSchema,
  sampleIntervalMs: TimeoutMsSchema,
}) {}

export class BrowserLeakSnapshot extends Schema.Class<BrowserLeakSnapshot>("BrowserLeakSnapshot")({
  openBrowsers: NonNegativeIntSchema,
  openContexts: NonNegativeIntSchema,
  openPages: NonNegativeIntSchema,
  consecutiveViolationCount: NonNegativeIntSchema,
  sampleCount: NonNegativeIntSchema,
  lastPlanId: Schema.NullOr(CanonicalIdentifierSchema),
  recordedAt: IsoDateTimeSchema,
}) {}

export class BrowserLeakAlarm extends Schema.Class<BrowserLeakAlarm>("BrowserLeakAlarm")({
  snapshot: BrowserLeakSnapshot,
  reason: NonEmptyStringSchema,
  recordedAt: IsoDateTimeSchema,
}) {}

export class BrowserCrashTelemetry extends Schema.Class<BrowserCrashTelemetry>(
  "BrowserCrashTelemetry",
)({
  planId: CanonicalIdentifierSchema,
  browserGeneration: NonNegativeIntSchema,
  recycledToGeneration: Schema.NullOr(NonNegativeIntSchema),
  recovered: Schema.Boolean,
  failure: CoreErrorEnvelopeSchema,
  recordedAt: IsoDateTimeSchema,
}) {}

export const BrowserLeakPolicySchema = BrowserLeakPolicy;
export const BrowserLeakSnapshotSchema = BrowserLeakSnapshot;
export const BrowserLeakAlarmSchema = BrowserLeakAlarm;
export const BrowserCrashTelemetrySchema = BrowserCrashTelemetry;
const BrowserLeakPlanIdSchema = Schema.NullOr(CanonicalIdentifierSchema);

type BrowserLeakPolicyType = Schema.Schema.Type<typeof BrowserLeakPolicySchema>;
type BrowserLeakPlanId = Schema.Schema.Type<typeof BrowserLeakPlanIdSchema>;
type BrowserLeakResourceKind = "browser" | "context" | "page";
type BrowserLeakSnapshotType = Schema.Schema.Type<typeof BrowserLeakSnapshotSchema>;
type BrowserLeakAlarmType = Schema.Schema.Type<typeof BrowserLeakAlarmSchema>;
type BrowserCrashTelemetryType = Schema.Schema.Type<typeof BrowserCrashTelemetrySchema>;
type BrowserLeakState = {
  readonly openBrowsers: number;
  readonly openContexts: number;
  readonly openPages: number;
  readonly consecutiveViolationCount: number;
  readonly sampleCount: number;
  readonly lastPlanId: BrowserLeakPlanId;
};
type BrowserLeakMutation = {
  readonly nextState: BrowserLeakState;
  readonly reason: string | null;
};

const emptyBrowserLeakState: BrowserLeakState = {
  openBrowsers: 0,
  openContexts: 0,
  openPages: 0,
  consecutiveViolationCount: 0,
  sampleCount: 0,
  lastPlanId: null,
};

function decodeBrowserLeakPolicy(input: unknown) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(BrowserLeakPolicySchema)(input),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode browser leak policy through shared contracts.",
      }),
  });
}

function buildSnapshot(state: BrowserLeakState, recordedAt: Date) {
  return Schema.decodeUnknownSync(BrowserLeakSnapshotSchema)({
    openBrowsers: state.openBrowsers,
    openContexts: state.openContexts,
    openPages: state.openPages,
    consecutiveViolationCount: state.consecutiveViolationCount,
    sampleCount: state.sampleCount,
    lastPlanId: state.lastPlanId,
    recordedAt: recordedAt.toISOString(),
  });
}

function buildAlarm(snapshot: BrowserLeakSnapshotType, reason: string, recordedAt: Date) {
  return Schema.decodeUnknownSync(BrowserLeakAlarmSchema)({
    snapshot,
    reason,
    recordedAt: recordedAt.toISOString(),
  });
}

export function makeBrowserCrashTelemetry(input: {
  readonly planId: string;
  readonly browserGeneration: number;
  readonly recycledToGeneration: number | null;
  readonly recovered: boolean;
  readonly failure: CoreTaggedError;
  readonly recordedAt: string;
}) {
  return Schema.decodeUnknownSync(BrowserCrashTelemetrySchema)({
    ...input,
    failure: toCoreErrorEnvelope(input.failure),
  });
}

function describeViolation(
  policy: BrowserLeakPolicyType,
  state: Pick<BrowserLeakState, "openBrowsers" | "openContexts" | "openPages">,
) {
  if (state.openBrowsers > policy.maxOpenBrowsers) {
    return `Open browser count ${state.openBrowsers} exceeded limit ${policy.maxOpenBrowsers}.`;
  }

  if (state.openContexts > policy.maxOpenContexts) {
    return `Open context count ${state.openContexts} exceeded limit ${policy.maxOpenContexts}.`;
  }

  if (state.openPages > policy.maxOpenPages) {
    return `Open page count ${state.openPages} exceeded limit ${policy.maxOpenPages}.`;
  }

  return null;
}

function adjustCount(
  state: BrowserLeakState,
  kind: BrowserLeakResourceKind,
  delta: 1 | -1,
): BrowserLeakMutation {
  const currentCount =
    kind === "browser"
      ? state.openBrowsers
      : kind === "context"
        ? state.openContexts
        : state.openPages;
  const nextCount = currentCount + delta;

  if (nextCount < 0) {
    return {
      nextState: state,
      reason: `Browser leak detector attempted to release ${kind} below zero.`,
    };
  }

  return {
    nextState: {
      ...state,
      openBrowsers: kind === "browser" ? nextCount : state.openBrowsers,
      openContexts: kind === "context" ? nextCount : state.openContexts,
      openPages: kind === "page" ? nextCount : state.openPages,
    },
    reason: null,
  };
}

function nextObservedState(options: {
  readonly current: BrowserLeakState;
  readonly updated: BrowserLeakState;
  readonly planId: BrowserLeakPlanId;
  readonly violationReason: string | null;
}) {
  return {
    ...options.updated,
    consecutiveViolationCount:
      options.violationReason === null ? 0 : options.current.consecutiveViolationCount + 1,
    sampleCount: options.current.sampleCount + 1,
    lastPlanId: options.planId ?? options.updated.lastPlanId,
  } satisfies BrowserLeakState;
}

export type BrowserLeakDetector = {
  readonly inspect: Effect.Effect<BrowserLeakSnapshotType>;
  readonly readAlarms: Effect.Effect<ReadonlyArray<BrowserLeakAlarmType>>;
  readonly readCrashTelemetry: Effect.Effect<ReadonlyArray<BrowserCrashTelemetryType>>;
  readonly recordBrowserOpened: (
    planId?: BrowserLeakPlanId,
  ) => Effect.Effect<BrowserLeakSnapshotType>;
  readonly recordBrowserClosed: (
    planId?: BrowserLeakPlanId,
  ) => Effect.Effect<BrowserLeakSnapshotType>;
  readonly recordContextOpened: (
    planId?: BrowserLeakPlanId,
  ) => Effect.Effect<BrowserLeakSnapshotType>;
  readonly recordContextClosed: (
    planId?: BrowserLeakPlanId,
  ) => Effect.Effect<BrowserLeakSnapshotType>;
  readonly recordPageOpened: (planId?: BrowserLeakPlanId) => Effect.Effect<BrowserLeakSnapshotType>;
  readonly recordPageClosed: (planId?: BrowserLeakPlanId) => Effect.Effect<BrowserLeakSnapshotType>;
  readonly recordCrashTelemetry: (
    telemetry: BrowserCrashTelemetryType,
  ) => Effect.Effect<BrowserCrashTelemetryType>;
};

export function makeInMemoryBrowserLeakDetector(
  policyInput: unknown,
  now: () => Date = () => new Date(),
) {
  return Effect.gen(function* () {
    const policy = yield* decodeBrowserLeakPolicy(policyInput);
    const stateRef = yield* Ref.make(emptyBrowserLeakState);
    const alarmsRef = yield* Ref.make(new Array<BrowserLeakAlarmType>());
    const crashTelemetryRef = yield* Ref.make(new Array<BrowserCrashTelemetryType>());

    const mutate = Effect.fn("InMemoryBrowserLeakDetector.mutate")(function* (
      kind: BrowserLeakResourceKind,
      delta: 1 | -1,
      planId: BrowserLeakPlanId = null,
    ) {
      const recordedAt = now();

      return yield* Ref.modify(stateRef, (current) => {
        const mutation = adjustCount(current, kind, delta);
        const violationReason = mutation.reason ?? describeViolation(policy, mutation.nextState);
        const nextState = nextObservedState({
          current,
          updated: mutation.nextState,
          planId,
          violationReason,
        });
        const snapshot = buildSnapshot(nextState, recordedAt);

        return [
          Effect.gen(function* () {
            if (
              violationReason !== null &&
              nextState.consecutiveViolationCount >= policy.consecutiveViolationThreshold
            ) {
              yield* Ref.update(alarmsRef, (currentAlarms) =>
                currentAlarms.concat(buildAlarm(snapshot, violationReason, recordedAt)),
              );
            }

            return snapshot;
          }),
          nextState,
        ] as const;
      }).pipe(Effect.flatten);
    });

    return {
      inspect: Ref.get(stateRef).pipe(Effect.map((state) => buildSnapshot(state, now()))),
      readAlarms: Ref.get(alarmsRef),
      readCrashTelemetry: Ref.get(crashTelemetryRef),
      recordBrowserOpened: (planId?: BrowserLeakPlanId) => mutate("browser", 1, planId),
      recordBrowserClosed: (planId?: BrowserLeakPlanId) => mutate("browser", -1, planId),
      recordContextOpened: (planId?: BrowserLeakPlanId) => mutate("context", 1, planId),
      recordContextClosed: (planId?: BrowserLeakPlanId) => mutate("context", -1, planId),
      recordPageOpened: (planId?: BrowserLeakPlanId) => mutate("page", 1, planId),
      recordPageClosed: (planId?: BrowserLeakPlanId) => mutate("page", -1, planId),
      recordCrashTelemetry: Effect.fn("InMemoryBrowserLeakDetector.recordCrashTelemetry")(
        (telemetry: BrowserCrashTelemetry) =>
          Ref.update(crashTelemetryRef, (current) => current.concat(telemetry)).pipe(
            Effect.as(telemetry),
          ),
      ),
    } satisfies BrowserLeakDetector;
  });
}
export type BrowserRuntimeFailureEnvelope = CoreErrorEnvelope;
