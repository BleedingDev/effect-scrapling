# E9 Public SDK Package

The public E9 consumer surface is the package subpath:

```ts
import { runE9CapabilitySlice, runE9LaunchReadiness } from "effect-scrapling/e9";
```

## Commands

```bash
bun run check:e9-sdk-consumer
```

Direct replay:

```bash
bun test tests/sdk/e9-consumer-example.test.ts
bun run example:e9-sdk-consumer
```

## Notes

- use only `effect-scrapling/e9`
- do not import `src/`, `scripts/`, or `libs/` from downstream consumers
- Scrapling parity is intentionally fixture-corpus postcapture evidence, not a
  live transport benchmark
