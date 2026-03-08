# E7 Performance Budget

## Purpose

Use this runbook to execute the current E7 quality-harness performance budget,
inspect the persisted scorecard, and decide whether a candidate remains within
the allowed latency and heap budgets.

This benchmark measures the deterministic E7 harnesses that exist today:

- baseline corpus execution
- incumbent comparison execution
- heap growth during the combined benchmark run

It does not benchmark:

- live canary traffic
- browser-backed extraction
- long-running soak duration
- external storage or network I/O

## Current Command Surface

Focused verification:

```bash
bun test tests/libs/foundation-core-performance-gate-runtime.test.ts
bun test tests/scripts/e7-performance-budget.test.ts
```

Operator-facing commands:

```bash
bun run benchmark:e7-performance-budget
bun run check:e7-performance-budget
```

Direct script:

```bash
bun run scripts/benchmarks/e7-performance-budget.ts \
  --baseline docs/artifacts/e7-performance-budget-baseline.json \
  --artifact docs/artifacts/e7-performance-budget-scorecard.json
```

`check:e7-performance-budget` runs the focused test files first and then the
benchmark command.

## CLI Options

`scripts/benchmarks/e7-performance-budget.ts` accepts only:

- `--artifact <path>`
- `--baseline <path>`
- `--sample-size <positive integer>`
- `--warmup <non-negative integer>`

Defaults:

- `sampleSize = 3`
- `warmupIterations = 1`

Behavior notes:

- omitting `--artifact` prints JSON only and does not persist a file
- omitting `--baseline` keeps `comparison.baselinePath = null`,
  `comparison.comparable = false`, and `comparison.deltas.* = null`
- baseline deltas are emitted only when `sampleSize`, `warmupIterations`, and
  the computed workload `profile` match exactly
- when those inputs do not match, the scorecard remains valid but
  `comparison.comparable = false` and `comparison.incompatibleReason` explains
  why deltas were suppressed

## Budgets

Current local budgets:

- `measurements.baselineCorpus.p95Ms <= 500`
- `measurements.incumbentComparison.p95Ms <= 1200`
- `measurements.heapDeltaKiB <= 16384`

These thresholds are intentionally wide enough for deterministic local replay
while still catching obvious regressions in E7 corpus execution or incumbent
comparison cost.

Threshold boundaries are inclusive. A measurement exactly on the configured
limit still passes.

## Artifact Locations

- committed baseline:
  `docs/artifacts/e7-performance-budget-baseline.json`
- operator scorecard:
  `docs/artifacts/e7-performance-budget-scorecard.json`

The script resolves `--artifact` and `--baseline` to absolute paths before
persisting the scorecard.

## Practical Execution

Run the focused test coverage first:

```bash
bun test tests/libs/foundation-core-performance-gate-runtime.test.ts \
  tests/scripts/e7-performance-budget.test.ts
```

Refresh the committed baseline intentionally:

```bash
bun run scripts/benchmarks/e7-performance-budget.ts \
  --artifact docs/artifacts/e7-performance-budget-baseline.json
```

Write the operator-facing scorecard against the committed baseline:

```bash
bun run scripts/benchmarks/e7-performance-budget.ts \
  --baseline docs/artifacts/e7-performance-budget-baseline.json \
  --artifact docs/artifacts/e7-performance-budget-scorecard.json
```

Run a faster local spot-check without baseline deltas:

```bash
bun run scripts/benchmarks/e7-performance-budget.ts \
  --artifact tmp/e7-performance-budget-scorecard.json \
  --sample-size 2 \
  --warmup 0
```

## Reading The Artifact

Focus on:

- `profile.caseCount`
- `profile.packCount`
- `measurements.baselineCorpus`
- `measurements.incumbentComparison`
- `measurements.heapDeltaKiB`
- `comparison.comparable`
- `comparison.incompatibleReason`
- `comparison.deltas.*`
- `violations`
- `status`

Inspect the current scorecard with:

```bash
cat docs/artifacts/e7-performance-budget-scorecard.json
jq '{status, profile, measurements, comparison, violations}' \
  docs/artifacts/e7-performance-budget-scorecard.json
```

Interpretation:

- `comparison.comparable = true` means baseline deltas are meaningful and can
  be compared directly
- `comparison.comparable = false` means the scorecard is still valid, but the
  baseline run used a different benchmark shape
- `status = "fail"` means at least one latency or heap budget was exceeded

## Troubleshooting

### The command fails with `Unknown argument`

The harness accepts only the four documented flags. Remove any ad-hoc options.

### The scorecard is valid but deltas are all `null`

Check:

1. `sampleSize`
2. `warmupIterations`
3. `profile.caseCount`
4. `profile.packCount`
5. `comparison.incompatibleReason`

Do not treat missing deltas as a benchmark failure by themselves. They mean the
baseline is not comparable to the current workload shape.

### The budget fails unexpectedly

Inspect:

1. `measurements.baselineCorpus.p95Ms`
2. `measurements.incumbentComparison.p95Ms`
3. `measurements.heapDeltaKiB`
4. `comparison.deltas.*` when `comparison.comparable = true`
5. `violations`

If baseline-corpus cost regresses first, inspect the corpus runner and fixture
shape. If incumbent-comparison cost regresses first, inspect the diffing and
comparison pipeline before touching budgets.

## Remediation Workflow

If `docs/artifacts/e7-performance-budget-scorecard.json` reports
`status: "fail"`:

1. keep the persisted scorecard unchanged as the failure artifact
2. record the breached fields from `violations`
3. capture whether the baseline was comparable
4. open a blocking remediation bead instead of widening budgets first

Use a blocking remediation bead command like:

```bash
CI=1 bd create "[E7] Remediate: quality harness performance budget breach" \
  --type bug \
  --priority 2 \
  --depends-on bd-i62.13 \
  --description "Investigate the failing E7 performance budget scorecard before changing thresholds."
```

Rollback in this lane means reverting the candidate change that introduced the
performance regression and rerunning:

- `bun run check:e7-performance-budget`
- `bun run benchmark:e7-performance-budget`
