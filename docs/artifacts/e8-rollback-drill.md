# E8 Rollback Drill Evidence

- Executed in an isolated disposable clone:
  `/var/folders/l5/j97t559s5ljgmjc_ylqn1jmh0000gn/T/e8-rollback-drill.XXXXXX.S4fwH5UbdM/repo`
- Drill source commit:
  `0a02ad9bd271c9a9d95e40056c335d73a41b020f`
- Overlay source:
  `/Users/satan/side/experiments/effect-scrapling`
- Note: the disposable clone was overlaid with the current working tree before
  execution so the drill exercised the live E8 closure-lane changes instead of
  stale `HEAD` only. This drill validates rebuild/recovery on that overlaid
  tree; it does not claim a code-level rollback to an older commit.

## Pre-recovery

Commands:

```bash
bun install --frozen-lockfile
bun run check:e8-workspace-operations
bun run check:e8-capability-slice
bun run check:e8-security-review
bun run check:e8-performance-budget
bun run check:e8-benchmark-export
bun run check:e8-parity-dry-run
bun run check:e8-sdk-consumer
```

Key evidence:

- `bun install --frozen-lockfile`: `909 packages installed [714.00ms]`
- all pre-recovery E8 checks passed

Pre-recovery compact scorecard:

```json
{
  "status": "pass",
  "capabilitySliceP95Ms": 2070.657,
  "benchmarkRunP95Ms": 73.909,
  "artifactExportP95Ms": 316.96,
  "heapDeltaKiB": 20861.319,
  "comparable": true,
  "violations": []
}
```

## Recovery Step

Command:

```bash
rm -rf node_modules dist docs/artifacts/e8-performance-budget-scorecard.json docs/artifacts/e8-benchmark-run-artifact.json docs/artifacts/e8-artifact-export-artifact.json docs/artifacts/e8-parity-dry-run-artifact.json
```

Post-step filesystem state:

- `node_modules`: absent
- `dist`: absent
- `docs/artifacts/e8-performance-budget-scorecard.json`: absent
- `docs/artifacts/e8-benchmark-run-artifact.json`: absent
- `docs/artifacts/e8-artifact-export-artifact.json`: absent
- `docs/artifacts/e8-parity-dry-run-artifact.json`: absent

## Post-recovery

Commands:

```bash
bun install --frozen-lockfile
bun run check:e8-workspace-operations
bun run check:e8-capability-slice
bun run check:e8-security-review
bun run check:e8-performance-budget
bun run check:e8-benchmark-export
bun run check:e8-parity-dry-run
bun run check:e8-sdk-consumer
```

Key evidence:

- `bun install --frozen-lockfile`: `909 packages installed [800.00ms]`
- all post-recovery E8 checks passed

Post-recovery compact scorecard:

```json
{
  "status": "pass",
  "capabilitySliceP95Ms": 2452.874,
  "benchmarkRunP95Ms": 69.18,
  "artifactExportP95Ms": 290.274,
  "heapDeltaKiB": 34289.372,
  "comparable": true,
  "violations": []
}
```

## Outcome

The bounded E8 rebuild-and-recovery drill passed end to end:

- frozen install succeeded before and after local cleanup
- workspace operations remained deterministic after recovery
- the E8 capability slice remained executable after recovery
- the security review stayed green after recovery
- the performance gate regenerated a comparable passing scorecard after recovery
- benchmark export, parity replay, and the public SDK consumer path all stayed
  green after recovery
