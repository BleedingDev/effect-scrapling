# E2 Snapshot Builder and Quality Score Runbook

## Purpose

Use this runbook when operators, extraction authors, or repo-internal SDK
consumers need to validate or troubleshoot the current snapshot assembly and
quality score behavior in:

- `libs/foundation/core/src/snapshot-builder.ts`
- `tests/libs/foundation-core-snapshot-builder.test.ts`
- `examples/e2-capability-slice.ts`
- `docs/runbooks/e2-extractor-orchestration.md`

This runbook is intentionally limited to behavior that exists today. It does
not assume:

- a public `effect-scrapling/sdk` export for `buildObservationSnapshot`
- automatic rejection of low-quality snapshots
- array reordering during normalized-value canonicalization
- hidden quality thresholds outside the emitted `qualityScore`
- manual `_tag`, `instanceof`, or unsafe-cast shortcuts

Policy baseline:

- Effect v4 only
- schema decode remains the boundary for snapshot-builder input and output
- quality-score auditing uses emitted inputs and breakdowns instead of
  re-deriving scores in downstream code

## Current Contract

### Direct builder contract

`buildObservationSnapshot(...)` currently:

- decodes `id`, `targetId`, `observations`, and `createdAt` through
  `SnapshotBuilderInputSchema`
- requires at least one observation
- returns a typed `SnapshotAssemblyResult`
- fails with `SnapshotBuilderFailure` when decode or assembly fails
- returns successfully even when `qualityScore` is low

Repo-internal callers can import the builder directly from
`libs/foundation/core/src/snapshot-builder.ts`. Public consumers cannot import
it from `effect-scrapling/sdk` today because the package export surface is
currently limited to:

- `extractRun`
- `accessPreview`
- `renderPreview`
- `runDoctor`
- fetch schemas and errors related to those commands

### Deterministic assembly rules

Snapshot assembly is deterministic across equivalent observation sets with these
current rules:

- nested object keys inside `normalizedValue` are sorted recursively before
  comparison and encoding
- array order inside `normalizedValue` is preserved, not sorted
- duplicate `evidenceRefs` are removed and the surviving refs are sorted
  lexicographically
- duplicate observations are identified by `field + stableSerialize(normalizedValue)`
- duplicate observations merge by:
  - keeping the maximum confidence
  - unioning and sorting evidence refs
- assembled observations are sorted by:
  - `field`
  - stable serialization of `normalizedValue`
  - descending `confidence`
  - joined `evidenceRefs`

Practical implication:

- object key order differences do not create snapshot drift
- array order differences do create snapshot drift
- equivalent duplicate observations reduce to one assembled observation
- conflicting values for the same field remain as separate observations and
  reduce the conflict-free score

### Quality score model

The builder emits three quality surfaces:

- `snapshot.qualityScore`
- `qualityScoreInputs`
- `qualityScoreBreakdown`

Current auditable inputs:

- `sourceObservationCount`: number of decoded input observations
- `assembledObservationCount`: number of observations after duplicate collapse
- `duplicateObservationCount`: `sourceObservationCount - assembledObservationCount`
- `uniqueFieldCount`: unique field names in the assembled snapshot
- `conflictingFieldCount`: fields that still have more than one distinct
  normalized value after assembly
- `uniqueEvidenceRefCount`: unique evidence refs across assembled observations
- `multiEvidenceObservationCount`: assembled observations with more than one
  evidence ref
- `averageEvidenceRefsPerObservation`: total evidence refs divided by assembled
  observation count, rounded to 6 decimals
- `averageConfidence`: mean assembled confidence, rounded and bounded to `0..1`
- `minimumConfidence`: minimum assembled confidence, rounded and bounded to
  `0..1`
- `evidenceStrengthScore`: `min(1, averageEvidenceRefsPerObservation / 2)`
- `conflictFreeScore`: `1 - conflictingFieldCount / uniqueFieldCount`
- `uniquenessScore`: `assembledObservationCount / sourceObservationCount`

Current weighted breakdown:

- `confidenceContribution = averageConfidence * 0.55`
- `evidenceStrengthContribution = evidenceStrengthScore * 0.20`
- `conflictFreeContribution = conflictFreeScore * 0.15`
- `uniquenessContribution = uniquenessScore * 0.10`

