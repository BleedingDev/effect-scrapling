# E6 Performance Budget

## Purpose

Use this runbook to execute the current E6 site-pack/reflection performance
budget harness, inspect the committed artifacts, and decide whether an E6
change is safe to keep or must be remediated.

This harness is intentionally limited to the deterministic, in-process E6
pipeline that exists today in:

- `scripts/benchmarks/e6-performance-budget.ts`
- `examples/e6-capability-slice.ts`
- `tests/scripts/e6-performance-budget.test.ts`

It measures the real typed E6 operations that currently exist:

- full `runE6CapabilitySlice()` end-to-end latency
- site-pack registry resolution against a fixed catalog
- reflection recommendation synthesis against fixed typed signals
- validator, promotion, and governance application against a fixed catalog

It does not benchmark:

- live network access
- browser-backed extraction
- persistent storage I/O
- concurrent multi-tenant governance traffic

## Current Command Surface

The repository currently exposes both the package aliases and the direct script:

```bash
bun test tests/scripts/e6-performance-budget.test.ts

bun run benchmark:e6-performance-budget
bun run check:e6-performance-budget

bun run scripts/benchmarks/e6-performance-budget.ts \
  --artifact docs/artifacts/e6-performance-budget-baseline.json

bun run scripts/benchmarks/e6-performance-budget.ts \
  --baseline docs/artifacts/e6-performance-budget-baseline.json \
  --artifact docs/artifacts/e6-performance-budget-scorecard.json
```

The script always prints the full JSON artifact to stdout. When the computed
artifact has `status: "fail"`, the CLI exits non-zero.

`benchmark:e6-performance-budget` currently expands to:

```bash
bun run scripts/benchmarks/e6-performance-budget.ts \
  --baseline docs/artifacts/e6-performance-budget-baseline.json \
  --artifact docs/artifacts/e6-performance-budget-scorecard.json
```

`check:e6-performance-budget` is currently an alias for the benchmark command.

## CLI Options

`scripts/benchmarks/e6-performance-budget.ts` accepts only:

- `--artifact <path>`
- `--baseline <path>`
- `--sample-size <positive integer>`
- `--warmup <non-negative integer>`

Defaults:

- `sampleSize=12`
- `warmupIterations=3`

Behavior notes:

- omitting `--artifact` prints JSON only and does not persist a file
- omitting `--baseline` keeps `comparison.baselinePath` as `null`,
  `comparison.comparable=false`, and `comparison.deltas.*` as `null`
- providing `--baseline` computes `comparison.deltas.*` only when
  `sampleSize`, `warmupIterations`, and `profile` exactly match the baseline;
  otherwise `comparison.comparable=false`, `comparison.incompatibleReason`
  explains the mismatch, and all deltas stay `null`
- any other flag fails immediately with `Unknown argument: ...`

## What The Harness Measures

Each benchmark run uses a fixed deterministic workload profile recorded in the
artifact under `profile`:

- `catalogSize: 192`
- `capabilitySliceRunsPerSample: 3`
- `registryLookupsPerSample: 128`
- `signalCount: 48`
- `reflectionIterationsPerSample: 12`
- `governanceCatalogArtifacts: 2`
- `governanceIterationsPerSample: 12`
- `minimumOccurrenceCount: 2`

Interpretation of the stage metrics:

- `measurements.capabilitySlice`
  - three sequential `runE6CapabilitySlice()` executions per sample
  - the sample latency is the average cost of that 3-run micro-batch
  - validates the current end-to-end E6 proving lane
- `measurements.registryResolution`
  - `128` repeated `resolvePackRegistryLookup(...)` calls per sample
  - ranks a fixed `192`-pack catalog for `shop.example.com`
- `measurements.reflectionRecommendation`
  - `12` repeated `synthesizePackReflection(...)` calls per sample
  - uses `48` typed regression/fixture signals with threshold `2`
- `measurements.promotionGovernance`
  - `12` repeated validator-ladder, promotion-decision, and governance-apply
    loops per sample
  - uses the current shadow pack, fixed snapshot diff, and a `2`-artifact
    governance catalog

The harness also records `stability.*` fields for both the full capability
slice and the focused micro-bench flows:

- capability slice:
  - `resolvedPackFingerprint`
  - `clusterFingerprint`
  - `proposalFingerprint`
  - `qualityAction`
  - `decisionAction`
  - `governanceAuditFingerprint`
  - `activeVersion`
- registry micro-bench:
  - `registryResolvedPackFingerprint`
- reflection micro-bench:
  - `reflectionClusterFingerprint`
  - `reflectionProposalFingerprint`
- promotion/governance micro-bench:
  - `promotionQualityAction`
  - `promotionDecisionAction`
  - `promotionGovernanceAuditFingerprint`
  - `promotionActiveVersion`

Any `consistent: false` value means the benchmark stopped measuring the same E6
behavior and must be treated as contract drift, not just a latency change.

