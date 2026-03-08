# E7 Quality Metrics

## Purpose

Operate the deterministic recall and false-positive metric calculators that feed
promotion-gate and canary decisions.

## Command Surface

```bash
bun run benchmark:e7-quality-metrics
bun run check:e7-quality-metrics
```

Direct artifact replay:

```bash
bun run scripts/benchmarks/e7-quality-metrics.ts \
  --artifact docs/artifacts/e7-quality-metrics-artifact.json
```

## What It Produces

- committed artifact: `docs/artifacts/e7-quality-metrics-artifact.json`
- aggregate recall and false-positive rates
- per-pack metric summaries suitable for policy evaluation

## Practical Use

Refresh the committed artifact:

```bash
bun run benchmark:e7-quality-metrics
```

Inspect metric deltas:

```bash
jq '{summary, packSummaries}' docs/artifacts/e7-quality-metrics-artifact.json
```

## Troubleshooting

### Recall falls while incumbent comparison remains clean

Inspect the input fixture alignment before touching thresholds. This usually
means the quality-metrics input bundle drifted from the baseline corpus, not
that the calculator itself is wrong.

### False-positive rate exceeds policy unexpectedly

Use the per-pack summaries first. Fix the emitting fixture or candidate output
instead of mutating the artifact.
