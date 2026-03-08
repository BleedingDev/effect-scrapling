# E7 Baseline Corpus

## Purpose

Operate the fixed E7 benchmark corpus and persist a reproducible artifact for
candidate-versus-incumbent quality work.

## Command Surface

```bash
bun run benchmark:e7-baseline-corpus
bun run check:e7-baseline-corpus
```

Direct artifact replay:

```bash
bun run scripts/benchmarks/e7-baseline-corpus.ts \
  --artifact docs/artifacts/e7-baseline-corpus-artifact.json
```

## What It Produces

- committed artifact: `docs/artifacts/e7-baseline-corpus-artifact.json`
- stable `corpusId`, `caseId`, `packId`, and `targetId` bindings
- deterministic capture / extraction / snapshot outputs for downstream E7 gates

## Practical Use

Refresh the committed artifact:

```bash
bun run benchmark:e7-baseline-corpus
```

Write an ephemeral local copy:

```bash
bun run scripts/benchmarks/e7-baseline-corpus.ts \
  --artifact tmp/e7-baseline-corpus-artifact.json
```

Inspect the corpus summary:

```bash
jq '{corpusId, caseCount, packIds}' docs/artifacts/e7-baseline-corpus-artifact.json
```

## Troubleshooting

### Duplicate case or pack ids

Treat that as corrupted benchmark input, not a reporting bug. Fix the producer
fixture and rerun the benchmark.

### Artifact drift after unrelated runtime changes

Rerun `bun run check:e7-baseline-corpus`. If ids stay stable but field values
change, the regression is in the capture or extraction path, not this runbook.
