import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Option, Schema } from "effect";
import { SqliteWorkflowWorkClaimStoreLive } from "../../libs/foundation/core/src/sqlite-workflow-work-claim-store.ts";
import {
  WorkflowWorkClaimCheckpointSchema,
  WorkflowWorkClaimStore,
} from "../../libs/foundation/core/src/workflow-work-claim-store.ts";

const CLAIMED_AT = "2026-03-08T05:30:00.000Z";
const EXPIRED_AT = "2026-03-08T05:30:01.000Z";
const RESUMED_AT = "2026-03-08T05:30:02.000Z";

function makeCheckpoint(sequence: number, checkpointId: string) {
  return Schema.decodeUnknownSync(WorkflowWorkClaimCheckpointSchema)({
    planId: "plan-work-claim-001",
    checkpointId,
    checkpointSequence: sequence,
    stage: "capture",
    stepId: "step-capture-001",
  });
}

function makeClaimInput(input?: {
  readonly checkpointSequence?: number;
  readonly checkpointId?: string;
  readonly claimId?: string;
  readonly claimantId?: string;
  readonly dedupeKey?: string;
  readonly ttlMs?: number;
}) {
  const checkpointSequence = input?.checkpointSequence ?? 1;

  return {
    key: {
      runId: "run-work-claim-001",
      dedupeKey: input?.dedupeKey ?? "capture/page-001",
    },
    checkpoint: makeCheckpoint(
      checkpointSequence,
      input?.checkpointId ?? `checkpoint-${checkpointSequence.toString().padStart(4, "0")}`,
    ),
    claimId: input?.claimId ?? `claim-${checkpointSequence.toString().padStart(4, "0")}`,
    claimantId: input?.claimantId ?? "worker-a",
    ttlMs: input?.ttlMs ?? 1_000,
  } as const;
}