Current score interpretation:

- each contribution is rounded and bounded to `0..1`
- final `snapshot.qualityScore` is the rounded sum of the four contributions
- `minimumConfidence` is emitted for auditability but is not directly weighted
  today
- duplicate counts and evidence counts are emitted for auditability but only
  the derived evidence-strength, conflict-free, and uniqueness scores affect the
  final score

## Command Contract

Run from repository root.

Focused snapshot-builder verification:

```bash
bun test tests/libs/foundation-core-snapshot-builder.test.ts
```

Integrated E2 evidence replay:

```bash
bun run check:e2-capability-slice
bun run example:e2-capability-slice | jq '.candidateOrchestration.snapshotAssembly'
```

Public SDK surface confirmation:

```bash
bun run check:e2-sdk-consumer
```

Recommended merge-blocking gate stack before closure:

```bash
bun run ultracite:check
bun run oxlint:check
bun run format:check
bun run test
bun run build
bun run check:e2-capability-slice
bun run check:e2-sdk-consumer
```

## Practical Execution Flow

### 1. Confirm deterministic assembly at unit-test level

```bash
bun test tests/libs/foundation-core-snapshot-builder.test.ts
```

What this proves today:

- equivalent observation permutations encode to the same assembled result
- duplicate observations collapse deterministically
- quality-score inputs and weighted breakdown are auditable
- empty observation arrays fail with `SnapshotBuilderFailure`

### 2. Inspect the live E2 snapshot-assembly payload

```bash
bun run example:e2-capability-slice | jq '.candidateOrchestration.snapshotAssembly'
```

Current output shape to inspect:

- `snapshot.id`
- `snapshot.targetId`
- `snapshot.observations`
- `snapshot.qualityScore`
- `qualityScoreInputs`
- `qualityScoreBreakdown`

Current example values from the checked-in capability slice:

- candidate `qualityScore` is `0.878`
- candidate `averageConfidence` is `0.96`
- candidate `evidenceStrengthScore` is `0.5` because each observation has one
  evidence ref
- candidate `conflictFreeScore` is `1`
- candidate `uniquenessScore` is `1`

This is the fastest operator path to confirm that extractor orchestration is
emitting snapshot quality telemetry without importing private paths.

### 3. Use the builder directly from repo-internal code

This is a repo-internal example, not a public `effect-scrapling/sdk` contract:

```ts
import { Effect, Schema } from "effect";
import {
  SnapshotAssemblyResultSchema,
  buildObservationSnapshot,
} from "./libs/foundation/core/src/snapshot-builder.ts";

const result = await Effect.runPromise(
  buildObservationSnapshot({
    id: "snapshot-product-001",
    targetId: "target-product-001",
    createdAt: "2026-03-06T10:15:00.000Z",
    observations: [
      {
        field: "title",
        normalizedValue: "example product",
        confidence: 0.95,
        evidenceRefs: ["artifact-title-dom"],
      },
      {
        field: "price",
        normalizedValue: {
          currency: "USD",
          amount: 19.99,
        },
        confidence: 0.87,
        evidenceRefs: ["artifact-price-json", "artifact-price-dom"],
      },
      {
        field: "price",
        normalizedValue: {
          amount: 19.99,
          currency: "USD",
        },
        confidence: 0.91,
        evidenceRefs: ["artifact-price-dom"],
      },
    ],
  }),
);

console.log(JSON.stringify(Schema.encodeSync(SnapshotAssemblyResultSchema)(result), null, 2));
```

Expected current behavior:

- the two `price` observations merge into one assembled observation
- merged `price.confidence` becomes `0.91`
- merged `price.evidenceRefs` become
  `["artifact-price-dom", "artifact-price-json"]`
- the result includes `snapshot`, `qualityScoreInputs`, and
  `qualityScoreBreakdown`

### 4. Interpret a score regression with the checked-in unit fixture

The unit fixture in
`tests/libs/foundation-core-snapshot-builder.test.ts` currently demonstrates
this exact case:

- `sourceObservationCount = 5`
- `assembledObservationCount = 4`
- `duplicateObservationCount = 1`
- `conflictingFieldCount = 1`
- `qualityScore = 0.754875`

