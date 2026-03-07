# E3 Access Runtime Benchmark Runbook

## Purpose

Use this runbook when operators or SDK consumers need to run the current E3
access-throughput harness, inspect the emitted baseline and scorecard
artifacts, and decide whether an HTTP-path change is safe to keep or must be
rolled back.

This runbook is intentionally limited to behavior that exists today in:

- `scripts/benchmarks/e3-access-runtime.ts`
- `tests/scripts/e3-access-runtime-benchmark.test.ts`
- `package.json` benchmark and check scripts

Important scope limit:

- the harness covers deterministic HTTP-path planning, capture, and retry
  recovery only
- it does not benchmark browser-backed capture, live network variability, or
  persistent artifact-store I/O

## Current Command Surface

The repository currently exposes these commands for this suite:

```bash
bun run benchmark:e3-access-runtime
bun run check:e3-access-runtime
bun test tests/scripts/e3-access-runtime-benchmark.test.ts
```

`benchmark:e3-access-runtime` currently expands to:

```bash
bun run scripts/benchmarks/e3-access-runtime.ts \
  --baseline docs/artifacts/e3-access-runtime-baseline.json \
  --artifact docs/artifacts/e3-access-runtime-scorecard.json
```

`check:e3-access-runtime` is currently just an alias for the benchmark:

```bash
bun run benchmark:e3-access-runtime
```

The script always prints the full JSON artifact to stdout. When the computed
artifact has `status: "fail"`, the CLI also exits non-zero.

## CLI Options

`scripts/benchmarks/e3-access-runtime.ts` accepts only these options:

- `--artifact <path>`
- `--baseline <path>`
- `--sample-size <positive integer>`
- `--warmup <positive integer>`

Defaults from the script:

- `sampleSize=12`
- `warmupIterations=3`

Behavior notes:

- omitting `--artifact` prints JSON only and does not persist a file
- omitting `--baseline` keeps `comparison.baselinePath` and
  `comparison.deltas.*` as `null`
- `--warmup 0` is invalid today because the parser accepts only positive
  integers
- any other CLI flag fails immediately with `Unknown argument: ...`

## What The Harness Measures

The benchmark collects three deterministic summaries:

- `baselineAccess`
  - plans the fixed E3 access run
  - executes a local success response plus `response.text()`
  - does not invoke `captureHttpArtifacts(...)` or bundle persistence
- `candidateAccess`
  - plans the same fixed run
  - executes `captureHttpArtifacts(...)` on a successful HTTP fixture
  - persists the resulting bundle through the in-memory capture store
- `retryRecovery`
  - plans the same fixed run
  - forces the first HTTP fetch attempt to fail once with a transient error
  - retries through the real bounded retry runtime, then persists the recovered
    bundle through the in-memory capture store

Current fixture and runtime details baked into the script:

- fixed target/profile IDs and `createdAt`
- access policy mode `http`
- `timeoutMs: 1000`
- `maxRetries: 2`
- deterministic `successResponse()` HTML payload

That means `retryRecovery` currently measures one recovered transient fetch
failure with the real retry delay derived from the fixed policy. It does not
exercise:

- browser-required plans
- multiple successive recovered retries
- exhausted-budget failure output in the scorecard artifact
- capture-bundle export beyond the in-memory store

## Budgets And Artifacts

Current local budgets enforced by the script:

- `baselineAccess.p95Ms <= 25`
- `candidateAccess.p95Ms <= 50`
- `retryRecovery.p95Ms <= 300`

Current artifact locations:

- committed comparison baseline:
  `docs/artifacts/e3-access-runtime-baseline.json`
- operator-facing scorecard overwritten by the default benchmark/check command:
  `docs/artifacts/e3-access-runtime-scorecard.json`

Important artifact details from the real script and committed files:

- `comparison.baselinePath` is written as an absolute path because the script
  resolves the provided baseline path before persisting the artifact
- the committed baseline artifact currently records `sampleSize: 3` and
  `warmupIterations: 1`
- the committed scorecard artifact currently records the default command shape:
  `sampleSize: 12` and `warmupIterations: 3`

Because of that sampling mismatch, `comparison.deltas.*` are still useful for
trend inspection, but they are not a strict like-for-like comparison unless the
baseline is intentionally regenerated with the same sample and warmup settings
as the candidate command you plan to enforce.

## Practical Execution

Run the focused verification suite first:

