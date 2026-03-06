# E1 Security Review

## Purpose

Review the E1 foundation-core capability slice for policy violations, secret
handling, storage-key sanitization gaps, and unsafe public-boundary drift before
promotion.

This review covers:

- schema primitives and canonical transport boundaries in
  `libs/foundation/core/src/schema-primitives.ts`
- config and storage contracts in `libs/foundation/core/src/config-storage.ts`
- tagged error envelopes in `libs/foundation/core/src/tagged-errors.ts`
- the executable capability slice in `examples/e1-capability-slice.ts`

## Threat Checklist

| Threat | Status | Control |
| --- | --- | --- |
| Credential-bearing or fragment-bearing execution URLs | Mitigated | `CanonicalHttpUrlSchema` rejects credentials, fragments, and non-HTTP(S) URLs |
| Traversal-like storage namespaces or keys | Mitigated | `CanonicalKeySchema` now rejects dot segments, duplicate slashes, and leading slashes before `StorageLocatorSchema` or `RunExecutionConfigSchema` accept them |
| Backend-specific path leakage in public storage records | Mitigated | `StorageLocatorSchema` remains logical `namespace + key` transport, not a filesystem path or URL |
| Secret or stack leakage in public error transport | Mitigated in current scope | `toCoreErrorEnvelope` emits only `code`, `retryable`, and `message` through `CoreErrorEnvelopeSchema` |
| Hidden runtime mutation in the capability slice | Mitigated | `runE1CapabilitySlice` emits encoded transport payloads and deterministic mock-backed layer results |
| Type-safety bypass or Effect-policy regression | Mitigated | full gates still require `lint:typesafety`, `check:governance`, and `check:effect-v4-policy` |

## Findings

### Fixed in this review

- Medium severity: `CanonicalKeySchema` previously allowed traversal-like values
  such as `../secrets` or `/absolute/path`. That was unsafe for future storage
  adapters that may map logical locators onto backend-specific path APIs.
- The E1 storage and config boundaries now reject dot segments, duplicate
  slashes, and leading slashes at schema decode time.

### Current severity summary

- Open high-severity findings: none
- Open medium-severity findings: none inside the current E1 slice after storage
  key hardening
- Residual risk: public error envelopes intentionally preserve a human-readable
  `message`. Callers must avoid embedding secrets from external systems into
  tagged error messages before calling `toCoreErrorEnvelope`.

## Verification Evidence

- `tests/guardrails/e1-security-review.verify.test.ts` verifies that
  `TargetProfileSchema`, `StorageLocatorSchema`, and `RunExecutionConfigSchema`
  reject traversal-like keys and credential-bearing execution URLs.
- The same test executes `runE1CapabilitySlice` and proves that emitted
  locators remain logical and that the public error envelope stays on the
  minimal `code + retryable + message` transport contract.
- Full repository gates confirm that the hardening change did not introduce
  Effect regressions, type-safety bypasses, or build drift.

## Operator Guidance

1. Treat any change to `CanonicalKeySchema`, `StorageLocatorSchema`, or
   `RunExecutionConfigSchema` as security-sensitive.
2. Re-run `bun test tests/guardrails/e1-security-review.verify.test.ts` after
   any public storage, config, or capability-slice boundary change.
3. Keep public storage locators logical. Do not expose absolute paths, URLs, or
   provider-native handles in encoded transport payloads.

## Rollback Guidance

1. Revert the offending schema or capability-boundary change rather than
   weakening the sanitization rules.
2. Re-run:

```bash
bun test tests/guardrails/e1-security-review.verify.test.ts
bun run check:e1-capability-slice
bun run check
```

3. Do not roll back by re-allowing traversal-like namespaces, removing schema
   validation, or introducing manual `instanceof`, manual `_tag`, or unsafe
   casts.
