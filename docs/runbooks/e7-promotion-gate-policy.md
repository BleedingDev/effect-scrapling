# E7 Promotion Gate Policy

## Purpose

Use this runbook when operators or SDK consumers need to evaluate the final E7
promotion decision from quality, performance, and live-canary evidence.

This surface exists today as:

- benchmark script: `scripts/benchmarks/e7-promotion-gate-policy.ts`
- shared runtime:
  `libs/foundation/core/src/promotion-gate-policy-runtime.ts`
- public SDK export: `src/e7.ts`
- focused verification:
  `tests/libs/foundation-core-promotion-gate-policy-runtime.test.ts`
- focused verification:
  `tests/scripts/e7-promotion-gate-policy.test.ts`

## Current Command Surface

Operator-facing commands:

```bash
bun run benchmark:e7-promotion-gate-policy
bun run check:e7-promotion-gate-policy
```

Direct script:

```bash
bun run scripts/benchmarks/e7-promotion-gate-policy.ts \
  --artifact docs/artifacts/e7-promotion-gate-policy-artifact.json
```

`check:e7-promotion-gate-policy` currently runs:

1. `tests/libs/foundation-core-promotion-gate-policy-runtime.test.ts`
2. `tests/scripts/e7-promotion-gate-policy.test.ts`
3. `bun run benchmark:e7-promotion-gate-policy`

Behavior notes:

- the CLI accepts exactly one option today: `--artifact <path>`
- omitting `--artifact` prints the JSON evaluation to stdout
- the default harness uses:
  - default incumbent comparison
  - drift analysis on that comparison
  - the default E7 performance-budget harness without a baseline override
  - the default live-canary harness
- that default combination currently yields `verdict: "hold"` because the
  embedded performance artifact is valid but not baseline-comparable

## SDK Consumer Surface

The public SDK surface is re-exported from `effect-scrapling/e7`:

```ts
import {
  DriftRegressionArtifactSchema,
  LiveCanaryArtifactSchema,
  PerformanceBudgetArtifactSchema,
  PromotionGateEvaluationSchema,
  evaluatePromotionGatePolicy,
} from "effect-scrapling/e7";
```

Use the SDK path when you already have typed evidence and only need the final
promotion verdict:

```ts
import { Effect } from "effect";
import { evaluatePromotionGatePolicy } from "effect-scrapling/e7";

const artifact = await Effect.runPromise(
  evaluatePromotionGatePolicy({
    evaluationId: "promotion-retail-smoke",
    generatedAt: "2026-03-08T21:20:00.000Z",
    quality,
    performance,
    canary,
  }),
);
```

## Reading The Artifact

Inspect these fields first:

- `verdict`
- `quality.highestSeverity`
- `quality.holdPackIds`
- `quality.quarantinePackIds`
- `performance.budgetStatus`
- `performance.comparable`
- `performance.incompatibleReason`
- `performance.deltas`
- `canary.verdict`
- `rationale`

Common interpretation:

- `promote` means quality, performance, and canary evidence are all inside the
  current thresholds
- `hold` means the candidate stays reviewable but should not promote yet
- `quarantine` means a critical quality, performance, or canary failure blocks
  promotion immediately

## Practical Execution

Refresh the committed operator artifact:

```bash
bun run scripts/benchmarks/e7-promotion-gate-policy.ts \
  --artifact docs/artifacts/e7-promotion-gate-policy-artifact.json
```

Write an ephemeral local artifact without touching committed docs:

```bash
bun run scripts/benchmarks/e7-promotion-gate-policy.ts \
  --artifact tmp/e7-promotion-gate-policy-artifact.json
```

Inspect only the top-line decision:

```bash
jq '{verdict, quality, performance, canary, rationale}' \
  docs/artifacts/e7-promotion-gate-policy-artifact.json
```

## Troubleshooting

### The CLI fails with `Unknown argument`

The script accepts only `--artifact <path>`.

### The runtime fails while decoding evidence

Check these alignment rules first:

1. `quality.packCount === performance.profile.packCount`
2. `quality.packCount === quality.holdPackIds.length + quality.quarantinePackIds.length + clean packs`
3. `performance.comparable` and `performance.incompatibleReason` do not disagree
4. every live-canary `failedScenarioIds[*]` matches an actual canary result

If any of those fail, treat it as evidence drift, not as a policy-threshold
problem.

### The default artifact stays `hold`

That is expected whenever the embedded performance benchmark has no comparable
baseline. Use the performance-budget runbook to refresh a comparable scorecard
first, then feed that artifact through the SDK surface if you need a fully
promotable decision.
