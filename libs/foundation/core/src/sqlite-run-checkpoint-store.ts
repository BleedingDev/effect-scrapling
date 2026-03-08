import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Layer, Option, Schema } from "effect";
import {
  CheckpointRecordSchema,
  RunCheckpointStore,
  checkpointPayloadSha256,
} from "./config-storage.ts";
import { RunCheckpointSchema } from "./run-state.ts";
import { CheckpointCorruption, ProviderUnavailable } from "./tagged-errors.ts";

const SqliteRunCheckpointStoreConfigSchema = Schema.Struct({
  filename: Schema.Trim.check(Schema.isNonEmpty()),
});

const SqliteStoredCheckpointRowSchema = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  planId: Schema.String,
  checkpointSequence: Schema.Int,
  checkpointSha256: Schema.String,
  storedAt: Schema.String,
  payloadJson: Schema.String,
});

type SqliteRunCheckpointStoreConfig = Schema.Schema.Type<
  typeof SqliteRunCheckpointStoreConfigSchema
>;
type SqliteStoredCheckpointRow = Schema.Schema.Type<typeof SqliteStoredCheckpointRowSchema>;

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

function toCheckpointCorruption(prefix: string, cause: unknown) {
  return new CheckpointCorruption({
    message: `${prefix} ${readCauseMessage(cause, prefix)}`,
  });
}

function decodeStoredCheckpoint(recordJson: string, label: string) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(CheckpointRecordSchema)(JSON.parse(recordJson)),
    catch: (cause) =>
      toCheckpointCorruption(`${label} failed to decode from SQLite storage.`, cause),
  });
}

function decodeStoredCheckpointRow(row: unknown, label: string) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(SqliteStoredCheckpointRowSchema)(row),
    catch: (cause) =>
      toCheckpointCorruption(`${label} row failed to decode through shared contracts.`, cause),
  });
}

function embeddedCheckpointMatchesRecord(
  record: Schema.Schema.Type<typeof CheckpointRecordSchema>,
) {
  return (
    record.checkpoint.id === record.id &&
    record.checkpoint.runId === record.runId &&
    record.checkpoint.planId === record.planId
  );
}

function validateResumeTokenJson(
  checkpoint: Schema.Schema.Type<typeof RunCheckpointSchema>,
  label: string,
) {
  const resumeToken = checkpoint.resumeToken;
  if (resumeToken === undefined) {
    return Effect.void;
  }

  return Effect.try({
    try: () => {
      JSON.parse(resumeToken);
    },
    catch: (cause) =>
      toCheckpointCorruption(
        `${label} contains an invalid durable workflow resume token payload.`,
        cause,
      ),
  });
}

function prepareSqliteDirectory(config: SqliteRunCheckpointStoreConfig) {
  if (config.filename === ":memory:") {
    return Effect.void;
  }

  return Effect.tryPromise({
    try: () => mkdir(dirname(config.filename), { recursive: true }),
    catch: (cause) =>
      toProviderUnavailable("Failed to create the SQLite checkpoint directory.", cause),
  });
}

function openSqliteDatabase(config: SqliteRunCheckpointStoreConfig) {
  return Effect.try({
    try: () => {
      const database = new Database(config.filename, { create: true, strict: true });

      database.run(`
        create table if not exists workflow_checkpoint_records (
          id text primary key,
          run_id text not null,
          plan_id text not null,
          checkpoint_sequence integer not null,
          checkpoint_sha256 text not null,
          stored_at text not null,
          payload_json text not null
        )
      `);
      database.run(`
        create index if not exists idx_workflow_checkpoint_records_run_restore
        on workflow_checkpoint_records (run_id, checkpoint_sequence desc, stored_at desc, id desc)
      `);

      return database;
    },
    catch: (cause) => toProviderUnavailable("Failed to open the SQLite checkpoint store.", cause),
  });
}

function closeSqliteDatabase(database: Database) {
  return Effect.sync(() => {
    database.close();
  });
}

