# E6 Pack Versioning and Immutable Active Policy

## Purpose

This runbook documents the current E6 versioning rules that keep active pack
artifacts immutable while preserving reproducible history.

Primary entrypoints:

- `applyPackGovernanceDecision(...)` from
  `libs/foundation/core/src/pack-governance-runtime.ts`
- `comparePackVersions(...)` from `libs/foundation/core/src/site-pack.ts`
- `resolvePackRegistryLookup(...)` from
  `libs/foundation/core/src/pack-registry-runtime.ts`

Primary validation surface:

- `bun test tests/libs/foundation-core-pack-governance-runtime.test.ts`
- `bun test tests/libs/foundation-core-pack-registry-runtime.test.ts`
- `bun test tests/libs/foundation-core-site-pack.test.ts`

## Policy

The current repository policy is:

- active artifacts are immutable
- promotion into `active` must create a new versioned artifact
- historical artifacts stay reproducible at their original version
- lifecycle-only transitions may change state on an existing version
- only one active artifact may exist per `packId` at a time

The shared catalog contract enforces:

- unique `(packId, version)` pairs
- at most one `active` artifact per `packId`

## Version Selection Rules

`nextVersion` must:

1. be present for every activation into `active`
2. be omitted for lifecycle-only transitions
3. sort after the newest recorded historical version for the same `packId`
4. decode through `PackVersionSchema`

`comparePackVersions(...)` compares:

1. numeric segments numerically
2. non-numeric segments lexically
3. full-string lexical order only as a final tie-break

Examples:

- `1.10.0` sorts after `1.9.0`
- `2026.3.10` sorts after `2026.03.9`
- `2026.03.08` equals `2026.03.08`

## Deterministic Replay

Run the focused versioning checks:

```bash
bun test tests/libs/foundation-core-site-pack.test.ts
bun test tests/libs/foundation-core-pack-registry-runtime.test.ts
bun test tests/libs/foundation-core-pack-governance-runtime.test.ts
```

Covered behaviors:

- numeric-aware version ordering
- registry preference for the newest matching version
- rejection of duplicate version artifacts
- rejection of multiple active artifacts for one `packId`
- rejection of missing activation versions
- rejection of stale activation versions

To replay the full E6 versioning surface in one command:

```bash
bun test tests/libs/foundation-core-site-pack.test.ts \
  tests/libs/foundation-core-pack-registry-runtime.test.ts \
  tests/libs/foundation-core-pack-governance-runtime.test.ts
```

## Troubleshooting

### Promotion is rejected even though the version looks newer

Check:

1. the new version actually sorts after the newest historical version for that
   pack id
2. there is no previously recorded artifact with the same `(packId, version)`
3. the new version does not contain whitespace

If the version naming scheme is ambiguous, normalize it before promotion. Do
not bypass the shared comparator.

### Registry returns an older active version

Check:

1. there is only one active artifact for the pack id
2. the candidate versions compare as expected through `comparePackVersions(...)`
3. the lookup domain/tenant/state filters are not excluding the newer artifact

### Historical replay is not reproducible

Check:

1. the historical artifact still exists under its original version
2. the active promotion created a new artifact instead of mutating the source
3. the audit trail records the source and target versions for the governance
   action

## Rollback Guidance

When rolling back:

1. choose the historical source artifact you want to restore
2. mint a fresh `nextVersion`
3. reactivate through the governance runtime
4. confirm the old current active version was demoted to `shadow`
5. rerun the focused governance and registry suites

Forbidden shortcuts:

- reusing the historical artifact's original version as the new active version
- mutating the current active artifact in place
- hand-sorting versions outside `comparePackVersions(...)`

## Related Runbooks

- `docs/runbooks/e6-shadow-active-governance-automation.md`
- `docs/runbooks/e6-pack-governance-actions.md`
- `docs/runbooks/e6-pack-registry-resolution.md`
