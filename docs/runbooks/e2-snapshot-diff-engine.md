# E2 Snapshot Diff Correctness Engine

## Purpose

This runbook is for operators and repo-internal runtime or SDK authors who need
to validate or call the snapshot diff correctness engine that lives in
`libs/foundation/core/src/snapshot-diff-engine.ts`.

It documents only the behavior that exists today:

- deterministic canonicalization of snapshot observations
- typed diff output for `add`, `remove`, and `change`
- signed metric deltas and canonical summary metrics
- the current failure modes
- practical validation, rollout, and rollback steps

It does not document pack promotion or quality-verdict workflows. Those schemas
exist in `libs/foundation/core/src/diff-verdict.ts`, but they are not emitted by
the snapshot diff engine today.

## Current Runtime Contract

The snapshot diff surface currently has four entry points:

- `canonicalizeSnapshot(input)`
- `compareSnapshots(input)`
- `makeSnapshotDiffEngine(now?, createDiffId?)`
- `SnapshotDiffEngineLive(now?, createDiffId?)`

### Canonicalization Rules

Before diffing, snapshots are canonicalized field-by-field:

1. observations are grouped by `field`
2. one observation is kept for each field
3. the kept observation is chosen by:
   - highest `confidence`
   - then lexicographically smaller stable serialization of
     `normalizedValue`
   - then lexicographically smaller sorted `evidenceRefs`
4. `evidenceRefs` are sorted before they are emitted
5. canonical fields are sorted by field name
6. `valueFingerprint` is the stable serialization of the chosen
   `normalizedValue`

`confidenceScore` is the average confidence of the chosen canonical fields. If a
snapshot has no observations, the engine falls back to the snapshot
`qualityScore`.

### Diff Rules

`compareSnapshots` accepts:

- `id`
- `baseline`
- `candidate`
- `createdAt`
- optional `latencyDeltaMs`
- optional `memoryDelta`

Current behavior:

- baseline and candidate must share the same `targetId`
- `latencyDeltaMs` defaults to `0` when omitted
- `memoryDelta` defaults to `0` when omitted
- changes are emitted in field-name order
- unchanged fields are not listed in `changes`
- current implementation always emits `changes`, including `[]` for a steady
  state
- current implementation always emits `canonicalMetrics`

The engine emits only three change kinds:

- `add`: field exists only in the candidate
- `remove`: field exists only in the baseline
- `change`: field exists in both snapshots but the canonical
  `valueFingerprint` changed

`confidenceDelta` is:

- `+candidate.confidence` for `add`
- `-baseline.confidence` for `remove`
- `candidate.confidence - baseline.confidence` for `change`

### Metric Semantics

`metrics` is always present and currently means:

- `fieldRecallDelta`: retained baseline confidence loss ratio
- `falsePositiveDelta`: added candidate confidence penalty ratio
- `driftDelta`: combined penalty ratio for removed, added, and changed fields
- `latencyDeltaMs`: caller-supplied latency delta
- `memoryDelta`: caller-supplied memory delta

The first three metrics are rounded to 6 decimals and trend toward `0` for a
steady state. More negative values indicate more loss or drift.

`latencyDeltaMs` and `memoryDelta` are directional:

- positive values mean the candidate used more time or memory
- negative values mean the candidate improved on the baseline

`canonicalMetrics` summarizes:

- baseline and candidate field counts
- unchanged, added, removed, and changed field counts
- baseline and candidate canonical confidence scores
- the confidence-score delta

Important current limitation: confidence-only movement on an unchanged value is
visible in `canonicalMetrics.confidenceDelta`, but it does not create a
`change`, and it does not affect `fieldRecallDelta`, `falsePositiveDelta`, or
`driftDelta`.

## Command Contract

Primary validation commands for this engine:

```bash
bun install --frozen-lockfile
bun test tests/libs/foundation-core-snapshot-diff-engine.test.ts
bun run check:e2-capability-slice
```

Useful focused follow-up when the integrated slice fails:

```bash
bun test tests/examples/e2-capability-slice.test.ts
bun run example:e2-capability-slice
```

## Standard Operator Flow

### 1. Validate the unit contract first

```bash
bun test tests/libs/foundation-core-snapshot-diff-engine.test.ts
```

What this proves today:

- deterministic canonicalization picks the strongest field evidence
- `add`, `remove`, and `change` are classified correctly
- cross-target comparisons fail fast
- the `DiffEngine` wrapper can emit deterministic ids and timestamps

### 2. Validate the integrated E2 slice

```bash
bun run check:e2-capability-slice
```

What this proves today:

- a golden fixture can replay into a baseline snapshot
- a candidate HTML capture can be orchestrated into a snapshot
- the resulting snapshot diff is typed and deterministic

The checked example lives in `examples/e2-capability-slice.ts` and currently
compares:

- a replayed golden baseline
- a candidate HTML document with title, price, and availability evidence

### 3. Escalate only if the integrated slice fails

Use:

```bash
bun test tests/examples/e2-capability-slice.test.ts
bun run example:e2-capability-slice
```

If that still fails, continue with
`docs/runbooks/e2-extractor-orchestration.md` because the fault may be in
capture, extraction, normalization, or snapshot assembly rather than in the diff
engine itself.

## Practical Execution Examples

### Direct repo-internal use with explicit resource deltas

Use `compareSnapshots` when the caller already has two snapshots and wants to
attach measured latency or memory deltas:

```ts
import { Effect } from "effect";
import { compareSnapshots } from "../libs/foundation/core/src/snapshot-diff-engine.ts";

const diff = await Effect.runPromise(
  compareSnapshots({
    id: "diff-target-product-001",
    baseline,
    candidate,
    createdAt: "2026-03-06T10:06:00.000Z",
    latencyDeltaMs: 12,
    memoryDelta: -4,
  }),
);
```

