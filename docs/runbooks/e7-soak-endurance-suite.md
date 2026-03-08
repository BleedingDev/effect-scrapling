# E7 Soak And Endurance Suite

## Purpose

Use this runbook to execute the current E7 soak/endurance suite, inspect the
persisted stability artifact, and decide whether a candidate remains stable
across repeated deterministic E7 harness runs.

This suite measures the behavior that exists today:

- repeated baseline-corpus execution
- repeated incumbent-comparison execution
- per-iteration heap delta inside the benchmark process
- fingerprint stability across repeated persisted samples
- bounded growth checks between the first and last persisted samples

It does not measure:

- live target fetches
- browser-backed extraction
- external storage or network I/O
- process lifetime outside one benchmark invocation

## Current Command Surface

Focused verification:

```bash
bun test tests/libs/foundation-core-quality-soak-suite-runtime.test.ts
bun test tests/scripts/e7-soak-endurance-suite.test.ts
```

Operator-facing commands:

```bash
bun run benchmark:e7-soak-endurance-suite
bun run check:e7-soak-endurance-suite
```

Direct script:

```bash
bun run scripts/benchmarks/e7-soak-endurance-suite.ts \
  --artifact docs/artifacts/e7-soak-endurance-artifact.json
```

`check:e7-soak-endurance-suite` runs the two focused test files first and then
executes the benchmark command.

Important behavior:

- `benchmark:e7-soak-endurance-suite` writes
  `docs/artifacts/e7-soak-endurance-artifact.json`
- use the direct script with a `tmp/` artifact path for scratch or triage runs
- omitting `--artifact` prints JSON only and does not persist a file

## CLI Options

`scripts/benchmarks/e7-soak-endurance-suite.ts` accepts only:

- `--artifact <path>`
- `--iterations <positive integer>`
- `--warmup <non-negative integer>`

Defaults:

- `iterations = 4`
- `warmupIterations = 1`

Behavior notes:

- warmup iterations execute the same inner work but are not included in
  `sampleCount` or `samples`
- the script resolves `--artifact` to an absolute path before persisting
- there is no CLI flag today for custom policy thresholds, custom `suiteId`, or
  a dynamic timestamp
- `generatedAt` is currently hardcoded to `2026-03-08T19:45:00.000Z` in the
  implementation and should not be treated as the actual wall-clock execution
  time

## Stability Policy

Default thresholds are baked into the shared runtime:

- `maxBaselineCorpusGrowthMs = 100`
- `maxIncumbentComparisonGrowthMs = 200`
- `maxHeapGrowthKiB = 4096`
- `maxConsecutiveHeapGrowth = 4`

How the suite evaluates stability:

- `baselineCorpusGrowthMs` is `max(0, last.baselineCorpusMs - first.baselineCorpusMs)`
- `incumbentComparisonGrowthMs` is
  `max(0, last.incumbentComparisonMs - first.incumbentComparisonMs)`
- `heapGrowthKiB` is `max(0, last.heapDeltaKiB - first.heapDeltaKiB)`
- `maxConsecutiveHeapGrowth` counts the longest strictly increasing streak in
  per-sample `heapDeltaKiB`
- fingerprints must stay identical across all persisted samples

`status` is `fail` when any fingerprint-stability or growth check breaches the
policy.

## Artifact Locations

- committed operator artifact: `docs/artifacts/e7-soak-endurance-artifact.json`
- recommended scratch artifact: `tmp/e7-soak-endurance-artifact.json`

The persisted artifact contains:

- `benchmark`
- `suiteId`
- `generatedAt`
- `policy`
- `sampleCount`
- `status`
- `violations`
- `stability`
- `samples`

## Practical Execution

Run the focused verification first:

```bash
bun test tests/libs/foundation-core-quality-soak-suite-runtime.test.ts \
  tests/scripts/e7-soak-endurance-suite.test.ts
```

Run a scratch soak artifact without touching the committed docs artifact:

```bash
bun run scripts/benchmarks/e7-soak-endurance-suite.ts \
  --artifact tmp/e7-soak-endurance-artifact.json
```

Run a faster local spot-check while debugging:

```bash
bun run scripts/benchmarks/e7-soak-endurance-suite.ts \
  --artifact tmp/e7-soak-endurance-artifact.json \
  --iterations 2 \
  --warmup 0
```

Run the merge-facing gate that matches the package script surface:

```bash
bun run check:e7-soak-endurance-suite
```

If you intentionally want to refresh the committed operator artifact:

```bash
bun run benchmark:e7-soak-endurance-suite
```

## Library-Level Usage

The shipped library contract is the shared runtime in
`libs/foundation/core/src/quality-soak-suite-runtime.ts`. SDK or library
consumers that already have their own samples can evaluate them directly:

```ts
import { Effect } from "effect";
import { evaluateQualitySoakSuite } from "effect-scrapling/e7";

const artifact = await Effect.runPromise(
  evaluateQualitySoakSuite({
    suiteId: "suite-e7-soak-endurance",
    generatedAt: "2026-03-08T19:45:00.000Z",
    samples,
  }),
);
```

