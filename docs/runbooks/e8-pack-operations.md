# E8 Pack Operations

## Purpose

Operate pack create, inspect, validate, and promote flows through the shared E8
surface with typed lifecycle and governance envelopes.

## Public Surface

CLI:

```sh
effect-scrapling pack create --input '<json>'
effect-scrapling pack inspect --input '<json>'
effect-scrapling pack validate --input '<json>'
effect-scrapling pack promote --input '<json>'
```

SDK:

```ts
import {
  runPackCreateOperation,
  runPackInspectOperation,
  runPackValidateOperation,
  runPackPromoteOperation,
} from "effect-scrapling/e8";
```

Focused checks:

```sh
bun test tests/sdk/e8-pack-verify.test.ts tests/sdk/e8-control-plane.test.ts
bun run check:e8-workspace-operations
```

## Practical Use

Validate a candidate pack:

```sh
effect-scrapling pack validate --input '{
  "pack": { "...": "shadow-pack" },
  "snapshotDiff": { "...": "quality-diff" },
  "checks": {
    "replayDeterminism": true,
    "workflowResume": true,
    "canary": true,
    "chaos": true,
    "securityRedaction": true,
    "soakStability": true
  },
  "createdAt": "2026-03-09T16:30:00.000Z"
}'
```

Promote a validated pack with explicit governance evidence:

```sh
effect-scrapling pack promote --input '{ "catalog": [...], "decision": {...}, "nextVersion": "2026.03.10", "...": "..." }'
```

## Troubleshooting

### Create or inspect rejects the definition

The DSL requires selectors, owners, and policy fields. Fix the pack definition
source; do not introduce optional holes just to pass malformed input.

### Promote fails on governance mismatch

The decision must match the pack id/version in the catalog. Rebuild the input
from the same validated artifact chain.

## Rollback

1. Revert the pack-surface changes in `src/e8-control-plane.ts`.
2. Re-run the focused pack checks.
3. Re-run `bun run check` before restoring the prior release path.
