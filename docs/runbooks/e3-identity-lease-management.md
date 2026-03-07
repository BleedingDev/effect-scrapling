# E3 Identity Lease Management

## Purpose

Operate and troubleshoot the E3 identity-lease boundary that prevents unbounded
identity reuse inside a scoped owner/tenant/domain budget while emitting
lease-lifecycle evidence.

Primary implementation and validation surfaces:

- `libs/foundation/core/src/identity-lease-runtime.ts`
- `tests/libs/foundation-core-identity-lease.test.ts`
- `docs/runbooks/e3-concurrency-budget-semaphores.md`

## Contract

`makeInMemoryIdentityLeaseManager(...)` is the current runtime surface.

Current guarantees:

- scopes are keyed by:
  - `ownerId`
  - `tenantId`
  - `domain`
- `maxActiveLeases` is enforced per scope
- duplicate active `identityKey` values are rejected inside the same scope
- renew, release, inspect, and lifecycle-event surfaces are all typed
- expired leases are swept before new allocation decisions
- lifecycle events record:
  - `allocated`
  - `renewed`
  - `released`
  - `expired`

Current examples proven by `tests/libs/foundation-core-identity-lease.test.ts`:

- the same scope cannot exceed its active lease budget
- the same scope cannot acquire the same `identityKey` twice while active
- renew extends `expiresAt`
- release removes the lease from the active scope
- expiry sweep emits an `expired` lifecycle event
- tenant and domain scopes stay isolated from each other
- scopes remain distinct even when identifiers contain separator characters
- parallel acquisition still honors the scope budget

## Validation Commands

Focused identity-lease validation:

```bash
bun test tests/libs/foundation-core-identity-lease.test.ts
```

Integrated E3 validation:

```bash
bun run check:e3-capability-slice
bun run check:e3-access-runtime
```

## Operator Workflow

### 1. Reproduce lease allocation and lifecycle behavior directly

Run:

```bash
bun test tests/libs/foundation-core-identity-lease.test.ts
```

This suite currently proves:

- active-budget exhaustion is enforced
- duplicate identity reuse is blocked
- renew and release mutate the active scope correctly
- expiry sweep collapses the scope back to zero active leases
- lifecycle events are emitted in deterministic order

### 2. Treat scope boundaries as the primary debugging key

Always triage identity-lease issues by scope:

- `ownerId`
- `tenantId`
- `domain`

The current manager intentionally allows the same `identityKey` to exist in a
different tenant or domain scope. That is not a bug.

### 3. Distinguish exhaustion from duplication

These are different operator states:

- exhaustion means the scope has no free active slots
- duplication means the exact `identityKey` is already leased inside the scope

Do not treat them as the same incident class in ops notes or follow-up work.

## Troubleshooting

### A lease request fails with an exhaustion message

Inspect the current scope snapshot with the same scope values used in the
request. If the scope is legitimately full, do not widen the budget casually.

The current contract wants bounded reuse, not silent over-allocation.

### A lease request fails as a duplicate even though the caller expects reuse

Check whether the earlier lease was actually released or expired.

If reuse is needed sooner, fix the caller lifecycle or the renewal-release
sequence. Do not weaken duplicate detection.

### Parallel acquisition behaves inconsistently

Re-run:

```bash
bun test tests/libs/foundation-core-identity-lease.test.ts
```

The current suite already covers unbounded concurrency on the same scope and is
the first place to confirm whether the regression is real.

## Rollout and Rollback

Roll forward only after:

```bash
bun test tests/libs/foundation-core-identity-lease.test.ts
bun run check:e3-capability-slice
bun run check:e3-access-runtime
```

Rollback by reverting the identity-lease change and rerunning the same
commands.

Do not roll back by:

- allowing duplicate active identity keys inside one scope
- flattening tenant-domain scope boundaries
- skipping expiry sweep before new allocations
- introducing manual `_tag`, `instanceof`, or unsafe casts