Why the score is lower than the clean E2 capability slice:

- duplicate price observations reduce `uniquenessScore` to `0.8`
- conflicting `availability` values reduce `conflictFreeScore` to `0.666667`
- average confidence is `0.7725`, which lowers the 55% confidence component

Use this fixture as the baseline example when operators ask why a snapshot can
be valid, deterministic, and still produce a lower score.

## Troubleshooting

### `SnapshotBuilderFailure` says observations are required

Current failure text contains `at least one observation`.

What it means:

- the caller passed `observations: []`
- snapshot assembly never started

What to fix:

- repair the upstream extractor or test fixture so at least one observation
  reaches the builder
- do not paper over this with placeholder observations

### Quality score is lower than expected

Inspect `qualityScoreInputs` before changing any code.

Common current causes:

- `conflictingFieldCount > 0`
- `duplicateObservationCount > 0`
- `averageConfidence` is lower than expected
- `averageEvidenceRefsPerObservation < 2`, which keeps
  `evidenceStrengthScore < 1`

Important current nuance:

- `minimumConfidence` is emitted but does not directly change the weighted score
- a snapshot with perfect uniqueness and zero conflicts still tops out below `1`
  if evidence strength or average confidence is below the maximum

### Equivalent-looking observations still produce different snapshots

Check whether the difference is in object-key order or array order.

Current behavior:

- object-key order is normalized away
- array order is preserved and therefore remains significant

If array order is not semantically meaningful for a field family, normalize it
before the builder. Do not add implicit array sorting to snapshot assembly
without updating tests and the deterministic contract.

### Public SDK consumer cannot import snapshot builder

That is expected today.

Current public export surface in `src/sdk/index.ts` includes extraction,
preview, doctor, fetch helpers, and related schemas/errors, but not
`buildObservationSnapshot`.

Use one of these paths instead:

- inspect `snapshotAssembly` through extractor orchestration outputs
- run `bun run example:e2-capability-slice`
- stay repo-internal and import from
  `libs/foundation/core/src/snapshot-builder.ts`

Do not import from `src/sdk/*` private paths.

## Rollout Guidance

1. Prepare

- confirm upstream normalization already produces canonical field names and
  evidence refs
- run `bun test tests/libs/foundation-core-snapshot-builder.test.ts`
- run `bun run check:e2-capability-slice`
- if public-SDK assumptions are part of the change, run
  `bun run check:e2-sdk-consumer`

2. Apply

- call `buildObservationSnapshot(...)` once per completed observation set
- treat `qualityScoreInputs` and `qualityScoreBreakdown` as the audit record
- keep `createdAt` supplied by the caller; the builder does not invent timestamps
- avoid parallel score implementations in downstream code

3. Verify

- confirm assembled observations are stable across reruns
- confirm score inputs explain the score without any hidden thresholds
- rerun the merge-blocking gate stack

4. Promote

- merge only when deterministic assembly, E2 capability slice output, and any
  affected public SDK checks are green

## Rollback Guidance

1. Revert the offending upstream normalization, evidence-linking, or snapshot
   caller change rather than weakening builder invariants.
2. Re-run:

```bash
bun test tests/libs/foundation-core-snapshot-builder.test.ts
bun run check:e2-capability-slice
bun run check:e2-sdk-consumer
bun run ultracite:check
bun run oxlint:check
bun run format:check
bun run test
bun run build
```

3. Do not roll back by:

- bypassing schema decode
- filtering out conflicting observations to inflate the score
- inventing extra evidence refs to inflate the evidence-strength score
- importing from `src/sdk/*` private paths
- adding manual `_tag`, `instanceof`, `any`, or unsafe casts

4. Re-attempt rollout only after the upstream observation set is corrected and
   the deterministic contract is green again.

## Operator Notes

- `qualityScore` is currently descriptive telemetry, not a built-in accept/reject gate.
- `qualityScoreInputs` is the first place to look when the score changes.
- `qualityScoreBreakdown` shows the exact weighted components used today.
- Public SDK consumers should treat snapshot-builder internals as non-public
  until `src/sdk/index.ts` exports them intentionally.
