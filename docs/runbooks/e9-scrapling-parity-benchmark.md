# E9 Scrapling Parity Benchmark

Use this runbook to replay the deterministic E9 parity benchmark against the
original `scrapling` parser on the committed 10-product Tesla retailer corpus.

## Scope

- measures post-capture parity on a committed fixture corpus
- compares required-field extraction completeness on 10 retailer cases
- compares fetch-success and bypass-success as corpus-consumption outcomes
- records the current Scrapling parser/fetcher runtime availability in this
  benchmark environment

This benchmark is intentionally `fixture-corpus-postcapture`. It does not claim
live-site transport parity on Alza, Datart, or TS Bohemia.

## Commands

```bash
bun run check:e9-scrapling-parity
```

Focused replay:

```bash
bun test tests/scripts/e9-scrapling-parity.test.ts
bun run benchmark:e9-scrapling-parity
```

## Artifact

- `docs/artifacts/e9-scrapling-parity-artifact.json`

## Practical notes

1. The benchmark bootstraps an isolated Python venv under
   `tmp/e9-scrapling-selector-env`.
2. The parser comparison uses `scrapling.Selector`, not live network fetchers.
3. The artifact records whether Scrapling fetchers are importable in the current
   environment; that signal is informative, not hidden.

## Failure triage

1. If a case loses completeness, inspect the mutated corpus case in
   `src/e9-fixture-corpus.ts`.
2. If a selector mismatch appears, compare the recorded `matchedSelectors`
   against the recipe selectors in `src/e9-reference-packs.ts`.
3. If the Python bootstrap fails, inspect the `tmp/e9-scrapling-selector-env`
   environment and rerun the benchmark.
