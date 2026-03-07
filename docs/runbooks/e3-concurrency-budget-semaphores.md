# E3 Concurrency Budget Semaphore Runbook

## Purpose

Use this runbook when operators or current in-repo SDK consumers need to
validate, observe, troubleshoot, roll out, or roll back the E3 concurrency
budget semaphores implemented in:

- `libs/foundation/core/src/access-budget-runtime.ts`
- `libs/foundation/core/src/budget-lease-artifact.ts`
- `libs/foundation/core/src/access-planner-runtime.ts`
- `tests/libs/foundation-core-access-budget.test.ts`
- `examples/e3-capability-slice.ts`
- `tests/examples/e3-capability-slice.test.ts`

Current scope limits:

- semaphore state, utilization snapshots, and event history are in-memory per
  `makeInMemoryAccessBudgetManager(...)` instance
- permit acquisition is fail-fast through `TxSemaphore.tryAcquire(...)`; the
  runtime does not queue callers
- there is no dedicated CLI or benchmark wrapper for this runtime today
- `makeInMemoryAccessBudgetManager(...)` is not re-exported from
  `libs/foundation/core/src/index.ts` today; current consumers import the
  source file directly inside this repo

Policy baseline:

- Effect v4 only
- budget payloads and domains are decoded through shared schemas before use
- no type-safety bypasses, manual tag inspection, or raw semaphore mutations in
  calling code

## Current Runtime Contract

Current exports from `libs/foundation/core/src/access-budget-runtime.ts`:

- `DomainBudgetUtilization`
- `AccessBudgetSnapshot`
- `AccessBudgetEvent`
- `BudgetExceededError`
- `makeInMemoryAccessBudgetManager`

Budget shape from `ConcurrencyBudgetSchema`:

- `id`: canonical identifier
- `ownerId`: canonical identifier
- `globalConcurrency`: integer `1..4096`
- `maxPerDomain`: integer `1..128`
- invariant: `globalConcurrency >= maxPerDomain`

Current manager methods:

- `withPermit(budget, domain, effect)`
- `inspect(budget)`
- `events()`

What `withPermit(...)` does now:

1. Decodes the budget through `ConcurrencyBudgetSchema`.
2. Decodes the domain through `CanonicalDomainSchema`.
3. Reuses or creates one budget state per `budget.id`.
4. Tries the global semaphore first.
5. Tries the domain semaphore second.
6. Records `acquired`, `released`, or `rejected` with a full
   `AccessBudgetSnapshot`.
7. Releases held permits through `Effect.acquireUseRelease(...)`, so the permit
   is released when the wrapped effect succeeds, fails, or is interrupted.

Operational consequences from the current code:

- `BudgetExceededError.message` is the same for global and per-domain denial:
  `Concurrency budget <id> denied access for <domain>.`
- when domain acquisition fails, the runtime releases the just-acquired global
  permit before it records the `rejected` event
- the first budget definition seen for a given `budget.id` wins for the
  lifetime of that manager instance; later calls with the same `budget.id` and
  different numeric limits keep using the original semaphore capacities
- `events()` returns one append-only list for every budget handled by that
  manager instance; callers must filter by `budgetId` and `domain` themselves

## Utilization Metrics

`inspect(...)` and `events()[n].snapshot` expose the current utilization shape:

- `globalCapacity`
- `globalAvailable`
- `globalInUse`
- `domains[]`
- `domains[].domain`
- `domains[].capacity`
- `domains[].available`
- `domains[].inUse`

How to read the fields:

- `globalInUse = globalCapacity - globalAvailable`
- `domains[].inUse = domains[].capacity - domains[].available`
- domain rows are unique and sorted lexicographically by domain
- a domain row does not exist until that domain has been touched by
  `withPermit(...)`

How to distinguish rejection causes with current telemetry:

- `globalAvailable === 0` means the global budget is saturated
- `globalAvailable > 0` plus `domains[target].available === 0` means the
  per-domain cap is saturated
- the error message alone does not distinguish those cases

## Planner Integration

`planAccessExecution(...)` currently emits the runtime budget directly from the
access policy:

- `id = budget-${target.id}`
- `ownerId = target.id`
- `globalConcurrency = accessPolicy.globalConcurrency`
- `maxPerDomain = accessPolicy.perDomainConcurrency`

