import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Layer, Option, Schema } from "effect";
import { RunStageSchema } from "./run-state.ts";
import {
  CanonicalIdentifierSchema,
  CanonicalKeySchema,
  IsoDateTimeSchema,
} from "./schema-primitives.ts";
import { ProviderUnavailable } from "./tagged-errors.ts";
import {
  WorkflowWorkClaimCompletionRequestSchema,
  WorkflowWorkClaimCorruption,
  WorkflowWorkClaimDecisionRecord,
  WorkflowWorkClaimDecisionSchema,
  WorkflowWorkClaimKeySchema,
  WorkflowWorkClaimRecordSchema,
  WorkflowWorkClaimReleaseRequestSchema,
  WorkflowWorkClaimRenewalRequestSchema,
  WorkflowWorkClaimRequestSchema,
  WorkflowWorkClaimStatusSchema,
  WorkflowWorkClaimStore,
  workflowWorkClaimRecordSha256,
} from "./workflow-work-claim-store.ts";

const SqliteWorkflowWorkClaimStoreConfigSchema = Schema.Struct({
  filename: Schema.Trim.check(Schema.isNonEmpty()),
});
const Sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const NullableReleaseReasonSchema = Schema.NullOr(Schema.Trim.check(Schema.isNonEmpty()));

const SqliteStoredWorkflowWorkClaimRowSchema = Schema.Struct({
  runId: CanonicalIdentifierSchema,
  dedupeKey: CanonicalKeySchema,
  claimId: CanonicalIdentifierSchema,
  planId: CanonicalIdentifierSchema,
  checkpointId: CanonicalIdentifierSchema,
  checkpointSequence: Schema.Int,
  stage: RunStageSchema,
  stepId: CanonicalIdentifierSchema,
  claimantId: CanonicalIdentifierSchema,
  status: WorkflowWorkClaimStatusSchema,
  claimedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  lastHeartbeatAt: IsoDateTimeSchema,
  lastTransitionAt: IsoDateTimeSchema,
  completedAt: Schema.NullOr(IsoDateTimeSchema),
  releasedAt: Schema.NullOr(IsoDateTimeSchema),
  releaseReason: NullableReleaseReasonSchema,
  recordSha256: Sha256Schema,
  payloadJson: Schema.String,
});

type SqliteWorkflowWorkClaimStoreConfig = Schema.Schema.Type<
  typeof SqliteWorkflowWorkClaimStoreConfigSchema
>;
type SqliteStoredWorkflowWorkClaimRow = Schema.Schema.Type<
  typeof SqliteStoredWorkflowWorkClaimRowSchema
>;
type WorkflowWorkClaimRecord = Schema.Schema.Type<typeof WorkflowWorkClaimRecordSchema>;
type WorkflowWorkClaimRequest = Schema.Schema.Type<typeof WorkflowWorkClaimRequestSchema>;
type WorkflowWorkClaimRenewalRequest = Schema.Schema.Type<
  typeof WorkflowWorkClaimRenewalRequestSchema
>;
type WorkflowWorkClaimCompletionRequest = Schema.Schema.Type<
  typeof WorkflowWorkClaimCompletionRequestSchema
>;
type WorkflowWorkClaimReleaseRequest = Schema.Schema.Type<
  typeof WorkflowWorkClaimReleaseRequestSchema
>;
type WorkflowWorkClaimDecision = Schema.Schema.Type<typeof WorkflowWorkClaimDecisionSchema>;

export type SqliteWorkflowWorkClaimStoreOptions = {
  readonly now?: () => Date;
};

