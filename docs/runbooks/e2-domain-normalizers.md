# E2 Domain Normalizers

## Purpose

Operate and troubleshoot the E2 field-normalization boundary that turns parsed
string payloads into canonical extraction values before snapshot assembly.

This runbook covers the currently supported E2 field families:

- `price`
- `currency`
- `availability`
- `date`
- `text`
- `productIdentifier`

Primary implementation and validation surfaces:

- `libs/foundation/core/src/domain-normalizers.ts`
- `tests/libs/foundation-core-domain-normalizers.test.ts`
- `docs/runbooks/e2-extractor-orchestration.md`

## Contract

The normalization boundary is schema-first and deterministic.

Current guarantees:

- whitespace and zero-width characters are removed from `text`
- currencies resolve to canonical ISO-like uppercase codes where supported
- prices require both an amount and a recognized currency
- availability resolves to a bounded enum, not free-form output
- dates normalize to ISO timestamps
- product identifiers normalize by kind and enforce checksum rules where
  applicable
- malformed inputs fail with typed `DomainNormalizationError` values tagged by
  field

Current examples proven by `tests/libs/foundation-core-domain-normalizers.test.ts`:

- `normalizeText("  Fresh\u00a0deal\u200b \n  today  ") => "Fresh deal today"`
- `normalizeCurrency(" us dollars ") => "USD"`
- `normalizePrice("EUR 19,99") => { amount: 19.99, currency: "EUR" }`
- `normalizePrice({ amount: "1 299,50", currency: "Canadian dollars" }) => { amount: 1299.5, currency: "CAD" }`
- `normalizeAvailability("Ships in 2 weeks") => "backorder"`
- `normalizeDate("2026-03-06") => "2026-03-06T00:00:00.000Z"`
- `normalizeProductIdentifier("EAN 4006381333931") => { kind: "ean", value: "4006381333931" }`
- `normalizeProductIdentifier("sku: part-9_a") => { kind: "sku", value: "PART-9_A" }`

Malformation examples that must continue to fail:

- `normalizePrice("19.99")` because the currency is missing
- `normalizeCurrency("store credit")`
- `normalizeAvailability("maybe later")`
- `normalizeDate("not-a-date")`
- `normalizeText(" \n\t\u200b ")`
- invalid UPC/EAN/GTIN checksum values

## Validation Commands

Focused normalizer validation:

```bash
bun test tests/libs/foundation-core-domain-normalizers.test.ts
```

Integrated E2 replay:

```bash
bun run check:e2-capability-slice
bun run check:e2-sdk-consumer
```

Full merge-facing E2 gates:

```bash
bun run check:e2-security-review
bun run check:e2-performance-budget
```

## Operator Workflow

### 1. Confirm canonical output on the focused suite

Run:

```bash
bun test tests/libs/foundation-core-domain-normalizers.test.ts
```

That suite currently proves:

- canonical success output for all supported field families
- deterministic malformed-input failures
- idempotent text normalization across generated inputs
- checksum rejection for generated invalid UPC values

### 2. Verify the integrated extraction slice

Run:

```bash
bun run check:e2-capability-slice
bun run check:e2-sdk-consumer
```

Use the focused suite first when changing alias tables or regexes. Use the
integrated commands when you need to prove those normalizers still compose
correctly inside snapshot assembly and the public SDK boundary.

### 3. Read failures by field, not by raw input

`DomainNormalizationError` is the operator boundary. Treat `field` as the
routing key for triage:

- `price` failures usually mean missing or malformed currency/amount pairs
- `currency` failures usually mean an unsupported alias or symbol
- `availability` failures usually mean the source text no longer matches the
  bounded status vocabulary
- `date` failures usually mean format drift
- `productIdentifier` failures often mean checksum or identifier-kind drift

Do not widen the boundary by accepting ambiguous free-form output just to make
the current site pass.

## Troubleshooting

### Price normalization started failing after a source-site change

Check whether the source now separates amount and currency differently. The
current boundary intentionally rejects amount-only text such as `19.99`.

Validate with:

```bash
bun test tests/libs/foundation-core-domain-normalizers.test.ts
```

If the source changed in a legitimate way, update the alias/parsing logic in
`libs/foundation/core/src/domain-normalizers.ts` and keep the failure typed.

### Availability is now resolving to `outOfStock` or failing unexpectedly

Review the source text against the current matcher list in
`libs/foundation/core/src/domain-normalizers.ts`.

Do not add vague catch-all patterns. Keep matcher semantics explicit and
deterministic.

### Product identifiers fail after a feed change

Differentiate:

- identifier kind drift, for example `gtin` vs `ean`
- formatting drift, for example spaces or punctuation
- actual checksum failures

Checksum failures should remain terminal. Do not bypass them.

## Rollout and Rollback

Roll forward only after:

```bash
bun test tests/libs/foundation-core-domain-normalizers.test.ts
bun run check:e2-capability-slice
bun run check:e2-sdk-consumer
```

Rollback by reverting the offending normalization change and rerunning the same
commands.

Do not roll back by:

- accepting price values without currency
- weakening checksum validation
- bypassing schema decoding
- introducing manual `_tag`, `instanceof`, or unsafe casts
