# E9 TS Bohemia Reference Pack

The TS Bohemia E9 reference pack is the Tesla Electronics shadow candidate for `*.tsbohemia.cz`.

## Pack surface

- pack id: `pack-tsbohemia-cz-tesla-electronics`
- entry domain: `*.tsbohemia.cz`
- required fields:
  - `title`
  - `price`
  - `availability`
  - `productIdentifier`

## Practical replay

```bash
bun run check:e9-reference-packs
```

Focused TS Bohemia selector triage lives in:

- `src/e9-reference-packs.ts`
- `tests/fixtures/e9-tsbohemia-tesla.html`

If the TS Bohemia pack drifts:

1. update the deterministic fixture first
2. update the selector candidates or fallback ordering second
3. rerun `bun run check:e9-reference-packs`
