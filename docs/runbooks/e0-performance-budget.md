# E0 Performance Budget

## Purpose

Capture reproducible local performance evidence for the E0 workspace foundation
slice and compare future candidate runs against the committed baseline artifact.

## Benchmark Contract

Command:

```bash
bun run benchmark:e0-performance-budget
```

Implementation:

- Script: `scripts/benchmarks/e0-performance-budget.ts`
- Baseline artifact: `docs/artifacts/e0-performance-budget-baseline.json`

The benchmark measures deterministic mock-backed execution for:

- `accessPreview`
- `extractRun`
- `runDoctor`

It records:

- `minMs`
- `meanMs`
- `p95Ms`
- `maxMs`
- aggregate heap delta in KiB

## Budgets

Current local budgets:

- `accessPreview` p95 <= `50ms`
- `extractRun` p95 <= `50ms`
- `runDoctor` p95 <= `10ms`
- heap delta <= `16384 KiB`

These budgets are intentionally wide enough to remain stable on normal developer
machines while still flagging obvious regressions in the E0 slice.

## Usage

### Compare current candidate against committed baseline

```bash
bun run benchmark:e0-performance-budget
```

### Refresh the committed baseline artifact intentionally

```bash
bun run scripts/benchmarks/e0-performance-budget.ts \
  --artifact docs/artifacts/e0-performance-budget-baseline.json
```

Only refresh the baseline when performance changes are understood and reviewed.

## Reading the Artifact

Key fields:

- `measurements.*.p95Ms`: operator-facing latency signal
- `comparison.deltas.*`: change versus committed baseline
- `status`: `pass` or `fail`

If `status` is `fail`, create a blocking remediation bead before promotion.

## Troubleshooting

### Benchmark fails unexpectedly on a loaded machine

1. Re-run with a clean shell and no background load if possible.
2. Compare current artifact output against `docs/artifacts/e0-performance-budget-baseline.json`.
3. If the regression is real, do not widen the budgets casually. Fix the slower
   path or open a blocking remediation bead.

### Need a faster spot-check during development

Use smaller samples:

```bash
bun run scripts/benchmarks/e0-performance-budget.ts --sample-size 3 --warmup 1
```

This is useful for iteration, but the baseline artifact should be refreshed with
the default sample size.
