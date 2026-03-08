# E8 Performance Budget

Use this runbook to replay the deterministic E8 performance gate and inspect
the committed baseline and scorecard artifacts.

This benchmark covers the current public E8 control-plane surfaces:

- workspace doctor
- workspace config show
- E8 capability slice
- benchmark metadata export
- artifact export

Focused commands:

```sh
bun test tests/scripts/e8-performance-budget.test.ts

bun run benchmark:e8-performance-budget
bun run check:e8-performance-budget
```

Direct script usage:

```sh
bun run scripts/benchmarks/e8-performance-budget.ts \
  --artifact docs/artifacts/e8-performance-budget-baseline.json

bun run scripts/benchmarks/e8-performance-budget.ts \
  --baseline docs/artifacts/e8-performance-budget-baseline.json \
  --artifact docs/artifacts/e8-performance-budget-scorecard.json
```

CLI options:

- `--artifact <path>`
- `--baseline <path>`
- `--sample-size <positive integer>`
- `--warmup <non-negative integer>`

Current workload profile:

- `workspaceRunsPerSample: 8`
- `capabilitySliceRunsPerSample: 1`
- `benchmarkRunsPerSample: 3`
- `artifactExportsPerSample: 3`

Current local budgets:

- `workspaceDoctor.p95Ms <= 100`
- `workspaceConfig.p95Ms <= 120`
- `capabilitySlice.p95Ms <= 2500`
- `benchmarkRun.p95Ms <= 450`
- `artifactExport.p95Ms <= 600`
- `heapDeltaKiB <= 36864`
- every stability fingerprint remains consistent

Committed artifacts:

- `docs/artifacts/e8-performance-budget-baseline.json`
- `docs/artifacts/e8-performance-budget-scorecard.json`

If the scorecard fails:

1. keep the failing artifact
2. rerun `bun run check:e8-capability-slice`
3. rerun `bun run check:e8-benchmark-export`
4. rerun `bun run check:e8-workspace-operations`
5. only update the baseline when the workload shape changed intentionally
