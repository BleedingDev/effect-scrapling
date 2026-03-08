# E8 Quality Operations

## Purpose

Operate extract-run, snapshot-diff, quality-verify, and quality-compare through
the unified E8 control plane.

## Public Surface

CLI:

```sh
effect-scrapling extract run --url "https://example.com" --selector "h1" --all
effect-scrapling quality diff --input '<json>'
effect-scrapling quality verify --input '<json>'
effect-scrapling quality compare --input '<json>'
```

SDK:

```ts
import {
  runExtractRunOperation,
  runSnapshotDiffOperation,
  runQualityVerifyOperation,
  runQualityCompareOperation,
} from "effect-scrapling/e8";
```

Focused checks:

```sh
bun test tests/sdk/e8-quality-verify.test.ts tests/sdk/e8-control-plane.test.ts
bun run check:e8-workspace-operations
```

## Practical Use

Run extraction:

```sh
effect-scrapling extract run \
  --url "https://shop.example.com/products/sku-42" \
  --selector "h1" \
  --all
```

Compare snapshots and evaluate quality:

```sh
effect-scrapling quality diff --input '{ "baseline": {...}, "candidate": {...}, "createdAt": "2026-03-09T16:15:00.000Z" }'
effect-scrapling quality verify --input '{ "pack": {...}, "snapshotDiff": {...}, "checks": {...}, "createdAt": "2026-03-09T16:17:00.000Z" }'
effect-scrapling quality compare --input '{ "metricsId": "metrics-e8-quality", "generatedAt": "2026-03-09T16:18:00.000Z", "baseline": {...}, "comparison": {...} }'
```

## Troubleshooting

### Diff or quality verification fails on malformed evidence

The E8 quality boundary enforces snapshot ids, metric shapes, timestamps, and
pack-verdict compatibility. Fix the evidence producer; do not introduce a
decoder workaround.

### Extract output differs between SDK and CLI

Re-run the focused quality checks and compare the envelope payloads. The CLI is
expected to transport the same typed contract, not a bespoke shape.

## Rollback

1. Revert the extraction/quality changes in `src/e8-control-plane.ts` and
   `src/standalone.ts`.
2. Re-run the focused quality checks.
3. Re-run `bun run check` before redeploying the rollback.
