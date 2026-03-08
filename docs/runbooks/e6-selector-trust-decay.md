# E6 Selector Trust Decay

## Purpose

This runbook covers the E6 selector trust runtime that turns observed selector
successes and failures into deterministic trusted / degraded / blocked bands.

Primary entrypoint:

- `summarizeSelectorTrust(...)` from
  `libs/foundation/core/src/selector-trust-decay.ts`

Primary validation surface:

- `bun test tests/libs/foundation-core-selector-trust-decay.test.ts`

## What It Consumes

The runtime accepts:

- typed selector trust events, including an empty list when no selector history
  exists yet
- a deterministic `evaluatedAt`
- an optional threshold and weighting policy

The default policy includes:

- `halfLifeHours`
- `priorSuccessWeight`
- `priorFailureWeight`
- recoverable and hard-failure penalties
- `degradedThreshold`
- `trustedThreshold`

Malformed policies fail closed through shared schema decoding.

## What It Produces

The runtime emits one `SelectorTrustSummary` with:

- deterministic per-selector records
- weighted success and failure counts
- a normalized trust score
- one trust band per selector:
  - `trusted`
  - `degraded`
  - `blocked`
- merged evidence references

The output ordering is deterministic by band severity, then score, then
selector path.

## Deterministic Operator Replay

Run the focused trust suite:

```bash
bun test tests/libs/foundation-core-selector-trust-decay.test.ts
```

Useful covered cases:

- recent successful selectors stay trusted
- recoverable failures degrade trust without immediate blocking
- repeated hard failures block selectors
- stale failures decay before new successes restore trust
- summaries sort deterministically
- malformed trust policies are rejected

## Troubleshooting

### A selector is unexpectedly `blocked`

Check:

1. how many recent hard failures were observed
2. whether the failures are within the configured half-life
3. whether your policy penalties were widened

### A selector never leaves `degraded`

Check:

1. whether new successful observations are arriving
2. whether stale failures are old enough to decay materially
3. whether `trustedThreshold` was set too high

## Rollback Guidance

Rollback means:

1. restore the previous selector evidence feed or trust policy
2. rerun `bun test tests/libs/foundation-core-selector-trust-decay.test.ts`
3. rerun the downstream candidate / reflector surfaces if trust output changed
   pack promotion input

Do not:

- hand-force a selector back to `trusted`
- skip the evidence history because one page is noisy
- loosen thresholds without replaying the focused trust suite

## Related Runbooks

- `docs/runbooks/e6-pack-candidate-generator.md`
- `docs/runbooks/e6-reflector-clustering.md`
