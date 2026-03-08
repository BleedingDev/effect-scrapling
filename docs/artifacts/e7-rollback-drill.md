# E7 Rollback Drill Evidence

- Executed in an isolated disposable clone:
  `/var/folders/l5/j97t559s5ljgmjc_ylqn1jmh0000gn/T/e7-rollback-drill.XXXXXX.ipWyXftZo5/repo`
- Drill source commit:
  `af128673e559b57ed8a53c9066a1834519f013db`
- Overlay source:
  `/Users/satan/side/experiments/effect-scrapling`
- Note: the disposable clone was overlaid with the current working tree before
  execution so the drill exercised the live E7 closeout state instead of stale
  `HEAD` only. This drill validates rebuild and recovery on that overlaid tree;
  it does not claim a code-level rollback to an older commit.

## Pre-recovery

Commands:

```bash
bun install --frozen-lockfile
bun run check:e7-baseline-corpus
bun run check:e7-incumbent-comparison
bun run check:e7-drift-regression
bun run check:e7-performance-budget
bun run check:e7-chaos-provider-suite
bun run check:e7-promotion-gate-policy
bun run check:e7-quality-report
bun run check:e7-soak-endurance-suite
bun run check:e7-quality-metrics
bun run check:e7-live-canary
bun run check:e7-security-review
bun run check:e7-sdk-consumer
bun run check:e7-capability-slice
```

Key evidence:

- `bun install --frozen-lockfile`: passed
- every focused E7 check above: passed

Pre-recovery compact scorecards:

```json
{
  "performanceBudget": {
    "status": "pass",
    "baselineCorpusP95Ms": 46.411,
    "incumbentComparisonP95Ms": 120.195,
    "heapDeltaKiB": 3110.904
  },
  "qualityReport": {
    "status": "warn",
    "decision": "hold",
    "warningSectionKeys": [
      "performanceBudget",
      "promotionGate"
    ],
    "failingSectionKeys": []
  },
  "soakEndurance": {
    "status": "pass",
    "baselineCorpusGrowthMs": 3.879,
    "incumbentComparisonGrowthMs": 0,
    "heapGrowthKiB": 0,
    "maxConsecutiveHeapGrowth": 1,
    "unboundedGrowthDetected": false
  }
}
```

## Recovery Step

Command:

```bash
rm -rf node_modules dist \
  docs/artifacts/e7-baseline-corpus-artifact.json \
  docs/artifacts/e7-incumbent-comparison-artifact.json \
  docs/artifacts/e7-performance-budget-scorecard.json \
  docs/artifacts/e7-chaos-provider-suite-artifact.json \
  docs/artifacts/e7-promotion-gate-policy-artifact.json \
  docs/artifacts/e7-quality-report-artifact.json \
  docs/artifacts/e7-soak-endurance-artifact.json \
  docs/artifacts/e7-quality-metrics-artifact.json \
  docs/artifacts/e7-live-canary-artifact.json
```

Post-step filesystem state:

- `node_modules`: absent
- `dist`: absent
- the regenerated E7 artifact files listed above: absent

## Post-recovery

Commands:

```bash
bun install --frozen-lockfile
bun run check:e7-baseline-corpus
bun run check:e7-incumbent-comparison
bun run check:e7-drift-regression
bun run check:e7-performance-budget
bun run check:e7-chaos-provider-suite
bun run check:e7-promotion-gate-policy
bun run check:e7-quality-report
bun run check:e7-soak-endurance-suite
bun run check:e7-quality-metrics
bun run check:e7-live-canary
bun run check:e7-security-review
bun run check:e7-sdk-consumer
bun run check:e7-capability-slice
```

Key evidence:

- `bun install --frozen-lockfile`: passed
- every focused E7 check above: passed

Post-recovery compact scorecards:

```json
{
  "performanceBudget": {
    "status": "pass",
    "baselineCorpusP95Ms": 40.527,
    "incumbentComparisonP95Ms": 118.543,
    "heapDeltaKiB": 3031.538
  },
  "qualityReport": {
    "status": "warn",
    "decision": "hold",
    "warningSectionKeys": [
      "performanceBudget",
      "promotionGate"
    ],
    "failingSectionKeys": []
  },
  "soakEndurance": {
    "status": "pass",
    "baselineCorpusGrowthMs": 0,
    "incumbentComparisonGrowthMs": 0,
    "heapGrowthKiB": 0,
    "maxConsecutiveHeapGrowth": 1,
    "unboundedGrowthDetected": false
  }
}
```

## Outcome

The bounded E7 rebuild-and-recovery drill passed end to end:

- frozen install succeeded before and after local cleanup
- the baseline corpus and incumbent comparison artifacts regenerated cleanly
- the performance budget regenerated a passing comparable scorecard
- the quality report returned the same non-failing `warn/hold` posture before
  and after recovery
- the soak suite remained bounded with no unbounded growth
- the E7 security review, SDK consumer, and capability slice all stayed green

No rebuild-or-recovery gaps were discovered in this drill.
