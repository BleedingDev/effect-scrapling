# E6 Pack Registry Resolution

## Purpose

This runbook covers typed site-pack catalog validation and deterministic pack
resolution for the current E6 surface.

Primary entrypoints:

- `resolvePackRegistryLookup(...)` from
  `libs/foundation/core/src/pack-registry-runtime.ts`
- `makePackRegistry(...)` and `makePackRegistryLayer(...)` from
  `libs/foundation/core/src/pack-registry-runtime.ts`
- `SitePackSchema`, `PackRegistryLookup`, and `SitePackDslSchema` from
  `libs/foundation/core/src/site-pack.ts`

Primary validation surface:

- `bun test tests/libs/foundation-core-pack-registry-runtime.test.ts`
- `bun test tests/libs/foundation-core-site-pack.test.ts`

There is no dedicated CLI command, API route, or root `package.json` script for
pack lookup today. The operational surface is library-level plus the focused Bun
tests above.

## Public Package Surface

Verified import paths in the current workspace:

```ts
import { PackRegistry, SitePackSchema } from "@effect-scrapling/foundation-core";
import {
  makePackRegistry,
  makePackRegistryLayer,
  resolvePackRegistryLookup,
} from "@effect-scrapling/foundation-core/pack-registry-runtime";
import {
  PackRegistryLookup,
  SitePackDslSchema,
} from "@effect-scrapling/foundation-core/site-pack";
```

Current boundary notes:

- `@effect-scrapling/foundation-core` exports the `PackRegistry` service plus
  `PackStateSchema` and `SitePackSchema`
- `resolvePackRegistryLookup(...)`, `makePackRegistry(...)`,
  `makePackRegistryLayer(...)`, `PackRegistryLookup`, and `SitePackDslSchema`
  are subpath exports, not root-index re-exports
- downstream runtime consumers resolve packs through the `PackRegistry` service

## Resolution Rules

The current resolver is deterministic and applies these rules in order:

1. filter to packs whose `domainPattern` matches the requested domain
2. filter to packs whose lifecycle state appears in `lookup.states`
3. reject tenant-specific packs for other tenants
4. prefer earlier states in the requested `lookup.states` order
5. prefer exact tenant matches before tenant-less global packs
6. prefer more specific domain patterns before broader wildcard patterns
7. prefer newer `version` strings by numeric segment ordering first, then lexical fallback
8. tie-break by `id`

Important behaviors covered by the runtime and tests:

- string lookups such as `resolvePackRegistryLookup(catalog, "shop.example.com")`
  and `registry.getByDomain("shop.example.com")` decode through
  `PackRegistryLookup` and default `states` to `["active", "shadow"]`
- wildcard patterns only match subdomains; `*.example.com` does not match the
  root domain `example.com`
- `makePackRegistry(...)` fails closed if the catalog does not decode through
  `PackRegistryCatalogSchema`
- `PackRegistryCatalogSchema` requires unique pack ids

## Deterministic Operator Replay

Run the contract and resolver suites directly:

```bash
bun test tests/libs/foundation-core-site-pack.test.ts
bun test tests/libs/foundation-core-pack-registry-runtime.test.ts
```

Useful covered cases:

- a complete DSL definition decodes with selectors, assertions, policy, and
  metadata
- duplicate selector fields and reused selector paths are rejected
- assertion fields must be declared by selectors
- domain patterns must be lowercased and protocol-free
- pack versions cannot contain whitespace
- metadata tenant isolation must match the pack tenant
- exact active matches beat wildcard matches by default
- tenant-specific active matches beat global matches inside the same lifecycle
  band
- shadow-only lookup stays deterministic
- wildcard packs do not accidentally match the root domain
- `getById(...)` resolves through the service surface

For adjacent E6 replay, use:

```bash
bun test tests/libs/foundation-core-reflector-runtime.test.ts
bun test tests/libs/foundation-core-validator-ladder-runtime.test.ts
```

Those suites do not exercise pack lookup directly, but they are the next
operator-visible E6 surfaces downstream from pack contracts.

To replay the currently documented E6 surface in one command:

```bash
bun test tests/libs/foundation-core-pack-registry-runtime.test.ts \
  tests/libs/foundation-core-site-pack.test.ts \
  tests/libs/foundation-core-reflector-runtime.test.ts \
  tests/libs/foundation-core-validator-ladder-runtime.test.ts
```

## Troubleshooting

### No pack resolved for a domain

Check:

1. the input is a canonical host such as `shop.example.com`, not a URL
2. the candidate `domainPattern` really matches the host
3. the candidate state is included in `lookup.states`
4. the tenant id is either omitted or exactly matches the candidate tenant
5. the catalog decodes cleanly through `SitePackSchema`

The most common surprise is wildcard behavior: `*.example.com` matches
`shop.example.com`, but not `example.com`.

### The wrong pack won

Check:

1. requested lifecycle state order
2. tenant preference
3. exact-domain versus wildcard specificity
4. version string ordering

Version ordering compares numeric segments before falling back to lexical
comparison. Treat versions as stable dotted stamps such as `2026.03.08` or
`1.10.0` if you want the newest pack to win predictably.

### DSL decode failed before resolution

Check:

1. duplicate selector fields
2. reused selector candidate paths
3. assertions referencing undeclared fields
4. unsafe domain patterns
5. whitespace in `pack.version`
6. pack and metadata tenant drift
7. invalid access-mode and rendering-policy combinations

If schema decoding fails, fix the pack definition. Do not bypass the shared
schema contracts with ad hoc runtime coercion.

## Current Gaps

The repository does not currently ship:

- a CLI command for catalog validation or pack lookup
- an HTTP endpoint for registry resolution
- an in-repo consumer example for
  `@effect-scrapling/foundation-core/pack-registry-runtime`

Use the focused Bun tests and the public package exports as the current source
of truth.

## Related Runbooks

- `docs/runbooks/e1-site-pack-state.md`
- `docs/runbooks/e3-access-planner-policy.md`
- `docs/runbooks/e6-reflector-clustering.md`
- `docs/runbooks/e6-validator-ladder.md`