const decodeWorkflowWorkClaimRequestSync = Schema.decodeUnknownSync(WorkflowWorkClaimRequestSchema);
const decodeWorkflowWorkClaimRenewalRequestSync = Schema.decodeUnknownSync(
  WorkflowWorkClaimRenewalRequestSchema,
);
const decodeWorkflowWorkClaimCompletionRequestSync = Schema.decodeUnknownSync(
  WorkflowWorkClaimCompletionRequestSchema,
);
const decodeWorkflowWorkClaimReleaseRequestSync = Schema.decodeUnknownSync(
  WorkflowWorkClaimReleaseRequestSchema,
);
const decodeSqliteStoredWorkflowWorkClaimRowSync = Schema.decodeUnknownSync(
  SqliteStoredWorkflowWorkClaimRowSchema,
);
const decodeWorkflowWorkClaimRecordSync = Schema.decodeUnknownSync(WorkflowWorkClaimRecordSchema);
const encodeWorkflowWorkClaimRecordSync = Schema.encodeSync(WorkflowWorkClaimRecordSchema);
const decodeWorkflowWorkClaimKeySync = Schema.decodeUnknownSync(WorkflowWorkClaimKeySchema);
const decodeCanonicalIdentifierSync = Schema.decodeUnknownSync(CanonicalIdentifierSchema);

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function toProviderUnavailable(prefix: string, cause: unknown) {
  return new ProviderUnavailable({
    message: `${prefix} ${readCauseMessage(cause, prefix)}`,
  });
}

function toWorkflowWorkClaimCorruption(prefix: string, cause: unknown) {
  return new WorkflowWorkClaimCorruption({
    message: `${prefix} ${readCauseMessage(cause, prefix)}`,
  });
}

function toStoreFailure(prefix: string, cause: unknown) {
  return Schema.is(WorkflowWorkClaimCorruption)(cause)
    ? cause
    : toProviderUnavailable(prefix, cause);
}

function buildLabel(runId: string, dedupeKey: string) {
  return `Workflow work claim ${runId}/${dedupeKey}`;
}

function encodeStoredRecordSync(record: WorkflowWorkClaimRecord) {
  const encodedRecord = encodeWorkflowWorkClaimRecordSync(record);
  return {
    encodedRecord,
    recordSha256: workflowWorkClaimRecordSha256(encodedRecord),
    payloadJson: JSON.stringify(encodedRecord),
  };
}

function decodeStoredRecordSync(recordJson: string, label: string) {
  try {
    return decodeWorkflowWorkClaimRecordSync(JSON.parse(recordJson));
  } catch (cause) {
    throw toWorkflowWorkClaimCorruption(`${label} failed to decode from SQLite storage.`, cause);
  }
}

function decodeStoredRowSync(row: unknown, label: string) {
  try {
    return decodeSqliteStoredWorkflowWorkClaimRowSync(row);
  } catch (cause) {
    throw toWorkflowWorkClaimCorruption(
      `${label} row failed to decode through shared contracts.`,
      cause,
    );
  }
}

function decodeClaimRowSync(row: unknown, label: string) {
  const decodedRow = decodeStoredRowSync(row, label);
  const record = decodeStoredRecordSync(decodedRow.payloadJson, label);
  const encodedRecord = encodeWorkflowWorkClaimRecordSync(record);
  const computedSha256 = workflowWorkClaimRecordSha256(encodedRecord);

  if (
    record.key.runId !== decodedRow.runId ||
    record.key.dedupeKey !== decodedRow.dedupeKey ||
    record.claimId !== decodedRow.claimId ||
    record.checkpoint.planId !== decodedRow.planId ||
    record.checkpoint.checkpointId !== decodedRow.checkpointId ||
    record.checkpoint.checkpointSequence !== decodedRow.checkpointSequence ||
    record.checkpoint.stage !== decodedRow.stage ||
    record.checkpoint.stepId !== decodedRow.stepId ||
    record.claimantId !== decodedRow.claimantId ||
    record.status !== decodedRow.status ||
    record.claimedAt !== decodedRow.claimedAt ||
    record.expiresAt !== decodedRow.expiresAt ||
    record.lastHeartbeatAt !== decodedRow.lastHeartbeatAt ||
    record.lastTransitionAt !== decodedRow.lastTransitionAt ||
    (record.completedAt ?? null) !== decodedRow.completedAt ||
    (record.releasedAt ?? null) !== decodedRow.releasedAt ||
    (record.releaseReason ?? null) !== decodedRow.releaseReason ||
    computedSha256 !== decodedRow.recordSha256
  ) {
    throw new WorkflowWorkClaimCorruption({
      message: `${label} failed persisted identity or digest verification.`,
    });
  }

  return record;
}

