# E8 Benchmark And Artifact Export

Use this runbook for the public E8 benchmark metadata surface and the sanitized
artifact export bundle.

Focused checks:

```sh
bun test tests/sdk/e8-benchmark-export.test.ts tests/scripts/e8-benchmark-export.test.ts
bun run check:e8-benchmark-export
```

Run the metadata surface:

```sh
bun run benchmark:e8-benchmark-run
```

Persist the benchmark metadata envelope:

```sh
bun run scripts/benchmarks/e8-benchmark-export.ts run \
  --artifact tmp/e8-benchmark-run.json
```

Persist the sanitized bundle:

```sh
bun run benchmark:e8-artifact-export
```

The exported bundle is the public transport surface. It reads the committed E7
artifacts that ship with the package and sanitizes persisted absolute paths
before emission.

Rollback guidance:

1. Preserve the failing `tmp/` or `docs/artifacts/` output.
2. Re-run `bun run check:e8-benchmark-export`.
3. If `artifact export` fails, treat missing or malformed committed E7 artifacts
   as a hard failure and repair the source artifact instead of regenerating it
   implicitly.
4. If only the export sanitizer regressed, fix the path sanitization boundary
   instead of widening the public bundle shape.
