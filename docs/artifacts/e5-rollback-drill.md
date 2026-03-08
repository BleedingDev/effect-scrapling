# E5 Rollback Drill Evidence

- Executed in an isolated disposable clone:
  `/var/folders/l5/j97t559s5ljgmjc_ylqn1jmh0000gn/T/e5-rollback-drill-final.XXXXXX.yRNWWZQR70/repo`
- Drill source commit:
  `d4f5dbd921c245c075ce28619c76ccdd0a1b8c45`
- Overlay source:
  `/Users/satan/side/experiments/effect-scrapling`
- Note: the disposable clone was overlaid with the current working tree before
  execution so the drill covered the uncommitted E5 capability-slice and
  rollback-runbook changes instead of stale `HEAD` only.
- Note: this drill intentionally used the reduced `50 x 1000` simulation
  profile from the runbook. The default `100 x 2000` operator scorecard is a
  separate E5 performance gate and is tracked independently in
  `docs/artifacts/e5-workflow-simulation-scorecard.json`.

## Pre-recovery

Commands:

```bash
bun install --frozen-lockfile
bun run check:e5-capability-slice
bun run check:e5-checkpoint-persistence-restore
bun run check:e5-duplicate-work-suppression
bun run check:e5-workflow-budget-integration
bun run scripts/benchmarks/e5-workflow-simulation.ts \
  --artifact tmp/e5-workflow-simulation-scorecard.json \
  --targets 50 \
  --observations-per-target 1000 \
  --sample-size 1 \
  --warmup 0
bun run scripts/benchmarks/e5-crash-resume-harness.ts \
  --artifact tmp/e5-crash-resume-harness-scorecard.json \
  --targets 2 \
  --observations-per-target 6 \
  --crash-after-sequence 1 \
  --crash-after-sequence 2
```

Key evidence:

- `bun install --frozen-lockfile`: `457 packages installed [1034.00ms]`
- `bun run check:e5-checkpoint-persistence-restore`: passed
- `bun run check:e5-duplicate-work-suppression`: passed
- `bun run check:e5-workflow-budget-integration`: passed

Capability-slice summary before rollback:

```json
{
  "planIds": [
    "plan-target-product-0001-pack-example-com",
    "plan-target-product-0002-pack-example-com"
  ],
  "rationaleKeys": [
    [
      "mode",
      "rendering",
      "budget",
      "capture-path",
      "workflow-graph"
    ],
    [
      "mode",
      "rendering",
      "budget",
      "capture-path",
      "workflow-graph"
    ]
  ],
  "restartCount": 4,
  "matchedOutputs": true,
  "matchedBudgetEvents": true,
  "matchedWorkClaims": true
}
```

Reduced simulation artifact before rollback:

```json
{
  "status": "pass",
  "profile": {
    "targetCount": 50,
    "observationsPerTarget": 1000,
    "totalObservations": 50000
  },
  "workflowDurationP95Ms": 1472.662,
  "observationsPerSecondMean": 33952.116,
  "checkpointsPerSecondMean": 101.856,
  "violations": []
}
```

Crash-resume artifact before rollback:

```json
{
  "status": "pass",
  "restartCount": 4,
  "matchedOutputs": true,
  "matchedBudgetEvents": true,
  "matchedWorkClaims": true
}
```

## Rollback Step

Command:

```bash
rm -rf node_modules dist tmp/e5-capability-slice.json tmp/e5-workflow-simulation-scorecard.json tmp/e5-crash-resume-harness-scorecard.json
```

Post-step filesystem state:

- `node_modules`: absent
- `dist`: absent
- `tmp/e5-capability-slice.json`: absent
- `tmp/e5-workflow-simulation-scorecard.json`: absent
- `tmp/e5-crash-resume-harness-scorecard.json`: absent

## Post-recovery

Commands:

```bash
bun install --frozen-lockfile
bun run check:e5-capability-slice
bun run check:e5-checkpoint-persistence-restore
bun run check:e5-duplicate-work-suppression
bun run check:e5-workflow-budget-integration
bun run scripts/benchmarks/e5-workflow-simulation.ts \
  --artifact tmp/e5-workflow-simulation-scorecard.json \
  --targets 50 \
  --observations-per-target 1000 \
  --sample-size 1 \
  --warmup 0
bun run scripts/benchmarks/e5-crash-resume-harness.ts \
  --artifact tmp/e5-crash-resume-harness-scorecard.json \
  --targets 2 \
  --observations-per-target 6 \
  --crash-after-sequence 1 \
  --crash-after-sequence 2
```

Key evidence:

- `bun install --frozen-lockfile`: `457 packages installed [594.00ms]`
- `bun run check:e5-checkpoint-persistence-restore`: passed
- `bun run check:e5-duplicate-work-suppression`: passed
- `bun run check:e5-workflow-budget-integration`: passed

Capability-slice summary after recovery:

```json
{
  "planIds": [
    "plan-target-product-0001-pack-example-com",
    "plan-target-product-0002-pack-example-com"
  ],
  "rationaleKeys": [
    [
      "mode",
      "rendering",
      "budget",
      "capture-path",
      "workflow-graph"
    ],
    [
      "mode",
      "rendering",
      "budget",
      "capture-path",
      "workflow-graph"
    ]
  ],
  "restartCount": 4,
  "matchedOutputs": true,
  "matchedBudgetEvents": true,
  "matchedWorkClaims": true
}
```

Reduced simulation artifact after recovery:

```json
{
  "status": "pass",
  "profile": {
    "targetCount": 50,
    "observationsPerTarget": 1000,
    "totalObservations": 50000
  },
  "workflowDurationP95Ms": 1479.314,
  "observationsPerSecondMean": 33799.445,
  "checkpointsPerSecondMean": 101.398,
  "violations": []
}
```

Crash-resume artifact after recovery:

```json
{
  "status": "pass",
  "restartCount": 4,
  "matchedOutputs": true,
  "matchedBudgetEvents": true,
  "matchedWorkClaims": true
}
```

## Outcome

The E5 rollback and recovery drill passed end to end:

- frozen install succeeded before and after rollback
- the integrated E5 capability slice preserved canonical plan wiring and
  restart parity before and after recovery
- checkpoint-restore, duplicate-work, and workflow-budget gates stayed green on
  both sides of the rollback
- the reduced E5 workflow-simulation artifact stayed `pass` before and after
  rollback
- the reduced E5 crash-resume artifact stayed `pass` before and after rollback
- repository-generated workspace state was removed and rebuilt cleanly
- the drill does not claim the separate default `200000` observation
  performance gate is green
