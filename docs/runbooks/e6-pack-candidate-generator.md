# E6 Pack Candidate Generator

## Purpose

This runbook covers the E6 candidate generator that turns typed failure,
regression, and fixture evidence into immutable pack-delta proposals.

Primary entrypoint:

- `generatePackCandidate(...)` from
  `libs/foundation/core/src/pack-candidate-generator.ts`

Primary validation surface:

- `bun test tests/libs/foundation-core-pack-candidate-generator.test.ts`

## What It Consumes

The generator accepts:

- one typed `SitePackDsl`
- one or more typed signals:
  - `failure`
  - `regression`
  - `fixture`
- a deterministic `createdAt`

Each signal must carry non-empty unique evidence references.

## What It Produces

The runtime emits one `PackCandidateProposal` with:

- stable source pack identity
- immutable source-pack state
- a draft target pack state for changes
- deterministic operation ordering
- merged evidence references
- merged fixture ids when the same operation recurs

Current supported operations:

- `appendSelectorCandidate`
- `promoteSelectorCandidate`

The generator does not mutate active packs in place. Active sources always emit
draft proposals.

## Deterministic Operator Replay

Run the focused candidate suite:

```bash
bun test tests/libs/foundation-core-pack-candidate-generator.test.ts
```

Useful covered cases:

- append a new selector candidate from failure evidence
- promote an existing fallback selector instead of appending a duplicate
- keep active packs immutable
- deduplicate repeated signals into one operation
- reject undeclared field targets
- reject signals that produce no actionable delta

## Troubleshooting

### No proposal was emitted

Check:

1. signals point at declared selector fields
2. the proposed selector candidate is not already the active selector
3. evidence refs are present and unique

### A proposal mutated the source pack

That should not happen. The focused suite explicitly asserts immutable behavior
for active packs. Treat this as a bug and rerun the focused candidate test
surface before shipping anything.

## Rollback Guidance

Rollback means:

1. stop consuming the generated proposal
2. preserve the source evidence
3. rerun `bun test tests/libs/foundation-core-pack-candidate-generator.test.ts`
4. rerun reflector synthesis if the proposal was already fed downstream

## Related Runbooks

- `docs/runbooks/e6-site-pack-dsl-contracts.md`
- `docs/runbooks/e6-reflector-clustering.md`
