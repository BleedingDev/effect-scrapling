# E6 Site Pack DSL Contracts

## Purpose

This runbook covers the typed E6 site-pack DSL that defines selectors,
assertions, policy, metadata, lifecycle state, and version contracts.

Primary entrypoints:

- `SitePackDslSchema`, `SitePackSchema`, `PackStateSchema`, and
  `comparePackVersions(...)` from `libs/foundation/core/src/site-pack.ts`

Primary validation surface:

- `bun test tests/libs/foundation-core-site-pack.test.ts`

There is no dedicated CLI or HTTP surface for site-pack DSL validation today.
The current operational surface is library-level plus the focused Bun test
suite.

## What The DSL Validates

The current schema enforces:

- canonical pack identity, tenant, access-policy, lifecycle state, and version
- lowercased protocol-free domain patterns
- at least one field selector with globally unique selector paths
- required-field and business-invariant assertions that reference declared
  selector fields
- compatible access mode and rendering policy combinations
- metadata ownership and unique labels

Important current fail-closed behaviors:

- duplicate selector fields are rejected
- reused selector paths are rejected even across different fields
- undeclared assertion fields are rejected
- pack and metadata tenant drift is rejected
- whitespace in `pack.version` is rejected

## Public Package Surface

Verified import paths in the current workspace:

```ts
import {
  PackStateSchema,
  SitePackSchema,
} from "@effect-scrapling/foundation-core";
import {
  SitePackDslSchema,
  comparePackVersions,
} from "@effect-scrapling/foundation-core/site-pack";
```

## Deterministic Operator Replay

Run the focused contract suite:

```bash
bun test tests/libs/foundation-core-site-pack.test.ts
```

Useful covered cases:

- complete DSL decode with selectors, assertions, policy, and metadata
- duplicate selector field rejection
- cross-field selector path reuse rejection
- undeclared assertion field rejection
- unsafe domain pattern rejection
- whitespace version rejection
- tenant drift rejection
- invalid access-mode and render-policy rejection
- numeric-aware version ordering

## Troubleshooting

### DSL decode failed

Check:

1. selector fields are unique
2. selector candidate paths are globally unique
3. assertion fields exist in selectors
4. `domainPattern` is a host pattern, not a URL
5. `pack.version` contains no whitespace
6. metadata tenant matches pack tenant
7. access mode and render policy are compatible

If decode fails, fix the DSL input. Do not coerce malformed definitions at
runtime.

### Version ordering behaved unexpectedly

`comparePackVersions(...)` compares numeric segments before lexical fallback.
Use stable dotted versions such as `2026.03.08` or `1.10.0` if you want
deterministic ordering.

## Rollback Guidance

Rollback for this surface means:

1. revert the pack-definition change
2. rerun `bun test tests/libs/foundation-core-site-pack.test.ts`
3. rerun downstream E6 runtime tests before re-promoting the pack

Do not:

- bypass the shared DSL schema for one-off packs
- hand-edit selector paths to duplicate an existing path
- mix tenant-local metadata into a different tenant pack

## Related Runbooks

- `docs/runbooks/e1-site-pack-state.md`
- `docs/runbooks/e6-pack-registry-resolution.md`
- `docs/runbooks/e6-pack-versioning-immutable-active.md`
