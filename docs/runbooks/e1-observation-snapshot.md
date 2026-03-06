# E1 Observation and Snapshot Schema Runbook

## Purpose

Use this runbook when operators, SDK consumers, or extraction authors need to
validate or troubleshoot canonical `Observation` and `Snapshot` contracts in
`@effect-scrapling/foundation-core`.

This contract keeps extraction outputs evidence-backed, quality-scored, and
safe to persist or compare across workflow boundaries.

Policy baseline:
- Effect v4 only.
- No Effect v3 dependencies or compatibility shims.
- No manual `instanceof`, manual `_tag`, or type-safety bypass shortcuts.

## Public Contract

Current exports:
- `Observation`
- `ObservationSchema`
- `Snapshot`
- `SnapshotSchema`
- `CanonicalIdentifierSchema`

Canonical field expectations:
- `field` must be trimmed and non-empty.
- `confidence` and `qualityScore` must be bounded to the inclusive range
  `0..1`.
- `evidenceRefs` must be unique, canonical identifiers and cannot be empty.
- `createdAt` must be a strict UTC ISO-8601 timestamp in
  `YYYY-MM-DDTHH:mm:ss(.sss)?Z` form.

Additional invariants:
- no observation without evidence
- `price` observations must include both numeric `amount` and non-empty
  `currency`
- snapshot persistence and restore must roundtrip through the public schema

## Command Usage

Run targeted verification from repository root:

```bash
bun test tests/libs/foundation-core-workflow.test.ts
bun test tests/guardrails/e1-capability-slice.verify.test.ts
```

Run touched-project compilation checks:

```bash
bunx --bun tsc --noEmit -p libs/foundation/core/tsconfig.json
bunx --bun tsc --noEmit -p apps/api/tsconfig.json
bunx --bun tsc --noEmit -p apps/cli/tsconfig.json
```

Run the full repository gates before closure:

```bash
bun run check
bun run nx:show-projects
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

## Practical Example

```ts
import { Schema } from "effect";
import { SnapshotSchema } from "@effect-scrapling/foundation-core";

const snapshot = Schema.decodeUnknownSync(SnapshotSchema)({
  id: "snapshot-001",
  targetId: "target-product-001",
  observations: [
    {
      field: "price",
      normalizedValue: {
        amount: 19.99,
        currency: "USD",
      },
      confidence: 0.9,
      evidenceRefs: ["artifact-price-001"],
    },
  ],
  qualityScore: 0.88,
  createdAt: "2026-03-06T00:00:00.000Z",
});
```

Expected behavior:
- decode fails if evidence is missing or scores are out of range
- price normalization is rejected without currency context
- encode returns the stable snapshot transport payload for persistence

## Troubleshooting

### Evidence validation fails

`evidenceRefs` rejects:
- empty arrays
- duplicate artifact identifiers
- malformed canonical identifiers

Do not patch around this in extractor code. Fix the capture or evidence-linking
step so every observation points to durable artifacts.

### Price observation validation fails

If `field` is `price`, `normalizedValue` must contain:
- finite numeric `amount`
- non-empty `currency`

Reject partial price payloads instead of filling defaults such as `"USD"` or
`0`, because those hide extraction drift.

### Timestamp validation fails

`createdAt` must be a UTC ISO string such as
`2026-03-06T00:00:00.000Z`. Human-readable strings like `March 6 2026` are
rejected. Normalize timestamps before schema decode and keep storage UTC-only.

## Rollout Guidance

1. Prepare
- update extractors and snapshot writers to decode through `ObservationSchema`
  and `SnapshotSchema`
- verify representative payloads with
  `bun test tests/guardrails/e1-capability-slice.verify.test.ts`

2. Apply
- remove parallel ad hoc snapshot DTO validation
- keep evidence linking and normalization explicit before persistence

3. Verify
- run targeted tests
- run touched-project typechecks
- run `bun run check`

4. Promote
- merge only when workflow and capability-slice verification are green

## Rollback Guidance

1. Revert the producer change that introduced invalid evidence references,
   malformed price payloads, or non-deterministic timestamps.
2. Re-run:

```bash
bun test tests/libs/foundation-core-workflow.test.ts
bun test tests/guardrails/e1-capability-slice.verify.test.ts
bun run check
```

3. Keep the schema invariants intact; do not add fallback DTO coercion,
   heuristic timestamp parsing, or manual `instanceof` or manual `_tag` checks
   to force bad payloads through.
4. Re-attempt rollout only after extraction outputs are corrected and the
   canonical observation contract is green again.

## Operator Notes

- Treat decode failures as extraction contract bugs, not recoverable runtime
  noise.
- Preserve evidence-backed observations all the way into snapshot persistence
  and diffing inputs.
- Effect v4 only remains mandatory for any future observation or snapshot
  extensions.