function prepareSqliteDirectory(config: SqliteWorkflowWorkClaimStoreConfig) {
  if (config.filename === ":memory:") {
    return Effect.void;
  }

  return Effect.tryPromise({
    try: () => mkdir(dirname(config.filename), { recursive: true }),
    catch: (cause) =>
      toProviderUnavailable("Failed to create the SQLite workflow work-claim directory.", cause),
  });
}

function openSqliteDatabase(config: SqliteWorkflowWorkClaimStoreConfig) {
  return Effect.try({
    try: () => {
      const database = new Database(config.filename, { create: true, strict: true });

      database.run(`
        create table if not exists workflow_work_claim_records (
          run_id text not null,
          dedupe_key text not null,
          claim_id text not null,
          plan_id text not null,
          checkpoint_id text not null,
          checkpoint_sequence integer not null,
          stage text not null,
          step_id text not null,
          claimant_id text not null,
          status text not null,
          claimed_at text not null,
          expires_at text not null,
          last_heartbeat_at text not null,
          last_transition_at text not null,
          completed_at text,
          released_at text,
          release_reason text,
          record_sha256 text not null,
          payload_json text not null,
          primary key (run_id, dedupe_key)
        )
      `);
      database.run(`
        create index if not exists idx_workflow_work_claim_records_run_status
        on workflow_work_claim_records (run_id, status, checkpoint_sequence desc, dedupe_key asc)
      `);
      database.run(`
        create index if not exists idx_workflow_work_claim_records_claim_id
        on workflow_work_claim_records (claim_id)
      `);

      return database;
    },
    catch: (cause) =>
      toProviderUnavailable("Failed to open the SQLite workflow work-claim store.", cause),
  });
}

function closeSqliteDatabase(database: Database) {
  return Effect.sync(() => {
    database.close();
  });
}

