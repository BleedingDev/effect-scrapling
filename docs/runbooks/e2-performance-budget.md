# E2 Performance Budget

## Purpose

Capture reproducible local performance evidence for the E2 extraction slice and
compare future candidate runs against a committed baseline artifact.

This scorecard combines two deterministic signals:

- end-to-end `runE2CapabilitySlice()` latency
- golden fixture replay latency through `replayGoldenFixture(...)`

## Benchmark Contract

Command:

```bash
bun run benchmark:e2-performance-budget
```

Implementation:

- Package scripts:
  - `benchmark:e2-performance-budget`
  - `check:e2-performance-budget`
- Script: `scripts/benchmarks/e2-performance-budget.ts`
- Capability slice: `examples/e2-capability-slice.ts`
- Focused tests: `tests/scripts/e2-performance-budget.test.ts`
- Committed baseline artifact: `docs/artifacts/e2-performance-budget-baseline.json`
- Operator scorecard: `docs/artifacts/e2-performance-budget-scorecard.json`

`benchmark:e2-performance-budget` writes the operator scorecard to
`docs/artifacts/e2-performance-budget-scorecard.json` and compares against the
committed baseline in `docs/artifacts/e2-performance-budget-baseline.json`.
`check:e2-performance-budget` is the merge-facing alias for the same benchmark.

## Budgets

Current local budgets:

- `measurements.capabilitySlice.p95Ms <= 75`
- `measurements.goldenReplay.p95Ms <= 60`
- `measurements.heapDeltaKiB <= 16384`

These limits are intentionally wide enough to remain stable on normal
developer machines while still flagging obvious E2 regressions in parser,
selector, normalization, assertion, evidence-manifest, or replay cost.

## Usage

### Compare the current candidate against the committed baseline

```bash
bun run benchmark:e2-performance-budget
```

### Refresh the committed baseline artifact intentionally

```bash
bun run scripts/benchmarks/e2-performance-budget.ts \
  --artifact docs/artifacts/e2-performance-budget-baseline.json
```

Only refresh the baseline when the performance change is understood and
reviewed.

### Run a faster local spot-check

```bash
bun run scripts/benchmarks/e2-performance-budget.ts \
  --baseline docs/artifacts/e2-performance-budget-baseline.json \
  --artifact tmp/e2-performance-budget-scorecard.json \
  --sample-size 3 \
  --warmup 1
```

## Reading The Artifact

Key fields:

- `measurements.capabilitySlice.p95Ms`
- `measurements.goldenReplay.p95Ms`
- `measurements.heapDeltaKiB`
- `comparison.deltas.*`
- `violations`
- `status`

Read the operator-facing scorecard with:

```bash
cat docs/artifacts/e2-performance-budget-scorecard.json
jq '{status, measurements, comparison, violations}' \
  docs/artifacts/e2-performance-budget-scorecard.json
```

If `status` is `fail`, keep the scorecard artifact unchanged and treat it as
the blocking evidence for the candidate.

## Remediation Workflow

If `docs/artifacts/e2-performance-budget-scorecard.json` reports
`status: "fail"`, create a blocking remediation bead instead of widening
budgets.

Template command:

```bash
CI=1 bd create "[E2] Remediate: extraction performance budget breach" \
  --type bug \
  --priority 1 \
  --parent bd-8en \
  --labels epic-e2,lane-performance,phase-2 \
  --deps blocks:<candidate-bead-id> \
  --description $'Performance gate failed in docs/artifacts/e2-performance-budget-scorecard.json.\nCapture the breached metric names, measured values, baseline deltas, local machine context, and the command used to reproduce the failure.' \
  --acceptance $'Acceptance Criteria:\n- The breached E2 benchmark metric is back within budget.\n- docs/artifacts/e2-performance-budget-scorecard.json returns status: pass on the reproducer.\n- Any required follow-up runtime or budget changes are reviewed and documented.'
```

## Troubleshooting

### The command fails with `Unknown argument`

The scorecard accepts only:

- `--artifact <path>`
- `--baseline <path>`
- `--sample-size <positive integer>`
- `--warmup <positive integer>`

### The benchmark output regresses unexpectedly

Inspect:

1. `measurements.capabilitySlice`
2. `measurements.goldenReplay`
3. `comparison.deltas`
4. `violations`

If replay cost regresses first, focus on the parser, selector, and extractor
runtime suites before touching the baseline.
