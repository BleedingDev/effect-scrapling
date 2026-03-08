# E5 Checkpoint Persistence And Restore Runbook

## Purpose

Use this runbook when operators or SDK consumers need to validate the current
SQLite-backed checkpoint persistence surface, confirm deterministic restore
behavior, and decide whether a workflow persistence change is safe to keep.

This runbook is intentionally limited to behavior that exists today in:

- `libs/foundation/core/src/sqlite-run-checkpoint-store.ts`
- `tests/libs/foundation-core-sqlite-run-checkpoint-store.test.ts`
- `tests/libs/foundation-core-durable-workflow-runtime.test.ts`
- `package.json` E5 checkpoint and crash-resume scripts

Important scope limits from the real implementation:

- the SQLite store validates persisted checkpoint identity and checksum on read
- `latest(runId)` rejects a corrupted latest row even if an older row remains
  readable
- restore semantics are exercised through the durable workflow runtime and the
  E5 crash-resume harness
- the current repository surface is library-first; there is no dedicated API or
  CLI wrapper for checkpoint restore today

## Current Command Surface

The repository currently exposes these commands for this area:

```bash
bun run check:e5-checkpoint-persistence-restore
bun run check:e5-crash-resume-harness
bun test tests/libs/foundation-core-sqlite-run-checkpoint-store.test.ts
bun test tests/libs/foundation-core-durable-workflow-runtime.test.ts
```

`check:e5-checkpoint-persistence-restore` currently expands to:

```bash
bun test tests/libs/foundation-core-sqlite-run-checkpoint-store.test.ts \
  tests/libs/foundation-core-durable-workflow-runtime.test.ts
```

`check:e5-crash-resume-harness` currently expands to:

```bash
bun run benchmark:e5-crash-resume-harness
```

## What The Current Coverage Proves

The focused checkpoint suites currently prove:

- checkpoint rows persist across reopened SQLite handles
- durable workflows resume from the latest persisted checkpoint after a runtime
  rebuild when that checkpoint still decodes through the shared contracts
- `latest(runId)` fails deterministically when every persisted row is corrupted
- `latest(runId)` also fails deterministically when the newest persisted row is
  corrupted, even if an older row still decodes
- crash-resume harness output matches the no-crash baseline across forced
  restart boundaries, including structured budget-event and work-claim parity
  evidence in the emitted artifact

## Practical Execution

Run the focused persistence suites first:

```bash
bun run check:e5-checkpoint-persistence-restore
```

Run the restore benchmark when you need end-to-end restart evidence:

```bash
bun run check:e5-crash-resume-harness
```

Run a local persisted crash-resume spot-check:

```bash
bun run scripts/benchmarks/e5-crash-resume-harness.ts \
  --artifact tmp/e5-crash-resume-harness-scorecard.json \
  --targets 2 \
  --observations-per-target 5 \
  --crash-after-sequence 1 \
  --crash-after-sequence 2
```

## Troubleshooting

### Restore fails with `CheckpointCorruption`

The latest persisted row no longer decodes through the shared checkpoint
contracts, or its stored checksum drifted from the decoded payload. Preserve the
failing row for analysis and roll back the candidate persistence change.

### Restore unexpectedly returns `none`

The requested run id does not exist in the current SQLite file. Verify the
runtime is pointed at the expected checkpoint database before debugging the
workflow graph.

### Restore now fails because the latest checkpoint is corrupted

That is the current contract, not an operator-only anomaly. Preserve the
failing row, keep the failing artifact unchanged, and fix or roll back the
candidate persistence change instead of forcing a fallback to an older row.

### Crash-resume output drifts from the baseline

Treat that as a workflow restore regression, not as an operator-only issue. Keep
the failing artifact unchanged, rerun `check:e5-checkpoint-persistence-restore`,
and only continue after the persistence/runtime diff is understood.

### Crash-resume output matches but budget or work-claim evidence drifts

Treat that as a restart-path regression anyway. The current artifact encodes
`baselineBudgetEvents`, `recoveredBudgetEvents`, `baselineWorkClaims`, and
`recoveredWorkClaims`, so drift there means the restore path no longer matches
steady-state orchestration behavior.

## Rollout And Rollback

Use this sequence before promoting a checkpoint persistence change:

1. Run `bun run check:e5-checkpoint-persistence-restore`.
2. Run `bun run check:e5-crash-resume-harness`.
3. Keep the emitted crash-resume artifact with the candidate diff for review.
4. Run the full repository gates before bead closure or release.

Rollback guidance:

- if checksum verification can be bypassed, roll back immediately
- if restore starts silently skipping a corrupted latest row without an
  intentional contract change and review, roll back immediately
- if corruption handling mutates or deletes the failing row instead of surfacing
  the fault, roll back and preserve the evidence
