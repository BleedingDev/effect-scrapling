# E4 Browser Soak And Load Runbook

## Purpose

Use this runbook when operators or SDK consumers need to run the current
browser soak/load harness, inspect the emitted artifact, and decide whether a
browser-runtime change is safe to keep or must be rolled back.

This runbook is intentionally limited to behavior that exists today in:

- `scripts/benchmarks/e4-browser-soak-load.ts`
- `tests/scripts/e4-browser-soak-load.test.ts`
- `package.json` benchmark and check scripts

## Current Command Surface

The repository currently exposes these commands for this suite:

```bash
bun run benchmark:e4-browser-soak-load
bun run check:e4-browser-soak-load
bun test tests/scripts/e4-browser-soak-load.test.ts
```

`benchmark:e4-browser-soak-load` runs:

```bash
bun run scripts/benchmarks/e4-browser-soak-load.ts
```

`check:e4-browser-soak-load` is currently just an alias for the benchmark:

```bash
bun run benchmark:e4-browser-soak-load
```

## CLI Options

`scripts/benchmarks/e4-browser-soak-load.ts` accepts only these options:

- `--artifact <path>`
- `--rounds <positive integer>`
- `--concurrency <positive integer>`
- `--warmup <non-negative integer>`

Defaults from the script:

- `rounds=8`
- `concurrency=6`
- `warmup=1`

Any other CLI flag fails immediately with `Unknown argument: ...`.

## Practical Execution

Run the focused verification suite first:

```bash
bun test tests/scripts/e4-browser-soak-load.test.ts
```

Run the benchmark with the script defaults:

```bash
bun run benchmark:e4-browser-soak-load
```

Run a smaller local verification pass and persist the artifact:

```bash
bun run benchmark:e4-browser-soak-load -- \
  --rounds 2 \
  --concurrency 2 \
  --warmup 0 \
  --artifact tmp/e4-browser-soak-load.json
```

Run a fuller soak/load pass and persist the artifact:

```bash
bun run benchmark:e4-browser-soak-load -- \
  --rounds 8 \
  --concurrency 6 \
  --warmup 1 \
  --artifact tmp/e4-browser-soak-load.json
```

Use the package alias when you only need pass/fail behavior:

```bash
bun run check:e4-browser-soak-load
```

## Expected Artifact Shape

When `--artifact` is provided, the benchmark writes a JSON document with the
schema enforced by `BrowserSoakLoadArtifactSchema`.

Key fields to inspect:

- `benchmark`
- `generatedAt`
- `environment.bun`
- `environment.platform`
- `environment.arch`
- `rounds`
- `concurrency`
- `warmupIterations`
- `measurements.roundDurationMs.samples`
- `measurements.roundDurationMs.minMs`
- `measurements.roundDurationMs.meanMs`
- `measurements.roundDurationMs.p95Ms`
- `measurements.roundDurationMs.maxMs`
- `captures.totalRuns`
- `captures.totalArtifacts`
- `captures.artifactKinds`
- `peaks.openBrowsers`
- `peaks.openContexts`
- `peaks.openPages`
- `finalSnapshot.openBrowsers`
- `finalSnapshot.openContexts`
- `finalSnapshot.openPages`
- `alarms`
- `crashTelemetry`
- `violations`
- `status`

## Artifact Inspection Guidance

For a healthy run under the default policy, inspect the artifact for all of the
following:

- `status === "pass"`
- `violations` is an empty array
- `alarms` is an empty array
- `crashTelemetry` is an empty array
- `finalSnapshot.openBrowsers === 0`
- `finalSnapshot.openContexts === 0`
- `finalSnapshot.openPages === 0`
- `peaks.openBrowsers <= 1`
- `peaks.openContexts <= concurrency`
- `peaks.openPages <= concurrency`
- `captures.totalRuns === rounds * concurrency`
- `captures.totalArtifacts === captures.totalRuns * 4`
- `captures.artifactKinds` contains exactly:
  - `renderedDom`
  - `screenshot`
  - `networkSummary`
  - `timings`

The current test suite verifies these behaviors directly. In particular:

- the default bounded suite passes
- stricter leak-policy overrides fail deterministically
- artifact persistence through the CLI entrypoint round-trips cleanly