The import path above matches the repo-local source examples in this codebase.
Adjust the relative path for your own call site.

With the current canonical test corpus, that call yields:

- `changes[0]`: `remove` for `availability`
- `changes[1]`: `change` for `price`
- `changes[2]`: `add` for `rating`
- `metrics.fieldRecallDelta`: `-0.708333`
- `metrics.falsePositiveDelta`: `-0.25`
- `metrics.driftDelta`: `-0.465909`
- `canonicalMetrics.confidenceDelta`: `-0.133333`

### Service-topology use with deterministic factories

Use `makeSnapshotDiffEngine` when a consumer needs a `DiffEngine`-compatible
service:

```ts
import { Effect } from "effect";
import { makeSnapshotDiffEngine } from "../libs/foundation/core/src/snapshot-diff-engine.ts";

const engine = makeSnapshotDiffEngine(
  () => new Date("2026-03-06T10:15:00.000Z"),
  () => "diff-live-001",
);

const diff = await Effect.runPromise(engine.compare(baseline, candidate));
```

This example also uses the repo-local source import style from the checked test
fixtures. Adjust the import path for your own consumer module.

Current behavior of the service wrapper:

- generated id defaults to `diff-${baseline.id}-${candidate.id}` unless
  overridden
- `createdAt` is `now().toISOString()`
- `latencyDeltaMs` is fixed to `0`
- `memoryDelta` is fixed to `0`

If a consumer needs non-zero resource deltas, call `compareSnapshots` directly
instead of going through `makeSnapshotDiffEngine`.

### Standalone E2 evidence inspection

Use the current example runner when an operator needs the full encoded evidence
payload, not just a pass or fail signal:

```bash
bun run example:e2-capability-slice
```

The current standalone output includes:

- `snapshotDiff.id === "e2-capability-slice-diff"`
- `snapshotDiff.changes[0].changeType === "change"`
- `snapshotDiff.changes[0].field === "price"`
- `snapshotDiff.metrics.fieldRecallDelta === -0.294118`
- `snapshotDiff.metrics.falsePositiveDelta === 0`
- `snapshotDiff.metrics.driftDelta === -0.157143`
- `snapshotDiff.metrics.latencyDeltaMs === -4`
- `snapshotDiff.metrics.memoryDelta === -128`
- `snapshotDiff.canonicalMetrics.confidenceDelta === 0.053333`

### Interpreting a steady-state diff

A steady-state diff currently looks like:

- `changes: []`
- `metrics.fieldRecallDelta === 0`
- `metrics.falsePositiveDelta === 0`
- `metrics.driftDelta === 0`

That does not mean confidence stayed flat. The current tests also prove that an
unchanged field value can still produce a non-zero
`canonicalMetrics.confidenceDelta`.

## Troubleshooting

### `Snapshot diff requires baseline and candidate snapshots for the same target.`

Cause:

- `baseline.targetId !== candidate.targetId`

Action:

1. fix the caller so both snapshots refer to the same target
2. do not rewrite ids or target ids to force a comparison
3. rerun:

```bash
bun test tests/libs/foundation-core-snapshot-diff-engine.test.ts
```

### `Failed to decode snapshot diff input through shared contracts.`

Cause:

- the top-level diff input did not satisfy the shared schema

Action:

1. validate that `id`, `baseline`, `candidate`, and `createdAt` are present
2. ensure `latencyDeltaMs` is an integer when supplied
3. ensure `memoryDelta` is finite when supplied
4. keep schema decoding in place; do not bypass it

### Canonicalization picked the "wrong" observation

Cause:

- another observation for the same field had higher confidence
- or confidence tied and stable value serialization won the tiebreak
- or both tied and sorted evidence refs won the final tiebreak

Action:

1. inspect duplicate observations for the field
2. compare confidences first
3. if confidences tie, compare the normalized values after stable
   serialization
4. if values also tie, compare the sorted evidence refs

### Integrated E2 slice fails while the unit suite passes

Cause:

- the diff engine may still be correct, but the upstream extraction path
  changed

Action:

1. rerun:

```bash
bun test tests/examples/e2-capability-slice.test.ts
```

2. inspect `examples/e2-capability-slice.ts`
3. continue with `docs/runbooks/e2-extractor-orchestration.md`

## Rollout Guidance

There is no separate runtime flag for this engine today. Rollout means adopting
the current API in a caller or wiring the `DiffEngine` service into a layer.

Recommended rollout sequence:

1. install dependencies and run the unit suite
2. run `bun run check:e2-capability-slice`
3. integrate `compareSnapshots` first if the caller needs explicit
   `latencyDeltaMs` or `memoryDelta`
4. integrate `makeSnapshotDiffEngine` or `SnapshotDiffEngineLive` when the
   caller wants the service-topology contract and zeroed resource deltas are
   acceptable
5. keep deterministic `now` and `createDiffId` overrides for tests or fixtures,
   not as a substitute for broken runtime inputs

Rollout is not complete until both the unit suite and the capability slice are
green.

## Rollback Guidance

There is no config toggle to disable only the diff engine. Rollback today means
reverting the caller integration or restoring the previous layer binding.

Recommended rollback sequence:

1. revert the offending consumer or layer change
2. keep the schema-backed snapshot contracts intact
3. rerun:

```bash
bun test tests/libs/foundation-core-snapshot-diff-engine.test.ts
bun run check:e2-capability-slice
```

Do not roll back by:

- bypassing schema decoding
- mutating `targetId` just to make a comparison run
- post-processing diff output to hide negative deltas
- discarding evidence refs before canonicalization
