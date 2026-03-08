# E7 Quality Report

## Purpose

Use this runbook when operators or SDK consumers need to generate, inspect, or
publish the current E7 quality report export.

This surface exists today as:

- benchmark script: `scripts/benchmarks/e7-quality-report.ts`
- shared runtime: `libs/foundation/core/src/quality-report-runtime.ts`
- public SDK export: `src/e7.ts`
- focused verification: `tests/libs/foundation-core-quality-report-runtime.test.ts`
- focused verification: `tests/scripts/e7-quality-report.test.ts`
- focused verification: `tests/sdk/e7-public-consumer.test.ts`

The current implementation produces one operator-readable and machine-readable
JSON artifact that includes the full evidence bundle. There is no separate API
route, daemon, or alternate output format yet.

## Current Command Surface

Operator-facing commands:

```bash
bun run benchmark:e7-quality-report
bun run check:e7-quality-report
```

Direct script:

```bash
bun run scripts/benchmarks/e7-quality-report.ts \
  --artifact docs/artifacts/e7-quality-report-artifact.json
```

`check:e7-quality-report` currently runs:

1. `tests/libs/foundation-core-quality-report-runtime.test.ts`
2. `tests/scripts/e7-quality-report.test.ts`
3. `tests/sdk/e7-public-consumer.test.ts`
4. `bun run benchmark:e7-quality-report`

Behavior notes:

- the CLI accepts exactly one option today: `--artifact <path>`
- omitting `--artifact` prints the JSON report to stdout and does not persist a
  file
- `benchmark:e7-quality-report` writes the default artifact to
  `docs/artifacts/e7-quality-report-artifact.json`
- the benchmark builds its evidence bundle from these shipped default E7
  producers: baseline corpus, incumbent comparison, drift regression,
  performance budget with `--sample-size 2 --warmup 0`, chaos provider suite,
  and promotion gate evaluation

## SDK Consumer Surface

The public SDK surface is re-exported from `effect-scrapling/e7`:

```ts
import {
  QualityReportArtifactSchema,
  buildQualityReportExport,
} from "effect-scrapling/e7";
```

Use the SDK path when you already have your own E7 evidence bundle and do not
want the CLI's fixed default inputs:

```ts
import { Effect } from "effect";
import { buildQualityReportExport } from "effect-scrapling/e7";

const artifact = await Effect.runPromise(
  buildQualityReportExport({
    reportId: "report-retail-smoke",
    generatedAt: "2026-03-08T20:07:00.000Z",
    evidence,
  }),
);
```

The SDK and benchmark produce the same `QualityReportArtifactSchema` contract.

## What The Export Contains

Top-level fields:

- `benchmark = "e7-quality-report"`
- `reportId`
- `generatedAt`
- `corpusId`
- `caseCount`
- `packCount`
- `summary`
- `sections`
- `evidence`

`summary` is the operator-facing digest:

- `decision`
- `status`
- `warningSectionKeys`
- `failingSectionKeys`
- `highlights`

`sections` always contains exactly six deterministic entries, in this order:

1. `baselineCorpus`
2. `incumbentComparison`
3. `driftRegression`
4. `performanceBudget`
5. `chaosProviderSuite`
6. `promotionGate`

`evidence` carries the full typed payload for each section, so downstream CLI
and SDK consumers do not need to fetch a second artifact to inspect the verdict
inputs.

## Practical Execution

Run the focused E7 quality report checks:

```bash
bun run check:e7-quality-report
```

Refresh the committed operator artifact:

```bash
bun run scripts/benchmarks/e7-quality-report.ts \
  --artifact docs/artifacts/e7-quality-report-artifact.json
```

Write an ephemeral local copy without touching committed docs:

```bash
bun run scripts/benchmarks/e7-quality-report.ts \
  --artifact tmp/e7-quality-report-artifact.json
```

Print the report only:

```bash
bun run scripts/benchmarks/e7-quality-report.ts
```

Inspect the operator summary quickly:

```bash
jq '{reportId, summary, sections}' docs/artifacts/e7-quality-report-artifact.json
```

Inspect only the embedded evidence ids:

```bash
jq '.sections[] | {key, status, evidenceIds}' \
  docs/artifacts/e7-quality-report-artifact.json
```

## Reading The Artifact

Check these fields first:

