# E9 Scrapling Live Turnstile Parity Benchmark

Use this runbook to replay a live parity benchmark against the installed
upstream `scrapling` CLI on current Alza Cloudflare Turnstile pages.

## Scope

- measures live browser parity on current high-friction Alza product pages
- compares `effect-scrapling` browser-stealth `--solve-cloudflare` against
  `scrapling extract stealthy-fetch --solve-cloudflare`
- records both fetch success and exact `h1` extraction parity
- records whether the live runs actually cleared Cloudflare on each side

This benchmark is intentionally separate from
`e9-scrapling-parity-artifact.json`. The older benchmark is still the
deterministic fixture/postcapture corpus; this one is the live upstream CLI
evidence for Turnstile migration.

## Commands

```bash
bun run check:e9-scrapling-live-parity
```

Focused replay:

```bash
bun test tests/scripts/e9-scrapling-live-parity.test.ts
bun run benchmark:e9-scrapling-live-parity
```

## Artifact

- `docs/artifacts/e9-scrapling-live-parity-artifact.json`

## Practical notes

1. The benchmark is intentionally small and live: two current Alza cases.
2. Both sides use the same extraction surface: `h1`.
3. `effect-scrapling` is exercised through its real CLI boundary.
4. Upstream Scrapling is exercised through `scrapling extract stealthy-fetch`
   with `--solve-cloudflare`.
5. A redirect on the upstream side is not treated as failure if the final page
   resolves to the expected title.

## Failure triage

1. If only our side fails, inspect the `ours.mediationStatus` and diagnostic in
   the artifact.
2. If both sides fail, treat it as a live-site or environment issue first.
3. If upstream succeeds but we fail, replay the affected URL directly through
   `effect-scrapling extract run --mode browser --provider browser-stealth
   --solve-cloudflare --selector h1`.
4. If the upstream CLI is missing, install or expose `scrapling` on `PATH`
   before rerunning the benchmark.
