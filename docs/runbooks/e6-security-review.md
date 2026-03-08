# E6 Security Review

## Purpose

Review the E6 site-pack and reflection pipeline for unsafe pack definitions,
forged promotion inputs, and governance-state ambiguity before promotion.

This review covers:

- `libs/foundation/core/src/site-pack.ts`
- `libs/foundation/core/src/reflection-engine-runtime.ts`
- `libs/foundation/core/src/pack-governance-runtime.ts`
- `tests/guardrails/e6-security-review.verify.test.ts`
- `tests/libs/foundation-core-reflection-engine-runtime.test.ts`
- `tests/libs/foundation-core-pack-governance-runtime.test.ts`

## Threat Checklist

| Threat | Status | Control |
| --- | --- | --- |
| Protocol-bearing, uppercase, or whitespace-bearing domain patterns smuggle unsafe pack routing into runtime resolution | Mitigated | `SitePackDslSchema` rejects malformed `domainPattern` values before registry, validator, or governance code runs |
| A forged quality verdict or stale decision promotes the wrong pack artifact into a privileged lifecycle state | Mitigated | `decidePackPromotion(...)` binds decisions to the selected `packId` and current `version`, and governance rejects replay against a different artifact version |
| Governance runs against ambiguous catalog state with multiple active artifacts for one pack | Mitigated | `VersionedSitePackCatalogSchema` rejects duplicate `(packId, version)` pairs and multiple active artifacts for the same pack id |
| Active promotion mutates the existing pack version in place | Mitigated | `applyPackGovernanceDecision(...)` requires a fresh `nextVersion` for active transitions and preserves historical source artifacts |
| Pack artifacts or verdict payloads are cryptographically signed at rest | Residual risk | current E6 artifacts are schema-validated and audited, but not signed; storage integrity remains an operational trust boundary |

## Findings

### Fixed in this review

- Medium-severity evidence gap: E6 already failed closed on malformed pack
  domains, pack-id mismatches, stale-version replay, and missing immutable
  `nextVersion` values, but the current slice lacked one focused security
  replay proving those controls together.
- Added `tests/guardrails/e6-security-review.verify.test.ts` to prove those
  boundaries through real schema and runtime surfaces.

### Current severity summary

- Open high-severity findings: none
- Open medium-severity findings: none inside the current E6 slice after the
  focused verification above
- Residual risk: the current E6 governance catalog is trusted operator input
  that is schema-validated and audited, but not cryptographically signed

## Verification Evidence

- `tests/guardrails/e6-security-review.verify.test.ts` proves:
  - unsafe `domainPattern` values are rejected before site packs enter runtime
    resolution
  - reflection automation rejects forged verdicts that target a different pack
  - governance rejects replay against a different version of the same pack id
  - governance rejects active promotion without a fresh immutable version and
    rejects ambiguous active-catalog state
- `tests/libs/foundation-core-reflection-engine-runtime.test.ts` proves the
  neighboring E6 automation invariants:
  - green verdicts are the only path to `active`
  - critical gate failures are quarantined
  - inconsistent lifecycle actions are rejected
- `tests/libs/foundation-core-pack-governance-runtime.test.ts` proves:
  - rollback and activation remain auditable
  - historical source artifacts remain reproducible
  - duplicate version reuse and missing catalog artifacts are rejected

## Operator Guidance

1. Treat changes to `SitePackDslSchema`, `comparePackVersions(...)`,
   `decidePackPromotion(...)`, and `applyPackGovernanceDecision(...)` as
   security-sensitive.
2. Re-run the focused E6 proof lanes after any pack-contract or governance
   change:

```bash
bun run check:e6-security-review
bun test tests/libs/foundation-core-reflection-engine-runtime.test.ts
bun test tests/libs/foundation-core-pack-governance-runtime.test.ts
```

3. Do not repair a governance catalog by hand-editing active pack versions.
   Promote or rollback through the governance runtime with a fresh `nextVersion`
   so audit history remains truthful.
4. Re-run repository release gates before promotion: `ultracite`, `oxlint`,
   `oxfmt`, tests, and build.

## Rollback Guidance

1. Revert the offending pack-contract, reflection, or governance change instead
   of weakening domain or version guards.
2. Re-run:

```bash
bun run check:e6-security-review
bun test tests/libs/foundation-core-reflection-engine-runtime.test.ts
bun test tests/libs/foundation-core-pack-governance-runtime.test.ts
```

3. Do not roll back by:
   - accepting protocol-bearing or whitespace-bearing `domainPattern` values
   - hand-authoring a verdict for a different `packId`
   - mutating an existing active version in place instead of minting a fresh one
   - bypassing schema validation, governance catalog validation, or audit-trail
     emission
   - introducing manual `instanceof`, manual `_tag`, unsafe casts, or Effect v3
     compatibility code
