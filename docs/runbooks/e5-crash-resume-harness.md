# E5 Crash Resume Harness Runbook

## Purpose

Use this runbook when operators or SDK consumers need to validate the current
E5 crash-resume harness, inspect the emitted scorecard artifact, and decide
whether a workflow-runtime change preserved deterministic output across forced
restart boundaries.

This runbook is intentionally limited to behavior that exists today in:

- `scripts/benchmarks/e5-crash-resume-harness.ts`
- `tests/scripts/e5-crash-resume-harness.test.ts`
- `package.json` benchmark and check scripts

Important scope limits from the real harness:

- the harness recreates the workflow runtime after selected checkpoint
  sequences, but keeps the checkpoint and snapshot stores in memory
- it validates deterministic restart recovery against a no-crash baseline for
  the same compiled plans
- it does not simulate OS-level process death, external durable storage, live
  network I/O, or browser-process crashes

## Current Command Surface

The repository currently exposes these commands for this suite:

```bash
bun run benchmark:e5-crash-resume-harness
bun run check:e5-crash-resume-harness
bun test tests/scripts/e5-crash-resume-harness.test.ts
```

`benchmark:e5-crash-resume-harness` currently expands to:

```bash
bun run scripts/benchmarks/e5-crash-resume-harness.ts \
  --artifact docs/artifacts/e5-crash-resume-harness-scorecard.json
```

`check:e5-crash-resume-harness` is currently just an alias for the benchmark:

```bash
bun run benchmark:e5-crash-resume-harness
```

The script always prints the full JSON artifact to stdout. When the computed
artifact has `status: "fail"`, the CLI also exits non-zero.

## CLI Options

`scripts/benchmarks/e5-crash-resume-harness.ts` accepts only these options:

- `--artifact <path>`
- `--targets <positive integer>`
- `--observations-per-target <positive integer>`
- `--crash-after-sequence <1|2>`

Defaults from the script:

- `targetCount=4`
- `observationsPerTarget=25`
- `crashAfterSequences=[1, 2]`

Behavior notes:

- omitting `--artifact` prints JSON only and does not persist a file
- omitting every `--crash-after-sequence` flag uses both restart boundaries
  `[1, 2]`
- repeating `--crash-after-sequence` is allowed only for unique values; the
  decoded list cannot contain duplicates
- any other CLI flag fails immediately with `Unknown argument: ...`
- missing option values fail immediately

## What The Harness Validates

For each compiled run plan, the harness currently does all of the following:

1. compile deterministic crawl plans from the shared E5 simulation fixtures
2. run a baseline workflow to completion with no forced restart
3. run a recovered workflow that recreates the runtime after checkpoint
   sequence `1`, sequence `2`, or both
4. inspect the latest persisted checkpoint and candidate snapshot for each run
5. compare baseline and recovered outputs for deterministic equivalence

Current details baked into the script and tests:

- default profile: `4` targets and `25` observations per target
- default total observations: `100`
- expected checkpoint count per run: `3`
- expected stage fingerprint per run: `snapshot>quality>reflect`
- expected terminal stage: `reflect`
- expected terminal outcome: `succeeded`
- current fixed fixture timestamp: `2026-03-07T14:00:00.000Z`

Because the harness processes plans with `concurrency: 1`, the current restart
count is deterministic:

- `restartCount === targetCount * crashAfterSequences.length`

That means the default benchmark currently produces `restartCount === 8`.

## Practical Execution

Run the focused verification suite first:

```bash
bun test tests/scripts/e5-crash-resume-harness.test.ts
```

Run the default operator scorecard command:

```bash
bun run benchmark:e5-crash-resume-harness
```

Run a smaller persisted local spot-check:

```bash
bun run scripts/benchmarks/e5-crash-resume-harness.ts \
  --artifact tmp/e5-crash-resume-harness-scorecard.json \
  --targets 2 \
  --observations-per-target 5 \
  --crash-after-sequence 1 \
  --crash-after-sequence 2
```

Run a single-boundary recovery spot-check:

```bash
bun run scripts/benchmarks/e5-crash-resume-harness.ts \
  --artifact tmp/e5-crash-resume-seq1-scorecard.json \
  --targets 3 \
  --observations-per-target 10 \
  --crash-after-sequence 1
```

Run a stdout-only check without persisting an artifact:

```bash
bun run scripts/benchmarks/e5-crash-resume-harness.ts \
  --targets 2 \
  --observations-per-target 5 \
  --crash-after-sequence 2
```

Inspect the committed scorecard artifact with:

