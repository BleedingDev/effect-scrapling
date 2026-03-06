# E1 Diff Verdict and Promotion Decision Runbook

## Purpose

Use this runbook when operators, SDK consumers, or quality authors need to
validate or troubleshoot canonical `SnapshotDiff`, `QualityVerdict`, and
`PackPromotionDecision` contracts in `@effect-scrapling/foundation-core`.

These contracts keep quality comparisons, promotion gates, and rollout
decisions explicit before any reflection or workflow system promotes a pack.

Policy baseline:
- Effect v4 only.
- No Effect v3 dependencies or compatibility shims.
- No manual `instanceof`, manual `_tag`, or type-safety bypass shortcuts.

## Public Contract

Current exports:
- `SnapshotDiff`
- `SnapshotDiffSchema`
- `QualityVerdictSchema`
- `PackPromotionDecision`
- `PackPromotionDecisionSchema`

Canonical expectations:
- `SnapshotDiff.metrics` keeps bounded rate deltas and stable numeric transport.
- `QualityVerdictSchema` requires exactly one result for every promotion gate:
  - `requiredFieldCoverage`
  - `falsePositiveRate`
  - `incumbentComparison`
  - `replayDeterminism`
  - `workflowResume`
  - `soakStability`
  - `securityRedaction`
- `PackPromotionDecisionSchema` allows only supported state/action pairs.

Supported decision actions:
- `promote-shadow`
- `active`
- `guarded`
- `quarantined`
- `retired`

## Command Usage

Run targeted verification from repository root:

```bash
bun test tests/guardrails/e1-capability-slice.verify.test.ts
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
  PackPromotionDecisionSchema,
  QualityVerdictSchema,
  SnapshotDiffSchema,
} from "@effect-scrapling/foundation-core";

const diff = Schema.decodeUnknownSync(SnapshotDiffSchema)({
  id: "diff-pack-example-com-001",
  baselineSnapshotId: "snapshot-baseline-001",
  candidateSnapshotId: "snapshot-candidate-001",
  metrics: {
    fieldRecallDelta: 0.03,
    falsePositiveDelta: -0.01,
    driftDelta: -0.02,
    latencyDeltaMs: -50,
    memoryDelta: -12,
  },
  createdAt: "2026-03-06T10:04:00.000Z",
});

const verdict = Schema.decodeUnknownSync(QualityVerdictSchema)({
  id: "verdict-pack-example-com-001",
  packId: "pack-example-com",
  snapshotDiffId: diff.id,
  action: "promote-shadow",
  gates: [
    { name: "requiredFieldCoverage", status: "pass" },
    { name: "falsePositiveRate", status: "pass" },
    { name: "incumbentComparison", status: "pass" },
    { name: "replayDeterminism", status: "pass" },
    { name: "workflowResume", status: "pass" },
    { name: "soakStability", status: "pass" },
    { name: "securityRedaction", status: "pass" },
  ],
  createdAt: "2026-03-06T10:05:00.000Z",
});

const decision = Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
  id: "decision-pack-example-com-001",
  packId: "pack-example-com",
  fromState: "draft",
  toState: "shadow",
  triggerVerdictId: verdict.id,
  action: "promote-shadow",
  createdAt: "2026-03-06T10:06:00.000Z",
});
```

Expected behavior:
- verdict decode fails if any required promotion gate is missing or duplicated
- decision decode fails on unsupported state/action combinations
- encode returns stable payloads for CLI, SDK, and workflow boundaries

## Troubleshooting

### Verdict validation fails

Check these first:
- all seven promotion gates are present
- gate names are canonical
- no gate appears twice
- timestamps are strict UTC ISO values

Do not add fallback gate defaults after decode. Fix the quality producer.

### Decision validation fails

Common invalid moves:
- `draft -> active`
- `shadow -> quarantined` with `promote-shadow`
- `guarded -> active` paired with the wrong `action`

Use the allowed decision matrix from the schema instead of manual switch logic
or ad hoc coercion.

### Downstream code branches on free-form decision strings

That is a contract bug. Decode through the shared schemas and propagate typed
decision payloads instead of re-inventing local enums or string maps.

## Rollout Guidance

1. Prepare
- update comparison and reflection code to emit only public quality contracts
- verify representative diffs and verdicts with
  `bun test tests/guardrails/e1-capability-slice.verify.test.ts`

2. Apply
- remove duplicate local decision DTOs or gate lists
- keep the shared decision schema as the single source of truth

3. Verify
- run targeted tests
- run `bun run example:e1-capability-slice`
- run `bun run check`

4. Promote
- merge only when quality tests, capability slice, and full gates are green

## Rollback Guidance

1. Revert the producer change that introduced unsupported verdicts or decision
   payloads.
2. Re-run:

```bash
bun test tests/guardrails/e1-capability-slice.verify.test.ts
bun run example:e1-capability-slice
bun run check
```

3. Keep the decision matrix strict; do not add string-based fallback promotion
   rules or manual type probing to push bad decisions through.
4. Re-attempt rollout only after shared quality payloads are green again.

## Operator Notes

- Stable promotion gates are part of the public contract.
- Use `QualityVerdictSchema` and `PackPromotionDecisionSchema` at every
  cross-surface boundary.
- Effect v4 only remains mandatory for future quality decision extensions.
