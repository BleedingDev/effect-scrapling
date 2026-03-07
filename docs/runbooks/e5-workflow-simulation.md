# E5 Workflow Simulation Runbook

## Purpose

Use this runbook when operators or SDK consumers need to run the current E5
durable-workflow scale harness, inspect the emitted scorecard artifact, and
decide whether a workflow-orchestration change is safe to keep or must be
rolled back.

This runbook is intentionally limited to behavior that exists today in:

- `scripts/benchmarks/e5-workflow-simulation.ts`
- `tests/scripts/e5-workflow-simulation.test.ts`
- `package.json` benchmark and check scripts

Important scope limits from the real harness:

- the benchmark validates workflow compilation, repeated resume behavior,
  checkpoint stability, and aggregate observation throughput with a synthetic
  in-memory runtime
- it does not exercise live network I/O, browser sessions, or durable external
  storage backends
- benchmark concurrency is fixed in the script at `8` and is not configurable
  through the CLI today

## Current Command Surface

The repository currently exposes these commands for this suite:

```bash
bun run benchmark:e5-workflow-simulation
bun run check:e5-workflow-simulation
bun test tests/scripts/e5-workflow-simulation.test.ts
```

`benchmark:e5-workflow-simulation` currently expands to:

```bash
bun run scripts/benchmarks/e5-workflow-simulation.ts \
  --artifact docs/artifacts/e5-workflow-simulation-scorecard.json
```

`check:e5-workflow-simulation` is currently just an alias for the benchmark:

```bash
bun run benchmark:e5-workflow-simulation
```

The script always prints the full JSON artifact to stdout. When the computed
artifact has `status: "fail"`, the CLI also exits non-zero.

## CLI Options

`scripts/benchmarks/e5-workflow-simulation.ts` accepts only these options:

- `--artifact <path>`
- `--baseline <path>`
- `--targets <positive integer>`
- `--observations-per-target <positive integer>`
- `--sample-size <positive integer>`
- `--warmup <non-negative integer>`

Defaults from the script:

- `targetCount=100`
- `observationsPerTarget=2000`
- `sampleSize=2`
- `warmupIterations=1`

Behavior notes:

- the default profile produces `200000` total observations
- omitting `--artifact` prints JSON only and does not persist a file
- omitting `--baseline` keeps `comparison.baselinePath` and
  `comparison.deltas.*` as `null`
- `--warmup 0` is valid today
- any other CLI flag fails immediately with `Unknown argument: ...`

## What The Harness Measures

Each simulated target goes through the same deterministic workflow path:

1. compile one crawl plan per target in canonical target order
2. `start(...)` the workflow
3. `resume(...)` it twice
4. persist the resulting checkpoints and synthetic snapshot output in memory

Current details baked into the script:

- `100` targets by default
- `2000` observations per target by default
- `3` checkpoints per target for the happy path
- expected checkpoint-stage fingerprint:
  `snapshot>quality>reflect`
- fixed `createdAt` timestamp: `2026-03-07T14:00:00.000Z`
- fixed pack/access-policy fixture with browser mode and bounded concurrency

That means the committed 200k scenario currently validates orchestration scale,
stable checkpoint sequencing, and synthetic throughput only. It does not
currently measure:

- real browser capture cost
- real HTTP variability
- cross-process durability or recovery from persisted external stores
- failure-path checkpoint fanout beyond the deterministic happy path

## Budgets And Artifact

Current local budgets enforced by the script:

- `measurements.workflowDurationMs.p95 <= 10000`
- `measurements.observationsPerSecond.mean >= 20000`
- `measurements.checkpointsPerSecond.mean >= 60`
- `stability.observedCheckpointCount === profile.targetCount * 3`
- `stability.observedStageFingerprint === "snapshot>quality>reflect"`
- `stability.consistentCheckpointCount === true`
- `stability.consistentStageFingerprint === true`

Current artifact locations:

- operator-facing scorecard overwritten by the default benchmark/check command:
  `docs/artifacts/e5-workflow-simulation-scorecard.json`
- optional comparison baseline chosen by the operator with `--baseline <path>`

There is no committed E5 baseline artifact in this repository today. Because
the package script does not pass `--baseline`, the committed scorecard normally
records `comparison.baselinePath: null` and `comparison.deltas.*: null`.

## Practical Execution

Run the focused verification suite first:

```bash
bun test tests/scripts/e5-workflow-simulation.test.ts
```

Run the default 200k operator scorecard command:

```bash
bun run benchmark:e5-workflow-simulation
```

Run a smaller persisted local spot-check:

```bash
bun run scripts/benchmarks/e5-workflow-simulation.ts \
  --artifact tmp/e5-workflow-simulation-scorecard.json \
  --targets 20 \
  --observations-per-target 500 \
  --sample-size 1 \
  --warmup 0
```

Generate a local comparison baseline with the default 200k profile:

```bash
bun run scripts/benchmarks/e5-workflow-simulation.ts \
  --artifact tmp/e5-workflow-simulation-baseline.json \
  --targets 100 \
  --observations-per-target 2000 \
  --sample-size 2 \
  --warmup 1
```

Inspect that local baseline before reusing it. Only compare against a baseline
whose artifact reports `status === "pass"`; a failing baseline is still
schema-valid input to the script, but its deltas are not a useful candidate
comparison.

