import { createHash } from "node:crypto";
import { Effect, Option, Schema, ServiceMap } from "effect";
import { RunStageSchema } from "./run-state.ts";
import {
  CanonicalIdentifierSchema,
  CanonicalKeySchema,
  IsoDateTimeSchema,
  TimeoutMsSchema,
  type CanonicalIdentifier,
} from "./schema-primitives.ts";
import { ProviderUnavailable } from "./tagged-errors.ts";
const WorkClaimSequenceSchema = Schema.Int.check(Schema.isGreaterThan(0));
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ReleaseReasonSchema = Schema.Trim.check(Schema.isNonEmpty());
const ArtifactIdListSchema = Schema.Array(CanonicalIdentifierSchema).pipe(
  Schema.refine(
    (artifactIds): artifactIds is ReadonlyArray<CanonicalIdentifier> =>
      new Set(artifactIds).size === artifactIds.length,
    {
      message: "Expected workflow work-claim artifact ids without duplicates.",
    },
  ),
);
const ResumeTokenSchema = Schema.Trim.check(Schema.isNonEmpty());

export const WorkflowWorkClaimStatusSchema = Schema.Literals([
  "claimed",
  "released",
  "completed",
] as const);
export const WorkflowWorkClaimDecisionSchema = Schema.Literals([
  "acquired",
  "alreadyClaimed",
  "alreadyCompleted",
  "superseded",
] as const);

export class WorkflowWorkClaimKey extends Schema.Class<WorkflowWorkClaimKey>(
  "WorkflowWorkClaimKey",
)({
  runId: CanonicalIdentifierSchema,
  dedupeKey: CanonicalKeySchema,
}) {}

export const WorkflowWorkClaimKeySchema = WorkflowWorkClaimKey;

export class WorkflowWorkClaimCheckpoint extends Schema.Class<WorkflowWorkClaimCheckpoint>(
  "WorkflowWorkClaimCheckpoint",
)({
  planId: CanonicalIdentifierSchema,
  checkpointId: CanonicalIdentifierSchema,
  checkpointSequence: WorkClaimSequenceSchema,
  stage: RunStageSchema,
  stepId: CanonicalIdentifierSchema,
}) {}

export const WorkflowWorkClaimCheckpointSchema = WorkflowWorkClaimCheckpoint;

export class WorkflowWorkClaimRequest extends Schema.Class<WorkflowWorkClaimRequest>(
  "WorkflowWorkClaimRequest",
)({
  key: WorkflowWorkClaimKeySchema,
  checkpoint: WorkflowWorkClaimCheckpointSchema,
  claimId: CanonicalIdentifierSchema,
  claimantId: CanonicalIdentifierSchema,
  ttlMs: TimeoutMsSchema,
}) {}

export const WorkflowWorkClaimRequestSchema = WorkflowWorkClaimRequest;

export class WorkflowWorkClaimRenewalRequest extends Schema.Class<WorkflowWorkClaimRenewalRequest>(
  "WorkflowWorkClaimRenewalRequest",
)({
  key: WorkflowWorkClaimKeySchema,
  claimId: CanonicalIdentifierSchema,
  ttlMs: TimeoutMsSchema,
}) {}

export const WorkflowWorkClaimRenewalRequestSchema = WorkflowWorkClaimRenewalRequest;

export class WorkflowWorkClaimCompletionRequest extends Schema.Class<WorkflowWorkClaimCompletionRequest>(
  "WorkflowWorkClaimCompletionRequest",
)({
  key: WorkflowWorkClaimKeySchema,
  claimId: CanonicalIdentifierSchema,
  artifactIds: ArtifactIdListSchema,
  resumeToken: ResumeTokenSchema,
}) {}

export const WorkflowWorkClaimCompletionRequestSchema = WorkflowWorkClaimCompletionRequest;

export class WorkflowWorkClaimReleaseRequest extends Schema.Class<WorkflowWorkClaimReleaseRequest>(
  "WorkflowWorkClaimReleaseRequest",
)({
  key: WorkflowWorkClaimKeySchema,
  claimId: CanonicalIdentifierSchema,
  releaseReason: Schema.optional(ReleaseReasonSchema),
}) {}

export const WorkflowWorkClaimReleaseRequestSchema = WorkflowWorkClaimReleaseRequest;

