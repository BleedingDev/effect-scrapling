# E9 Alza Reference Pack

The Alza E9 reference pack is the Tesla Electronics shadow candidate for `*.alza.cz`.

## Pack surface

- pack id: `pack-alza-cz-tesla-electronics`
- entry domain: `*.alza.cz`
- required fields:
  - `title`
  - `price`
  - `availability`
  - `productIdentifier`

## Practical replay

```bash
bun run check:e9-reference-packs
```

Focused Alza selector triage lives in:

- `src/e9-reference-packs.ts`
- `tests/fixtures/e9-alza-tesla.html`

If the Alza pack drifts:

1. update the deterministic fixture first
2. update the selector candidates or fallback ordering second
3. rerun `bun run check:e9-reference-packs`