The deterministic E3 example wraps the identity lease, egress lease, capture,
and health recording inside:

```ts
yield* budgetManager.withPermit(
  plannerDecision.concurrencyBudget,
  target.domain,
  Effect.gen(function* () {
    // identity lease, egress lease, capture, and health writes
  }),
);
```

`tests/examples/e3-capability-slice.test.ts` currently verifies:

- planner rationale keys include `budget`
- `budgetBefore.globalInUse === 0`
- `budgetAfter.globalInUse === 0`
- `budgetAfter.domains[0]?.domain === "example.com"`
- `budgetEvents.map(({ kind }) => kind)` equals `["acquired", "released"]`

## Command Usage

Run targeted verification from repository root:

```bash
bun test tests/libs/foundation-core-access-budget.test.ts
bun test tests/examples/e3-capability-slice.test.ts
bun run check:e3-capability-slice
```

Inspect the standalone E3 example JSON with `jq`:

```bash
tmpfile=$(mktemp)
bun run example:e3-capability-slice > "$tmpfile" 2>/dev/null
jq '{
  budget: .plannerDecision.concurrencyBudget,
  budgetBefore: {
    globalInUse: .budgetBefore.globalInUse,
    domains: .budgetBefore.domains
  },
  budgetAfter: {
    globalInUse: .budgetAfter.globalInUse,
    domains: .budgetAfter.domains
  },
  budgetEventKinds: [.budgetEvents[].kind]
}' "$tmpfile"
rm "$tmpfile"
```

Current verified output shape from that command:

```json
{
  "budget": {
    "id": "budget-target-product-001",
    "ownerId": "target-product-001",
    "globalConcurrency": 4,
    "maxPerDomain": 2
  },
  "budgetBefore": {
    "globalInUse": 0,
    "domains": []
  },
  "budgetAfter": {
    "globalInUse": 0,
    "domains": [
      {
        "domain": "example.com",
        "capacity": 2,
        "available": 2,
        "inUse": 0
      }
    ]
  },
  "budgetEventKinds": [
    "acquired",
    "released"
  ]
}
```

Run full repository gates before promotion or bead closure:

```bash
bun run lint:check
bun run test
bun run build
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

## Practical Execution Examples

### Stress saturation and confirm overrun protection

`tests/libs/foundation-core-access-budget.test.ts` is the current committed
stress harness. It uses:

- `globalConcurrency: 2`
- `maxPerDomain: 1`
- one held permit for `example.com`
- one held permit for `shop.example.com`

Current assertions from that test prove:

- extra access is rejected while the budget is saturated
- `inspect(...)` reports `globalInUse === 2` during saturation
- the per-domain rows for `example.com` and `shop.example.com` both show
  `available: 0` and `inUse: 1`
- after both permits are released, `globalInUse === 0`
- current event order is:
  `["acquired", "acquired", "rejected", "rejected", "released", "released"]`

Use that test when the question is "does the runtime prevent overrun and expose
utilization under stress?"

### Isolate a pure per-domain denial while global capacity remains available

Use this current in-repo consumer pattern when you need to confirm that
`maxPerDomain` is the blocking factor instead of the global cap:

```ts
import { Deferred, Effect, Fiber, Schema } from "effect";
import { makeInMemoryAccessBudgetManager } from "./libs/foundation/core/src/access-budget-runtime.ts";
import { ConcurrencyBudgetSchema } from "./libs/foundation/core/src/budget-lease-artifact.ts";

const budget = Schema.decodeUnknownSync(ConcurrencyBudgetSchema)({
  id: "budget-target-product-001",
  ownerId: "target-product-001",
  globalConcurrency: 3,
  maxPerDomain: 1,
});