export class WorkflowWorkClaimRecord extends Schema.Class<WorkflowWorkClaimRecord>(
  "WorkflowWorkClaimRecord",
)({
  key: WorkflowWorkClaimKeySchema,
  checkpoint: WorkflowWorkClaimCheckpointSchema,
  claimId: CanonicalIdentifierSchema,
  claimantId: CanonicalIdentifierSchema,
  status: WorkflowWorkClaimStatusSchema,
  claimCount: PositiveIntSchema,
  takeoverCount: NonNegativeIntSchema,
  claimedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  lastHeartbeatAt: IsoDateTimeSchema,
  lastTransitionAt: IsoDateTimeSchema,
  completedAt: Schema.optional(IsoDateTimeSchema),
  releasedAt: Schema.optional(IsoDateTimeSchema),
  releaseReason: Schema.optional(ReleaseReasonSchema),
  artifactIds: Schema.optional(ArtifactIdListSchema),
  resumeToken: Schema.optional(ResumeTokenSchema),
}) {}

export const WorkflowWorkClaimRecordSchema = WorkflowWorkClaimRecord;

export class WorkflowWorkClaimDecisionRecord extends Schema.Class<WorkflowWorkClaimDecisionRecord>(
  "WorkflowWorkClaimDecisionRecord",
)({
  decision: WorkflowWorkClaimDecisionSchema,
  record: WorkflowWorkClaimRecordSchema,
}) {}

export const WorkflowWorkClaimDecisionRecordSchema = WorkflowWorkClaimDecisionRecord;

const WorkflowWorkClaimCorruptionTypeId =
  "@effect-scrapling/foundation/WorkflowWorkClaimCorruption";

