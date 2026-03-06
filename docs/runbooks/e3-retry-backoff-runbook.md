# E3 Retry And Backoff Runbook

## Purpose

Use this runbook when operators or SDK consumers need to validate, observe, or
troubleshoot the bounded retry runtime in:

- `libs/foundation/core/src/access-retry-runtime.ts`
- `libs/foundation/core/src/http-access-runtime.ts`

This document is intentionally limited to the behavior that exists today. It
does not assume jitter, persisted retry state, automatic rollback, or retry
coverage outside the current HTTP fetch path.

Policy baseline:

- Effect v4 only.
- Retry budgets stay bounded by shared schemas and decoded run plans.
- Retry only transient access failures that the current runtime marks as
  retryable.
- No manual `_tag` branching, `instanceof` shortcuts, or type-safety bypasses.

## Current Runtime Contract

Current retry exports:

- `AccessRetryPolicy`
- `AccessRetryDecision`
- `AccessRetryReport`
- `deriveAccessRetryPolicy`
- `isRetryableAccessFailure`
- `executeWithAccessRetry`

Current HTTP caller:

- `captureHttpArtifacts`

What the runtime does now:

- `planAccessExecution` maps `accessPolicy.maxRetries` to
  `runPlan.maxAttempts = maxRetries + 1`.
- `deriveAccessRetryPolicy(plan)` derives a retry policy from the decoded
  `RunPlan`:
  - `id = "retry-" + plan.id`
  - `maxAttempts = plan.maxAttempts`
  - `baseDelayMs = max(100, min(250, plan.timeoutMs))`
  - `maxDelayMs = max(baseDelayMs, min(plan.timeoutMs, 5000))`
  - `backoffFactor = 2`
- `executeWithAccessRetry` retries only when:
  - `shouldRetry(error)` returns `true`
  - the current attempt is still below `policy.maxAttempts`
- `isRetryableAccessFailure` currently retries only:
  - `ProviderUnavailable`
  - `TimeoutError`
- `PolicyViolation` is terminal and is never retried.

HTTP-specific scope:

- `captureHttpArtifacts` wraps the outbound `fetch(...)` call in the retry
  runtime.
- The later `response.text()` body read is protected by timeout policy, but it
  is not inside the retry loop. A body-read failure is terminal in the current
  implementation.
- HTTP access rejects plans that:
  - do not contain a `capture` step
  - require browser resources

Observability limits to keep in mind:

- Successful execution returns an `AccessRetryReport`.
- Exhausted retry budgets do not currently emit a final report. The runtime
  returns the terminal error once the budget is spent.
- Decision history is therefore available from:
  - the `report.decisions` array on success
  - `onDecision` / `onRetryDecision` logging on retry
  - the terminal error on failure

## Command Usage

Run targeted verification from repository root:

```bash
bun test tests/libs/foundation-core-access-retry.test.ts
bun test tests/libs/foundation-core-e3-runtime.test.ts
bun run check:e3-capability-slice
bun run check:e3-access-runtime
```

Run full repository gates before bead closure or merge:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

Useful artifacts and entrypoints:

- `examples/e3-capability-slice.ts`
- `scripts/benchmarks/e3-access-runtime.ts`
- `docs/artifacts/e3-access-runtime-baseline.json`

## Practical Execution Examples

### Retry budget example from the current planner and runtime

Input access policy:

```ts
{
  timeoutMs: 1000,
  maxRetries: 2,
}
```

Derived runtime behavior:

- planner emits `runPlan.maxAttempts = 3`
- retry policy emits `baseDelayMs = 250`
- retry policy emits `maxDelayMs = 1000`
- retry policy emits `backoffFactor = 2`
- the fetch path can therefore retry:
  - attempt `1 -> 2` after `250ms`
  - attempt `2 -> 3` after `500ms`
  - attempt `3` is terminal if it still fails

If `maxRetries: 0`, the planner emits `maxAttempts: 1`, which disables retry
scheduling while still allowing a single capture attempt.

### Run the deterministic E3 capability slice

```bash
bun run example:e3-capability-slice
```

What to look for:

- the example completes without browser resources
- the capture bundle contains four artifacts:
  - `requestMetadata`
  - `responseMetadata`
  - `html`
  - `timings`
- planner and service plans stay identical

### Run the retry/backoff benchmark harness

```bash
bun run scripts/benchmarks/e3-access-runtime.ts \
  --baseline docs/artifacts/e3-access-runtime-baseline.json \
  --sample-size 3 \
  --warmup 1
```

What this exercises:

- baseline plan creation
- successful HTTP capture
- retry recovery from one transient fetch failure

What to inspect in the JSON output:

- `measurements.retryRecovery.p95Ms`
- `comparison.deltas.retryRecoveryP95Ms`
- `status`

Current budget thresholds in the benchmark harness:

- `baselineAccessP95Ms <= 25`
- `candidateAccessP95Ms <= 50`
- `retryRecoveryP95Ms <= 300`

### Add structured retry-decision logging at the caller boundary

`captureHttpArtifacts` already accepts a decision callback. Use that boundary to
attach run-specific context that the generic retry runtime does not know.

