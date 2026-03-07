# E2 Rollback Drill Evidence

- Executed in an isolated disposable clone:
  `/var/folders/l5/j97t559s5ljgmjc_ylqn1jmh0000gn/T/e2-rollback-drill.XXXXXX.esG3jkSsrH/repo`
- Drill source commit:
  `56186dd94f6d1c95718b2943d47c2d909612d7fe`
- Overlay source: `/Users/satan/side/experiments/effect-scrapling`
- Note: macOS `mktemp -t` retains the `.XXXXXX` template marker in the concrete
  generated basename; the path above is the actual clone location used for this
  drill.

## Pre-recovery

Commands:

```bash
bun install --frozen-lockfile
bun run check:e2-capability-slice
bun run example:e2-sdk-consumer
bun run check:e2-security-review
bun run scripts/benchmarks/e2-performance-budget.ts \
  --sample-size 3 \
  --warmup 1 \
  --artifact tmp/e2-performance-budget-scorecard.json
```

Key evidence:

- `bun install --frozen-lockfile`: `457 packages installed [1034.00ms]`
- `bun run check:e2-capability-slice`: completed successfully before rollback
- `bun run check:e2-security-review`: `Ran 3 tests across 1 file. [202.00ms]`
- benchmark status before rollback: `pass`
- capability-slice p95 before rollback: `33.726ms`

Consumer example output (head):

```json
{
  "importPath": "effect-scrapling/sdk",
  "prerequisites": [
    "Bun >= 1.3.10",
    "Run from repository root with \"bun run example:e2-sdk-consumer\".",
    "Replace the mock FetchService with FetchServiceLive or another public FetchService implementation for real network access."
  ],
  "pitfalls": [
    "Import from effect-scrapling/sdk instead of src/sdk/* private paths.",
    "Handle SDK failures with Effect.catchTag instead of manual tag-property branching.",
    "Invalid or incomplete payloads fail with InvalidInputError before any fetch happens.",
    "Empty selector matches are warnings, not failures, so consumers should inspect the warnings array.",
    "Invalid CSS selectors fail with ExtractionError, for example selector \"[\"."
  ]
}
```

## Rollback Step

Command:

```bash
rm -rf node_modules dist tmp/e2-performance-budget-scorecard.json
```

Post-step filesystem state:

- `node_modules`: absent
- `dist`: absent
- `tmp/e2-performance-budget-scorecard.json`: absent

## Post-recovery

Commands:

```bash
bun install --frozen-lockfile
bun run check:e2-capability-slice
bun run example:e2-sdk-consumer
bun run check:e2-security-review
bun run scripts/benchmarks/e2-performance-budget.ts \
  --sample-size 3 \
  --warmup 1 \
  --artifact tmp/e2-performance-budget-scorecard.json
```

Key evidence:

- `bun install --frozen-lockfile`: `457 packages installed [847.00ms]`
- `bun run check:e2-capability-slice`: completed successfully after rollback
- `bun run example:e2-sdk-consumer`: completed successfully after rollback
- `bun run check:e2-security-review`: `Ran 3 tests across 1 file. [194.00ms]`
- benchmark status after rollback: `pass`
- capability-slice p95 after rollback: `41.227ms`

Consumer example output after recovery (head):

```json
{
  "importPath": "effect-scrapling/sdk",
  "prerequisites": [
    "Bun >= 1.3.10",
    "Run from repository root with \"bun run example:e2-sdk-consumer\".",
    "Replace the mock FetchService with FetchServiceLive or another public FetchService implementation for real network access."
  ],
  "pitfalls": [
    "Import from effect-scrapling/sdk instead of src/sdk/* private paths.",
    "Handle SDK failures with Effect.catchTag instead of manual tag-property branching.",
    "Invalid or incomplete payloads fail with InvalidInputError before any fetch happens."
  ]
}
```

Reduced benchmark artifact after recovery:

```json
{
  "benchmark": "e2-performance-budget",
  "generatedAt": "2026-03-07T06:28:12.672Z",
  "environment": {
    "bun": "1.3.10",
    "platform": "darwin",
    "arch": "arm64"
  },
  "sampleSize": 3,
  "warmupIterations": 1,
  "budgets": {
    "capabilitySliceP95Ms": 75,
    "goldenReplayP95Ms": 60,
    "heapDeltaKiB": 16384
  },
  "measurements": {
    "capabilitySlice": {
      "samples": 3,
      "minMs": 33.147,
      "meanMs": 36.884,
      "p95Ms": 41.227,
      "maxMs": 41.227
    },
    "goldenReplay": {
      "samples": 3,
      "minMs": 13.35,
      "meanMs": 15.151,
      "p95Ms": 16.478,
      "maxMs": 16.478
    },
    "heapDeltaKiB": 13105.089
  },
  "comparison": {
    "baselinePath": null,
    "deltas": {
      "capabilitySliceP95Ms": null,
      "goldenReplayP95Ms": null,
      "heapDeltaKiB": null
    }
  },
  "violations": [],
  "status": "pass"
}
```

## Outcome

The E2 rollback and recovery drill passed end to end:

- frozen install succeeded before and after rollback
- the integrated capability slice stayed green before and after recovery
- the public SDK consumer example remained runnable through the public
  `effect-scrapling/sdk` boundary
- the E2 security review stayed green on both sides of the rollback
- the reduced performance artifact stayed `pass` before and after rollback
- repository-generated state was removed and rebuilt cleanly
