# E5 Workflow Inspection Read Models Runbook

## Purpose

Use this runbook when operators or SDK consumers need to inspect the current E5
workflow read model for run status, stage, progress, budget utilization, and
typed failure envelopes.

This runbook is intentionally limited to behavior that exists today in:

- `libs/foundation/core/src/run-state.ts`
- `libs/foundation/core/src/durable-workflow-runtime.ts`
- `examples/e1-capability-slice.ts`
- `tests/libs/foundation-core-workflow.test.ts`
- `tests/libs/foundation-core-durable-workflow-runtime.test.ts`

## Current Contract Surface

The inspection surface is the library-level `WorkflowRunner.inspect(runId)`
method:

```ts
const workflowRunner = yield* WorkflowRunner
const inspection = yield* workflowRunner.inspect("run-001")
```

The current behavior is:

- `Option.none()` for unknown run ids
- `Option.some(WorkflowInspectionSnapshot)` for known runs
- typed failure if the latest persisted checkpoint no longer decodes

`WorkflowInspectionSnapshot` currently exposes:

- run identity: `runId`, `planId`, `targetId`, `packId`, `accessPolicyId`,
  `concurrencyBudgetId`, `entryUrl`
- execution state: `status`, `stage`, `nextStepId`, `startedAt`, `updatedAt`,
  `storedAt`
- progress view: planned/completed/pending step counts and ids
- budget view: configured timeout, elapsed time, remaining timeout, utilization,
  checkpoint interval, and steps until next checkpoint
- typed `error` envelope only for failed runs

The live runtime also enforces deterministic invariants:

- progress counts must align with the checkpoint queues
- terminal succeeded snapshots cannot have pending work
- failed snapshots keep a machine-readable `error` envelope
- inspection decode fails when the latest checkpoint resume token is corrupted

## Practical Execution

Run the focused inspection suites:

```bash
bun test \
  tests/libs/foundation-core-workflow.test.ts \
  tests/libs/foundation-core-durable-workflow-runtime.test.ts
```

Run the public capability example that emits an encoded inspection snapshot:

```bash
bun run check:e1-capability-slice
bun run example:e1-capability-slice
```

Use the example output when you need a concrete encoded inspection payload for
operator or SDK documentation review.

## Troubleshooting

### `inspect(runId)` returned `Option.none()`

The run id was not found in the checkpoint store. Treat that as an absence of
state, not as a failed inspection decode.

### `inspect(runId)` fails with checkpoint corruption

The latest checkpoint no longer matches the encoded plan or the resume token no
longer decodes through the shared schema contracts. Preserve the failing state
for analysis and roll back the candidate runtime change.

### `inspect(runId)` fails because the checkpoint is missing a resume token

The inspection runtime requires persisted checkpoints to carry resume-token
metadata. If the latest checkpoint exists but omits `resumeToken`, treat that as
durable-state corruption, preserve the failing record unchanged, and roll back
the candidate workflow-runtime change that produced it.

### `status` and `progress` look inconsistent

Run the focused inspection suites again. The shared schema contracts reject
misaligned progress math, terminal-state drift, and missing failure metadata.
If those tests fail, do not patch around the mismatch in documentation or
consumers; fix the runtime or schema contract.

### The example inspection shows zero remaining timeout

That is expected in the shipped E1 capability example because the fixture clock
puts `updatedAt` beyond the configured timeout budget. The example is proving
encoding behavior, not simulating a healthy live SLA.

## Rollout And Rollback

Use this sequence before promoting a change that affects workflow inspection
payloads:

1. Run the focused inspection suites.
2. Run the E1 capability slice and inspect the encoded inspection payload.
3. Run the full repository gates.
4. Keep any failing inspection payload unchanged for review.

Rollback guidance:

- if inspection starts dropping the typed `error` envelope for failed runs, roll
  back immediately because operators lose deterministic failure context
- if progress or budget fields drift from checkpoint reality, roll back the
  runtime change instead of weakening read-model invariants
- if only the example output changed, verify whether the contract changed
  intentionally before updating downstream docs or consumers
