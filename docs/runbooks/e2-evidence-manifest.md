# E2 Evidence Manifest

## Purpose

Use this runbook to validate, inspect, and troubleshoot evidence manifest
generation as it exists today.

The current implementation binds each extracted observation to:

- the original snapshot observation
- one or more artifact metadata records referenced by `evidenceRefs`
- one or more selector traces derived from the field binding for that
  observation

This runbook is intentionally limited to the behavior that is already present in
the repository. There is no standalone CLI or public SDK helper that generates
only an evidence manifest today. The supported observable surfaces are:

- `generateEvidenceManifest` in the shared foundation core
- `bun test tests/libs/foundation-core-evidence-manifest.test.ts`
- `bun run check:e2-capability-slice`
- `bun run example:e2-capability-slice`

For the broader extractor flow around manifest generation, see
`docs/runbooks/e2-extractor-orchestration.md`.

## Current Contract

Today, a generated manifest has this shape:

- top level:
  - `id`: `${snapshot.id}-evidence-manifest`
  - `snapshotId`
  - `targetId`
  - `documentId`
  - `createdAt`: copied from `snapshot.createdAt`
  - `observations`
- each manifest observation:
  - `observationIndex`: the zero-based position from `snapshot.observations`
  - `field`
  - `observation`: the original snapshot observation
  - `artifacts`: decoded artifact metadata records referenced by
    `observation.evidenceRefs`
  - `selectorTraces`: selector resolutions wrapped with `documentId` and
    `rootPath`

The implementation rejects input when any of these conditions are not met:

- an emitted observation references an artifact id that is not present in the
  provided artifact catalog
- an emitted observation field has no matching field binding
- field bindings contain duplicate field names
- a manifest observation resolves to zero artifacts
- selector trace bindings are empty or contain duplicate selector paths
- artifact catalogs contain duplicate artifact ids

## Prerequisites

- Run commands from the repository root:
  `/Users/satan/side/experiments/effect-scrapling`
- Use Bun `1.3.10` or newer. The current examples were validated with Bun
  `1.3.10`.
- Install dependencies:

```bash
bun install --frozen-lockfile
```

- `jq` is optional, but it makes manifest inspection much easier.

## Operator Flow

### 1. Prove the narrow contract first

Run the dedicated manifest tests:

```bash
bun test tests/libs/foundation-core-evidence-manifest.test.ts
```

This verifies three behaviors that exist today:

- observations are bound to artifact metadata and selector traces
- generation fails when `evidenceRefs` contain an artifact id that is not in
  the artifact catalog
- generation fails when a snapshot observation field does not have a selector
  trace binding

### 2. Generate manifests through the supported E2 path

Run the E2 capability slice:

```bash
bun run check:e2-capability-slice
```

This executes the typed example, verifies its tests, and prints the full
evidence payload. The manifest is nested in two places:

- `.baselineReplay.evidenceManifest`
- `.candidateOrchestration.evidenceManifest`

To inspect only the manifest content:

```bash
bun run example:e2-capability-slice \
  | jq '{baselineManifest: .baselineReplay.evidenceManifest, candidateManifest: .candidateOrchestration.evidenceManifest}'
```

To inspect the per-observation linkage that operators usually care about:

```bash
bun run example:e2-capability-slice \
  | jq '.candidateOrchestration.evidenceManifest.observations[]
    | {
        observationIndex,
        field,
        evidenceRefs: .observation.evidenceRefs,
        artifactIds: [.artifacts[].artifactId],
        selectorPaths: [.selectorTraces[].resolution.selectorPath]
      }'
```

In the current example, the candidate manifest emits observations for
`availability`, `price`, and `title`, and each one resolves to at least one
artifact and at least one selector trace.

### 3. Check what changed between baseline and candidate

The current example is useful for verifying selector relocation behavior:

- baseline `price` resolves through `price/fallback`
- candidate `price` resolves through `price/primary`

To compare just the selector paths:

```bash
bun run example:e2-capability-slice \
  | jq '{
      baseline: [.baselineReplay.evidenceManifest.observations[]
        | {field, selectorPaths: [.selectorTraces[].resolution.selectorPath]}],
      candidate: [.candidateOrchestration.evidenceManifest.observations[]
        | {field, selectorPaths: [.selectorTraces[].resolution.selectorPath]}]
    }'
```

That gives operators a fast confirmation that a field still has evidence even
when selector precedence changes.

## SDK Consumer Guidance

### Public SDK status today

Validate the public SDK example with:

```bash
bun run check:e2-sdk-consumer
bun run example:e2-sdk-consumer
```

What this proves today:

- the public import path is `effect-scrapling/sdk`
- downstream consumers can run the public extraction contract end to end
- invalid input is surfaced through typed failures
- expected no-match selector behavior surfaces warnings without crashing the
  consumer flow

What it does not prove:

- it does not emit or document a public evidence manifest contract
- it does not provide a standalone public helper for manifest generation

If a consumer needs evidence manifests today, read them from the typed
orchestration result instead of the public SDK example output. The supported
shape to inspect is the same one emitted by:

```bash
bun run example:e2-capability-slice
```

The manifest lives under `.candidateOrchestration.evidenceManifest` in that
payload.

## Practical Inspection Examples

### Show the manifest header only

```bash
bun run example:e2-capability-slice \
  | jq '.candidateOrchestration.evidenceManifest
    | {id, snapshotId, targetId, documentId, createdAt}'
```

### Verify positive evidence counts per observation

Generated manifest observations cannot contain zero artifacts or zero selector
traces. If either count would be zero, manifest generation fails instead of
emitting a partial observation.

Use this command to inspect the counts that were successfully emitted:

```bash
bun run example:e2-capability-slice \
  | jq '.candidateOrchestration.evidenceManifest.observations[]
    | {
        field,
        artifactCount: (.artifacts | length),
        selectorTraceCount: (.selectorTraces | length)
      }'
```

### Inspect one field end to end

```bash
bun run example:e2-capability-slice \
  | jq '.candidateOrchestration.evidenceManifest.observations[]
    | select(.field == "price")'
```

In the current candidate example, the `price` observation includes:

- `evidenceRefs: ["golden-plan-001-candidate-html"]`
- the matching artifact metadata for `golden-plan-001-candidate-html`
- a selector trace for `price/primary`

## Troubleshooting

### `Observation field <field> references missing evidence artifacts: ...`

Meaning:

- `snapshot.observations[].evidenceRefs` contains an artifact id that is not
  present in the `artifacts` catalog passed to `generateEvidenceManifest`

What to do:

1. Compare every `evidenceRef` for the failing field against the artifact ids in
   the catalog passed into generation.
2. Check that the expected capture artifact actually exists in the orchestration
   input and was not dropped before manifest generation.
3. Re-run:

```bash
bun test tests/libs/foundation-core-evidence-manifest.test.ts
```

### `Observation field <field> does not have a selector trace binding.`

Meaning:

- the snapshot emitted an observation whose `field` does not exist in
  `fieldBindings`

What to do:

1. Verify that each emitted snapshot field has a matching `fieldBindings[].field`
   entry.
2. Re-run the capability slice to confirm the field is represented in the
   emitted manifest:

```bash
bun run check:e2-capability-slice
```

### Schema decode or refinement failures before manifest assembly

Meaning:

- one or more inputs did not satisfy the shared schemas before or during
  manifest assembly

What operators usually see:

- a specific refinement message from the schema layer, for example:
  - `Expected evidence artifact catalogs without duplicate artifact ids.`
  - `Expected evidence field bindings without duplicate fields.`
  - `Expected selector traces with at least one entry and without duplicate selector paths.`
- or, when no more specific message is available:
  - `Failed to decode evidence-manifest input through shared contracts.`
- the implementation also contains a later fallback
  `Observation field <field> could not encode selector traces.`, but with the
  current schemas empty or duplicate selector-resolution lists are rejected
  earlier during input decoding

Common causes from the current implementation:

- duplicate artifact ids in the artifact catalog
- duplicate field names in the field bindings array
- empty selector resolution lists
- duplicate selector paths inside a field binding

What to do:

1. Fix the input data instead of bypassing schema decoding.
2. Re-run the dedicated manifest tests.
3. Re-run the capability slice if the invalid input came from orchestration.

### The public SDK example passes, but there is no manifest in the output

This is expected today. The public SDK example validates the public extraction
surface, not manifest emission. Use the capability slice example when you need
an actual evidence manifest payload.

## Rollout

There is no manifest-specific feature flag or alternate runtime path today.
Rollout is operationally simple:

1. Prove the narrow contract:

```bash
bun test tests/libs/foundation-core-evidence-manifest.test.ts
```

2. Prove the integrated path:

```bash
bun run check:e2-capability-slice
```

3. Prove the adjacent public SDK contract if downstream teams depend on it:

```bash
bun run check:e2-sdk-consumer
```

4. Run the repository gates before declaring the rollout complete:

```bash
bun run ultracite:check
bun run oxlint:check
bun run format:check
bun run check:e2-security-review
bun run check:e2-performance-budget
bun run build
```

Treat any failure as a stop signal. Do not widen types, skip schema decoding, or
strip evidence requirements to force a rollout through.

## Rollback

Rollback is also code-based today. There is no documented runtime switch that
disables evidence manifest generation on demand.

If manifest generation starts failing after a change:

1. Revert the offending extraction, evidence, or orchestration change.
2. Re-run the narrow and integrated checks:

```bash
bun test tests/libs/foundation-core-evidence-manifest.test.ts
bun run check:e2-capability-slice
bun run check:e2-sdk-consumer
```

3. Re-run the repository gates:

```bash
bun run ultracite:check
bun run oxlint:check
bun run format:check
bun run check:e2-security-review
bun run check:e2-performance-budget
bun run build
```

Do not roll back by:

- removing `evidenceRefs` from observations
- allowing manifest observations with zero artifacts
- dropping selector traces for emitted fields
- bypassing shared schema validation
- adding unsafe casts or manual tag branching to suppress typed failures