```bash
cat docs/artifacts/e5-crash-resume-harness-scorecard.json
jq '{status, sample: (.sample | {profile, crashAfterSequences, restartCount, matchedOutputs})}' \
  docs/artifacts/e5-crash-resume-harness-scorecard.json
```

## Expected Artifact Shape

When `--artifact` is provided, the harness writes a JSON document with the
schema enforced by `CrashResumeArtifactSchema`.

Key fields to inspect:

- `benchmark`
- `generatedAt`
- `sample.profile.targetCount`
- `sample.profile.observationsPerTarget`
- `sample.profile.totalObservations`
- `sample.crashAfterSequences`
- `sample.restartCount`
- `sample.baseline`
- `sample.recovered`
- `sample.matchedOutputs`
- `status`

Each run summary inside `sample.baseline[]` and `sample.recovered[]` currently
includes:

- `runId`
- `checkpointCount`
- `stageFingerprint`
- `finalCheckpointId`
- `finalSequence`
- `finalStage`
- `finalOutcome`
- `totalObservations`
- `inspection`

## Artifact Inspection Guidance

For a healthy default run, inspect the artifact for all of the following:

- `status === "pass"`
- `sample.profile.targetCount === 4`
- `sample.profile.observationsPerTarget === 25`
- `sample.profile.totalObservations === 100`
- `sample.crashAfterSequences === [1, 2]`
- `sample.restartCount === 8`
- `sample.matchedOutputs === true`
- every baseline and recovered run summary reports `checkpointCount === 3`
- every baseline and recovered run summary reports
  `stageFingerprint === "snapshot>quality>reflect"`
- every baseline and recovered run summary reports `finalStage === "reflect"`
- every baseline and recovered run summary reports
  `finalOutcome === "succeeded"`

Interpret the summaries this way:

- `baseline` is the no-crash reference run for the current profile
- `recovered` is the forced-restart run for the same compiled plans
- `matchedOutputs` is the top-level pass/fail signal for deterministic recovery
- `restartCount` tells you how many times the harness recreated the runtime
  while replaying the configured crash boundaries

## Troubleshooting

### The command fails with `Unknown argument`

The harness accepts only:

- `--artifact <path>`
- `--targets <positive integer>`
- `--observations-per-target <positive integer>`
- `--crash-after-sequence <1|2>`

### The command fails before running because an option value is missing or invalid

The harness requires positive integers for `--targets` and
`--observations-per-target`, and allows `--crash-after-sequence` only for `1`
or `2`. Duplicate crash-after values are rejected by the shared schema decode.

### `status` is `fail` or `sample.matchedOutputs` is `false`

Treat that as a workflow-recovery regression signal. Inspect `sample.baseline`
and `sample.recovered` together, keep the failing artifact unchanged, and run
the focused test suite before attempting any wider rollout.

### `sample.restartCount` is lower than expected

Check the requested profile first. The current harness restarts once per target
for each configured crash boundary, so a run with `--targets 2` and
`--crash-after-sequence 1` should currently report `restartCount === 2`, while
the default `[1, 2]` profile reports `restartCount === 8`.

### The artifact was not written

The script writes a file only when `--artifact <path>` is provided. Without
that flag it prints JSON to stdout and returns the in-memory artifact only.

## Rollout And Rollback

Use this sequence before promoting a workflow-runtime change that could affect
restart recovery:

1. Run the focused verification suite.
2. Run a smaller persisted spot-check to a temporary artifact path and inspect
   `status`, `sample.matchedOutputs`, `sample.restartCount`, and the baseline
   versus recovered summaries.
3. Run the default operator scorecard command when you are ready to refresh the
   repository artifact.
4. Keep the emitted scorecard artifact with the candidate change for review.

Rollback guidance for the current harness:

- if the focused test fails, stop there and fix the regression before
  refreshing any scorecard artifact
- if the temporary spot-check fails, keep that failing artifact unchanged and
  roll back the candidate workflow-runtime change rather than weakening the
  comparison
- if the default benchmark fails, preserve the failing scorecard evidence and
  roll back the candidate change before updating downstream docs or budgets
- if you need to preserve failing evidence without leaving the repository
  artifact path dirty, rerun the script to a temporary path such as
  `tmp/e5-crash-resume-harness-scorecard.json`

## Related Runbooks

- [E5 durable workflow graph fanout fanin](./e5-durable-workflow-graph-fanout-fanin.md)
- [E5 resume and replay operations](./e5-resume-replay-operations.md)
- [E5 workflow operational controls](./e5-workflow-operational-controls.md)
- [E5 workflow simulation](./e5-workflow-simulation.md)
