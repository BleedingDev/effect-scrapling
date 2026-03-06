# E1 Rollback Drill Evidence

- Disposable clone path: /private/tmp/e1-rollback-drill.HDVqf1/repo
- Overlay source: working tree synced from /Users/satan/side/experiments/effect-scrapling

## Pre-recovery

Command: bun install --frozen-lockfile
Result: success

Command: bun run check:e1-capability-slice
Result:
(pass) E1 capability slice verification > executes the public foundation-core capability slice and emits durable evidence [11.43ms]

Command: bun run example:e1-foundation-core-consumer
Result (head):
$ bun run examples/e1-foundation-core-consumer.ts
{
  "importPath": "@effect-scrapling/foundation-core",
  "prerequisites": [
    "Bun >= 1.3.10",
    "Use the public @effect-scrapling/foundation-core package only.",
    "Run from repository root with \"bun run example:e1-foundation-core-consumer\"."
  ],
  "pitfalls": [
    "Decode public payloads through the shared schemas instead of retyping DTOs by hand.",
    "Treat StorageLocator values as logical namespace/key transport, not filesystem paths.",
    "Handle schema rejections explicitly when user input can affect config or locator payloads."
  ],
  "payload": {
    "targetProfile": {
      "id": "target-product-001",
      "tenantId": "tenant-main",
      "domain": "example.com",
      "kind": "productPage",
      "canonicalKey": "catalog/product-001"
    },
    ...
Result (tail):
      "maxRetries": 1,
      "checkpointInterval": 10,
      "artifactNamespace": "artifacts/example-com",
      "checkpointNamespace": "checkpoints/default"
    },
    "promotionDecision": {
      "id": "decision-pack-example-com-001",
      "packId": "pack-example-com",
      "triggerVerdictId": "verdict-pack-example-com-001",
      "createdAt": "2026-03-06T12:00:00.000Z",
      "fromState": "draft",
      "toState": "shadow",
      "action": "promote-shadow"
    },
    "expectedError": {
      "tag": "SchemaBoundaryError",
      "message": "StorageLocator rejected a traversal-like namespace before the payload reached any backend."
    }
  }
}
Command completed with exit code 0.

Command: bun run scripts/benchmarks/e1-performance-budget.ts --sample-size 3 --warmup 1
Result:
{
  "benchmark": "e1-performance-budget",
  "generatedAt": "2026-03-06T09:28:35.147Z",
  "environment": {
    "bun": "1.3.10",
    "platform": "darwin",
    "arch": "arm64"
  },
  "sampleSize": 3,
  "warmupIterations": 1,
  "budgets": {
    "capabilitySliceP95Ms": 50,
    "contractRoundtripP95Ms": 10,
    "heapDeltaKiB": 16384
  },
  "measurements": {
    "capabilitySlice": {
      "samples": 3,
      "minMs": 0.679,
      "meanMs": 0.911,
      "p95Ms": 1.177,
      "maxMs": 1.177
    },
    "contractRoundtrip": {
      "samples": 3,
      "minMs": 0.547,
      "meanMs": 0.585,
      "p95Ms": 0.65,
      "maxMs": 0.65
    },
    "heapDeltaKiB": 0
  },
  "comparison": {
    "baselinePath": null,
    "deltas": {
      "capabilitySliceP95Ms": null,
      "contractRoundtripP95Ms": null,
      "heapDeltaKiB": null
    }
  },
  "status": "pass"
}

## Rollback Step

Command: rm -rf node_modules dist

Filesystem state immediately after removal:
- `node_modules`: absent
- `dist`: absent

## Post-recovery

Command: bun install --frozen-lockfile
Result: success

Command: bun run check:e1-capability-slice
Result:
(pass) E1 capability slice verification > executes the public foundation-core capability slice and emits durable evidence [13.27ms]

Command: bun run example:e1-foundation-core-consumer
Result (head):
$ bun run examples/e1-foundation-core-consumer.ts
{
  "importPath": "@effect-scrapling/foundation-core",
  "prerequisites": [
    "Bun >= 1.3.10",
    "Use the public @effect-scrapling/foundation-core package only.",
    "Run from repository root with \"bun run example:e1-foundation-core-consumer\"."
  ],
  "pitfalls": [
    "Decode public payloads through the shared schemas instead of retyping DTOs by hand.",
    "Treat StorageLocator values as logical namespace/key transport, not filesystem paths.",
    "Handle schema rejections explicitly when user input can affect config or locator payloads."
  ],
  "payload": {
    "targetProfile": {
      "id": "target-product-001",
      "tenantId": "tenant-main",
      "domain": "example.com",
      "kind": "productPage",
      "canonicalKey": "catalog/product-001"
    },
    ...
Result (tail):
      "maxRetries": 1,
      "checkpointInterval": 10,
      "artifactNamespace": "artifacts/example-com",
      "checkpointNamespace": "checkpoints/default"
    },
    "promotionDecision": {
      "id": "decision-pack-example-com-001",
      "packId": "pack-example-com",
      "triggerVerdictId": "verdict-pack-example-com-001",
      "createdAt": "2026-03-06T12:00:00.000Z",
      "fromState": "draft",
      "toState": "shadow",
      "action": "promote-shadow"
    },
    "expectedError": {
      "tag": "SchemaBoundaryError",
      "message": "StorageLocator rejected a traversal-like namespace before the payload reached any backend."
    }
  }
}
Command completed with exit code 0.

Command: bun run scripts/benchmarks/e1-performance-budget.ts --sample-size 3 --warmup 1
Result:
{
  "benchmark": "e1-performance-budget",
  "generatedAt": "2026-03-06T09:28:39.388Z",
  "environment": {
    "bun": "1.3.10",
    "platform": "darwin",
    "arch": "arm64"
  },
  "sampleSize": 3,
  "warmupIterations": 1,
  "budgets": {
    "capabilitySliceP95Ms": 50,
    "contractRoundtripP95Ms": 10,
    "heapDeltaKiB": 16384
  },
  "measurements": {
    "capabilitySlice": {
      "samples": 3,
      "minMs": 0.619,
      "meanMs": 0.867,
      "p95Ms": 1.125,
      "maxMs": 1.125
    },
    "contractRoundtrip": {
      "samples": 3,
      "minMs": 0.536,
      "meanMs": 0.572,
      "p95Ms": 0.629,
      "maxMs": 0.629
    },
    "heapDeltaKiB": 0
  },
  "comparison": {
    "baselinePath": null,
    "deltas": {
      "capabilitySliceP95Ms": null,
      "contractRoundtripP95Ms": null,
      "heapDeltaKiB": null
    }
  },
  "status": "pass"
}