```bash
bun test tests/scripts/e3-access-runtime-benchmark.test.ts
```

Run the default operator scorecard command:

```bash
bun run benchmark:e3-access-runtime
```

Run a smaller persisted local spot-check:

```bash
bun run scripts/benchmarks/e3-access-runtime.ts \
  --baseline docs/artifacts/e3-access-runtime-baseline.json \
  --artifact tmp/e3-access-runtime-scorecard.json \
  --sample-size 3 \
  --warmup 1
```

Run a stdout-only exploratory pass with no baseline comparison:

```bash
bun run scripts/benchmarks/e3-access-runtime.ts \
  --sample-size 3 \
  --warmup 1
```

Refresh the committed baseline artifact intentionally:

```bash
bun run scripts/benchmarks/e3-access-runtime.ts \
  --artifact docs/artifacts/e3-access-runtime-baseline.json \
  --sample-size 12 \
  --warmup 3
```

Only refresh the baseline when the current performance profile is understood and
reviewed. If the goal is like-for-like delta comparisons for the default
package script, keep the baseline sampling aligned with the package defaults.

Use the package alias when you only need pass/fail behavior and the persisted
scorecard:

```bash
bun run check:e3-access-runtime
```

## Expected Artifact Shape

When `--artifact` is provided, the benchmark writes a JSON document with the
schema enforced by `BenchmarkArtifactSchema`.

Key fields to inspect:

- `benchmark`
- `generatedAt`
- `environment.bun`
- `environment.platform`
- `environment.arch`
- `sampleSize`
- `warmupIterations`
- `budgets.baselineAccessP95Ms`
- `budgets.candidateAccessP95Ms`
- `budgets.retryRecoveryP95Ms`
- `measurements.baselineAccess.samples`
- `measurements.baselineAccess.minMs`
- `measurements.baselineAccess.meanMs`
- `measurements.baselineAccess.p95Ms`
- `measurements.baselineAccess.maxMs`
- `measurements.candidateAccess.samples`
- `measurements.candidateAccess.minMs`
- `measurements.candidateAccess.meanMs`
- `measurements.candidateAccess.p95Ms`
- `measurements.candidateAccess.maxMs`
- `measurements.retryRecovery.samples`
- `measurements.retryRecovery.minMs`
- `measurements.retryRecovery.meanMs`
- `measurements.retryRecovery.p95Ms`
- `measurements.retryRecovery.maxMs`
- `comparison.baselinePath`
- `comparison.deltas.baselineAccessP95Ms`
- `comparison.deltas.candidateAccessP95Ms`
- `comparison.deltas.retryRecoveryP95Ms`
- `status`

## Artifact Inspection Guidance

For a healthy default run, inspect the artifact for all of the following:

- `status === "pass"`
- `sampleSize === 12`
- `warmupIterations === 3`
- `measurements.baselineAccess.p95Ms <= budgets.baselineAccessP95Ms`
- `measurements.candidateAccess.p95Ms <= budgets.candidateAccessP95Ms`
- `measurements.retryRecovery.p95Ms <= budgets.retryRecoveryP95Ms`
- `comparison.baselinePath` points at
  `docs/artifacts/e3-access-runtime-baseline.json`

Interpret the three summaries this way:

- `baselineAccess` is the local planner-plus-body-read floor for the current
  machine
- `candidateAccess` is the successful HTTP capture path plus in-memory bundle
  persistence
- `retryRecovery` is the one-recovered-transient-failure path and should remain
  the slowest summary because it includes a real retry delay

Important current behavior:

- `status` depends only on the three absolute p95 budgets above
- a positive `comparison.deltas.*` value does not fail the run by itself
- `minMs`, `meanMs`, and `maxMs` are diagnostic only; they do not affect pass
  or fail

If you need to verify capture-bundle counts, artifact kinds, retry attempt
counts, or exhausted-budget reporting, use the focused test file instead of the
scorecard artifact because those details are not serialized into the benchmark
JSON.

## What A Failure Means Today

The benchmark marks the run as failed only when at least one of these
conditions is true:

- `measurements.baselineAccess.p95Ms > budgets.baselineAccessP95Ms`
- `measurements.candidateAccess.p95Ms > budgets.candidateAccessP95Ms`
- `measurements.retryRecovery.p95Ms > budgets.retryRecoveryP95Ms`

If the printed JSON or persisted artifact shows `status: "fail"`, use the
breached `measurements.*.p95Ms` field as the primary diagnostic summary.

