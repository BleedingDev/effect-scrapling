# E6 Shadow To Active Governance Automation

## Purpose

This runbook operationalizes the current E6 automation path that moves a pack
candidate from `shadow` to `active` only after the validator ladder, reflection
decision, and governance runtime all agree.

This runbook is intentionally limited to behavior that exists in the repository
today. There is no dedicated CLI command or API route for this flow yet. The
operator surface is library-level through the shared runtimes and the focused
test suites below.

## Automation Chain

The current shadow-to-active chain is:

1. `evaluateValidatorLadder(...)`
2. `decidePackPromotion(...)`
3. `applyPackGovernanceDecision(...)`
4. `transitionPackLifecycle(...)` for the active demotion or any lifecycle-only
   fallback

Verified import paths in the current workspace:

```ts
import { evaluateValidatorLadder } from "@effect-scrapling/foundation-core/validator-ladder-runtime";
import { decidePackPromotion } from "@effect-scrapling/foundation-core/reflection-engine-runtime";
import { applyPackGovernanceDecision } from "@effect-scrapling/foundation-core/pack-governance-runtime";
```

## Promotion Gates

`shadow -> active` automation is allowed only when all of these are true:

- the selected pack is currently in `shadow`
- every validator gate is `pass`
- recall delta is at least `-0.05`
- false-positive delta is at most `0.05`
- drift delta is at most `0.1`
- latency delta is at most `250ms`
- memory delta is at most `32`
- replay determinism, workflow resume, canary, chaos, security redaction, and
  soak stability all pass

Current action mapping:

- green `draft` pack -> `promote-shadow`
- green `shadow` pack -> `active`
- non-critical failing pack -> `guarded`
- critical failing non-draft pack -> `quarantined`
- critical failing draft pack -> `retired`

Critical failures are:

- `workflowResume`
- `securityRedaction`
- `soakStability`

The reflection engine rejects `promote-shadow` and `active` automation if any
validator gate is still failing.

## Practical Execution Example

Use the shared runtimes in this order:

```ts
const validation = yield* evaluateValidatorLadder({
  pack,
  snapshotDiff,
  checks,
  createdAt: "2026-03-08T12:00:00.000Z",
});

const decision = yield* decidePackPromotion({
  pack,
  verdict: validation.qualityVerdict,
});

const result = yield* applyPackGovernanceDecision({
  catalog,
  subjectPackId: pack.id,
  subjectPackVersion: pack.version,
  decision,
  changedBy: "curator-main",
  rationale: "shadow pack passed the promotion ladder",
  occurredAt: "2026-03-08T12:30:00.000Z",
  nextVersion: "2026.03.09",
});
```

Green-path expectations from the current runtime and tests:

- `decision.fromState` is `shadow`
- `decision.toState` is `active`
- `decision.action` is `active`
- `nextVersion` is required and must sort after every recorded version for that
  `packId`
- the promoted artifact is copied into a new `active` version
- any previous `active` artifact is demoted to `shadow`
- the audit trail records the activation and, when applicable, the active
  demotion

## Truthful Validation Commands

Replay the end-to-end automation surface with these focused commands:

```bash
bun test tests/libs/foundation-core-validator-ladder-runtime.test.ts
bun test tests/libs/foundation-core-reflection-engine-runtime.test.ts
bun test tests/libs/foundation-core-pack-governance-runtime.test.ts
bun test tests/libs/foundation-core-pack-lifecycle-runtime.test.ts
bun run check:e6-capability-slice
```

What each command proves today:

- `foundation-core-validator-ladder-runtime.test.ts`: gate thresholds, action
  mapping, and critical-failure handling
- `foundation-core-reflection-engine-runtime.test.ts`: only fully green
  verdicts can automate `shadow -> active`
- `foundation-core-pack-governance-runtime.test.ts`: `nextVersion` rules,
  immutable active promotion, rollback activation, and audit trail emission
- `foundation-core-pack-lifecycle-runtime.test.ts`: lifecycle guardrails still
  fail closed, including invalid direct `draft -> active` moves

Before broader rollout or bead closure, rerun the repository gates that defend
the documented surface:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

## Troubleshooting

### Promotion automation is rejected before governance runs

Check:

1. every validator gate is `pass`
2. the verdict `packId` matches the selected pack id
3. the selected pack is still in `shadow`

If a verdict contains any failing gate, `decidePackPromotion(...)` should reject
`active` automation.

### Governance rejects the activation

Check:

1. `subjectPackId` and `subjectPackVersion` select an artifact that exists in
   the current catalog
2. `decision.fromState` matches the selected artifact state
3. `nextVersion` is present
4. `nextVersion` sorts after the newest recorded version for the same `packId`

Do not mutate the current active artifact in place and do not reuse an existing
historical version as the new active version.

### Audit output looks incomplete

Expected current shapes:

- activation with previous active artifact: one `demote-previous-active` record
  plus one `activate-version` record
- first activation with no previous active artifact: one `activate-version`
  record
- lifecycle-only fallback such as `guarded` or `quarantined`: one `transition`
  record

If that behavior changes, replay the focused E6 suites above before trusting
the catalog.

## Rollout And Rollback

Normal rollout:

1. validate the candidate through the validator ladder
2. confirm the reflected decision is `shadow -> active`
3. apply governance with a fresh `nextVersion`
4. verify the previous active artifact moved to `shadow`
5. rerun the focused E6 suites and then repository gates

Rollback:

1. identify the last stable historical artifact in `shadow`, `guarded`, or
   `quarantined`
2. reactivate it through `applyPackGovernanceDecision(...)`
3. mint a fresh `nextVersion`
4. verify the current active artifact was demoted to `shadow`
5. rerun the focused E6 suites and repository gates

Forbidden shortcuts:

- skipping the validator ladder and hand-authoring an `active` decision
- bypassing `PackPromotionDecisionSchema`
- mutating an `active` artifact in place
- reusing an existing historical version as the new active version

## Related Runbooks

- `docs/runbooks/e6-validator-ladder.md`
- `docs/runbooks/e6-pack-governance-actions.md`
- `docs/runbooks/e6-pack-versioning-immutable-active.md`
- `docs/runbooks/e6-pack-lifecycle-state-machine.md`
- `docs/runbooks/e1-site-pack-state.md`