const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const manager = yield* makeInMemoryAccessBudgetManager();
      const releaseFirst = yield* Deferred.make<void>();

      const firstFiber = yield* manager
        .withPermit(budget, "example.com", Deferred.await(releaseFirst))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;

      const sameDomainFailure = yield* manager
        .withPermit(budget, "example.com", Effect.void)
        .pipe(
          Effect.match({
            onFailure: ({ message }) => message,
            onSuccess: () => "unexpected-success",
          }),
        );

      const otherDomainResult = yield* manager.withPermit(
        budget,
        "shop.example.com",
        Effect.succeed("other-domain-acquired"),
      );

      const snapshot = yield* manager.inspect(budget);
      const events = yield* manager.events();

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(firstFiber);

      return {
        sameDomainFailure,
        otherDomainResult,
        snapshot,
        eventKinds: events.map(({ kind }) => kind),
      };
    }),
  ),
);
```

Current verified behavior from that exact pattern:

- `sameDomainFailure` contains `denied access for example.com`
- `otherDomainResult === "other-domain-acquired"`
- `snapshot.globalAvailable === 2`
- `snapshot.globalInUse === 1`
- `snapshot.domains` includes:
  - `example.com` with `available: 0`, `inUse: 1`
  - `shop.example.com` with `available: 1`, `inUse: 0`
- `eventKinds` equals `["acquired", "rejected", "acquired", "released"]`

Use this pattern when the operator report is "one hot domain is blocked even
though the fleet still has spare global capacity."

## Troubleshooting

### `BudgetExceededError` appears but the message is too generic

The current error text does not say whether the global or per-domain semaphore
rejected the request. Inspect the snapshot instead:

- if `globalAvailable === 0`, the global cap is the blocker
- if `globalAvailable > 0` and the target domain row has `available === 0`, the
  per-domain cap is the blocker

Check both `inspect(budget)` and the latest `rejected` event snapshot from the
same manager instance.

### A config change did not update live capacities

This is current runtime behavior. Budget state is cached by `budget.id`, and
the first-seen budget payload wins for that manager instance.

Verified current behavior:

- inspect with `{ id: "budget-target-product-001", globalConcurrency: 2, maxPerDomain: 1 }`
- inspect again with the same `id` but `{ globalConcurrency: 4, maxPerDomain: 2 }`
- the second snapshot still reports `globalConcurrency: 2` and
  `maxPerDomain: 1`

If capacities must change, use a fresh manager instance or a new `budget.id`.
Do not assume live semaphore resizing under a reused identifier.

### A domain is missing from `snapshot.domains`

This is expected until `withPermit(...)` has touched that domain at least once.
`inspect(...)` on a never-used budget returns `domains: []`.

### Event history mixes unrelated runs

`events()` is append-only across every budget seen by a single manager
instance. Filter by `budgetId` and `domain`, or use a fresh manager when you
need isolated telemetry for a single scenario.

### Permits look stuck

`withPermit(...)` already handles release through `Effect.acquireUseRelease(...)`.
If `globalInUse` stays above zero, the most likely cause is still-running work
inside the wrapped effect. Confirm that the caller is not holding the work open
with `Deferred.await(...)`, a long-running fiber, or a hung downstream step.

## Rollout Guidance

1. Prepare
- verify the planner emits the intended `ConcurrencyBudgetSchema` values from
  the access policy
- run `bun test tests/libs/foundation-core-access-budget.test.ts`
- run `bun run check:e3-capability-slice`

2. Apply
- wrap the bounded access section with `budgetManager.withPermit(...)`
- keep identity, egress, capture, and health effects inside the permit scope
- expose `inspect(...)` or `events()` from that same manager instance wherever
  operators need utilization evidence

3. Verify
- inspect the E3 example JSON or the caller's own snapshots for
  `globalInUse`, `globalAvailable`, and per-domain rows
- confirm `rejected` events only appear where the rollout expects hard limits
- run the full repository gates

4. Promote
- merge only when the utilization signals match the expected policy
- keep the budget identifier strategy explicit; a reused `budget.id` does not
  pick up new capacities inside a still-live manager

## Rollback Guidance

1. Revert the caller, planner, or access-policy change that introduced the bad
   concurrency behavior.
2. Recreate the affected manager instance or deploy a fresh process if the
   rollback depends on different numeric limits for an existing `budget.id`.
3. Re-run:

```bash
bun test tests/libs/foundation-core-access-budget.test.ts
bun run check:e3-capability-slice
bun run check
```

4. Re-inspect `budgetBefore`, `budgetAfter`, and `events()` to confirm the
   restored policy is actually live.
5. Do not bypass the runtime with raw `TxSemaphore` calls, swallow
   `BudgetExceededError`, or silently clamp policy numbers to hide the issue.
