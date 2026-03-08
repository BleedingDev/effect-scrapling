# E6 Validator Ladder Pipeline

## Purpose

This runbook covers the E6 validator ladder that turns snapshot-diff metrics and
runtime checks into one typed pack verdict.

Primary entrypoint:

- `evaluateValidatorLadder(...)` from
  `libs/foundation/core/src/validator-ladder-runtime.ts`

Primary validation surface:

- `bun test tests/libs/foundation-core-validator-ladder-runtime.test.ts`

## Inputs

The validator ladder consumes:

- a typed `SitePack`
- a typed `SnapshotDiff`
- explicit replay / resume / canary / chaos / redaction checks
- an optional threshold policy
- a deterministic `createdAt`

The default policy enforces:

- bounded recall regression
- bounded false-positive drift
- bounded snapshot drift
- bounded latency delta
- bounded memory delta

Malformed policies fail closed through shared schema decoding.

## Outputs

The runtime emits one `PackValidationVerdict` with:

- pack and diff identifiers
- explicit metric deltas
- one result per ladder stage:
  - `schema`
  - `replay`
  - `canary`
  - `chaos`
- one `qualityVerdict` with action and gate statuses

Current actions:

- green `draft` pack -> `promote-shadow`
- green non-draft pack -> `active`
- critical failure on `draft` pack -> `retired`
- critical failure on non-draft pack -> `quarantined`
- non-critical failure -> `guarded`

Critical failures are:

- workflow resume failure
- security redaction failure
- soak / chaos instability

## Deterministic Operator Replay

Run the focused suite:

```bash
bun test tests/libs/foundation-core-validator-ladder-runtime.test.ts
```

Useful covered cases:

- full green verdict with all deltas carried through
- draft promotion only to `shadow`
- guarded output for threshold-only failures
- quarantined output for critical failures
- malformed policy rejection

For the upstream quality evidence that feeds this ladder, use:

```bash
bun run check:e5-workflow-simulation
bun run check:e5-crash-resume-harness
bun run check:e4-browser-soak-load
```

## Troubleshooting

### Unexpected `guarded`

Check:

1. `driftDelta`
2. `latencyDeltaMs`
3. `memoryDelta`
4. canary result

This is the expected outcome when quality thresholds fail but the runtime is not
in a critical safety state.

### Unexpected `quarantined`

Check:

1. replay determinism
2. workflow resume
3. security redaction
4. soak / chaos stability

This is the expected outcome when the candidate is unsafe, not merely weaker.

## Rollback Guidance

Do not widen thresholds casually after a red verdict.

Rollback sequence:

1. keep the failing `SnapshotDiff`
2. keep the emitted `PackValidationVerdict`
3. inspect the failing gate or stage
4. remediate upstream extraction, runtime, or pack logic
5. rerun the focused validator suite and the upstream benchmark/check surfaces

## Related Runbooks

- `docs/runbooks/e6-shadow-active-governance-automation.md`
- `docs/runbooks/e2-snapshot-diff-engine.md`
- `docs/runbooks/e4-browser-soak-load.md`
- `docs/runbooks/e5-workflow-simulation.md`
- `docs/runbooks/e5-crash-resume-harness.md`
- `docs/runbooks/e6-reflector-clustering.md`
