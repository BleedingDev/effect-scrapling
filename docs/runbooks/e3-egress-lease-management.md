# E3 Egress Lease Management Runbook

## Purpose

Use this runbook when operators or runtime authors need to validate and
troubleshoot the in-memory E3 egress lease allocator implemented in:

- `libs/foundation/core/src/egress-lease-runtime.ts`
- `libs/foundation/core/src/budget-lease-artifact.ts`
- `tests/libs/foundation-core-egress-lease.test.ts`
- `examples/e3-capability-slice.ts`
- `tests/examples/e3-capability-slice.test.ts`

This runbook only documents behavior that exists today. It does not assume:

- persistent proxy-pool state across process restarts
- weighted proxy selection or health scoring
- background renewal loops
- package-root exports for the egress runtime

Policy baseline:

- Effect v4 only
- schema-first decode on acquire, renew, release, and scope inspection
- no manual `_tag`, no manual `instanceof`, no type-safety bypasses

## Current Runtime Contract

Current exports from `egress-lease-runtime.ts`:

- `EgressLeaseScope`
- `EgressLeaseAcquireRequest`
- `EgressLeaseRenewalRequest`
- `EgressLeaseRecord`
- `EgressLeaseScopeSnapshot`
- `EgressLeaseLifecycleEvent`
- `EgressLeaseUnavailable`
- `makeInMemoryEgressLeaseManager`

Current manager methods:

- `acquire(request)`
- `renew({ leaseId, ttlMs })`
- `release(leaseId)`
- `inspectScope({ ownerId, poolId, routePolicyId })`
- `events()`

What `acquire(...)` enforces today:

1. Decodes the request through `EgressLeaseAcquireRequest`.
2. Sweeps expired leases before budget evaluation.
3. Enforces `maxPoolLeases` for `{ ownerId, poolId }`.
4. Enforces `maxRouteLeases` for `{ ownerId, poolId, routePolicyId }`.
5. Rejects duplicate `egressKey` reuse inside the same route scope.
6. Emits `allocated` events with scope snapshots after successful writes.

Current failure messages are explicit and stable:

- pool saturation: `Egress pool <poolId> exhausted its <n> active lease budget.`
- route saturation:
  `Route policy <routePolicyId> exhausted its <n> active egress leases.`
- duplicate egress key:
  `Egress key <egressKey> is already allocated for route <routePolicyId>.`

Operational limits:

- lease state is in-memory per manager instance
- `release(...)` returns `Option.none()` when the lease is already gone
- `renew(...)` fails with `PolicyViolation` if the lease already expired or was
  released
- events are append-only for that manager instance

## Command Usage

Run the focused runtime checks from repository root:

```bash
bun test tests/libs/foundation-core-egress-lease.test.ts
bun test tests/examples/e3-capability-slice.test.ts
bun run check:e3-capability-slice
```

Run the full repository gates before bead closure or merge:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

## Practical Execution Examples

### Validate pool and route caps directly

`tests/libs/foundation-core-egress-lease.test.ts` is the committed stress
check. It proves:

- one route can saturate while another route in the same pool still fits
- the pool cap can saturate independently of the route cap
- renewals extend `expiresAt`
- released and expired leases both clear the active scope counts
- the event sequence remains:
  `["allocated", "allocated", "renewed", "released", "expired"]`

Run the test and inspect only the saturation case:

```bash
bun test tests/libs/foundation-core-egress-lease.test.ts \
  --test-name-pattern "enforces pool and route budgets while emitting lease telemetry"
```

### Inspect the deterministic E3 capability slice

The current E3 example allocates and then releases an egress lease around the
HTTP capture path.

Run:

```bash
bun run example:e3-capability-slice | jq '{
  lease: .egressLease,
  scopeDuringRun: .egressScopeDuringRun,
  scopeAfterRun: .egressScopeAfterRun,
  events: [.egressEvents[].kind]
}'
```

Healthy evidence:

- `scopeDuringRun.activePoolLeaseCount === 1`
- `scopeDuringRun.activeRouteLeaseCount === 1`
- `scopeAfterRun.activePoolLeaseCount === 0`
- `scopeAfterRun.activeRouteLeaseCount === 0`
- `events == ["allocated", "released"]`

## Troubleshooting

### Route policy exhausts before the pool

Symptoms:

- acquire fails with `Route policy <routePolicyId> exhausted ...`
- `inspectScope(...).activePoolLeaseCount` may still be below the pool cap

Response:

- rotate to another route policy if policy allows it
- do not raise `maxRouteLeases` without also checking route isolation needs

### Pool exhausts before the route

Symptoms:

- acquire fails with `Egress pool <poolId> exhausted ...`
- other route policies under the same pool are already consuming the budget

Response:

- reduce concurrent runs sharing that pool
- add another pool instead of weakening the cap blindly

### Renew fails with `PolicyViolation`

Meaning:

- the lease was already released or expired before the renew call ran

Response:

- reacquire a new lease instead of retrying the renewal indefinitely
- verify callers are not extending expired leases after timeout/cancellation

## Rollout And Rollback

Roll out egress-runtime changes only when:

- the focused egress lease test is green
- the E3 capability slice remains green
- full repository gates are green

Rollback guidance for this runtime today:

- there is no feature flag for the in-memory allocator
- revert the `egress-lease-runtime.ts` change together with any touched tests
  and runbook updates
- rerun the focused egress test, the E3 capability slice, and the full gates