That runtime still enforces the same schema-backed policy and contiguous
iteration numbering as the benchmark script.

## Reading The Artifact

Inspect the artifact with:

```bash
cat tmp/e7-soak-endurance-artifact.json
jq '{status, policy, stability, violations, sampleCount}' \
  tmp/e7-soak-endurance-artifact.json
```

Focus on:

- `status`
- `violations`
- `stability.baselineCorpusGrowthMs`
- `stability.incumbentComparisonGrowthMs`
- `stability.heapGrowthKiB`
- `stability.maxConsecutiveHeapGrowth`
- `stability.baselineFingerprintStable`
- `stability.comparisonFingerprintStable`
- `stability.unboundedGrowthDetected`
- `samples[*].baselineCorpusMs`
- `samples[*].incumbentComparisonMs`
- `samples[*].heapDeltaKiB`

Interpretation:

- `status = "pass"` means no configured violations were emitted
- `status = "fail"` means at least one policy threshold or fingerprint check
  failed
- `unboundedGrowthDetected = true` means one of the growth limits was breached
- fingerprint instability is usually more serious than timing variance because
  it means the deterministic baseline or comparison output changed
- timing growth is computed from the first persisted sample to the last
  persisted sample, not from an average or p95 calculation

## Troubleshooting

### The command fails with `Unknown argument`

The script accepts only the three documented flags. Remove any extra options.

### The command fails with `Missing value for argument`

`--artifact`, `--iterations`, and `--warmup` all require an immediate value.
Do not leave a flag trailing at the end of the command.

### The suite fails even though fingerprints stayed stable

Inspect:

1. `violations`
2. `stability.baselineCorpusGrowthMs`
3. `stability.incumbentComparisonGrowthMs`
4. `stability.heapGrowthKiB`
5. `stability.maxConsecutiveHeapGrowth`

This usually means the run regressed on elapsed growth rather than output
shape. The current implementation measures real wall-clock time, so a clean
candidate can still fail on a busy machine. Preserve the failing artifact,
rerun on a quieter machine or with fewer scratch iterations for diagnosis, and
then inspect the upstream baseline-corpus or incumbent-comparison lanes before
touching thresholds.

### A fresh local run fails but the committed artifact passes

That is possible today. The committed artifact is only one deterministic sample
set, while the benchmark uses live local timing for each invocation. Compare:

1. `violations`
2. `stability.*`
3. `samples[*].incumbentComparisonMs`
4. `samples[*].baselineCorpusMs`

Treat the current run artifact as the source of truth for the environment where
you executed it. Do not silently replace the committed artifact with a failing
scratch run.

### `baselineFingerprintStable` or `comparisonFingerprintStable` becomes `false`

Rerun the upstream deterministic lanes first:

```bash
bun run check:e7-baseline-corpus
bun run check:e7-incumbent-comparison
```

If the fingerprints keep changing, treat that as a real deterministic
regression in the E7 baseline corpus or incumbent-comparison output rather than
as soak-only noise.

### `sampleCount` is lower than expected

`sampleCount` includes only persisted soak iterations. Warmup iterations are
discarded by design.

### `generatedAt` does not change across runs

That is the current implementation. Use the artifact file path, shell history,
or file modification time to determine when the run actually happened.

## Rollout Guidance

Use this sequence when promoting a candidate that touched the E7 quality lane:

1. Run `bun run check:e7-baseline-corpus`.
2. Run `bun run check:e7-incumbent-comparison`.
3. Run `bun run check:e7-soak-endurance-suite`.
4. Review the new artifact and require:
   - `status = "pass"`
   - both fingerprint-stability flags equal `true`
   - `violations = []`
5. Keep scratch artifacts under `tmp/` during investigation.
6. Refresh `docs/artifacts/e7-soak-endurance-artifact.json` only when you are
   intentionally publishing operator evidence for the accepted state.

Reject rollout when the soak suite fails on fingerprint drift or repeatable
growth breaches. Open a remediation bead instead of widening thresholds first.

## Rollback Guidance

There is no separate mutable soak-service state to roll back. Rollback in this
lane means reverting the candidate change that introduced the regression and
rerunning the deterministic E7 checks.

Recommended rollback steps:

1. Preserve the failing soak artifact.
2. Record the exact `violations` and the affected `stability.*` fields.
3. Revert the candidate code, fixture, or comparison change that introduced the
   regression.
4. Rerun:
   - `bun run check:e7-baseline-corpus`
   - `bun run check:e7-incumbent-comparison`
   - `bun run check:e7-soak-endurance-suite`
5. Restore the committed soak artifact only after the rerun is green and the
   replacement artifact reflects the known-good state.

Do not "fix" rollback by changing the thresholds first. That changes the
meaning of every future E7 soak decision.