function isExpired(record: WorkflowWorkClaimRecord, now: Date) {
  return Date.parse(record.expiresAt) <= now.valueOf();
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
  readonly artifactIds: ReadonlyArray<string> | undefined;
  readonly resumeToken: string | undefined;
}) {
  return Schema.decodeUnknownSync(WorkflowWorkClaimRecordSchema)({
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
  });
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

export function SqliteWorkflowWorkClaimStoreLive(
  config: unknown,
  options: SqliteWorkflowWorkClaimStoreOptions = {},
) {
  return Layer.effect(WorkflowWorkClaimStore)(
    Effect.gen(function* () {
      const decodedConfig = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(SqliteWorkflowWorkClaimStoreConfigSchema)(config),
        catch: (cause) =>
          toProviderUnavailable("Invalid SQLite workflow work-claim store configuration.", cause),
      });
      const now = options.now ?? (() => new Date());

      yield* prepareSqliteDirectory(decodedConfig);

      const database = yield* openSqliteDatabase(decodedConfig);
      yield* Effect.addFinalizer(() => closeSqliteDatabase(database));

      const selectClaimRowByKey = database.query<
        SqliteStoredWorkflowWorkClaimRow,
        [string, string]
      >(
        `
          select
            run_id as runId,
            dedupe_key as dedupeKey,
            claim_id as claimId,
            plan_id as planId,
            checkpoint_id as checkpointId,
            checkpoint_sequence as checkpointSequence,
            stage,
            step_id as stepId,
            claimant_id as claimantId,
            status,
            claimed_at as claimedAt,
            expires_at as expiresAt,
            last_heartbeat_at as lastHeartbeatAt,
            last_transition_at as lastTransitionAt,
            completed_at as completedAt,
            released_at as releasedAt,
            release_reason as releaseReason,
            record_sha256 as recordSha256,
            payload_json as payloadJson
          from workflow_work_claim_records
          where run_id = ? and dedupe_key = ?
          limit 1
        `,
      );
      const selectClaimRowsByRunId = database.query<SqliteStoredWorkflowWorkClaimRow, [string]>(`
        select
          run_id as runId,
          dedupe_key as dedupeKey,
          claim_id as claimId,
          plan_id as planId,
          checkpoint_id as checkpointId,
          checkpoint_sequence as checkpointSequence,
          stage,
          step_id as stepId,
          claimant_id as claimantId,
          status,
          claimed_at as claimedAt,
          expires_at as expiresAt,
          last_heartbeat_at as lastHeartbeatAt,
          last_transition_at as lastTransitionAt,
          completed_at as completedAt,
          released_at as releasedAt,
          release_reason as releaseReason,
          record_sha256 as recordSha256,
          payload_json as payloadJson
        from workflow_work_claim_records
        where run_id = ?
        order by dedupe_key asc
      `);
      const putClaimRecord = database.query(`
        insert into workflow_work_claim_records (
          run_id,
          dedupe_key,
          claim_id,
          plan_id,
          checkpoint_id,
          checkpoint_sequence,
          stage,
          step_id,
          claimant_id,
          status,
          claimed_at,
          expires_at,
          last_heartbeat_at,
          last_transition_at,
          completed_at,
          released_at,
          release_reason,
          record_sha256,
          payload_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(run_id, dedupe_key) do update set
          claim_id = excluded.claim_id,
          plan_id = excluded.plan_id,
          checkpoint_id = excluded.checkpoint_id,
          checkpoint_sequence = excluded.checkpoint_sequence,
          stage = excluded.stage,
          step_id = excluded.step_id,
          claimant_id = excluded.claimant_id,
          status = excluded.status,
          claimed_at = excluded.claimed_at,
          expires_at = excluded.expires_at,
          last_heartbeat_at = excluded.last_heartbeat_at,
          last_transition_at = excluded.last_transition_at,
          completed_at = excluded.completed_at,
          released_at = excluded.released_at,
          release_reason = excluded.release_reason,
          record_sha256 = excluded.record_sha256,
          payload_json = excluded.payload_json
      `);

      const persistRecordSync = (record: WorkflowWorkClaimRecord) => {
        const { payloadJson, recordSha256 } = encodeStoredRecordSync(record);

        putClaimRecord.run(
          record.key.runId,
          record.key.dedupeKey,
          record.claimId,
          record.checkpoint.planId,
          record.checkpoint.checkpointId,
          record.checkpoint.checkpointSequence,
          record.checkpoint.stage,
          record.checkpoint.stepId,
          record.claimantId,
          record.status,
          record.claimedAt,
          record.expiresAt,
          record.lastHeartbeatAt,
          record.lastTransitionAt,
          record.completedAt ?? null,
          record.releasedAt ?? null,
          record.releaseReason ?? null,
          recordSha256,
          payloadJson,
        );
      };

      const claimTransaction = database.transaction(
        (request: WorkflowWorkClaimRequest, currentNowIso: string) => {
          const currentNow = new Date(currentNowIso);
          const label = buildLabel(request.key.runId, request.key.dedupeKey);
          const existingRow = selectClaimRowByKey.get(request.key.runId, request.key.dedupeKey);
          const existing =
            existingRow === null || existingRow === undefined
              ? undefined
              : decodeClaimRowSync(existingRow, label);

          if (existing === undefined) {
            const record = buildClaimedRecord(request, currentNow);
            persistRecordSync(record);
            return { decision: "acquired" as const, record };
          }

          if (existing.status === "completed") {
            return { decision: "alreadyCompleted" as const, record: existing };
          }

          if (existing.checkpoint.checkpointSequence > request.checkpoint.checkpointSequence) {
            return { decision: "superseded" as const, record: existing };
          }

          if (existing.claimId === request.claimId && existing.status === "claimed") {
            const refreshed = refreshClaimRecord(existing, request, currentNow);
            persistRecordSync(refreshed);
            return { decision: "acquired" as const, record: refreshed };
          }

          if (existing.status === "claimed" && !isExpired(existing, currentNow)) {
            return { decision: "alreadyClaimed" as const, record: existing };
          }

          const record = buildClaimedRecord(request, currentNow, existing);
          persistRecordSync(record);
          return { decision: "acquired" as const, record };
        },
      );

      const renewTransaction = database.transaction(
        (request: WorkflowWorkClaimRenewalRequest, currentNowIso: string) => {
          const currentNow = new Date(currentNowIso);
          const label = buildLabel(request.key.runId, request.key.dedupeKey);
          const existingRow = selectClaimRowByKey.get(request.key.runId, request.key.dedupeKey);
          const existing =
            existingRow === null || existingRow === undefined
              ? undefined
              : decodeClaimRowSync(existingRow, label);

          if (
            existing === undefined ||
            existing.status !== "claimed" ||
            existing.claimId !== request.claimId ||
            isExpired(existing, currentNow)
          ) {
            return undefined;
          }

          const renewed = renewClaimRecord(existing, request, currentNow);
          persistRecordSync(renewed);
          return renewed;
        },
      );

      const completeTransaction = database.transaction(
        (request: WorkflowWorkClaimCompletionRequest, currentNowIso: string) => {
          const label = buildLabel(request.key.runId, request.key.dedupeKey);
          const existingRow = selectClaimRowByKey.get(request.key.runId, request.key.dedupeKey);
          const existing =
            existingRow === null || existingRow === undefined
              ? undefined
              : decodeClaimRowSync(existingRow, label);

          if (existing === undefined || existing.claimId !== request.claimId) {
            return undefined;
          }

          if (existing.status === "completed") {
            return existing;
          }

          if (existing.status !== "claimed") {
            return undefined;
          }

          const completed = completeClaimRecord(existing, request, new Date(currentNowIso));
          persistRecordSync(completed);
          return completed;
        },
      );

      const releaseTransaction = database.transaction(
        (request: WorkflowWorkClaimReleaseRequest, currentNowIso: string) => {
          const label = buildLabel(request.key.runId, request.key.dedupeKey);
          const existingRow = selectClaimRowByKey.get(request.key.runId, request.key.dedupeKey);
          const existing =
            existingRow === null || existingRow === undefined
              ? undefined
              : decodeClaimRowSync(existingRow, label);

          if (existing === undefined || existing.claimId !== request.claimId) {
            return undefined;
          }

          if (existing.status === "completed" || existing.status === "released") {
            return existing;
          }

          const released = releaseClaimRecord(existing, request, new Date(currentNowIso));
          persistRecordSync(released);
          return released;
        },
      );

      const loadClaimRowByKey = Effect.fn("SqliteWorkflowWorkClaimStore.loadClaimRowByKey")(
        function* (runId: string, dedupeKey: string) {
          return yield* Effect.try({
            try: () => selectClaimRowByKey.get(runId, dedupeKey),
            catch: (cause) =>
              toProviderUnavailable(
                "Failed to read a workflow work-claim from the SQLite store.",
                cause,
              ),
          });
        },
      );
      const loadClaimRowsByRunId = Effect.fn("SqliteWorkflowWorkClaimStore.loadClaimRowsByRunId")(
        function* (runId: string) {
          return yield* Effect.try({
            try: () => selectClaimRowsByRunId.all(runId),
            catch: (cause) =>
              toProviderUnavailable(
                "Failed to list workflow work-claims from the SQLite store.",
                cause,
              ),
          });
        },
      );
      const decodeClaimRow = Effect.fn("SqliteWorkflowWorkClaimStore.decodeClaimRow")(function* (
        row: unknown,
        label: string,
      ) {
        return yield* Effect.try({
          try: () => decodeClaimRowSync(row, label),
          catch: (cause) => toStoreFailure(`${label} failed to decode from SQLite storage.`, cause),
        });
      });
      const loadStoredRecord = Effect.fn("SqliteWorkflowWorkClaimStore.loadStoredRecord")(
        function* (runId: string, dedupeKey: string) {
          const storedRow = yield* loadClaimRowByKey(runId, dedupeKey);
          if (storedRow === null || storedRow === undefined) {
            return Option.none();
          }

          return Option.some(yield* decodeClaimRow(storedRow, buildLabel(runId, dedupeKey)));
        },
      );
      const reloadedDecisionRecord = Effect.fn(
        "SqliteWorkflowWorkClaimStore.reloadedDecisionRecord",
      )(function* (decision: WorkflowWorkClaimDecision, record: WorkflowWorkClaimRecord) {
        const reloaded = yield* loadStoredRecord(record.key.runId, record.key.dedupeKey).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new ProviderUnavailable({
                    message: `${buildLabel(record.key.runId, record.key.dedupeKey)} was not readable after SQLite persistence.`,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );

        return Schema.decodeUnknownSync(WorkflowWorkClaimDecisionRecord)({
          decision,
          record: reloaded,
        });
      });

      return WorkflowWorkClaimStore.of({
        claim: (input) =>
          Effect.gen(function* () {
            const request = yield* Effect.try({
              try: () => decodeWorkflowWorkClaimRequestSync(input),
              catch: (cause) =>
                toWorkflowWorkClaimCorruption(
                  "Failed to decode workflow work-claim request through shared contracts.",
                  cause,
                ),
            });
            const currentNowIso = now().toISOString();
            const result = yield* Effect.try({
              try: () => claimTransaction(request, currentNowIso),
              catch: (cause) =>
                toStoreFailure("Failed to claim workflow work in the SQLite store.", cause),
            });

            return result.decision === "acquired"
              ? yield* reloadedDecisionRecord(result.decision, result.record)
              : Schema.decodeUnknownSync(WorkflowWorkClaimDecisionRecord)({
                  decision: result.decision,
                  record: result.record,
                });
          }),
        renew: (input) =>
          Effect.gen(function* () {
            const request = yield* Effect.try({
              try: () => decodeWorkflowWorkClaimRenewalRequestSync(input),
              catch: (cause) =>
                toWorkflowWorkClaimCorruption(
                  "Failed to decode workflow work-claim renewal request through shared contracts.",
                  cause,
                ),
            });
            const renewed = yield* Effect.try({
              try: () => renewTransaction(request, now().toISOString()),
              catch: (cause) =>
                toStoreFailure("Failed to renew a workflow work-claim in the SQLite store.", cause),
            });

            if (renewed === undefined) {
              return Option.none();
            }

            return yield* loadStoredRecord(request.key.runId, request.key.dedupeKey);
          }),
        complete: (input) =>
          Effect.gen(function* () {
            const request = yield* Effect.try({
              try: () => decodeWorkflowWorkClaimCompletionRequestSync(input),
              catch: (cause) =>
                toWorkflowWorkClaimCorruption(
                  "Failed to decode workflow work-claim completion request through shared contracts.",
                  cause,
                ),
            });
            const completed = yield* Effect.try({
              try: () => completeTransaction(request, now().toISOString()),
              catch: (cause) =>
                toStoreFailure(
                  "Failed to complete a workflow work-claim in the SQLite store.",
                  cause,
                ),
            });

            if (completed === undefined) {
              return Option.none();
            }

            return yield* loadStoredRecord(request.key.runId, request.key.dedupeKey);
          }),
        release: (input) =>
          Effect.gen(function* () {
            const request = yield* Effect.try({
              try: () => decodeWorkflowWorkClaimReleaseRequestSync(input),
              catch: (cause) =>
                toWorkflowWorkClaimCorruption(
                  "Failed to decode workflow work-claim release request through shared contracts.",
                  cause,
                ),
            });
            const released = yield* Effect.try({
              try: () => releaseTransaction(request, now().toISOString()),
              catch: (cause) =>
                toStoreFailure(
                  "Failed to release a workflow work-claim in the SQLite store.",
                  cause,
                ),
            });

            if (released === undefined) {
              return Option.none();
            }

            return yield* loadStoredRecord(request.key.runId, request.key.dedupeKey);
          }),
        get: (input) =>
          Effect.gen(function* () {
            const key = yield* Effect.try({
              try: () => decodeWorkflowWorkClaimKeySync(input),
              catch: (cause) =>
                toWorkflowWorkClaimCorruption(
                  "Failed to decode a workflow work-claim key through shared contracts.",
                  cause,
                ),
            });

            return yield* loadStoredRecord(key.runId, key.dedupeKey);
          }),
        listByRun: (input) =>
          Effect.gen(function* () {
            const runId = yield* Effect.try({
              try: () => decodeCanonicalIdentifierSync(input),
              catch: (cause) =>
                toWorkflowWorkClaimCorruption(
                  "Failed to decode a workflow run identifier through shared contracts.",
                  cause,
                ),
            });
            const rows = yield* loadClaimRowsByRunId(runId);
            const records = new Array<WorkflowWorkClaimRecord>();

            for (const row of rows) {
              records.push(yield* decodeClaimRow(row, buildLabel(runId, row.dedupeKey)));
            }

            return records;
          }),
      });
    }),
  );
}
