# E1 Config Cascade and Storage Contract Runbook

## Purpose

Use this runbook when operators, SDK consumers, or runtime authors need to
validate or troubleshoot canonical config cascade and storage contracts in
`@effect-scrapling/foundation-core`.

These contracts keep execution configuration deterministic and keep artifact or
checkpoint storage backend agnostic.

Policy baseline:
- Effect v4 only.
- No Effect v3 dependencies or compatibility shims.
- No manual `instanceof`, manual `_tag`, or type-safety bypass shortcuts.

## Public Contract

Current exports:
- `RunConfigSourceSchema`
- `RunExecutionConfig`
- `RunExecutionConfigSchema`
- `RunExecutionConfigOverrideSchema`
- `RunConfigCascadeInputSchema`
- `resolveRunExecutionConfig`
- `StorageLocator`
- `StorageLocatorSchema`
- `ArtifactMetadataRecord`
- `ArtifactMetadataRecordSchema`
- `CheckpointRecord`
- `CheckpointRecordSchema`
- `ArtifactMetadataStore`
- `RunCheckpointStore`

Deterministic precedence:
- `defaults < sitePack < targetProfile < run`

Storage contract expectations:
- locators are logical `namespace + key`, not filesystem paths, URLs, or
  storage-engine-specific handles
- artifact metadata records keep:
  - canonical ids
  - artifact kind and visibility
  - locator
  - SHA-256 digest
  - size and media type
  - strict UTC storage timestamp
- checkpoint records keep:
  - canonical ids for checkpoint, run, and plan
  - locator
  - encoded checkpoint payload
  - digest
  - encoding and compression metadata
  - strict UTC storage timestamp

## Command Usage

Run targeted verification from repository root:

```bash
bun test tests/libs/foundation-core-workflow.test.ts
bun run example:e1-capability-slice
```

Run touched-project compilation checks:

```bash
bunx --bun tsc --noEmit -p libs/foundation/core/tsconfig.json
bunx --bun tsc --noEmit -p apps/api/tsconfig.json
bunx --bun tsc --noEmit -p apps/cli/tsconfig.json
```

Run the full repository gates before closure:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

## Practical Example

```ts
import {
  ArtifactMetadataRecordSchema,
  CheckpointRecordSchema,
  RunExecutionConfigSchema,
  Schema,
  resolveRunExecutionConfig,
} from "@effect-scrapling/foundation-core";

const resolved = resolveRunExecutionConfig({
  defaults: {
    targetId: "target-product-001",
    packId: "pack-example-com",
    accessPolicyId: "policy-default",
    entryUrl: "https://example.com/catalog",
    mode: "http",
    render: "never",
    perDomainConcurrency: 2,
    globalConcurrency: 8,
    timeoutMs: 10000,
    maxRetries: 1,
    checkpointInterval: 10,
    artifactNamespace: "artifacts/default",
    checkpointNamespace: "checkpoints/default",
  },
  sitePack: {
    artifactNamespace: "artifacts/site-pack",
  },
  targetProfile: {
    entryUrl: "https://example.com/products/001",
  },
  run: {
    mode: "browser",
    render: "always",
  },
});

Schema.encodeSync(RunExecutionConfigSchema)(resolved);
Schema.decodeUnknownSync(ArtifactMetadataRecordSchema)({
  id: "artifact-record-001",
  runId: "run-001",
  artifactId: "artifact-html-001",
  kind: "html",
  visibility: "redacted",
  locator: { namespace: "artifacts/example-com", key: "run-001/html-001" },
  sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  sizeBytes: 2048,
  mediaType: "text/html",
  storedAt: "2026-03-06T10:02:00.000Z",
});
```

Expected behavior:
- config resolution is deterministic and last writer wins by the declared order
- storage records fail if ids, digests, timestamps, or locator fields are not
  canonical
- store interfaces stay backend agnostic

## Troubleshooting

### Config resolution looks wrong

Check the precedence order first:
- `defaults`
- `sitePack`
- `targetProfile`
- `run`

Do not mix extra override tiers into callers. Add them explicitly to the shared
contract if they are truly needed.

### A storage implementation leaks backend-specific details

That is a contract regression. Keep backend specifics behind the store service
implementation. Public records should expose only logical locators and shared
metadata.

### Checkpoint persistence decode fails

Check:
- the embedded checkpoint still decodes through `RunCheckpointSchema`
- digests are canonical SHA-256 values
- timestamps remain strict UTC ISO strings
- encoding/compression values are supported

Fix the store implementation or writer rather than weakening the public record
schema.

## Rollout Guidance

1. Prepare
- update config producers to emit only shared override payloads
- update stores to persist `ArtifactMetadataRecord` and `CheckpointRecord`
- validate representative payloads with
  `bun test tests/libs/foundation-core-workflow.test.ts`

2. Apply
- resolve config through `resolveRunExecutionConfig`
- remove backend-specific public DTOs and duplicated precedence logic

3. Verify
- run targeted tests
- run `bun run example:e1-capability-slice`
- run `bun run check`

4. Promote
- merge only when config/storage tests, capability slice, and full gates are
  green

## Rollback Guidance

1. Revert the producer or storage change that introduced invalid precedence,
   backend-specific locators, or malformed record payloads.
2. Re-run:

```bash
bun test tests/libs/foundation-core-workflow.test.ts
bun run example:e1-capability-slice
bun run check
```

3. Keep the shared precedence and record schemas intact; do not add storage
   engine escape hatches to public contracts.
4. Re-attempt rollout only after config resolution and record persistence are
   green again.

## Operator Notes

- `resolveRunExecutionConfig` is the single source of truth for E1 precedence.
- Storage contracts describe durable records, not concrete storage engines.
- Effect v4 only remains mandatory for future config or storage extensions.
