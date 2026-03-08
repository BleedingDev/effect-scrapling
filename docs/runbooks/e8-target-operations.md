# E8 Target Operations

## Purpose

Operate deterministic target import and target listing through the shared E8
control plane.

## Public Surface

CLI:

```sh
effect-scrapling target import --input '<json>'
effect-scrapling target list --input '<json>'
```

SDK:

```ts
import { runTargetImportOperation, runTargetListOperation } from "effect-scrapling/e8";
```

Focused checks:

```sh
bun test tests/sdk/e8-target-verify.test.ts tests/sdk/e8-control-plane.test.ts
bun run check:e8-workspace-operations
```

## Practical Use

Import a catalog:

```sh
effect-scrapling target import --input '{
  "targets": [{
    "id": "target-shop-001",
    "tenantId": "tenant-main",
    "domain": "shop.example.com",
    "kind": "productPage",
    "canonicalKey": "productPage/target-shop-001",
    "seedUrls": ["https://shop.example.com/target-shop-001"],
    "accessPolicyId": "policy-default",
    "packId": "pack-shop-example-com",
    "priority": 40
  }]
}'
```

List a filtered subset:

```sh
effect-scrapling target list --input '{
  "targets": [...],
  "filters": {
    "tenantId": "tenant-main",
    "domain": "shop.example.com",
    "kind": "productPage"
  }
}'
```

## Troubleshooting

### Import fails on duplicate ids

The target catalog is intentionally unique by `target.id`. Deduplicate upstream
catalog generation; do not weaken the schema.

### Filter payload is rejected

`tenantId`, `domain`, and `kind` are schema-validated. Fix the payload shape or
canonical value instead of bypassing validation in CLI parsing.

## Rollback

1. Revert the offending target-surface changes in `src/e8-control-plane.ts` or
   `src/standalone.ts`.
2. Re-run the focused target checks.
3. Re-run `bun run check` before merging the rollback.
