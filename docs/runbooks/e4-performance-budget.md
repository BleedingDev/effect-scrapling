# E4 Performance Budget

## Purpose

Capture reproducible local performance evidence for the E4 browser-selective
runtime and compare future candidate runs against a committed baseline
artifact.

This scorecard intentionally combines two deterministic signals:

- end-to-end `runE4CapabilitySlice()` latency
- bounded browser soak/load throughput and resource cleanup evidence from
  `runSoakLoadSuite(...)`

## Benchmark Contract

Command:

```bash
bun run benchmark:e4-performance-budget
```

Implementation:

- Package scripts:
  - `benchmark:e4-performance-budget`
  - `check:e4-performance-budget`
- Script: `scripts/benchmarks/e4-performance-budget.ts`
- Supporting soak harness: `scripts/benchmarks/e4-browser-soak-load.ts`
- Capability slice: `examples/e4-capability-slice.ts`
- Focused tests: `tests/scripts/e4-performance-budget.test.ts`
- Committed baseline artifact: `docs/artifacts/e4-performance-budget-baseline.json`
- Operator scorecard: `docs/artifacts/e4-performance-budget-scorecard.json`

`benchmark:e4-performance-budget` writes the operator scorecard to
`docs/artifacts/e4-performance-budget-scorecard.json` and compares against the
committed baseline in `docs/artifacts/e4-performance-budget-baseline.json`.
`check:e4-performance-budget` is the merge-facing alias for the same benchmark.
  command

## Budgets

Current local budgets:

- `measurements.capabilitySlice.p95Ms <= 40`
- `measurements.soakRoundDurationMs.p95Ms <= 40`
- `measurements.throughputRunsPerSecond >= max(50, 25 * soakConcurrency)`
- `measurements.heapDeltaKiB <= 16384`
- `resources.peaks.openBrowsers <= 1`
- `resources.peaks.openContexts <= soakConcurrency`
- `resources.peaks.openPages <= soakConcurrency`
- `resources.finalSnapshot.openBrowsers === 0`
- `resources.finalSnapshot.openContexts === 0`
- `resources.finalSnapshot.openPages === 0`
- `resources.alarms.length === 0`
- `resources.crashTelemetry.length === 0`

These limits are intentionally wide enough to remain stable on normal
developer machines while still flagging obvious E4 regressions in provider
selection latency, bounded browser concurrency, or leak cleanup.

## Usage

### Compare the current candidate against the committed baseline

```bash
bun run benchmark:e4-performance-budget
```

### Refresh the committed baseline artifact intentionally

```bash
bun run scripts/benchmarks/e4-performance-budget.ts \
  --artifact docs/artifacts/e4-performance-budget-baseline.json
```

Only refresh the baseline when the performance change is understood and
reviewed.

### Run a faster local spot-check

```bash
bun run scripts/benchmarks/e4-performance-budget.ts \
  --baseline docs/artifacts/e4-performance-budget-baseline.json \
  --artifact tmp/e4-performance-budget-scorecard.json \
  --sample-size 3 \
  --warmup 1 \
  --rounds 4 \
  --concurrency 2 \
  --soak-warmup 0
```

## Reading The Artifact

Key fields:

- `measurements.capabilitySlice.p95Ms`
- `measurements.soakRoundDurationMs.p95Ms`
- `measurements.throughputRunsPerSecond`
- `measurements.heapDeltaKiB`
- `resources.captures.totalRuns`
- `resources.captures.totalArtifacts`
- `resources.peaks`
- `resources.finalSnapshot`
- `resources.alarms`
- `resources.crashTelemetry`
- `comparison.deltas.*`
- `violations`
- `status`

Read the operator-facing scorecard with:

```bash
cat docs/artifacts/e4-performance-budget-scorecard.json
jq '{status, measurements, resources, comparison, violations}' \
  docs/artifacts/e4-performance-budget-scorecard.json
```

Interpretation:

- `capabilitySlice` is the deterministic end-to-end E4 capability latency
- `soakRoundDurationMs` is the bounded concurrent browser round latency
- `throughputRunsPerSecond` is the steady-state soak throughput computed from
  the measured round mean and total captures
- `heapDeltaKiB` is the aggregate heap movement across the full benchmark run
- `resources.*` is the operator-facing leak, peak-concurrency, and crash signal

If `status` is `fail`, keep the scorecard artifact unchanged and treat it as
the blocking evidence for the candidate.

## Remediation Workflow

If `docs/artifacts/e4-performance-budget-scorecard.json` reports
`status: "fail"`, create a blocking remediation bead instead of widening
budgets.

Recommended workflow:

1. Keep the persisted scorecard file unchanged so the failing evidence remains
   inspectable.
2. Record the exact failing metrics from:
   - `measurements.capabilitySlice.p95Ms`
   - `measurements.soakRoundDurationMs.p95Ms`
   - `measurements.throughputRunsPerSecond`
   - `measurements.heapDeltaKiB`
   - `comparison.deltas.*`
   - `violations`
3. Open a bug bead that blocks the candidate bead you were trying to promote.

Template command:

```bash
CI=1 bd create "[E4] Remediate: browser performance budget breach" \
  --type bug \
  --priority 1 \
  --parent bd-ymb \
  --labels epic-e4,lane-performance,phase-4 \
  --deps blocks:<candidate-bead-id> \
  --description $'Performance gate failed in docs/artifacts/e4-performance-budget-scorecard.json.\nCapture the breached metric names, measured values, baseline deltas, local machine context, and the command used to reproduce the failure.' \
  --acceptance $'Acceptance Criteria:\n- The breached E4 benchmark metric is back within budget.\n- docs/artifacts/e4-performance-budget-scorecard.json returns status: pass on the reproducer.\n- Any required follow-up runtime or budget changes are reviewed and documented.'
```

Replace `<candidate-bead-id>` with the implementation or rollout bead that
must stay blocked until the regression is fixed.

## Troubleshooting

### The command fails with `Unknown argument`

The scorecard accepts only:

- `--artifact <path>`
- `--baseline <path>`
- `--sample-size <positive integer>`
- `--warmup <non-negative integer>`
- `--rounds <positive integer>`
- `--concurrency <positive integer>`
- `--soak-warmup <non-negative integer>`

### The benchmark output includes unexpected browser lifecycle failures

Inspect:

1. `resources.finalSnapshot`
2. `resources.alarms`
3. `resources.crashTelemetry`
4. `violations`

If those fields show non-zero dangling resources, leak alarms, or crash
telemetry, use `docs/runbooks/e4-browser-soak-load.md`,
`docs/runbooks/e4-browser-crash-recovery.md`, and
`docs/runbooks/e4-browser-leak-detection.md` to isolate the runtime regression
before refreshing any baseline.

### You only need the lower-level soak harness

Use the underlying harness directly when you need to focus on browser
round-level artifact counts and leak policy behavior without the additional
capability-slice measurement:

```bash
bun run scripts/benchmarks/e4-browser-soak-load.ts \
  --artifact tmp/e4-browser-soak-load.json \
  --rounds 4 \
  --concurrency 2 \
  --warmup 0
```
