# E9 Performance Budget

Use the E9 performance budget to capture reproducible latency and heap evidence
for reference-pack validation, Scrapling parity, canary replay, and launch
readiness.

## Commands

```bash
bun run check:e9-performance-budget
```

Direct replay:

```bash
bun test tests/scripts/e9-performance-budget.test.ts
bun run benchmark:e9-performance-budget
```

## Artifacts

- baseline: `docs/artifacts/e9-performance-budget-baseline.json`
- scorecard: `docs/artifacts/e9-performance-budget-scorecard.json`

## Budget policy

- reference-pack validation `p95` must stay within the committed threshold
- Scrapling parity `p95` must stay within the committed threshold
- canary `p95` must stay within the committed threshold
- launch readiness `p95` must stay within the committed threshold
- total end-to-end replay `p95` and heap delta must remain within budget

If the scorecard fails, open a remediation bead instead of widening the budget
casually.