- `summary.decision`
- `summary.status`
- `summary.warningSectionKeys`
- `summary.failingSectionKeys`
- `sections[*].status`
- `sections[*].headline`
- `evidence.promotionGate.verdict`
- `evidence.driftRegression.findings`
- `evidence.performanceBudget.comparison`
- `evidence.chaosProviderSuite.status`

Interpretation of the current default harness:

- `summary.decision` comes directly from the promotion-gate verdict
- `summary.status` is the highest severity across all six sections
- `performanceBudget` reports `warn` when the embedded performance artifact is
  valid but not baseline-comparable
- `promotionGate` reports `pass` for `promote`, `warn` for `hold`, and `fail`
  for `quarantine`
- `driftRegression` reports `pass` for `none`, `warn` for `low` or `moderate`,
  and `fail` for `high` or `critical`

The committed sample artifact currently demonstrates an important behavior:
`performanceBudget` can stay `warn` because no baseline is supplied to the
quality-report benchmark, while the export still remains valid and complete.

## Troubleshooting

### The CLI fails with `Unknown argument`

The script accepts only `--artifact <path>`. Remove any extra flags.

### The CLI fails with `Missing value for argument: --artifact`

Pass a non-empty path immediately after `--artifact`.

### The runtime fails while decoding the evidence bundle

The quality report enforces shared contracts before it emits JSON. Check these
alignment rules first:

1. `baselineCorpus.corpusId === incumbentComparison.incumbentCorpusId`
2. `baselineCorpus.corpusId === incumbentComparison.candidateCorpusId`
3. `incumbentComparison.comparisonId === driftRegression.comparisonId`
4. `driftRegression.analysisId === promotionGate.quality.analysisId`
5. `performanceBudget.benchmarkId === promotionGate.performance.benchmarkId`
6. `performanceBudget.profile.caseCount === baselineCorpus.caseCount`
7. `performanceBudget.profile.packCount === baselineCorpus.packCount`
8. every `chaosProviderSuite.results[*].plannerRationale` is non-empty

If any of those fail, treat it as upstream evidence drift. Fix the producer or
the supplied SDK input instead of editing the emitted artifact by hand.

### The exported report is valid, but `performanceBudget` stays `warn`

That is expected whenever the embedded performance benchmark is not comparable
to a persisted baseline. In the current default quality-report benchmark, no
baseline file is supplied to the performance-budget runner, so the report
headlines and highlights correctly call out the missing comparability.

### The report shape changes unexpectedly

Treat any of these as contract regressions for downstream consumers:

- `sections` no longer has six entries
- section keys are duplicated or reordered
- `summary.decision` stops matching `evidence.promotionGate.verdict`
- full evidence payloads disappear from `evidence`

Re-run `bun run check:e7-quality-report` before trusting the new output.

## Rollout Guidance

For a documentation or consumer rollout of this surface:

1. Run `bun run check:e7-quality-report`.
2. If any upstream evidence producer changed, rerun the adjacent E7 checks it
   depends on: `bun run check:e7-baseline-corpus`,
   `bun run check:e7-incumbent-comparison`, `bun run check:e7-drift-regression`,
   `bun run check:e7-performance-budget`,
   `bun run check:e7-chaos-provider-suite`, and
   `bun run check:e7-promotion-gate-policy`.
3. Regenerate `docs/artifacts/e7-quality-report-artifact.json` only after the
   focused checks are green.
4. Publish the refreshed artifact and any SDK consumer changes together so the
   section headlines and full evidence bundle stay in sync.

The current rollout unit is a regenerated JSON export plus the runtime or SDK
version that produced it. There is no live service rollout switch for this
feature today.

## Rollback Guidance

Rollback for this surface is file and version based:

1. restore the last known-good runtime or benchmark change that generated the
   previous report shape
2. restore the last known-good
   `docs/artifacts/e7-quality-report-artifact.json` when a bad export was
   committed
3. rerun `bun run check:e7-quality-report`
4. republish the prior artifact and SDK/runtime version together

Do not roll back by:

- editing `docs/artifacts/e7-quality-report-artifact.json` by hand
- deleting failing sections from `sections`
- stripping embedded evidence to make the file smaller
- overriding the promotion verdict in `summary`

## Related Runbooks

- [E7 Drift Regression Analysis](./e7-drift-regression-analysis.md)
- [E7 Performance Budget](./e7-performance-budget.md)
