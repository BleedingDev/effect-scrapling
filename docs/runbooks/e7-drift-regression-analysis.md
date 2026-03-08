# E7 Drift Regression Analysis

## Purpose

Use this runbook to inspect deterministic regression evidence emitted from the
E7 incumbent-comparison lane and decide whether a candidate should keep moving
or be blocked for remediation.

Today this surface is library-level. There is no dedicated CLI or SDK wrapper
for drift analysis yet. The shipped contract is:

- runtime: `libs/foundation/core/src/drift-regression-runtime.ts`
- focused verification: `tests/libs/foundation-core-drift-regression-runtime.test.ts`
- merge-facing check: `bun run check:e7-drift-regression`

The analyzer consumes an incumbent-comparison artifact and emits typed findings
plus per-pack summaries. It does not fetch live targets, run browser captures,
or mutate pack state.

## Current Command Surface

Run the focused verification suite:

```bash
bun test tests/libs/foundation-core-drift-regression-runtime.test.ts
bun run check:e7-drift-regression
```

The current public API is `analyzeDriftRegression(...)`. Execute it from a Bun
script or REPL with an already-produced incumbent-comparison artifact:

```ts
import { Effect } from "effect";
import { analyzeDriftRegression } from "../libs/foundation/core/src/drift-regression-runtime.ts";

const artifact = await Effect.runPromise(
  analyzeDriftRegression({
    id: "analysis-retail-smoke",
    createdAt: "2026-03-08T16:05:00.000Z",
    comparison,
  }),
);
```

## What The Analyzer Produces

Each finding is typed as one of:

- `fieldAdded`
- `fieldRemoved`
- `fieldChanged`
- `confidenceDrop`

Each finding also includes:

- `severity`
- `signature`
- `caseId`
- `packId`
- `targetId`
- `snapshotDiffId`
- optional `field`

Pack-level output is aggregated in `packSummaries` with:

- `severity`
- `caseCount`
- `regressedCaseCount`
- `findingCount`
- `highestDriftMagnitude`
- `highestConfidenceDrop`
- sorted unique `signatures`

## Default Severity Policy

Default drift thresholds:

- `lowDriftThreshold = 0.01`
- `moderateDriftThreshold = 0.05`
- `highDriftThreshold = 0.12`
- `criticalDriftThreshold = 0.25`

Default confidence-drop thresholds:

- `lowConfidenceDropThreshold = 0.02`
- `moderateConfidenceDropThreshold = 0.08`
- `highConfidenceDropThreshold = 0.15`
- `criticalConfidenceDropThreshold = 0.3`

Behavior notes:

- `fieldRemoved` is always `critical`
- added fields default to at least `moderate`, even if raw drift magnitude is
  otherwise low
- `confidenceDrop` findings are emitted only when the diff contains no field
  changes and the confidence delta alone breaches thresholds
- only negative `driftDelta` / `confidenceDelta` values are treated as
  regressions; positive deltas are improvements and do not create findings
- findings are sorted by severity rank first, then pack, case, field, and kind

## Practical Execution

Create or load the deterministic incumbent-comparison artifact first:

```bash
bun run check:e7-baseline-corpus
bun run check:e7-incumbent-comparison
```

Then run the focused drift suite:

```bash
bun test tests/libs/foundation-core-drift-regression-runtime.test.ts
```

If you need to inspect a custom comparison artifact locally, use a short Bun
script and print only the fields you need:

```ts
console.log(
  JSON.stringify(
    {
      findings: artifact.findings,
      packSummaries: artifact.packSummaries,
    },
    null,
    2,
  ),
);
```

## Reading The Artifact

Focus on:

- `findings[*].severity`
- `findings[*].signature`
- `findings[*].message`
- `packSummaries[*].severity`
- `packSummaries[*].regressedCaseCount`
- `packSummaries[*].highestDriftMagnitude`
- `packSummaries[*].highestConfidenceDrop`

Interpretation:

- repeated `fieldRemoved` or `fieldChanged` findings usually mean a real pack
  regression, not a noise-only fluctuation
- `confidenceDrop` with no field-level diff means the extraction shape stayed
  stable but confidence degraded enough to matter
- `packSummaries[*].severity === "none"` means the candidate matched the
  incumbent on the current deterministic corpus for that pack

## Troubleshooting

### Decode fails before analysis runs

The analyzer decodes the full input through shared schemas. Inspect:

- `comparison.comparisonId`
- `comparison.caseCount`
- `comparison.packCount`
- the shape of every `comparison.results[*].snapshotDiff`

If decode fails, treat it as contract drift between the comparison layer and
the drift-analysis layer. Fix the producer or shared contract instead of
patching around the decoder.

### Findings are missing when you expected a regression

Check the upstream incumbent-comparison artifact first:

1. confirm the candidate artifact actually changed
2. inspect `snapshotDiff.changes`
3. inspect `snapshotDiff.metrics.driftDelta`
4. inspect `snapshotDiff.canonicalMetrics?.confidenceDelta`

If `snapshotDiff.changes` is empty and confidence delta also stays below the
configured thresholds, the analyzer is behaving correctly.

### Severity looks lower or higher than expected

Confirm whether the regression came from:

- a removed field
- raw `driftDelta`
- `confidenceDelta`
- the fallback rule for unexpected added fields

Do not widen thresholds first. Threshold changes alter promotion behavior for
every downstream E7 gate.

## Remediation Workflow

When the drift-analysis lane surfaces a real regression:

1. preserve the failing comparison artifact and analysis output
2. record the finding ids, signatures, and affected `packId` values
3. open a blocking remediation bead against the candidate work instead of
   weakening thresholds first
4. rerun:
   - `bun run check:e7-incumbent-comparison`
   - `bun run check:e7-drift-regression`

Rollback in this lane means reverting the candidate/runtime/pack change that
introduced the regression and rerunning the deterministic comparison. There is
no separate mutable E7 drift state to roll back.