export class WorkflowWorkClaimCorruption extends Schema.TaggedErrorClass<WorkflowWorkClaimCorruption>(
  WorkflowWorkClaimCorruptionTypeId,
)("WorkflowWorkClaimCorruption", {
  message: Schema.String,
}) {
  readonly [WorkflowWorkClaimCorruptionTypeId] = WorkflowWorkClaimCorruptionTypeId;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  if (typeof value === "object" && value !== null) {
    if (Object.prototype.toString.call(value) === "[object Date]") {
      return JSON.stringify(value);
    }

    return `{${Object.keys(value)
      .filter((key) => Reflect.get(value, key) !== undefined)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(Reflect.get(value, key))}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function workflowWorkClaimRecordSha256(
  record: Schema.Codec.Encoded<typeof WorkflowWorkClaimRecordSchema>,
) {
  return createHash("sha256").update(stableSerialize(record), "utf8").digest("hex");
}

export class WorkflowWorkClaimStore extends ServiceMap.Service<
  WorkflowWorkClaimStore,
  {
    readonly claim: (
      request: WorkflowWorkClaimRequest,
    ) => Effect.Effect<
      WorkflowWorkClaimDecisionRecord,
      WorkflowWorkClaimCorruption | ProviderUnavailable
    >;
    readonly renew: (
      request: WorkflowWorkClaimRenewalRequest,
    ) => Effect.Effect<
      Option.Option<WorkflowWorkClaimRecord>,
      WorkflowWorkClaimCorruption | ProviderUnavailable
    >;
    readonly complete: (
      request: WorkflowWorkClaimCompletionRequest,
    ) => Effect.Effect<
      Option.Option<WorkflowWorkClaimRecord>,
      WorkflowWorkClaimCorruption | ProviderUnavailable
    >;
    readonly release: (
      request: WorkflowWorkClaimReleaseRequest,
    ) => Effect.Effect<
      Option.Option<WorkflowWorkClaimRecord>,
      WorkflowWorkClaimCorruption | ProviderUnavailable
    >;
    readonly get: (
      key: WorkflowWorkClaimKey,
    ) => Effect.Effect<
      Option.Option<WorkflowWorkClaimRecord>,
      WorkflowWorkClaimCorruption | ProviderUnavailable
    >;
    readonly listByRun: (
      runId: CanonicalIdentifier,
    ) => Effect.Effect<
      ReadonlyArray<WorkflowWorkClaimRecord>,
      WorkflowWorkClaimCorruption | ProviderUnavailable
    >;
  }
>()("@effect-scrapling/foundation/WorkflowWorkClaimStore") {}

export type WorkflowWorkClaimStatus = Schema.Schema.Type<typeof WorkflowWorkClaimStatusSchema>;
export type WorkflowWorkClaimDecision = Schema.Schema.Type<typeof WorkflowWorkClaimDecisionSchema>;
export type WorkflowWorkClaimKeyEncoded = Schema.Codec.Encoded<typeof WorkflowWorkClaimKeySchema>;
export type WorkflowWorkClaimRecordEncoded = Schema.Codec.Encoded<
  typeof WorkflowWorkClaimRecordSchema
>;

function buildWorkflowWorkClaimMapKey(key: WorkflowWorkClaimKey) {
  return `${key.runId}:${key.dedupeKey}`;
}

function makeWorkflowWorkClaimRecord(input: {
  readonly key: WorkflowWorkClaimRecord["key"];
  readonly checkpoint: WorkflowWorkClaimRecord["checkpoint"];
  readonly claimId: string;
  readonly claimantId: string;
  readonly status: WorkflowWorkClaimRecord["status"];
  readonly claimCount: number;
  readonly takeoverCount: number;
  readonly claimedAt: string;
  readonly expiresAt: string;
  readonly lastHeartbeatAt: string;
  readonly lastTransitionAt: string;
  readonly completedAt: string | undefined;
  readonly releasedAt: string | undefined;
  readonly releaseReason: string | undefined;
  readonly artifactIds: ReadonlyArray<CanonicalIdentifier> | undefined;
  readonly resumeToken: string | undefined;
}) {
  return {
    key: input.key,
    checkpoint: input.checkpoint,
    claimId: input.claimId,
    claimantId: input.claimantId,
    status: input.status,
    claimCount: input.claimCount,
    takeoverCount: input.takeoverCount,
    claimedAt: input.claimedAt,
    expiresAt: input.expiresAt,
    lastHeartbeatAt: input.lastHeartbeatAt,
    lastTransitionAt: input.lastTransitionAt,
    ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
    ...(input.releasedAt === undefined ? {} : { releasedAt: input.releasedAt }),
    ...(input.releaseReason === undefined ? {} : { releaseReason: input.releaseReason }),
    ...(input.artifactIds === undefined ? {} : { artifactIds: input.artifactIds }),
    ...(input.resumeToken === undefined ? {} : { resumeToken: input.resumeToken }),
  } satisfies WorkflowWorkClaimRecord;
}

function buildWorkflowWorkClaimDecisionRecord(
  decision: WorkflowWorkClaimDecision,
  record: WorkflowWorkClaimRecord,
) {
  return {
    decision,
    record,
  } satisfies WorkflowWorkClaimDecisionRecord;
}

function isExpired(record: WorkflowWorkClaimRecord, now: Date) {
  return Date.parse(record.expiresAt) <= now.valueOf();
}

function buildClaimedRecord(
  request: WorkflowWorkClaimRequest,
  currentNow: Date,
  previous?: WorkflowWorkClaimRecord,
) {
  const claimedAt = currentNow.toISOString();
  const expiresAt = new Date(currentNow.valueOf() + request.ttlMs).toISOString();
  const takeoverCount =
    previous === undefined || previous.claimId === request.claimId
      ? (previous?.takeoverCount ?? 0)
      : previous.takeoverCount + 1;

  return makeWorkflowWorkClaimRecord({
    key: request.key,
    checkpoint: request.checkpoint,
    claimId: request.claimId,
    claimantId: request.claimantId,
    status: "claimed",
    claimCount: previous === undefined ? 1 : previous.claimCount + 1,
    takeoverCount,
    claimedAt,
    expiresAt,
    lastHeartbeatAt: claimedAt,
    lastTransitionAt: claimedAt,
    completedAt: undefined,
    releasedAt: undefined,
    releaseReason: undefined,
    artifactIds: previous?.artifactIds,
    resumeToken: previous?.resumeToken,
  });
}

function refreshClaimRecord(
  record: WorkflowWorkClaimRecord,
  request: WorkflowWorkClaimRequest,
  currentNow: Date,
) {
  const lastHeartbeatAt = currentNow.toISOString();
  const expiresAt = new Date(currentNow.valueOf() + request.ttlMs).toISOString();

  return makeWorkflowWorkClaimRecord({
    ...record,
    claimantId: request.claimantId,
    expiresAt,
    lastHeartbeatAt,
    completedAt: record.completedAt,
    releasedAt: record.releasedAt,
    releaseReason: record.releaseReason,
    artifactIds: record.artifactIds,
    resumeToken: record.resumeToken,
  });
}

function renewClaimRecord(
  record: WorkflowWorkClaimRecord,
  request: WorkflowWorkClaimRenewalRequest,
  currentNow: Date,
) {
  const lastHeartbeatAt = currentNow.toISOString();
  const expiresAt = new Date(currentNow.valueOf() + request.ttlMs).toISOString();

  return makeWorkflowWorkClaimRecord({
    ...record,
    expiresAt,
    lastHeartbeatAt,
    completedAt: record.completedAt,
    releasedAt: record.releasedAt,
    releaseReason: record.releaseReason,
    artifactIds: record.artifactIds,
    resumeToken: record.resumeToken,
  });
}

function completeClaimRecord(
  record: WorkflowWorkClaimRecord,
  request: WorkflowWorkClaimCompletionRequest,
  currentNow: Date,
) {
  const completedAt = currentNow.toISOString();

  return makeWorkflowWorkClaimRecord({
    ...record,
    status: "completed",
    lastHeartbeatAt: completedAt,
    lastTransitionAt: completedAt,
    completedAt,
    releasedAt: undefined,
    releaseReason: undefined,
    artifactIds: request.artifactIds,
    resumeToken: request.resumeToken,
  });
}

function releaseClaimRecord(
  record: WorkflowWorkClaimRecord,
  request: WorkflowWorkClaimReleaseRequest,
  currentNow: Date,
) {
  const releasedAt = currentNow.toISOString();

  return makeWorkflowWorkClaimRecord({
    ...record,
    status: "released",
    expiresAt: releasedAt,
    lastHeartbeatAt: releasedAt,
    lastTransitionAt: releasedAt,
    completedAt: undefined,
    releasedAt,
    releaseReason: request.releaseReason,
    artifactIds: record.artifactIds,
    resumeToken: record.resumeToken,
  });
}

export function makeInMemoryWorkflowWorkClaimStore(now: () => Date = () => new Date()) {
  const claims = new Map<string, WorkflowWorkClaimRecord>();

  return Effect.succeed(
    WorkflowWorkClaimStore.of({
      claim: (input) =>
        Effect.sync(() => {
          const request = input;
          const currentNow = now();
          const key = buildWorkflowWorkClaimMapKey(request.key);
          const existing = claims.get(key);

          if (existing === undefined) {
            const record = buildClaimedRecord(request, currentNow);
            claims.set(key, record);
            return buildWorkflowWorkClaimDecisionRecord("acquired", record);
          }

          if (existing.status === "completed") {
            return buildWorkflowWorkClaimDecisionRecord("alreadyCompleted", existing);
          }

          if (existing.checkpoint.checkpointSequence > request.checkpoint.checkpointSequence) {
            return buildWorkflowWorkClaimDecisionRecord("superseded", existing);
          }

          if (existing.claimId === request.claimId && existing.status === "claimed") {
            const refreshed = refreshClaimRecord(existing, request, currentNow);
            claims.set(key, refreshed);
            return buildWorkflowWorkClaimDecisionRecord("acquired", refreshed);
          }

          if (existing.status === "claimed" && !isExpired(existing, currentNow)) {
            return buildWorkflowWorkClaimDecisionRecord("alreadyClaimed", existing);
          }

          const record = buildClaimedRecord(request, currentNow, existing);
          claims.set(key, record);
          return buildWorkflowWorkClaimDecisionRecord("acquired", record);
        }),
      renew: (input) =>
        Effect.sync(() => {
          const request = input;
          const key = buildWorkflowWorkClaimMapKey(request.key);
          const existing = claims.get(key);

          if (
            existing === undefined ||
            existing.status !== "claimed" ||
            existing.claimId !== request.claimId ||
            isExpired(existing, now())
          ) {
            return Option.none();
          }

          const renewed = renewClaimRecord(existing, request, now());
          claims.set(key, renewed);
          return Option.some(renewed);
        }),
      complete: (input) =>
        Effect.sync(() => {
          const request = input;
          const key = buildWorkflowWorkClaimMapKey(request.key);
          const existing = claims.get(key);

          if (existing === undefined || existing.claimId !== request.claimId) {
            return Option.none();
          }

          if (existing.status === "completed") {
            return Option.some(existing);
          }

          if (existing.status !== "claimed") {
            return Option.none();
          }

          const completed = completeClaimRecord(existing, request, now());
          claims.set(key, completed);
          return Option.some(completed);
        }),
      release: (input) =>
        Effect.sync(() => {
          const request = input;
          const key = buildWorkflowWorkClaimMapKey(request.key);
          const existing = claims.get(key);

          if (existing === undefined || existing.claimId !== request.claimId) {
            return Option.none();
          }

          if (existing.status === "completed" || existing.status === "released") {
            return Option.some(existing);
          }

          const released = releaseClaimRecord(existing, request, now());
          claims.set(key, released);
          return Option.some(released);
        }),
      get: (input) =>
        Effect.sync(() => {
          const key = input;
          const record = claims.get(buildWorkflowWorkClaimMapKey(key));
          return record === undefined ? Option.none() : Option.some(record);
        }),
      listByRun: (input) =>
        Effect.sync(() => {
          const runId = input;
          return [...claims.values()]
            .filter((record) => record.key.runId === runId)
            .sort((left, right) => left.key.dedupeKey.localeCompare(right.key.dedupeKey));
        }),
    }),
  );
}
