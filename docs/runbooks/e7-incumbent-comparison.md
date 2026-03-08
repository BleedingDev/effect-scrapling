# E7 Incumbent Comparison

## Purpose

Compare candidate output against the incumbent baseline corpus and emit
pack-scoped verdicts plus deterministic delta summaries.

## Command Surface

```bash
bun run benchmark:e7-incumbent-comparison
bun run check:e7-incumbent-comparison
```

Direct artifact replay:

```bash
bun run scripts/benchmarks/e7-incumbent-comparison.ts \
  --artifact docs/artifacts/e7-incumbent-comparison-artifact.json
```

## What It Produces

- committed artifact: `docs/artifacts/e7-incumbent-comparison-artifact.json`
- one comparison summary per pack
- aligned incumbent and candidate references bound to the same corpus and case ids

## Practical Use

Refresh the committed artifact:

```bash
bun run benchmark:e7-incumbent-comparison
```

Inspect pack verdicts quickly:

```bash
jq '.summaries[] | {packId, verdict, caseCount}' \
  docs/artifacts/e7-incumbent-comparison-artifact.json
```

Write a local-only replay artifact:

```bash
bun run scripts/benchmarks/e7-incumbent-comparison.ts \
  --artifact tmp/e7-incumbent-comparison-artifact.json
```

## Troubleshooting

### Comparison ids or pack counts do not align

That is upstream evidence drift. Rebuild the baseline artifact first, then rerun
the comparison.

### A pack summary disappears

Treat that as a runtime regression. The comparison runner must emit exactly one
summary per pack id.
