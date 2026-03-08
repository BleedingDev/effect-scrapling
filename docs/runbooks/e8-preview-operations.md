# E8 Preview Operations

## Purpose

Operate access-preview and render-preview flows through the unified E8 boundary
for CLI and SDK consumers.

## Public Surface

CLI:

```sh
effect-scrapling access preview --url "https://example.com"
effect-scrapling render preview --url "https://example.com" --wait-until commit
```

SDK:

```ts
import { runAccessPreviewOperation, runRenderPreviewOperation } from "effect-scrapling/e8";
```

Focused checks:

```sh
bun test tests/sdk/e8-preview-verify.test.ts tests/sdk/e8-control-plane.test.ts
bun run check:e8-workspace-operations
```

## Practical Use

HTTP access preview:

```sh
effect-scrapling access preview \
  --url "https://shop.example.com/products/sku-42" \
  --mode http
```

Browser render preview:

```sh
effect-scrapling render preview \
  --url "https://shop.example.com/products/sku-42?view=rendered" \
  --wait-until commit \
  --wait-ms 400
```

## Troubleshooting

### Preview rejects the payload

The E8 boundary validates URLs, timeouts, wait states, and optional browser
options before any fetch or browser work starts. Fix the request payload; do not
paper over it in CLI parsing.

### Render preview differs from access preview

That is expected when browser rendering is required. Compare the typed status
and artifact bundle instead of assuming the DOM transport is identical.

## Rollback

1. Revert the preview-surface changes in `src/e8-control-plane.ts`,
   `src/standalone.ts`, or the SDK boundary.
2. Re-run the focused preview checks.
3. Re-run `bun run check` before shipping the rollback.
