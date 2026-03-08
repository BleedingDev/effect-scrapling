# E6 Pack Lifecycle State Machine

## Purpose

This runbook covers the typed E6 lifecycle transitions for `draft`, `shadow`,
`active`, `guarded`, `quarantined`, and `retired` packs.

Primary entrypoints:

- `transitionPackLifecycle(...)` from
  `libs/foundation/core/src/pack-lifecycle-runtime.ts`
- `PackLifecycleTransitionSchema` and `PackStateSchema` from
  `libs/foundation/core/src/site-pack.ts`

Primary validation surface:

- `bun test tests/libs/foundation-core-pack-lifecycle-runtime.test.ts`

## Current Transition Rules

The shared contract only allows explicit typed transitions. The current schema
allows these direct paths:

- `draft -> shadow`
- `draft -> retired`
- `shadow -> active`
- `shadow -> retired`
- `active -> shadow`
- `active -> guarded`
- `active -> quarantined`
- `active -> retired`
- `guarded -> shadow`
- `guarded -> active`
- `guarded -> quarantined`
- `guarded -> retired`
- `quarantined -> shadow`
- `quarantined -> active`
- `quarantined -> retired`

Every successful transition emits one typed `PackLifecycleTransitionEvent`.

## Deterministic Operator Replay

Run the focused lifecycle suite:

```bash
bun test tests/libs/foundation-core-pack-lifecycle-runtime.test.ts
```

Useful covered cases:

- `draft -> shadow` emits a deterministic typed event
- `active -> guarded` preserves pack identity and version
- invalid transitions fail closed
- malformed transition requests fail through shared schema decoding

## Public Package Surface

Verified import paths in the current workspace:

```ts
import { PackLifecycleTransitionSchema } from "@effect-scrapling/foundation-core";
import { transitionPackLifecycle } from "@effect-scrapling/foundation-core/pack-lifecycle-runtime";
```

## Troubleshooting

### Transition was rejected

Check:

1. current `pack.state`
2. requested `to` state
3. non-empty `changedBy`
4. non-empty `rationale`
5. canonical `occurredAt`

If the transition is not in `PackLifecycleTransitionSchema`, the runtime should
reject it. Do not bypass the state machine with manual object mutation.

### Transition event ids changed unexpectedly

Event ids are derived from pack id, version, target state, and timestamp. If
ids move, check those inputs before suspecting the runtime.

## Rollback Guidance

Rollback means:

1. revert the caller that emitted the bad transition
2. rerun `bun test tests/libs/foundation-core-pack-lifecycle-runtime.test.ts`
3. rerun downstream governance tests if the lifecycle change affected promotion
   flow

## Related Runbooks

- `docs/runbooks/e6-pack-governance-actions.md`
- `docs/runbooks/e6-pack-versioning-immutable-active.md`
