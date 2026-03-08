# E6 Pack Governance Actions

## Purpose

This runbook covers the current curator-facing governance surface for pack
promotion, rollback, and quarantine actions in E6.

Primary entrypoint:

- `applyPackGovernanceDecision(...)` from
  `libs/foundation/core/src/pack-governance-runtime.ts`

Primary validation surface:

- `bun test tests/libs/foundation-core-pack-governance-runtime.test.ts`

There is no CLI command or API route for pack governance today. The operational
surface is library-level through the shared runtime and the focused Bun tests.

## Public Package Surface

Verified import path in the current workspace:

```ts
import { applyPackGovernanceDecision } from "@effect-scrapling/foundation-core/pack-governance-runtime";
```

Related shared contracts:

- `PackPromotionDecisionSchema` from
  `@effect-scrapling/foundation-core/diff-verdict`
- `SitePackDslSchema` and `PackStateSchema` from
  `@effect-scrapling/foundation-core/site-pack`

## Action Model

The runtime accepts:

1. a versioned catalog of pack artifacts
2. a selected `subjectPackId` and `subjectPackVersion`
3. a typed `PackPromotionDecision`
4. operator metadata: `changedBy`, `rationale`, `occurredAt`
5. `nextVersion` only when the decision promotes a pack into `active`

The runtime rejects:

- decisions whose `packId` does not match the selected artifact
- decisions whose `fromState` does not match the selected artifact state
- lifecycle-only transitions that try to supply `nextVersion`
- activations that omit `nextVersion`
- activations whose `nextVersion` does not sort after the newest historical
  version for that pack id

## Operational Semantics

### Promote shadow to active

When `toState` is `active`:

- the subject artifact stays in historical storage at its current version
- a new active artifact is created at `nextVersion`
- if another artifact is currently `active`, it is demoted to `shadow`
- the result emits audit records for both the demotion and activation

### Roll back to a historical version

Rollback is just another typed activation:

- choose a historical `shadow`, `guarded`, or `quarantined` artifact
- supply a fresh `nextVersion`
- the runtime creates a new active artifact from that historical definition
- the current active artifact is demoted to `shadow`
- the result emits the same two-audit-record pattern as forward promotion

### Quarantine a version

Quarantine is lifecycle-only:

- it updates the selected artifact in place
- it must not supply `nextVersion`
- it emits one `transition` audit record
- no replacement active artifact is minted

## Deterministic Operator Replay

Run the governance suite directly:

```bash
bun test tests/libs/foundation-core-pack-governance-runtime.test.ts
```

Covered scenarios:

- shadow promotion into a fresh active version
- rollback activation from a quarantined historical artifact
- quarantine in place without minting a new version
- missing `nextVersion` on activation
- stale `nextVersion` on activation
- forbidden `nextVersion` on lifecycle-only actions
- mismatched curator decision source state
- duplicate catalog artifact keys
- multiple active artifacts for one pack id

For adjacent lifecycle-only replay:

```bash
bun test tests/libs/foundation-core-pack-lifecycle-runtime.test.ts
```

## Troubleshooting

### Activation fails with a `nextVersion` error

Check:

1. `nextVersion` is present for every activation into `active`
2. `nextVersion` is omitted for `guarded`, `quarantined`, `shadow`, or
   `retired` transitions
3. `nextVersion` sorts after every historical version already recorded for the
   same `packId`

### Decision is rejected for source-state drift

Check:

1. the selected `subjectPackVersion` really points at the intended artifact
2. the `PackPromotionDecision.fromState` matches that artifact's current state
3. the catalog has not already been rewritten by another promotion path

### Audit history looks incomplete

Expected result shapes:

- activation: two audit records when another active artifact existed
- activation without previous active: one `activate-version` audit record
- lifecycle-only transition: one `transition` audit record

If this changes, replay the focused governance suite before trusting the
catalog.

## Rollback Guidance

To back out a bad active promotion:

1. identify the last stable historical artifact version
2. promote it back into `active` with a fresh `nextVersion`
3. rerun `bun test tests/libs/foundation-core-pack-governance-runtime.test.ts`
4. rerun full repository gates before bead closure or broader rollout

Forbidden rollback shortcuts:

- mutating the current active artifact in place
- reusing an already-recorded historical version as the new active version
- bypassing `PackPromotionDecisionSchema` with ad hoc object shapes

## Related Runbooks

- `docs/runbooks/e6-shadow-active-governance-automation.md`
- `docs/runbooks/e6-pack-versioning-immutable-active.md`
- `docs/runbooks/e6-pack-registry-resolution.md`
- `docs/runbooks/e1-site-pack-state.md`
