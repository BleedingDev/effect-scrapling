# E9 Capability Slice

Use the E9 capability slice to replay the full reference-pack, parity, canary,
and readiness path as one typed executable.

## Commands

```bash
bun run check:e9-capability-slice
```

Standalone replay:

```bash
bun test tests/examples/e9-capability-slice.test.ts
bun run example:e9-capability-slice
```

## Evidence

- `examples/e9-capability-slice.ts`
- `tests/examples/e9-capability-slice.test.ts`

## Expected result

- reference-pack validation is `pass`
- Scrapling parity is `pass`
- high-friction canary is `pass`
- launch readiness is `pass`
- all ids in `evidencePath` align with the child artifacts
