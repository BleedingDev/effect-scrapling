# E2 Extractor Orchestration

## Purpose

Give operators and SDK consumers one E2 runbook for:

- deterministic extractor orchestration setup
- routine validation commands
- focused diagnostics for parser, selector, normalization, assertion, and
  evidence-manifest failures
- rollback guidance

## Command Contract

Primary E2 setup and validation commands:

```bash
bun install --frozen-lockfile
bun run check:e2-capability-slice
bun run check:e2-security-review
bun run check:e2-performance-budget
bun run check:e2-sdk-consumer
```

Focused E2 diagnostics:

```bash
bun test tests/libs/foundation-core-e2-runtime.test.ts
bun test tests/libs/foundation-core-extractor-runtime.test.ts
bun test tests/libs/foundation-core-domain-normalizers.test.ts
bun test tests/libs/foundation-core-assertion-engine.test.ts
bun test tests/libs/foundation-core-evidence-manifest.test.ts
bun test tests/libs/foundation-core-snapshot-diff-engine.test.ts
bun test tests/libs/foundation-core-golden-fixtures.test.ts
bun test tests/examples/e2-capability-slice.test.ts
```

Public extraction-surface smoke checks:

```bash
bun run standalone -- extract run \
  --url "https://example.com" \
  --selector "h1"

PORT=3000 bun run api

curl -sS -X POST http://127.0.0.1:3000/extract/run \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","selector":"h1"}'
```

## Current Runtime Contract

Operators should read the integrated E2 evidence with these current guarantees
in mind:

- parser output is deterministic for repeated HTML input
- selector fallback is bounded and evidence-bearing
- domain normalization is schema-backed and deterministic across the supported
  field families
- required-field and business-invariant assertions preserve evidence refs
  without echoing captured secret values
- the extractor orchestration boundary emits:
  - parsed document metadata
  - selector resolutions
  - field bindings
  - snapshot assembly
  - assertion report
  - evidence manifest
- `check:e2-capability-slice` currently proves:
  - a golden fixture replays successfully
  - a candidate capture bundle is orchestrated through the full E2 pipeline
  - the candidate snapshot diff remains deterministic and typed

## Standard Execution Flow

### 1. Validate the integrated E2 slice

```bash
bun run check:e2-capability-slice
```

Inspect the emitted evidence for:

- successful golden replay
- deterministic candidate snapshot assembly
- typed snapshot diff output

### 2. Replay the consumer-facing public contract

```bash
bun run check:e2-sdk-consumer
```

What this proves today:

- the public SDK `extractRun` contract is sufficient for a downstream consumer
- invalid input and invalid selector paths surface typed public errors
- expected no-match behavior remains warning-based instead of crashing the
  consumer flow

### 3. Re-run the security and performance gates

```bash
bun run check:e2-security-review
bun run check:e2-performance-budget
```

If either gate fails, treat it as blocking evidence rather than relaxing the
runtime boundary or widening budgets immediately.

### 4. Escalate to focused diagnostics only when needed

Use the focused suites above to isolate the failing subsystem before rerunning
broader checks.

## Troubleshooting

### `extractRun` returns warnings with an empty value list

This is expected when the selector matches nothing. Treat it as a data-quality
signal and inspect the selector recipe before escalating to a runtime bug.

### E2 capability slice fails during replay

Inspect:

1. `tests/fixtures/foundation-core-e2-golden-fixtures.json`
2. `tests/libs/foundation-core-golden-fixtures.test.ts`
3. `tests/libs/foundation-core-extractor-runtime.test.ts`

### Performance budget fails

Use `docs/runbooks/e2-performance-budget.md` and keep the failing scorecard
artifact intact while you isolate the regression.

## Rollback Guidance

1. Revert the offending parser, selector, normalizer, assertion, or evidence
   change rather than weakening typed failures or determinism guarantees.
2. Re-run:

```bash
bun run check:e2-capability-slice
bun run check:e2-security-review
bun run check:e2-performance-budget
bun run check:e2-sdk-consumer
```

3. Do not roll back by:
   - bypassing schema decoding
   - defaulting to unbounded selector fallback
   - echoing captured secret values in assertion failures
   - introducing manual `_tag`, `instanceof`, or unsafe casts