```ts
import { Effect } from "effect";
import { captureHttpArtifacts } from "@effect-scrapling/foundation-core";

const bundle = yield* captureHttpArtifacts(
  plan,
  fetch,
  () => new Date(),
  () => performance.now(),
  (decision) =>
    Effect.log(
      JSON.stringify({
        event: "access.retry",
        runId: plan.id,
        targetId: plan.targetId,
        accessPolicyId: plan.accessPolicyId,
        entryUrl: plan.entryUrl,
        attempt: decision.attempt,
        nextAttempt: decision.nextAttempt,
        delayMs: decision.delayMs,
        reason: decision.reason,
      }),
    ),
);
```

Default HTTP behavior if no callback is supplied:

- `captureHttpArtifacts` emits one text log line per scheduled retry decision
- the line includes the current attempt, next attempt, delay in milliseconds,
  and the retry reason

## Policy Logging Guidance

Minimum fields to log for each retry decision:

- `runId`
- `targetId`
- `accessPolicyId`
- `entryUrl`
- `attempt`
- `nextAttempt`
- `delayMs`
- `reason`

Recommended operator checks:

- confirm no logged `nextAttempt` exceeds `runPlan.maxAttempts`
- confirm delay growth matches the derived policy
- confirm repeated terminal failures include the final error cause
- correlate retry logs with access-health, lease, and artifact persistence logs
  at the same run id

Do not rely on these signals today:

- a persisted retry ledger
- a final exhaustion report from `executeWithAccessRetry`
- body-read retries after a successful HTTP response
- jitter or randomized spread between retries

## Troubleshooting

### No retries happen when the operator expects them

Check these first:

- the failure is actually `ProviderUnavailable` or `TimeoutError`
- `accessPolicy.maxRetries` is greater than `0`
- the generated `RunPlan.maxAttempts` is greater than `1`
- the failure happened during `fetch`, not during `response.text()`

Common terminal cases:

- `PolicyViolation`
- missing `capture` step in the plan
- browser-required plans passed into the HTTP runtime
- response body read failures after the HTTP request already succeeded

### Retry counts look off by one

The planner uses `maxRetries + 1` because `maxAttempts` includes the initial
attempt.

Examples:

- `maxRetries: 0` -> `maxAttempts: 1`
- `maxRetries: 1` -> `maxAttempts: 2`
- `maxRetries: 2` -> `maxAttempts: 3`

If the operator compares logs directly to `maxRetries`, this off-by-one is the
first thing to check.

### Delay values are lower or higher than expected

Recompute the policy from `RunPlan.timeoutMs`:

- base delay is clamped into `100..250ms`
- max delay is capped at `5000ms`
- delay growth is exponential with factor `2`

Examples:

- `timeoutMs: 80` -> `baseDelayMs: 100`, `maxDelayMs: 100`
- `timeoutMs: 1000` -> `baseDelayMs: 250`, `maxDelayMs: 1000`
- `timeoutMs: 20000` -> `baseDelayMs: 250`, `maxDelayMs: 5000`

There is no jitter in the current implementation, so repeated runs with the
same failure sequence should schedule the same delays.

### The runtime fails after logging one or more retry decisions

This means the retry budget was not enough to recover, or a later terminal
failure occurred.

Check:

- the last logged `nextAttempt`
- the final error message returned by the effect
- whether the failing stage was fetch-time or body-read time

Remember that the final exhausted attempt returns the original error. There is
currently no final `exhaustedBudget` report on failure.

### Policy decode failures appear immediately

Both retry and timeout runtimes decode their policies before execution.

Typical causes:

- invalid `RunPlan`
- invalid retry policy object passed to `executeWithAccessRetry`
- incompatible access policy values upstream in the planner

Do not patch around this with ad hoc object mutation. Fix the producer and rerun
the targeted tests.

## Rollout Guidance

1. Prepare
- verify current behavior with:
  - `bun test tests/libs/foundation-core-access-retry.test.ts`
  - `bun test tests/libs/foundation-core-e3-runtime.test.ts`
- confirm the rollout target's `accessPolicy.timeoutMs` and `accessPolicy.maxRetries`
- decide whether default text logging is sufficient or whether a custom
  `onRetryDecision` callback is required

2. Apply
- ship the policy/config change or caller integration
- keep retryability limited to the existing transient error classes unless the
  contract is intentionally expanded
- if rollback safety is a priority, start with conservative `maxRetries`

3. Verify
- run:
  - `bun run check:e3-capability-slice`
  - `bun run check:e3-access-runtime`
- confirm logs show bounded attempt transitions
- confirm retry recovery stays within the benchmark budget

4. Promote
- run full repository gates
- merge only when targeted E3 checks and full gates are green

## Rollback Guidance

1. Restore the last known-good access policy inputs.
- If the issue is retry amplification, set `maxRetries: 0` for the affected
  policy to force `maxAttempts: 1`.
- If the issue is long waits, restore the previous `timeoutMs`, because delay
  derivation depends on it.

2. Revert the code change if the regression came from runtime behavior rather
   than policy data.

3. Re-run:

```bash
bun test tests/libs/foundation-core-access-retry.test.ts
bun test tests/libs/foundation-core-e3-runtime.test.ts
bun run check:e3-capability-slice
bun run check:e3-access-runtime
```

4. Before re-promoting, rerun the full repository gates:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

Forbidden rollback shortcuts:

- widening retryability to non-transient failures without updating the contract
- adding unbounded retry loops
- hiding policy decode failures with fallback object coercion
- claiming successful rollback without rerunning the targeted E3 checks