## Budgets

Current local budgets:

- `measurements.capabilitySlice.p95Ms <= 25`
- `measurements.registryResolution.p95Ms <= 25`
- `measurements.reflectionRecommendation.p95Ms <= 100`
- `measurements.promotionGovernance.p95Ms <= 100`
- `measurements.heapDeltaKiB <= 16384`
- every `stability.*.consistent === true`

These limits are intentionally wide enough to stay reproducible on a normal
developer machine while still flagging obvious regressions in E6 pack
resolution, reflector clustering, validator gating, or governance application.
The capability-slice lane uses a 3-run sample specifically so the reported p95
tracks steady-state E6 work instead of a single Bun/GC spike. The percentile is
computed with linear interpolation, so the p95 is not just the highest sample
when `sampleSize` is small.

## Artifact Locations

- committed baseline:
  `docs/artifacts/e6-performance-budget-baseline.json`
- operator-facing scorecard:
  `docs/artifacts/e6-performance-budget-scorecard.json`

`comparison.baselinePath` is written as an absolute path because the script
resolves the baseline CLI argument before persisting the artifact.

## Practical Execution

Run the focused suite first:

```bash
bun test tests/scripts/e6-performance-budget.test.ts
```

Refresh the committed baseline intentionally:

```bash
bun run scripts/benchmarks/e6-performance-budget.ts \
  --artifact docs/artifacts/e6-performance-budget-baseline.json
```

Write the operator scorecard against the committed baseline:

```bash
bun run scripts/benchmarks/e6-performance-budget.ts \
  --baseline docs/artifacts/e6-performance-budget-baseline.json \
  --artifact docs/artifacts/e6-performance-budget-scorecard.json
```

Run a smaller local spot-check without baseline deltas:

```bash
bun run scripts/benchmarks/e6-performance-budget.ts \
  --artifact tmp/e6-performance-budget-scorecard.json \
  --sample-size 3 \
  --warmup 1
```

## Reading The Artifact

Key fields:

- `profile`
- `measurements.capabilitySlice`
- `measurements.registryResolution`
- `measurements.reflectionRecommendation`
- `measurements.promotionGovernance`
- `measurements.heapDeltaKiB`
- `stability`
- `comparison.comparable`
- `comparison.incompatibleReason`
- `comparison.deltas.*`
- `violations`
- `status`

Inspect the persisted scorecard with:

```bash
cat docs/artifacts/e6-performance-budget-scorecard.json
jq '{status, profile, measurements, stability, comparison, violations}' \
  docs/artifacts/e6-performance-budget-scorecard.json
```

Interpretation:

- `resolvedPackFingerprint` proves the registry still selects the expected
  shadow pack
- `clusterFingerprint` and `proposalFingerprint` prove the reflector still
  produces the same pack-level recommendation
- `qualityAction`, `decisionAction`, and `governanceAuditFingerprint` prove the
  validator and governance path still emits the current active-promotion flow

If `status` is `fail`, keep the scorecard artifact unchanged and treat it as
the blocking evidence for the candidate.

## Remediation Workflow

If `docs/artifacts/e6-performance-budget-scorecard.json` reports
`status: "fail"`:

1. Keep the persisted scorecard unchanged so the evidence remains inspectable.
2. Record the exact failing metrics or stability fields from:
   - `measurements.*`
   - `stability.*`
   - `comparison.comparable`
   - `comparison.incompatibleReason`
   - `comparison.deltas.*` when the baseline is comparable
   - `violations`
3. Open a blocking remediation bead instead of widening budgets first.

## Troubleshooting

### The command fails with `Unknown argument`

The harness accepts only:

- `--artifact <path>`
- `--baseline <path>`
- `--sample-size <positive integer>`
- `--warmup <non-negative integer>`

### `stability.*.consistent` flips to `false`

Treat that as E6 contract drift. Inspect:

1. `examples/e6-capability-slice.ts`
2. `tests/examples/e6-capability-slice.test.ts`
3. `tests/libs/foundation-core-reflector-runtime.test.ts`
4. `tests/libs/foundation-core-validator-ladder-runtime.test.ts`
5. `tests/libs/foundation-core-reflection-engine-runtime.test.ts`

Do not refresh the baseline until the behavioral change is understood and
reviewed.

### Latency regresses but stability remains green

Focus on the stage that breached first:

1. `registryResolution`: pack catalog ranking and version/state resolution
2. `reflectionRecommendation`: candidate generation and recurring-cluster
   synthesis
3. `promotionGovernance`: validator ladder, promotion decision, or governance
   audit/application cost
4. rerun `bun run check:e6-performance-budget` on an otherwise idle machine
   before widening budgets or opening a remediation bead
5. do not compare low-sample spot-checks against the committed `12/3` baseline;
   either run the default profile or omit `--baseline`
