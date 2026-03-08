# E9 Reference Pack Validation

Use this runbook to replay the deterministic E9 reference-pack validation lane for Alza, Datart, and TS Bohemia.

## Scope

- validates one shadow reference pack per retailer
- proves required-field extraction on a deterministic Tesla product fixture
- proves green validator-ladder output in the shadow lane
- proves governance promotion into a fresh active version
- proves green validator-ladder output again on the resulting active artifact

## Commands

```bash
bun run check:e9-reference-packs
```

Focused replay:

```bash
bun test tests/sdk/e9-reference-packs.test.ts tests/scripts/e9-reference-pack-validation.test.ts
bun run benchmark:e9-reference-pack-validation
```

## Artifacts

- scorecard: `docs/artifacts/e9-reference-pack-validation-artifact.json`
- fixtures:
  - `tests/fixtures/e9-alza-tesla.html`
  - `tests/fixtures/e9-datart-tesla.html`
  - `tests/fixtures/e9-tsbohemia-tesla.html`

## Failure triage

1. If extraction fails, inspect the missing field in the relevant fixture and compare it to the selectors exported from `src/e9-reference-packs.ts`.
2. If validator output degrades, inspect `shadowValidation.qualityVerdict.gates` first.
3. If governance fails, confirm that `previousActiveVersion`, shadow version, and `nextActiveVersion` are all distinct.
