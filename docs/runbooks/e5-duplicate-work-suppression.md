# E5 Duplicate Work Suppression Runbook

## Purpose

Use this runbook when operators or SDK consumers need to validate the current
E5 duplicate-work suppression path, confirm that concurrent runners do not
silently duplicate the same workflow step, and understand how the runtime
behaves when a work claim is lost or superseded.

This runbook is intentionally limited to behavior that exists today in:

- `libs/foundation/core/src/workflow-work-claim-store.ts`
- `libs/foundation/core/src/sqlite-workflow-work-claim-store.ts`
- `libs/foundation/core/src/durable-workflow-runtime.ts`
- `tests/libs/foundation-core-workflow-work-claim-store.test.ts`
- `tests/libs/foundation-core-durable-workflow-runtime.test.ts`

Important scope limits from the real implementation:

- duplicate suppression is library-first through `WorkflowWorkClaimStore` and
  `WorkflowRunner`; there is no dedicated CLI or API control surface today
- claims are keyed per `runId + dedupeKey` and are intentionally runner-instance
  aware
- losing a claim before completion fails the current attempt and does not write
  a poisoned failure checkpoint
- completed or newer claims suppress older duplicate attempts deterministically

## Current Command Surface

The repository currently exposes these commands for this area:

```bash
bun run check:e5-duplicate-work-suppression
bun test tests/libs/foundation-core-workflow-work-claim-store.test.ts
bun test tests/libs/foundation-core-durable-workflow-runtime.test.ts
```

`check:e5-duplicate-work-suppression` currently expands to:

```bash
bun test tests/libs/foundation-core-workflow-work-claim-store.test.ts \
  tests/libs/foundation-core-durable-workflow-runtime.test.ts
```

## What The Current Coverage Proves

The focused suites currently prove:

- SQLite-backed work claims persist across reopened store handles
- completed claims suppress later duplicate attempts with
  `decision: "alreadyCompleted"`
- expired claims can be taken over by a newer checkpoint while older
  checkpoint attempts become `superseded`
- tampered persisted claim rows fail with typed corruption instead of being
  accepted silently
- a concurrent runner is rejected while another runner still holds the step
  claim
- losing a claim before completion fails the attempt and preserves checkpoint
  history instead of writing a false failure checkpoint
- the crash-resume harness emits stable `baselineWorkClaims` and
  `recoveredWorkClaims` summaries, so restart-boundary regressions show up in a
  first-class artifact instead of relying on log inspection

## Practical Execution

Run the focused duplicate-suppression suite:

```bash
bun run check:e5-duplicate-work-suppression
```

Run only the claim-store suite when you need to isolate persistence behavior:

```bash
bun test tests/libs/foundation-core-workflow-work-claim-store.test.ts
```

Run only the durable-runtime suite when you need the end-to-end runner evidence:

```bash
bun test tests/libs/foundation-core-durable-workflow-runtime.test.ts
```

Run the deterministic restart harness when you need persisted duplicate-work
evidence across forced runtime rebuilds:

```bash
bun run check:e5-crash-resume-harness
```

## Troubleshooting

### A concurrent runner starts doing the same step anyway

Treat that as a hard regression. The current contract requires the second runner
to fail with a duplicate-claim style error, not to race the first runner.

### A stale runner loses its claim but still writes a failed checkpoint

That is also a regression. Preserve the failing checkpoint history unchanged and
roll back the candidate runtime change before widening any policy.

### A completed claim no longer suppresses a later duplicate

Treat that as a state-store or claim-resolution bug. Re-run the focused suites
and inspect the persisted claim record before touching the dedupe key contract.

### Crash-resume evidence shows `baselineWorkClaims` drifting from `recoveredWorkClaims`

Treat that as a restart-boundary dedupe regression. Preserve the emitted crash-
resume artifact and inspect claim counts, takeover counts, and decision
distribution before changing the checkpoint or work-claim contracts.

## Rollout And Rollback

Use this sequence before promoting a duplicate-suppression change:

1. Run `bun run check:e5-duplicate-work-suppression`.
2. Confirm the runtime still rejects concurrent duplicates and stale completions.
3. Run the full repository gates before bead closure or release.

Rollback guidance:

- if concurrent duplicates are allowed to proceed, roll back immediately
- if lost claims start poisoning checkpoint history, roll back immediately
- if persisted claim corruption stops surfacing as an error, roll back and
  preserve the failing row for analysis
