# E5 Workflow Operational Controls Runbook

## Purpose

Use this runbook when operators or SDK consumers need the full E5 workflow
control surface for inspection, pause/cancel decisions, replay, or controlled
retry.

This runbook covers the current library-level surface in:

- `libs/foundation/core/src/service-topology.ts`
- `libs/foundation/core/src/durable-workflow-runtime.ts`
- `tests/libs/foundation-core-durable-workflow-runtime.test.ts`

There is no dedicated CLI or API wrapper for these operations today.

## Current Contract Surface

The shipped control surface is the `WorkflowRunner` service:

```ts
const workflowRunner = yield* WorkflowRunner

const inspection = yield* workflowRunner.inspect("run-001")
const cancelled = yield* workflowRunner.cancelRun("run-001")
const deferred = yield* workflowRunner.deferRun("run-001")
const resumed = yield* workflowRunner.resumeRun("run-001")
const replayed = yield* workflowRunner.replayRun("run-001")
const retried = yield* workflowRunner.retryRun("run-001")
```

Common return contracts:

- `inspect(runId)` returns `Option.none()` when the run does not exist
- control operations return `Option.none()` when the run does not exist
- successful control operations return `Option.some(WorkflowControlResult)`
- malformed durable state fails through typed schema corruption or policy errors
- `cancelRun(runId)`, `replayRun(runId)`, and `resumeRun(runId)` fail closed
  when the latest checkpoint is missing `resumeToken` or its token no longer
  decodes through shared contracts

`WorkflowControlResult` carries:

- `operation`
- `requestedRunId`
- `resolvedRunId`
- `sourceCheckpointId`
- `checkpoint`

## Live Runtime Semantics

- `inspect(runId)` returns a typed inspection snapshot with progress, budget,
  control audit metadata, and persisted failure envelopes
- `cancelRun(runId)` terminalizes pending work as `cancelled`
- repeated `cancelRun(runId)` returns an auditable cancelled checkpoint instead
  of appending extra control checkpoints
- `deferRun(runId)` persists a running checkpoint with `control.operation =
  "defer"` and does not advance work
- repeated `deferRun(runId)` is idempotent while the latest checkpoint is
  already deferred and running
- `resumeRun(runId)` continues the latest running or deferred checkpoint
- `resumeRun(runId)` rejects failed checkpoints; failed runs require
  `retryRun(runId)`
- `retryRun(runId)` only succeeds for failed checkpoints with a retryable
  failure envelope
- `replayRun(runId)` starts a fresh run lineage from the latest persisted
  checkpoint and returns a new `resolvedRunId`
- `cancelRun(runId)`, `replayRun(runId)`, and `resumeRun(runId)` do not repair
  or synthesize missing/tampered resume-token state

## Practical Execution

Run the focused deterministic suite for the full control surface:

```bash
bun test tests/libs/foundation-core-durable-workflow-runtime.test.ts
```

Run the adjacent inspection and public-surface checks:

```bash
bun test tests/libs/foundation-core-workflow.test.ts
bun run check:e1-capability-slice
```

Run the wider repository gates before closing a change:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

The focused suite currently proves:

- the real `WorkflowRunner` control surface returns auditable control results
  for cancel, defer, replay, resume, and retry
- `cancelRun(...)`, `replayRun(...)`, and `resumeRun(...)` reject missing or
  tampered latest `resumeToken` state instead of inferring fallback execution
- cancelled and failed checkpoints remain terminal or retry-gated under control
  replay

## Troubleshooting

### `inspect` or a control call returns `Option.none()`

The run id was not found in the durable checkpoint store. Verify the canonical
stored run id before treating this as a runtime failure.

### `resumeRun` fails after a capture or extract error

That is expected for failed checkpoints. Inspect the persisted failure envelope
first, then use `retryRun` only if `error.retryable === true`.

### `resumeRun` or `retryRun` fails because the run was cancelled

That is expected. Cancelled checkpoints are terminal for both operations.
Inspect the latest snapshot first and confirm `status === "cancelled"` together
with `control.operation === "cancel"`. If work must continue, start a fresh run
or replay from a known-good checkpoint lineage instead of trying to resume the
cancelled run id.

### `deferRun` appears to do nothing

Repeated `deferRun` is intentionally idempotent when the latest checkpoint is
already deferred and still `running`. The operation should return the same
auditable deferred checkpoint instead of appending a duplicate checkpoint.

### `retryRun` fails with a policy error

The latest checkpoint is either not failed or its failure envelope is not
retryable. Do not bypass that guard. Fix the durable-state cause or replay from
an earlier known-good run instead.

### `replayRun` returns a different run id

That is the contract. Replay starts a new lineage. Use `resumeRun` when you
need to continue the original run id.

### `cancelRun`, `replayRun`, or `resumeRun` fails because the latest checkpoint is missing `resumeToken`

Treat that as durable-state corruption, not as an operator error. The runtime
requires persisted resume context for control actions and will not synthesize it
from partial checkpoint state. Preserve the record unchanged and recover from a
trusted backup or replay lineage instead of manually patching the checkpoint.

### `cancelRun`, `replayRun`, or `resumeRun` fails with resume-token corruption

The latest checkpoint token no longer decodes through
`WorkflowResumeContextSchema`. Keep the corrupted checkpoint payload unchanged
for analysis and roll back the candidate runtime or storage change that
introduced the corruption.

## Residual Risk

Residual risk inferred from the current implementation:

- operator controls trust the checkpoint store once the latest checkpoint and
  `resumeToken` decode successfully through shared schemas
- the runtime does not cryptographically sign persisted resume tokens, so direct
  storage write access can still forge a self-consistent checkpoint lineage
  outside the in-process control checks

## Rollout And Rollback

Promote changes to the control surface with this sequence:

1. Run the focused durable workflow runtime suite.
2. Run the adjacent inspection and E1 capability checks.
3. Run the full repository gates.
4. Keep the candidate diff and any failing checkpoint payload together if a
   gate fails.

Rollback guidance:

- if inspection starts decoding stale checkpoints incorrectly, roll back the
  workflow-runtime change instead of weakening the schemas
- if cancelled checkpoints stop rejecting `resumeRun` or `retryRun`, roll back
  immediately because terminal operator intent is no longer enforced
- if `cancelRun`, `replayRun`, or `resumeRun` stop failing closed on missing or
  tampered latest resume tokens, roll back immediately because the control
  surface is no longer safe against corrupted durable state
- if `resumeRun` starts continuing failed checkpoints, roll back immediately
  because that breaks the explicit retry contract
- if `deferRun` starts appending duplicate checkpoints, roll back because the
  operator surface is no longer idempotent
- if `retryRun` starts bypassing `retryable` enforcement, roll back because the
  control surface is no longer safe under concurrent operator use

## Related Runbooks

- [E5 resume and replay operations](./e5-resume-replay-operations.md)
- [E5 workflow inspection read models](./e5-workflow-inspection-read-models.md)
- [E5 workflow simulation](./e5-workflow-simulation.md)