Compare a new run against that local baseline:

```bash
bun run scripts/benchmarks/e5-workflow-simulation.ts \
  --baseline tmp/e5-workflow-simulation-baseline.json \
  --artifact tmp/e5-workflow-simulation-scorecard.json \
  --targets 100 \
  --observations-per-target 2000 \
  --sample-size 2 \
  --warmup 1
```

Use the package alias when you only need pass/fail behavior and the persisted
default scorecard:

```bash
bun run check:e5-workflow-simulation
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
- `profile.targetCount`
- `profile.observationsPerTarget`
- `profile.totalObservations`
- `budgets.workflowDurationP95Ms`
- `budgets.observationsPerSecondMin`
- `budgets.checkpointsPerSecondMin`
- `measurements.workflowDurationMs`
- `measurements.observationsPerSecond`
- `measurements.checkpointsPerSecond`
- `stability.expectedCheckpointCount`
- `stability.observedCheckpointCount`
- `stability.consistentCheckpointCount`
- `stability.expectedStageFingerprint`
- `stability.observedStageFingerprint`
- `stability.consistentStageFingerprint`
- `comparison.baselinePath`
- `comparison.deltas.workflowDurationP95Ms`
- `comparison.deltas.observationsPerSecondMean`
- `comparison.deltas.checkpointsPerSecondMean`
- `violations`
- `status`

## Artifact Inspection Guidance

For a healthy default run, inspect the artifact for all of the following:

- `status === "pass"`
- `profile.totalObservations === 200000`
- `sampleSize === 2`
- `warmupIterations === 1`
- `measurements.workflowDurationMs.p95 <= budgets.workflowDurationP95Ms`
- `measurements.observationsPerSecond.mean >= budgets.observationsPerSecondMin`
- `measurements.checkpointsPerSecond.mean >= budgets.checkpointsPerSecondMin`
- `stability.expectedCheckpointCount === 300`
- `stability.observedCheckpointCount === 300`
- `stability.consistentCheckpointCount === true`
- `stability.observedStageFingerprint === "snapshot>quality>reflect"`
- `stability.consistentStageFingerprint === true`

Interpret the summaries this way:

- `workflowDurationMs` is the full compile-plus-run duration for the synthetic
  workflow batch
- `observationsPerSecond` is aggregate snapshot output throughput across all
  simulated targets
- `checkpointsPerSecond` is aggregate durable-checkpoint throughput across the
  same run
- `stability.*` verifies that repeated samples kept the same checkpoint count
  and stage ordering

The committed scorecard artifact can be inspected with:

```bash
cat docs/artifacts/e5-workflow-simulation-scorecard.json
jq '{status, profile, measurements, stability, comparison, violations}' \
  docs/artifacts/e5-workflow-simulation-scorecard.json
```

## Troubleshooting

### The command fails with `Unknown argument`

The harness accepts only:

- `--artifact <path>`
- `--baseline <path>`
- `--targets <positive integer>`
- `--observations-per-target <positive integer>`
- `--sample-size <positive integer>`
- `--warmup <non-negative integer>`

### `status` is `fail`

Inspect these fields in order:

1. `violations`
2. `measurements.workflowDurationMs`
3. `measurements.observationsPerSecond`
4. `measurements.checkpointsPerSecond`
5. `stability`
6. `comparison`

Interpretation for current behavior:

- workflow-duration failures mean the synthetic compile-plus-run path exceeded
  the current local p95 budget
- observation-throughput failures mean aggregate snapshot production fell below
  the current mean budget
- checkpoint-throughput failures mean durable checkpoint production fell below
  the current mean budget
- stability mismatches mean checkpoint count or stage ordering changed across
  repeated samples and should be treated as a workflow-regression signal

Do not hand-edit the failing artifact. Keep the scorecard as the diagnostic
record for the candidate you were validating.

### The artifact was not written

The script writes a file only when `--artifact <path>` is provided. Without
that flag it prints JSON to stdout and returns the in-memory artifact only.

### You need a faster confidence check before rerunning the full 200k profile

Use the smaller persisted spot-check from the Practical Execution section:

```bash
bun run scripts/benchmarks/e5-workflow-simulation.ts \
  --artifact tmp/e5-workflow-simulation-scorecard.json \
  --targets 20 \
  --observations-per-target 500 \
  --sample-size 1 \
  --warmup 0
```

## Rollout And Rollback

Use this sequence before promoting a workflow-runtime change that could affect
the E5 orchestration path:

1. Run the focused verification suite.
2. Run the smaller persisted spot-check and inspect `status`, `measurements`,
   `stability`, and `violations`.
3. Run the default 200k scorecard command.
4. Keep the emitted scorecard artifact with the candidate change for review.

Rollback guidance for the current benchmark:

- if the smaller spot-check fails, stop there and fix the regression before
  rerunning the 200k scenario
- if the default 200k scenario fails, keep the failing scorecard unchanged and
  roll back the candidate workflow/runtime change rather than widening budgets
- if you need to preserve failing evidence without leaving the tracked artifact
  path dirty, rerun the script to a temporary artifact path such as
  `tmp/e5-workflow-simulation-scorecard.json` before abandoning the candidate
  branch
- only regenerate a local baseline intentionally after the new behavior is
  understood and reviewed
