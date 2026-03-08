# E5 Workflow Budget Integration Runbook

## Purpose

Use this runbook when operators or SDK consumers need to validate the current
E5 workflow-budget scheduler, confirm permit enforcement at durable capture
boundaries, and inspect the scale-harness evidence that backs the current
budget contract.

This runbook is intentionally limited to behavior that exists today in:

- `libs/foundation/core/src/workflow-budget-runtime.ts`
- `libs/foundation/core/src/durable-workflow-runtime.ts`
- `tests/libs/foundation-core-workflow-budget-runtime.test.ts`
- `tests/scripts/e5-workflow-simulation.test.ts`
- `scripts/benchmarks/e5-workflow-simulation.ts`
- `scripts/benchmarks/e5-crash-resume-harness.ts`

Important scope limits from the real implementation:

- budget registration is derived from compiled plans and resolved target domains
- scheduler enforcement is library-first through `WorkflowBudgetScheduler`
  integration inside the durable runtime
- current benchmarking remains synthetic; it validates orchestration behavior,
  not live browser or HTTP latency

## Current Command Surface

The repository currently exposes these commands for this area:

```bash
bun run check:e5-workflow-budget-integration
bun run check:e5-workflow-simulation
bun run check:e5-crash-resume-harness
bun test tests/libs/foundation-core-workflow-budget-runtime.test.ts
```

`check:e5-workflow-budget-integration` currently expands to:

```bash
bun test tests/libs/foundation-core-workflow-budget-runtime.test.ts \
  tests/scripts/e5-workflow-simulation.test.ts \
  tests/scripts/e5-crash-resume-harness.test.ts
```

## What The Current Coverage Proves

The focused suites currently prove:

- equivalent workflow budgets coalesce into shared global and per-domain pools
- permit denial occurs when either the domain pool or the global pool is
  exhausted
- durable capture boundaries respect scheduler permits and persist retryable
  failures when permits are denied
- the simulation harness preserves stable checkpoint counts and stage order
  under the current budgeted scale scenario
- the crash-resume harness preserves matching outputs across deterministic
  restart boundaries while running through the same budget integration path
- the crash-resume artifact emits `baselineBudgetEvents` / `recoveredBudgetEvents`
  and `baselineWorkClaims` / `recoveredWorkClaims`, so budget and dedupe drift
  is visible as structured evidence instead of inferred from logs

## Practical Execution

Run the focused scheduler and harness suite:

```bash
bun run check:e5-workflow-budget-integration
```

Run the default scale scorecard:

```bash
bun run check:e5-workflow-simulation
```

Run the deterministic restart scorecard:

```bash
bun run check:e5-crash-resume-harness
```

Run only the scheduler suite when isolating permit logic:

```bash
bun test tests/libs/foundation-core-workflow-budget-runtime.test.ts
```

## Troubleshooting

### Domain budget denial never happens under contention

Treat that as a scheduler regression. The current tests expect domain-specific
rejection when the same domain exhausts its bounded pool.

### Global denial never happens even when the global pool is saturated

Treat that as a cross-domain scheduler regression. Do not widen the global
budget to hide it.

### The simulation scorecard fails on checkpoint throughput or stability

Keep the failing scorecard unchanged and inspect `violations`,
`measurements.checkpointsPerSecond`, and `stability` before changing budgets.

### The crash-resume artifact shows budget or work-claim drift

Treat that as a restart-boundary scheduler regression. Preserve the emitted
artifact and inspect `baselineBudgetEvents`, `recoveredBudgetEvents`,
`baselineWorkClaims`, and `recoveredWorkClaims` before touching the runtime
budget contracts.

## Rollout And Rollback

Use this sequence before promoting a workflow-budget change:

1. Run `bun run check:e5-workflow-budget-integration`.
2. Run `bun run check:e5-workflow-simulation`.
3. Run `bun run check:e5-crash-resume-harness`.
4. Run the full repository gates before bead closure or release.

Rollback guidance:

- if permit exhaustion stops rejecting correctly, roll back immediately
- if durable capture stops surfacing retryable budget failures, roll back
  immediately
- if the scale or restart scorecards fail, keep the emitted artifacts and roll
  back the candidate budget/runtime change rather than widening thresholds
