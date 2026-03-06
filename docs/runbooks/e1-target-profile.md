# E1 Target Profile Schema Runbook

## Purpose

Use this runbook when operators, SDK consumers, or downstream schema authors need
to validate or troubleshoot the canonical `TargetProfile` and `TargetKind`
contracts in `@effect-scrapling/foundation-core`.

This contract is the canonical identity surface for crawl targets. It exists to
keep target classification, domain ownership, and seed URL selection stable
across CLI, SDK, and workflow boundaries.

Policy baseline:
- Effect v4 only.
- No Effect v3 dependencies or compatibility shims.
- No manual tag inspection, `instanceof`, or type-safety bypass shortcuts.

## Public Contract

Current exports:
- `TargetKindSchema`
- `TargetProfile`
- `TargetProfileSchema`
- `CanonicalIdentifierSchema`
- `CanonicalDomainSchema`
- `CanonicalKeySchema`
- `CanonicalHttpUrlSchema`

Canonical identity expectations:
- `id`, `tenantId`, `accessPolicyId`, and `packId` must be trimmed, non-empty,
  and whitespace-free identifiers.
- `domain` must be a lowercased host name only. Do not include protocol, path,
  query, fragment, or credentials.
- `canonicalKey` is a whitespace-free logical key for a target within a tenant
  and pack.
- `seedUrls` must be a non-empty, duplicate-free `http` or `https` list with no
  credentials or fragments.
- `priority` is an integer in the inclusive range `0..1000`.

## Command Usage

Run targeted verification from repository root:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts
bun test tests/guardrails/e1-foundation-core-consumer.verify.test.ts
```

Run touched-project compilation checks:

```bash
bunx --bun tsc --noEmit -p libs/foundation/core/tsconfig.json
bunx --bun tsc --noEmit -p apps/api/tsconfig.json
bunx --bun tsc --noEmit -p apps/cli/tsconfig.json
```

Run the full repository gates before closure:

```bash
bun run check
bun run nx:show-projects
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

## Practical Example

```ts
import { Schema } from "effect";
import { TargetProfileSchema } from "@effect-scrapling/foundation-core";

const targetProfile = Schema.decodeUnknownSync(TargetProfileSchema)({
  id: "target-product-001",
  tenantId: "tenant-main",
  domain: "example.com",
  kind: "productPage",
  canonicalKey: "catalog/product-001",
  seedUrls: ["https://example.com/products/001"],
  accessPolicyId: "policy-default",
  packId: "pack-example-com",
  priority: 10,
});
```

Expected behavior:
- decode succeeds for canonical identity inputs
- encode returns the stable transport shape
- invalid domains, keys, URLs, duplicates, or out-of-range priorities fail at
  the contract boundary

## Troubleshooting

### Domain validation fails

Check whether `domain` contains:
- uppercase characters
- `http://` or `https://`
- `/path`, `?query`, or `#fragment`
- credentials such as `user:pass@host`

Fix the upstream normalization instead of weakening the schema.

### Seed URL validation fails

`seedUrls` rejects:
- empty arrays
- duplicate URLs
- non-HTTP schemes
- fragments
- credentials

If a consumer depends on those inputs, normalize them before schema decode.

### Priority validation fails

`priority` must be an integer between `0` and `1000`. If an upstream planner
needs a wider range, change the contract deliberately and update tests, docs,
and downstream consumers in the same change.

## Rollout Guidance

1. Prepare
- update downstream producers to emit canonical target identity fields
- verify the consumer path with `bun test tests/guardrails/e1-foundation-core-consumer.verify.test.ts`

2. Apply
- land schema consumer changes that decode through `TargetProfileSchema`
- remove parallel ad hoc target DTO validation

3. Verify
- run targeted tests
- run touched-project typechecks
- run `bun run check`

4. Promote
- merge only when the target profile runtime and consumer path are green

## Rollback Guidance

1. Revert the consumer or producer change that started emitting invalid target
   payloads.
2. Re-run:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts
bun test tests/guardrails/e1-foundation-core-consumer.verify.test.ts
bun run check
```

3. Keep the canonical schema intact; do not add bypass parsing or fallback DTO
   branches to force old payloads through.
4. Re-attempt rollout only after the payload source is fixed and the target
   profile contract is green again.

## Operator Notes

- Treat target profile decode failures as data contract bugs, not as cases for
  silent coercion.
- Keep the public surface on `@effect-scrapling/foundation-core`.
- Effect v4 only remains mandatory for any future schema extensions.