export function SqliteRunCheckpointStoreLive(config: unknown) {
  return Layer.effect(RunCheckpointStore)(
    Effect.gen(function* () {
      const decodedConfig = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(SqliteRunCheckpointStoreConfigSchema)(config),
        catch: (cause) =>
          toProviderUnavailable("Invalid SQLite checkpoint store configuration.", cause),
      });

      yield* prepareSqliteDirectory(decodedConfig);

      const database = yield* openSqliteDatabase(decodedConfig);
      yield* Effect.addFinalizer(() => closeSqliteDatabase(database));

      const selectCheckpointRowById = database.query<SqliteStoredCheckpointRow, [string]>(`
        select
          id,
          run_id as runId,
          plan_id as planId,
          checkpoint_sequence as checkpointSequence,
          checkpoint_sha256 as checkpointSha256,
          stored_at as storedAt,
          payload_json as payloadJson
        from workflow_checkpoint_records
        where id = ?
        limit 1
      `);
      const selectCheckpointRowsByRunId = database.query<SqliteStoredCheckpointRow, [string]>(`
        select
          id,
          run_id as runId,
          plan_id as planId,
          checkpoint_sequence as checkpointSequence,
          checkpoint_sha256 as checkpointSha256,
          stored_at as storedAt,
          payload_json as payloadJson
        from workflow_checkpoint_records
        where run_id = ?
        order by checkpoint_sequence desc, stored_at desc, id desc
      `);
      const putCheckpointRecord = database.query(`
        insert into workflow_checkpoint_records (
          id,
          run_id,
          plan_id,
          checkpoint_sequence,
          checkpoint_sha256,
          stored_at,
          payload_json
        ) values (?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          run_id = excluded.run_id,
          plan_id = excluded.plan_id,
          checkpoint_sequence = excluded.checkpoint_sequence,
          checkpoint_sha256 = excluded.checkpoint_sha256,
          stored_at = excluded.stored_at,
          payload_json = excluded.payload_json
      `);

      const loadCheckpointRowById = Effect.fn("SqliteRunCheckpointStore.loadCheckpointRowById")(
        function* (checkpointId: string) {
          return yield* Effect.try({
            try: () => selectCheckpointRowById.get(checkpointId),
            catch: (cause) =>
              toProviderUnavailable("Failed to read a checkpoint from the SQLite store.", cause),
          });
        },
      );
      const loadCheckpointRowsByRunId = Effect.fn(
        "SqliteRunCheckpointStore.loadCheckpointRowsByRunId",
      )(function* (runId: string) {
        return yield* Effect.try({
          try: () => selectCheckpointRowsByRunId.all(runId),
          catch: (cause) =>
            toProviderUnavailable(
              "Failed to read workflow checkpoints from the SQLite store.",
              cause,
            ),
        });
      });
      const decodeCheckpointRow = Effect.fn("SqliteRunCheckpointStore.decodeCheckpointRow")(
        function* (row: unknown, label: string) {
          const decodedRow = yield* decodeStoredCheckpointRow(row, label);
          const record = yield* decodeStoredCheckpoint(decodedRow.payloadJson, label);
          yield* validateResumeTokenJson(record.checkpoint, label);
          const computedCheckpointSha256 = checkpointPayloadSha256(
            Schema.encodeSync(RunCheckpointSchema)(record.checkpoint),
          );

          if (
            !embeddedCheckpointMatchesRecord(record) ||
            record.id !== decodedRow.id ||
            record.runId !== decodedRow.runId ||
            record.planId !== decodedRow.planId ||
            record.checkpoint.sequence !== decodedRow.checkpointSequence ||
            record.sha256 !== computedCheckpointSha256 ||
            record.sha256 !== decodedRow.checkpointSha256 ||
            record.storedAt !== decodedRow.storedAt
          ) {
            return yield* Effect.fail(
              new CheckpointCorruption({
                message: `${label} failed persisted identity or digest verification.`,
              }),
            );
          }

          return record;
        },
      );

      return RunCheckpointStore.of({
        getById: (checkpointId) =>
          Effect.gen(function* () {
            const row = yield* loadCheckpointRowById(checkpointId);
            if (row === null || row === undefined) {
              return Option.none();
            }

            return Option.some(yield* decodeCheckpointRow(row, `Checkpoint ${checkpointId}`));
          }),
        latest: (runId) =>
          Effect.gen(function* () {
            const rows = yield* loadCheckpointRowsByRunId(runId);
            let latestCorruption: CheckpointCorruption | undefined;

            for (const row of rows) {
              const decoded = yield* decodeCheckpointRow(
                row,
                `Checkpoint candidate for ${runId}`,
              ).pipe(
                Effect.map(Option.some),
                Effect.catchTag("CheckpointCorruption", (error) => {
                  latestCorruption = error;
                  return Effect.succeed(Option.none());
                }),
              );

              if (Option.isSome(decoded)) {
                if (latestCorruption !== undefined) {
                  return yield* Effect.fail(
                    new CheckpointCorruption({
                      message: `Failed to restore the latest durable workflow checkpoint for run ${runId}. ${latestCorruption.message}`,
                    }),
                  );
                }

                return decoded;
              }
            }

            if (latestCorruption !== undefined) {
              return yield* Effect.fail(
                new CheckpointCorruption({
                  message: `Failed to restore a valid durable workflow checkpoint for run ${runId}. ${latestCorruption.message}`,
                }),
              );
            }

            return Option.none();
          }),
        put: (record) =>
          Effect.gen(function* () {
            const encodedCanonicalRecord = yield* Effect.try({
              try: () => {
                const serializedRecord = JSON.stringify({
                  ...Schema.encodeSync(CheckpointRecordSchema)(record),
                  sha256: "0".repeat(64),
                });
                const parsedRecord = JSON.parse(serializedRecord);
                const normalizedRecord =
                  Schema.decodeUnknownSync(CheckpointRecordSchema)(parsedRecord);
                const encodedNormalizedRecord =
                  Schema.encodeSync(CheckpointRecordSchema)(normalizedRecord);
                const parsedNormalizedRecord = JSON.parse(JSON.stringify(encodedNormalizedRecord));
                return {
                  ...parsedNormalizedRecord,
                  sha256: checkpointPayloadSha256(parsedNormalizedRecord.checkpoint),
                };
              },
              catch: (cause) =>
                toCheckpointCorruption(
                  `Checkpoint ${record.id} failed SQLite canonicalization.`,
                  cause,
                ),
            });

            const canonicalRecord = yield* Effect.try({
              try: () => Schema.decodeUnknownSync(CheckpointRecordSchema)(encodedCanonicalRecord),
              catch: (cause) =>
                toCheckpointCorruption(
                  `Checkpoint ${record.id} failed SQLite record finalization.`,
                  cause,
                ),
            });

            const encodedRecord = yield* Effect.try({
              try: () => JSON.stringify(encodedCanonicalRecord),
              catch: (cause) =>
                toCheckpointCorruption(
                  `Checkpoint ${record.id} failed to encode for SQLite persistence.`,
                  cause,
                ),
            });

            const existingRow = yield* loadCheckpointRowById(canonicalRecord.id);
            if (existingRow !== null && existingRow !== undefined) {
              const existingRecord = yield* decodeCheckpointRow(
                existingRow,
                `Checkpoint ${canonicalRecord.id}`,
              ).pipe(
                Effect.map(Option.some),
                Effect.catchTag("CheckpointCorruption", () => Effect.succeed(Option.none())),
              );

              if (Option.isSome(existingRecord)) {
                const existingCheckpointSha256 = checkpointPayloadSha256(
                  Schema.encodeSync(RunCheckpointSchema)(existingRecord.value.checkpoint),
                );
                const incomingCheckpointSha256 = checkpointPayloadSha256(
                  Schema.encodeSync(RunCheckpointSchema)(canonicalRecord.checkpoint),
                );

                if (existingCheckpointSha256 !== incomingCheckpointSha256) {
                  return yield* Effect.fail(
                    new CheckpointCorruption({
                      message: `Checkpoint ${canonicalRecord.id} already exists in SQLite storage with a different checksum.`,
                    }),
                  );
                }

                return existingRecord.value;
              }
            }

            yield* Effect.try({
              try: () =>
                putCheckpointRecord.run(
                  canonicalRecord.id,
                  canonicalRecord.runId,
                  canonicalRecord.planId,
                  canonicalRecord.checkpoint.sequence,
                  canonicalRecord.sha256,
                  canonicalRecord.storedAt,
                  encodedRecord,
                ),
              catch: (cause) =>
                toProviderUnavailable("Failed to persist a checkpoint to the SQLite store.", cause),
            });

            const storedRow = yield* loadCheckpointRowById(canonicalRecord.id);
            if (storedRow === null || storedRow === undefined) {
              return yield* Effect.fail(
                new ProviderUnavailable({
                  message: `Checkpoint ${canonicalRecord.id} was not readable after SQLite persistence.`,
                }),
              );
            }

            const storedRecord = yield* decodeCheckpointRow(
              storedRow,
              `Checkpoint ${canonicalRecord.id}`,
            );
            if (storedRecord.sha256 !== canonicalRecord.sha256) {
              return yield* Effect.fail(
                new CheckpointCorruption({
                  message: `Checkpoint ${canonicalRecord.id} already exists in SQLite storage with a different checksum.`,
                }),
              );
            }

            return storedRecord;
          }),
      });
    }),
  );
}
