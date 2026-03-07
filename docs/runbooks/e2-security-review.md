# E2 Security Review

## Purpose

Review the E2 extraction slice for secret leakage, unsafe error reporting, and
sanitization drift before promotion.

This review covers:

- parser and selector failures in `libs/foundation/core/src/extraction-parser.ts`
  and `libs/foundation/core/src/selector-engine.ts`
- assertion and extractor mismatch reporting in
  `libs/foundation/core/src/assertion-engine.ts` and
  `libs/foundation/core/src/extractor-runtime.ts`
- deterministic E2 evidence paths in `examples/e2-capability-slice.ts`

## Threat Checklist

| Threat | Status | Control |
| --- | --- | --- |
| Malformed HTML or selectors crash the extraction runtime with untyped failures | Mitigated | `parseDeterministicHtml(...)` and `resolveSelectorPrecedence(...)` fail through typed `ParserFailure` or `ExtractionMismatch` envelopes |
| Business-invariant failures echo extracted secret values into logs or public transports | Mitigated in this review | `runAssertionEngine(...)` now reports invariant violations without embedding the observed normalized value, and `runExtractorOrchestration(...)` emits field-level summaries instead of replaying raw assertion text |
| Missing capture payloads expose raw document bodies in failure paths | Mitigated | payload-loader failures identify only the missing artifact id |
| Raw captured HTML escapes E2 through consumer-facing examples | Mitigated | `examples/e2-sdk-consumer.ts` stays on the public SDK boundary and emits only public `extractRun` response shapes plus typed error examples |
| Type-safety or Effect-policy shortcuts weaken the extraction boundary | Mitigated | repository gates still enforce `lint:typesafety`, `check:governance`, and `check:effect-v4-policy` |

## Findings

### Fixed in this review

- High severity: E2 business-invariant failures previously echoed normalized
  values such as product identifiers, availability strings, or secret-bearing
  text directly in assertion messages.
- The direct assertion boundary now preserves field and evidence context without
  replaying the observed normalized value.
- The extractor orchestration boundary now maps invariant failures to
  field-scoped summaries, so `ExtractionMismatch` messages stay useful without
  leaking captured values.

### Current severity summary

- Open high-severity findings: none
- Open medium-severity findings: none in the current E2 slice
- Residual risk: raw HTML payloads remain internal capture artifacts. They are
  intentionally required for deterministic replay and should not be logged,
  prompted, or transported outside internal E2 tooling without an explicit
  redaction boundary.

## Verification Evidence

- `tests/guardrails/e2-security-review.verify.test.ts` verifies that:
  - direct assertion failures keep evidence refs while omitting secret-bearing
    normalized values
  - extractor mismatch envelopes do not echo captured secret content
- `tests/libs/foundation-core-assertion-engine.test.ts` proves invariant
  failures remain typed, evidence-rich, and redacted.
- `tests/libs/foundation-core-extractor-runtime.test.ts` continues to prove the
  extractor runtime stays deterministic on valid captures.

## Operator Guidance

1. Treat any change to `runAssertionEngine(...)` or
   `runExtractorOrchestration(...)` as security-sensitive.
2. Re-run `bun test tests/guardrails/e2-security-review.verify.test.ts` after
   any change to extraction failures, assertion messaging, or public E2
   examples.
3. Re-run the focused E2 suites before promotion:

```bash
bun test tests/libs/foundation-core-assertion-engine.test.ts
bun test tests/libs/foundation-core-extractor-runtime.test.ts
bun test tests/examples/e2-capability-slice.test.ts
```

4. Replay full repository gates before bead closure or merge:
   `bun run ultracite:check`, `bun run oxlint:check`, `bun run format:check`, `bun run test`, `bun run build`.

## Rollback Guidance

1. Revert the offending assertion or extractor change rather than weakening
   failure redaction.
2. Re-run:

```bash
bun test tests/guardrails/e2-security-review.verify.test.ts
bun test tests/libs/foundation-core-assertion-engine.test.ts
bun test tests/libs/foundation-core-extractor-runtime.test.ts
bun test tests/examples/e2-capability-slice.test.ts
```

3. Do not roll back by:
   - embedding captured normalized values back into assertion messages
   - bypassing typed `ParserFailure` or `ExtractionMismatch` envelopes
   - introducing manual `_tag`, `instanceof`, or unsafe casts
