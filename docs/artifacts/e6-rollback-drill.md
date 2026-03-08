# E6 Rollback Drill Evidence

- Executed in an isolated disposable clone:
  `/var/folders/l5/j97t559s5ljgmjc_ylqn1jmh0000gn/T/e6-rollback-drill.XXXXXX.1taQMVIStK/repo`
- Drill source commit:
  `bbfd1eab045b72e29ad20a10792a3b7e696e1762`
- Overlay source:
  `/Users/satan/side/experiments/effect-scrapling`
- Note: the disposable clone was overlaid with the current working tree before
  execution so the drill exercised the live E6 `.32` to `.35` closure-lane
  changes instead of stale `HEAD` only. This drill validates rebuild/recovery
  on that overlaid tree; it does not claim a code-level rollback to an older
  commit.

## Pre-recovery

Commands:

```bash
bun install --frozen-lockfile
bun run check:e6-capability-slice
bun run check:e6-security-review
bun run check:e6-performance-budget
bun run check:e6-sdk-consumer
```

Key evidence:

- `bun install --frozen-lockfile`: `909 packages installed [767.00ms]`
- `bun run check:e6-capability-slice`: passed
- `bun run check:e6-security-review`: passed
- `bun run check:e6-performance-budget`: passed
- `bun run check:e6-sdk-consumer`: passed

Pre-recovery compact scorecard:

```json
{
  "status": "pass",
  "capabilitySliceP95Ms": 8.625,
  "registryResolutionP95Ms": 4.941,
  "reflectionRecommendationP95Ms": 19.753,
  "promotionGovernanceP95Ms": 72.663,
  "heapDeltaKiB": 14374.134,
  "comparable": true,
  "incompatibleReason": null,
  "violations": []
}
```

## Recovery Step

Command:

```bash
rm -rf node_modules dist docs/artifacts/e6-performance-budget-scorecard.json
```

Post-step filesystem state:

- `node_modules`: absent
- `dist`: absent
- `docs/artifacts/e6-performance-budget-scorecard.json`: absent

## Post-recovery

Commands:

```bash
bun install --frozen-lockfile
bun run check:e6-capability-slice
bun run check:e6-security-review
bun run check:e6-performance-budget
bun run check:e6-sdk-consumer
```

Key evidence:

- `bun install --frozen-lockfile`: `909 packages installed [697.00ms]`
- `bun run check:e6-capability-slice`: passed
- `bun run check:e6-security-review`: passed
- `bun run check:e6-performance-budget`: passed
- `bun run check:e6-sdk-consumer`: passed

Post-recovery compact scorecard:

```json
{
  "status": "pass",
  "capabilitySliceP95Ms": 6.734,
  "registryResolutionP95Ms": 5.758,
  "reflectionRecommendationP95Ms": 21.485,
  "promotionGovernanceP95Ms": 79.615,
  "heapDeltaKiB": 14390.504,
  "comparable": true,
  "incompatibleReason": null,
  "violations": []
}
```

## Outcome

The bounded E6 rebuild-and-recovery drill passed end to end:

- frozen install succeeded before and after local artifact cleanup
- the integrated E6 capability slice remained executable after recovery
- the E6 security review replay remained green after recovery
- the performance gate regenerated a comparable passing scorecard after recovery
- the E6 consumer example still ran through workspace package subpaths only

No rebuild-or-recovery gaps were discovered in this drill.