## Troubleshooting

### The command fails with `Unknown argument`

The harness accepts only `--artifact`, `--baseline`, `--sample-size`, and
`--warmup`. Remove any extra flags.

### The command rejects `--warmup 0`

That is expected with the current parser. Both `--sample-size` and `--warmup`
must be positive integers greater than zero.

### `status` is `fail`

Inspect these fields in order:

1. `measurements.baselineAccess.p95Ms`
2. `measurements.candidateAccess.p95Ms`
3. `measurements.retryRecovery.p95Ms`
4. `budgets`
5. `comparison.deltas`
6. `sampleSize` and `warmupIterations`

Interpretation for current behavior:

- `baselineAccess` failure means the local planner/body-read floor regressed
- `candidateAccess` failure means the successful HTTP capture path regressed
- `retryRecovery` failure means the recovered transient-failure path regressed
- positive deltas without a budget breach are regressions worth watching, but
  they are not gate failures by themselves
- if `sampleSize` or `warmupIterations` changed from the expected values, do
  not compare the result directly to the committed scorecard without noting the
  sampling difference

### The persisted scorecard contains an unexpected absolute baseline path

That is expected today. The script resolves the baseline CLI argument before it
writes `comparison.baselinePath`, so the stored string is machine-specific.

### The artifact was not written

The script writes a file only when `--artifact <path>` is provided. Without
that flag it prints JSON to stdout and returns the in-memory artifact only.

### You need a deterministic reproduction of the retry and artifact details

Run the focused suite:

```bash
bun test tests/scripts/e3-access-runtime-benchmark.test.ts
```

That suite covers:

- real runtime planning on the deterministic fixture
- successful HTTP capture plus in-memory bundle persistence
- single-retry recovery from fetch-time and body-read transient failures
- exhausted retry budget reporting at the caller boundary
- artifact persistence through `runBenchmark(...)`

If that test file is red, fix that regression before treating benchmark
scorecards as trustworthy.

## Rollout

Use this sequence before promoting an HTTP-path E3 runtime change:

1. Run the focused verification suite.
2. Run a small persisted benchmark pass:

```bash
bun run scripts/benchmarks/e3-access-runtime.ts \
  --baseline docs/artifacts/e3-access-runtime-baseline.json \
  --artifact tmp/e3-access-runtime-scorecard.json \
  --sample-size 3 \
  --warmup 1
```

3. Inspect `status`, `sampleSize`, `warmupIterations`, the three
   `measurements.*.p95Ms` fields, and `comparison.deltas`.
4. Run the default benchmark command:

```bash
bun run check:e3-access-runtime
```

5. Run the related E3 verification commands:

```bash
bun run check:e3-capability-slice
bun test tests/scripts/e3-access-runtime-benchmark.test.ts
```

6. Run the repository gates required by project policy:

```bash
bun run ultracite
bun run oxlint
bun run oxfmt
bun run build
```

Promote only when the focused suite is green, the persisted scorecard is a
pass, and the repository gates are green.

## Rollback

Rollback is warranted when the current benchmark starts producing:

- `status: "fail"` in the default scorecard
- a new p95 budget breach in `baselineAccess`, `candidateAccess`, or
  `retryRecovery`
- a benchmark shape that no longer matches the intended HTTP-only rollout
  target

Rollback procedure:

1. Revert the E3 HTTP-path change or restore the last known-good policy/config
   that affected the benchmarked path.
2. Re-run the focused suite:

```bash
bun test tests/scripts/e3-access-runtime-benchmark.test.ts
```

3. Re-run a persisted benchmark pass:

```bash
bun run scripts/benchmarks/e3-access-runtime.ts \
  --baseline docs/artifacts/e3-access-runtime-baseline.json \
  --artifact tmp/e3-access-runtime-scorecard.json \
  --sample-size 3 \
  --warmup 1
```

4. Confirm the artifact returns to:
   - `status === "pass"`
   - all three `measurements.*.p95Ms` within budget
   - the expected sample and warmup settings for the command you are using
5. Re-run the default scorecard command and the repository gates before
   reattempting rollout.

Forbidden rollback shortcuts:

- widening the budgets casually instead of fixing the slower path
- treating a machine-specific `comparison.baselinePath` string change as a real
  performance regression
- claiming rollback is complete without rerunning the focused suite and the
  benchmark command