describe("foundation-core workflow work-claim store", () => {
  it.effect(
    "persists claims across reopened SQLite handles and suppresses completed duplicates",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "work-claim-sqlite-")),
        );
        const filename = join(directory, "workflow-work-claims.sqlite");
        const initialClaim = makeClaimInput({
          checkpointId: "checkpoint-0001",
          claimId: "claim-0001",
          ttlMs: 5_000,
        });

        try {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const store = yield* WorkflowWorkClaimStore;
              const claimed = yield* store.claim(initialClaim);

              expect(claimed.decision).toBe("acquired");

              const completed = yield* store
                .complete({
                  key: initialClaim.key,
                  claimId: initialClaim.claimId,
                  artifactIds: ["artifact-target-001"],
                  resumeToken: JSON.stringify({
                    runId: initialClaim.key.runId,
                    completedStepIds: ["step-capture-001"],
                  }),
                })
                .pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new Error("Expected the claim to complete.")),
                      onSome: Effect.succeed,
                    }),
                  ),
                );

              expect(completed.status).toBe("completed");
              expect(completed.artifactIds).toEqual(["artifact-target-001"]);
            }).pipe(
              Effect.provide(
                SqliteWorkflowWorkClaimStoreLive({ filename }, { now: () => new Date(CLAIMED_AT) }),
              ),
            ),
          );

          const persisted = yield* Effect.scoped(
            Effect.gen(function* () {
              const store = yield* WorkflowWorkClaimStore;
              const stored = yield* store.get(initialClaim.key).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new Error("Expected the stored claim to exist.")),
                    onSome: Effect.succeed,
                  }),
                ),
              );
              const duplicate = yield* store.claim(
                makeClaimInput({
                  checkpointSequence: 2,
                  checkpointId: "checkpoint-0002",
                  claimId: "claim-0002",
                }),
              );

              return { duplicate, stored };
            }).pipe(
              Effect.provide(
                SqliteWorkflowWorkClaimStoreLive({ filename }, { now: () => new Date(RESUMED_AT) }),
              ),
            ),
          );

          expect(persisted.stored.status).toBe("completed");
          expect(persisted.stored.artifactIds).toEqual(["artifact-target-001"]);
          expect(persisted.stored.resumeToken).toBe(
            JSON.stringify({
              runId: initialClaim.key.runId,
              completedStepIds: ["step-capture-001"],
            }),
          );
          expect(persisted.duplicate.decision).toBe("alreadyCompleted");
          expect(persisted.duplicate.record.claimId).toBe(initialClaim.claimId);
          expect(persisted.duplicate.record.resumeToken).toBe(
            JSON.stringify({
              runId: initialClaim.key.runId,
              completedStepIds: ["step-capture-001"],
            }),
          );
        } finally {
          yield* Effect.promise(() => rm(directory, { force: true, recursive: true }));
        }
      }),
  );

  it.effect("allows expired claims to be taken over while suppressing older checkpoints", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "work-claim-expire-")));
      const filename = join(directory, "workflow-work-claims.sqlite");
      const firstClaim = makeClaimInput({
        checkpointSequence: 1,
        checkpointId: "checkpoint-0001",
        claimId: "claim-0001",
        claimantId: "worker-a",
        ttlMs: 100,
      });

      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* WorkflowWorkClaimStore;
            const claimed = yield* store.claim(firstClaim);

            expect(claimed.decision).toBe("acquired");
            expect(claimed.record.takeoverCount).toBe(0);
          }).pipe(
            Effect.provide(
              SqliteWorkflowWorkClaimStoreLive({ filename }, { now: () => new Date(CLAIMED_AT) }),
            ),
          ),
        );

        const resumed = yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* WorkflowWorkClaimStore;
            const takeover = yield* store.claim(
              makeClaimInput({
                checkpointSequence: 2,
                checkpointId: "checkpoint-0002",
                claimId: "claim-0002",
                claimantId: "worker-b",
                ttlMs: 1_000,
              }),
            );
            const stale = yield* store.claim(
              makeClaimInput({
                checkpointSequence: 1,
                checkpointId: "checkpoint-0001",
                claimId: "claim-0003",
                claimantId: "worker-c",
                ttlMs: 1_000,
              }),
            );
            const listed = yield* store.listByRun(firstClaim.key.runId);

            return { listed, stale, takeover };
          }).pipe(
            Effect.provide(
              SqliteWorkflowWorkClaimStoreLive({ filename }, { now: () => new Date(EXPIRED_AT) }),
            ),
          ),
        );

        expect(resumed.takeover.decision).toBe("acquired");
        expect(resumed.takeover.record.claimId).toBe("claim-0002");
        expect(resumed.takeover.record.checkpoint.checkpointSequence).toBe(2);
        expect(resumed.takeover.record.takeoverCount).toBe(1);
        expect(resumed.stale.decision).toBe("superseded");
        expect(resumed.stale.record.claimId).toBe("claim-0002");
        expect(resumed.listed).toHaveLength(1);
        expect(resumed.listed[0]?.claimId).toBe("claim-0002");
      } finally {
        yield* Effect.promise(() => rm(directory, { force: true, recursive: true }));
      }
    }),
  );

  it.effect("fails with corruption when persisted workflow work-claim rows are tampered with", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "work-claim-corrupt-")));
      const filename = join(directory, "workflow-work-claims.sqlite");
      const firstClaim = makeClaimInput({
        checkpointId: "checkpoint-0001",
        claimId: "claim-0001",
      });

      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* WorkflowWorkClaimStore;
            yield* store.claim(firstClaim);
          }).pipe(
            Effect.provide(
              SqliteWorkflowWorkClaimStoreLive({ filename }, { now: () => new Date(CLAIMED_AT) }),
            ),
          ),
        );

        const database = new Database(filename, { readonly: false, strict: true });
        try {
          database
            .query(
              "update workflow_work_claim_records set record_sha256 = ? where run_id = ? and dedupe_key = ?",
            )
            .run(
              "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
              firstClaim.key.runId,
              firstClaim.key.dedupeKey,
            );
        } finally {
          database.close();
        }

        const failure = yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* WorkflowWorkClaimStore;
            return yield* Effect.flip(store.get(firstClaim.key));
          }).pipe(
            Effect.provide(
              SqliteWorkflowWorkClaimStoreLive({ filename }, { now: () => new Date(RESUMED_AT) }),
            ),
          ),
        );

        expect(failure.message).toContain("failed persisted identity or digest verification");
      } finally {
        yield* Effect.promise(() => rm(directory, { force: true, recursive: true }));
      }
    }),
  );
});
