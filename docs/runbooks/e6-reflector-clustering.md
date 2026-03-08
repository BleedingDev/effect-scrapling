# E6 Reflector Clustering and Pattern Synthesis

## Purpose

This runbook covers the E6 reflector runtime that turns repeated extraction
signals into one pack-level recommendation instead of ad hoc one-off selector
hacks.

Primary entrypoint:

- `synthesizePackReflection(...)` from
  `libs/foundation/core/src/reflector-runtime.ts`

Primary validation surface:

- `bun test tests/libs/foundation-core-reflector-runtime.test.ts`

## What The Reflector Consumes

The reflector accepts:

- a typed site-pack DSL definition
- recurring pack-candidate signals
- an operator-controlled `minimumOccurrenceCount`
- a deterministic `createdAt` timestamp

Supported signal classes today:

- required-field failures
- business-invariant failures
- selector regressions
- fixture consensus signals

The reflector refuses to emit output when:

- signals do not recur above the configured threshold
- recurring signals still do not produce an actionable pack-level delta
- input does not decode through the shared schemas

## What It Produces

The runtime emits one `PackReflectionRecommendation` with:

- stable pack identifier
- deterministic cluster ordering
- one or more typed `ReflectorCluster` entries
- one synthesized `PackCandidateProposal`
- one operator-readable rationale

The reflector is intentionally pack-level. If you find yourself trying to patch a
single extraction failure directly, stop and feed the signal back through the
reflector instead.

## Deterministic Operator Replay

Run the focused suite:

```bash
bun test tests/libs/foundation-core-reflector-runtime.test.ts
```

Useful covered cases:

- recurring failures collapse into one pack-level recommendation
- multiple recurring clusters synthesize one proposal
- non-recurring noise is rejected
- recurring but no-op deltas are rejected
- selector-path spellings remain distinct and do not collide

## Troubleshooting

### No recommendation emitted

Expected causes:

- threshold too high for the observed evidence volume
- repeated signals still point to an already-active selector candidate
- signal payload drifted and no longer decodes

Operator actions:

1. confirm the evidence really recurs
2. confirm the candidate selector path is not already active
3. confirm the signal payload still decodes through shared schemas

### Too many one-off signals

This is usually not a reflector problem. It usually means upstream extraction is
feeding low-quality evidence.

Check these first:

1. `docs/runbooks/e2-selector-relocation.md`
2. `docs/runbooks/e2-assertion-engine.md`
3. `docs/runbooks/e2-golden-fixtures.md`

## Rollback Guidance

The reflector itself does not mutate site packs. Rollback means:

1. stop consuming the synthesized proposal
2. keep the raw recurring evidence
3. re-run the focused test surface before re-enabling proposal generation

Do not:

- hand-edit one production extraction path to “just make this case pass”
- collapse multiple distinct selector paths into one synthetic cluster id
- bypass schema decoding for signal ingestion

## Related Runbooks

- `docs/runbooks/e2-selector-relocation.md`
- `docs/runbooks/e2-assertion-engine.md`
- `docs/runbooks/e2-golden-fixtures.md`
- `docs/runbooks/e6-validator-ladder.md`
