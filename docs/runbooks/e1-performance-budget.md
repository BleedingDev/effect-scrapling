# E1 Performance Budget

## Purpose

Capture reproducible local performance evidence for the E1 foundation-core
capability slice and compare future candidate runs against the committed
baseline artifact.

## Benchmark Contract

Command:

```bash
bun run benchmark:e1-performance-budget
```

Implementation:

- Script: `scripts/benchmarks/e1-performance-budget.ts`
- Baseline artifact: `docs/artifacts/e1-performance-budget-baseline.json`

The benchmark measures deterministic mock-backed execution for:

- `runE1CapabilitySlice`
- shared contract decode/encode roundtrips across the emitted E1 evidence

It records:

- `minMs`
- `meanMs`
- `p95Ms`
- `maxMs`
- aggregate heap delta in KiB

## Budgets

Current local budgets:

- `runE1CapabilitySlice` p95 <= `50ms`
- contract roundtrip p95 <= `10ms`
- heap delta <= `16384 KiB`

These budgets are intentionally wide enough to remain stable on normal
developer machines while still flagging obvious E1 regressions.

## Usage

### Compare current candidate against committed baseline

```bash
bun run benchmark:e1-performance-budget
```

### Refresh the committed baseline artifact intentionally

```bash
bun run scripts/benchmarks/e1-performance-budget.ts \
  --artifact docs/artifacts/e1-performance-budget-baseline.json
```

Only refresh the baseline when the performance change is understood and
reviewed.

## Reading the Artifact

Key fields:

- `measurements.capabilitySlice.p95Ms`: operator-facing latency signal for the
  full E1 capability slice
- `measurements.contractRoundtrip.p95Ms`: cost of re-validating public encoded
  evidence through shared schemas
- `comparison.deltas.*`: change versus the committed baseline
- `status`: `pass` or `fail`

If `status` is `fail`, create a blocking remediation bead before promotion.

## Troubleshooting

### Benchmark fails unexpectedly on a loaded machine

1. Re-run with a clean shell and no background load if possible.
2. Compare the current artifact output against
   `docs/artifacts/e1-performance-budget-baseline.json`.
3. If the regression is real, fix the slower path or open a blocking
   remediation bead. Do not casually widen the budgets.

### Need a faster spot-check during development

Use smaller samples:

```bash
bun run scripts/benchmarks/e1-performance-budget.ts --sample-size 3 --warmup 1
```

This is useful for iteration, but the committed baseline should be refreshed
with the default sample size.
