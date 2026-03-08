# E9 Datart Reference Pack

The Datart E9 reference pack is the Tesla Electronics shadow candidate for `*.datart.cz`.

## Pack surface

- pack id: `pack-datart-cz-tesla-electronics`
- entry domain: `*.datart.cz`
- required fields:
  - `title`
  - `price`
  - `availability`
  - `productIdentifier`

## Practical replay

```bash
bun run check:e9-reference-packs
```

Focused Datart selector triage lives in:

- `src/e9-reference-packs.ts`
- `tests/fixtures/e9-datart-tesla.html`

If the Datart pack drifts:

1. update the deterministic fixture first
2. update the selector candidates or fallback ordering second
3. rerun `bun run check:e9-reference-packs`
