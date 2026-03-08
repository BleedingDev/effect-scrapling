# E8 Public SDK Package

Use this runbook for downstream consumers that integrate the public E8 SDK
surface through `effect-scrapling/e8`.
`effect-scrapling` ships the public E8 entrypoint, while
`@effect-scrapling/foundation-core` remains a separate package in the same
published package family.

Focused checks:

```sh
bun test tests/sdk/e8-consumer-example.test.ts
bun run check:e8-sdk-consumer
```

Run the public consumer example:

```sh
bun run example:e8-sdk-consumer
```

The example proves three things:

1. workspace doctor/config flows stay on the public E8 package surface
2. benchmark metadata is available through the same public package subpath
3. artifact export stays on the sanitized public bundle shape

Consumer guidance:

- import only `effect-scrapling/e8`
- do not import `src/*`, `scripts/*`, or `libs/*`
- treat the exported benchmark bundle as the supported transport artifact
- for local tarball smoke tests, install both workspace tarballs together so the
  consumer simulates the published package family without requiring a live
  registry publish

Rollback guidance:

1. Re-run `bun run check:e8-sdk-consumer`.
2. If the example starts requiring private imports, revert that change and keep
   the public E8 subpath minimal.
