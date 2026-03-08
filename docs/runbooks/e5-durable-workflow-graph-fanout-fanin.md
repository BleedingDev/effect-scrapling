# E5 Durable Workflow Graph Fanout Fanin Runbook

## Purpose

Use this runbook when operators or SDK consumers need to validate or
troubleshoot the current E5 durable workflow graph that drives capture,
extraction, snapshot, diff, quality, and reflect stages with deterministic
checkpoint transitions.

This runbook is intentionally limited to behavior that exists today in:

- `libs/foundation/core/src/durable-workflow-runtime.ts`
- `libs/foundation/core/src/crawl-plan-runtime.ts`
- `tests/libs/foundation-core-durable-workflow-runtime.test.ts`

## Current Contract Surface

The shipped runtime models fanout/fanin as a canonical stage graph inside a
single durable run plan. There is no separate CLI or API wrapper for graph
controls today.

Current stage graph:

1. `capture`
2. `extract`
3. `snapshot`
4. `diff`
5. `quality`
6. `reflect`

The current implementation checkpoints deterministic graph progress at the
workflow boundaries exercised by the runtime tests:

- first persisted checkpoint after `capture` + `extract`
- second persisted checkpoint after `snapshot` + `diff`
- terminal persisted checkpoint after `quality` + `reflect`

Current contract guarantees:

- durable checkpoint queues must remain aligned with the canonical graph order
- operator controls and replay restore do not infer graph progress when the
  latest checkpoint token is missing or tampered
- resumed runs reject corrupted or reordered pending-step graphs
- replayed runs keep the same graph semantics and reject corrupted persisted
  state instead of inferring fallback graph progress
- final inspection snapshots reflect the terminal graph state exactly

## Practical Execution

Run the focused durable workflow runtime suite:

```bash
bun test tests/libs/foundation-core-durable-workflow-runtime.test.ts
```

Run the broader repository gates when validating a graph change:

```bash
bun run check
bun run nx:typecheck
bun run nx:build
```

The focused suite currently proves:

- deterministic stage progression through the canonical graph
- replay and resume over the same graph structure
- stable checkpoint and inspection payloads
- rejection of reordered graph queues
- rejection of malformed run ids and missing or corrupted latest resume tokens
  across `cancelRun(...)`, `replayRun(...)`, and `resumeRun(...)`

## Troubleshooting

### Resume fails because checkpoint ordering drifted

The persisted checkpoint queue no longer matches the canonical workflow graph.
Treat that as durable-state corruption or a runtime regression. Do not patch
around it in docs or operators.

### Resume or replay fails because the token is corrupted

The persisted checkpoint can no longer decode through the shared resume-token
schema. Preserve the failing checkpoint state and roll back the candidate
runtime change.

### Cancel, replay, or resume fails because the latest token is missing

That is expected. The live runtime refuses to reconstruct graph state when the
latest persisted checkpoint omits `resumeToken`. Preserve the failing record for
analysis and recover from a known-good checkpoint lineage or trusted backup
instead of hand-editing the graph state.

### Inspect fails because the latest token is corrupted

Inspection uses the same persisted resume-token contract as replay and restore.
If `inspect(runId)` starts failing on the latest checkpoint token, preserve that
checkpoint unchanged and roll back the candidate runtime change.

### Final inspection does not match terminal graph state

Run the focused durable workflow runtime suite again. The shipped tests assert
the exact terminal `reflect` stage with empty pending work and full completion
ratio.

## Residual Risk

Residual risk inferred from the current implementation:

- graph recovery trusts checkpoint-store integrity once a checkpoint and
  `resumeToken` decode successfully through shared schemas
- `resumeToken` is schema-validated JSON, not a cryptographically signed
  artifact, so storage write access remains the trust boundary outside the
  in-process graph checks

## Rollout And Rollback

Use this sequence before promoting a graph change:

1. Run the focused durable workflow runtime suite.
2. Confirm the canonical graph stages and checkpoint boundaries are unchanged or
   intentionally updated.
3. Run the full repository gates.
4. Keep any failing checkpoint payload unchanged for review.

Rollback guidance:

- if checkpoint queues can be reordered without failure, roll back immediately
  because deterministic graph execution is broken
- if `cancelRun`, `replayRun`, or `resumeRun` stop failing closed on missing or
  tampered latest resume tokens, roll back immediately because the runtime is no
  longer protecting graph recovery from corrupted durable state
- if terminal inspection no longer reflects the completed graph accurately, roll
  back the runtime change before updating downstream consumers