## What A Failure Means Today

The benchmark marks the run as failed when `violations.length > 0`.

Current violation checks in the script are:

- non-zero final open browser count
- non-zero final open context count
- non-zero final open page count
- any leak alarms recorded
- any crash telemetry recorded
- peak browser count greater than `1`
- peak context count greater than requested `concurrency`
- peak page count greater than requested `concurrency`
- total artifact count mismatch
- artifact kind mismatch

If the printed JSON or persisted artifact shows `status: "fail"`, use the
`violations` array as the primary diagnostic summary.

## Troubleshooting

### The command fails with `Unknown argument`

The harness accepts only `--artifact`, `--rounds`, `--concurrency`, and
`--warmup`. Remove any extra flags.

### The command fails before the soak/load assertions

Check the focused suite first:

```bash
bun test tests/scripts/e4-browser-soak-load.test.ts
```

That suite covers:

- option parsing
- passing bounded run behavior
- deterministic failure under stricter leak policy
- artifact persistence through `runBenchmark(...)`

If this test file is red, fix that regression before treating benchmark output
as trustworthy.

### `status` is `fail`

Inspect these fields in order:

1. `violations`
2. `finalSnapshot`
3. `alarms`
4. `crashTelemetry`
5. `peaks`
6. `captures`

Interpretation for current behavior:

- non-zero `finalSnapshot.*` means browser/context/page cleanup did not fully
  complete
- non-empty `alarms` means the detector observed a leak-policy violation
- non-empty `crashTelemetry` means the soak/load run hit a crash/recycle path
  instead of the clean happy path
- peak counts above the requested bounds mean concurrency accounting regressed
- capture count or artifact-kind mismatch means the benchmark no longer emitted
  the expected four artifact kinds per run

### The artifact was not written

The script writes a file only when `--artifact <path>` is provided. Without that
flag it prints JSON to stdout and returns the in-memory artifact only.

### You need a deterministic failure example

The current test file demonstrates the supported failure mode by calling
`runSoakLoadSuite(...)` with a stricter policy than the requested concurrency:

- `maxOpenContexts: 1`
- `maxOpenPages: 1`
- `concurrency: 3`

That produces a failing artifact with leak alarms while still ending with
`finalSnapshot.openBrowsers === 0`, `openContexts === 0`, and `openPages === 0`.

## Rollout

Use this sequence before promoting a browser-runtime change that could affect
soak/load behavior:

1. Run the focused verification suite.
2. Run a small persisted benchmark pass:

```bash
bun run benchmark:e4-browser-soak-load -- \
  --rounds 2 \
  --concurrency 2 \
  --warmup 0 \
  --artifact tmp/e4-browser-soak-load.json
```

3. Inspect `status`, `violations`, `alarms`, `crashTelemetry`, `finalSnapshot`,
   `peaks`, and `captures`.
4. Run the default benchmark command:

```bash
bun run check:e4-browser-soak-load
```

5. Run the repository gates required by project policy:

```bash
bun run ultracite
bun run oxlint
bun run oxfmt
bun test tests/scripts/e4-browser-soak-load.test.ts
bun run build
```

Promote only when the focused suite is green, the benchmark artifact is a pass,
and the repository gates are green.

## Rollback

Rollback is warranted when the current benchmark starts producing:

- non-zero final open resource counts
- non-empty leak alarms
- non-empty crash telemetry in the expected happy path
- artifact-count or artifact-kind mismatches

Rollback procedure:

1. Revert the browser-runtime change that introduced the regression.
2. Re-run the focused suite:

```bash
bun test tests/scripts/e4-browser-soak-load.test.ts
```

3. Re-run a persisted benchmark pass:

```bash
bun run benchmark:e4-browser-soak-load -- \
  --rounds 2 \
  --concurrency 2 \
  --warmup 0 \
  --artifact tmp/e4-browser-soak-load.json
```

4. Confirm the artifact returns to:
   - `status === "pass"`
   - empty `violations`
   - empty `alarms`
   - empty `crashTelemetry`
   - zeroed `finalSnapshot.*`
5. Re-run the required repository gates before reattempting rollout.
