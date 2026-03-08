# E5 Resume And Replay Operations Runbook

## Purpose

Use this runbook when operators or SDK consumers need the focused E5 guidance
for explicit resume and replay operations.

For the full control surface, including `inspect`, `cancelRun`, `deferRun`, and
`retryRun`, use [E5 workflow operational controls](./e5-workflow-operational-controls.md).

This runbook is intentionally limited to the resume/replay subset that exists
today in:

- `libs/foundation/core/src/service-topology.ts`
- `libs/foundation/core/src/durable-workflow-runtime.ts`
- `tests/libs/foundation-core-durable-workflow-runtime.test.ts`

## Current Contract Surface

There is no standalone CLI or API endpoint for these operations today.

The supported subset is the library-level `WorkflowRunner` service:

```ts
const workflowRunner = yield* WorkflowRunner

const replayed = yield* workflowRunner.replayRun("run-001")
const resumed = yield* workflowRunner.resumeRun("run-001")
```

Both methods currently return:

- `Option.none()` when the requested run does not exist
- `Option.some(WorkflowControlResult)` when the request resolves successfully
- typed failures when the stored workflow state is malformed

`WorkflowControlResult` currently contains:

- `operation`
- `requestedRunId`
- `resolvedRunId`
- `sourceCheckpointId`
- `checkpoint`

Behavioral guarantees from the live runtime:

- `resumeRun(runId)` continues the latest persisted checkpoint for that run
- `replayRun(runId)` starts a new run from the latest persisted checkpoint and
  returns a fresh `resolvedRunId`
- replay run identifiers are suffixed as
  `<requestedRunId>-replay-<checkpoint-sequence>-<utc-stamp>`
- malformed run identifiers fail through shared schema contracts
- corrupted checkpoint resume tokens fail with `CheckpointCorruption`

## Practical Execution

Run the focused deterministic verification suite:

```bash
bun test tests/libs/foundation-core-durable-workflow-runtime.test.ts
```

Run the broader repository gate replay when validating a candidate change:

```bash
bun run check
bun run nx:typecheck
bun run nx:build
```

The focused suite currently proves:

- success-path replay from a stable source run
- success-path explicit resume across multiple checkpoints
- `Option.none()` on unknown run ids
- malformed run id rejection
- corrupted checkpoint token rejection
- deterministic typed control-result encoding through shared schemas

## Troubleshooting

### `replayRun` or `resumeRun` returns `Option.none()`

The requested run id was not found in the current checkpoint store. Verify that
the run exists before treating this as a runtime failure.

### The call fails with a run-identifier error

The provided run id failed `CanonicalIdentifierSchema`. Remove whitespace or
other invalid identifier characters and retry with the canonical stored run id.

### The call fails with resume-token corruption

The latest persisted checkpoint for that run no longer decodes through the
shared resume-token schema. Treat that as a durable-state regression, keep the
failing checkpoint record unchanged for analysis, and roll back the candidate
runtime change.

### `resumeRun` fails because the run was cancelled

That is expected. Cancellation is terminal for the original run id. Inspect the
latest checkpoint first and confirm `status === "cancelled"` plus
`control.operation === "cancel"`. If work still needs to run, start a fresh run
or use replay from a known-good lineage instead of retrying the cancelled run.

### `replayRun` returned a new run id unexpectedly

That is the expected behavior. Replay starts a fresh run lineage from the latest
checkpoint; only `resumeRun` continues the original run id.

## Rollout And Rollback

Use this sequence before promoting a change that affects replay or resume
behavior:

1. Run the focused durable workflow runtime suite.
2. Confirm the suite still covers unknown-run, malformed-run-id, and corrupted
   checkpoint fail paths.
3. Run the full repository gates.
4. Keep the candidate diff and failing checkpoint evidence together if a gate
   fails.

Rollback guidance:

- if replay/resume starts failing with `CheckpointCorruption`, roll back the
  workflow-runtime candidate rather than weakening schema checks
- if cancelled runs stop rejecting `resumeRun`, roll back immediately because
  the documented terminal-cancel contract was broken
- if replay starts mutating the original run id, roll back immediately because
  that breaks the documented operator contract
- if only the focused suite fails, stop there and fix the runtime before
  re-running wider repository gates

For broader control-surface rollback guidance, see
[E5 workflow operational controls](./e5-workflow-operational-controls.md).
