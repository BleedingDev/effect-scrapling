# E1 Workflow Run State Schema Runbook

## Purpose

Use this runbook when operators, SDK consumers, or workflow authors need to
validate or troubleshoot canonical `RunPlan`, `RunCheckpoint`, and `RunStats`
contracts in `@effect-scrapling/foundation-core`.

These contracts keep durable run orchestration explicit before planners,
checkpoint stores, or resume flows persist or restore state.

Policy baseline:
- Effect v4 only.
- No Effect v3 dependencies or compatibility shims.
- No manual `instanceof`, manual `_tag`, or type-safety bypass shortcuts.

## Public Contract

Current exports:
- `RunPlan`
- `RunPlanSchema`
- `RunCheckpoint`
- `RunCheckpointSchema`
- `RunStats`
- `RunStatsSchema`
- `RunStageSchema`
- `RunOutcomeSchema`

Canonical expectations:
- `RunPlan` declares a durable plan boundary:
  - canonical ids for the run, target, pack, access policy, and concurrency
    budget
  - a canonical `entryUrl`
  - bounded `maxAttempts` and `checkpointInterval`
  - a non-empty, duplicate-free step list
- `RunStats` tracks bounded counts with monotonic timestamps.
- `RunCheckpoint` must preserve:
  - disjoint completed and pending step sets
  - a `nextStepId` taken from the pending queue when present
  - `stats.runId === checkpoint.runId`
  - `stats.completedSteps === completedStepIds.length`
  - `stats.plannedSteps === completed + pending`

Supported stages:
- `capture`
- `extract`
- `snapshot`
- `diff`
- `quality`
- `reflect`

Supported outcomes:
- `running`
- `succeeded`
- `failed`
- `cancelled`

## Command Usage

Run targeted verification from repository root:

```bash
bun test tests/libs/foundation-core-workflow.test.ts
bun test tests/guardrails/e1-schema-runbooks.verify.test.ts
bun run example:e1-capability-slice
```

Run touched-project compilation checks:

```bash
bunx --bun tsc --noEmit -p libs/foundation/core/tsconfig.json
bunx --bun tsc --noEmit -p apps/api/tsconfig.json
bunx --bun tsc --noEmit -p apps/cli/tsconfig.json
```

Run the full repository gates before closure:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

## Practical Example

```ts
import { Schema } from "effect";
import {
  RunCheckpointSchema,
  RunPlanSchema,
  RunStatsSchema,
} from "@effect-scrapling/foundation-core";

const plan = Schema.decodeUnknownSync(RunPlanSchema)({
  id: "run-plan-001",
  targetId: "target-product-001",
  packId: "pack-example-com",
  accessPolicyId: "policy-default",
  concurrencyBudgetId: "budget-run-001",
  entryUrl: "https://example.com/products/001",
  maxAttempts: 3,
  checkpointInterval: 2,
  steps: [
    {
      id: "step-capture-001",
      stage: "capture",
      requiresBrowser: false,
      artifactKind: "html",
    },
    {
      id: "step-extract-001",
      stage: "extract",
      requiresBrowser: false,
    },
  ],
  createdAt: "2026-03-06T10:00:00.000Z",
});

const stats = Schema.decodeUnknownSync(RunStatsSchema)({
  runId: "run-001",
  plannedSteps: 2,
  completedSteps: 1,
  checkpointCount: 1,
  artifactCount: 1,
  outcome: "running",
  startedAt: "2026-03-06T10:00:00.000Z",
  updatedAt: "2026-03-06T10:01:00.000Z",
});

const checkpoint = Schema.decodeUnknownSync(RunCheckpointSchema)({
  id: "checkpoint-001",
  runId: "run-001",
  planId: "run-plan-001",
  sequence: 1,
  stage: "extract",
  nextStepId: "step-extract-001",
  completedStepIds: ["step-capture-001"],
  pendingStepIds: ["step-extract-001"],
  artifactIds: ["artifact-html-001"],
  stats,
  storedAt: "2026-03-06T10:01:00.000Z",
});
```

Expected behavior:
- decode fails on duplicate stages or duplicate step ids in a plan
- decode fails when succeeded stats claim incomplete execution
- decode fails when checkpoint stats disagree with pending/completed step sets
- encode returns a deterministic transport payload suitable for persistence

## Troubleshooting

### Plan validation fails

Check these first:
- the step list is non-empty
- every step id is unique
- every stage appears only once
- `entryUrl` is a canonical HTTP(S) URL
- `checkpointInterval` and `maxAttempts` stay within bounded ranges

Do not add fallback DTO parsing or inferred steps. Fix the plan producer.

### Stats validation fails

Common failures:
- `completedSteps > plannedSteps`
- `updatedAt < startedAt`
- `outcome: "succeeded"` while some steps are still incomplete

Treat these as integrity bugs in the runner or checkpoint writer.

### Resume fails because checkpoint decode rejects the payload

Check:
- completed and pending queues do not overlap
- `nextStepId` is actually still pending
- `stats.runId` matches the checkpoint `runId`
- `stats.completedSteps` and `stats.plannedSteps` match the queue lengths

Do not patch around this with manual object surgery after decode. Repair the
checkpoint producer and replay from the last valid durable state.

## Rollout Guidance

1. Prepare
- update planners and stores to emit `RunPlan`, `RunStats`, and
  `RunCheckpoint` through shared schema exports
- verify representative resume payloads with
  `bun test tests/libs/foundation-core-workflow.test.ts`

2. Apply
- persist only encoded public contract payloads
- remove parallel ad hoc checkpoint DTOs and partial restore logic

3. Verify
- run targeted tests
- run `bun run example:e1-capability-slice`
- run `bun run check`

4. Promote
- merge only when run-state tests, capability slice, and full gates are green

## Rollback Guidance

1. Revert the producer change that introduced invalid run plans, non-monotonic
   stats, or inconsistent checkpoints.
2. Re-run:

```bash
bun test tests/libs/foundation-core-workflow.test.ts
bun test tests/guardrails/e1-schema-runbooks.verify.test.ts
bun run example:e1-capability-slice
bun run check
```

3. Restore from the last valid encoded checkpoint rather than weakening the
   schema.
4. Keep resume flows schema-first. Do not add manual `instanceof`, manual
   `_tag`, or post-decode mutation hacks to accept corrupt state.

## Operator Notes

- Treat checkpoint decode failures as integrity bugs, not normal runtime noise.
- Keep run-state persistence deterministic and UTC-only.
- Use the public `@effect-scrapling/foundation-core` surface for all durable
  run-state boundaries.
- Effect v4 only remains mandatory for future workflow state extensions.
