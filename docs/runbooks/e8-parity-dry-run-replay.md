# E8 Parity Dry-Run Replay

Use this runbook to replay the deterministic E8 SDK and CLI parity suite.

Focused checks:

```sh
bun test tests/scripts/e8-parity-dry-run.test.ts
bun run check:e8-parity-dry-run
```

Run the suite directly:

```sh
bun run benchmark:e8-parity-dry-run
```

Persist a scratch artifact:

```sh
bun run scripts/benchmarks/e8-parity-dry-run.ts \
  --artifact tmp/e8-parity-dry-run.json
```

The suite proves:

- SDK and CLI envelopes match for deterministic E8 operations
- replaying the same CLI command yields the same normalized envelope
- benchmark metadata and artifact export stay aligned with the E8 public surface

If the suite fails:

1. Inspect `mismatches` first.
2. Check whether the drift is real envelope drift or only a volatile timing
   field that should remain normalized.
3. Re-run `bun run check:e8-workspace-operations` and `bun run check:e8-benchmark-export`
   before widening the parity normalizer.
