# E4 Render Preview Runbook

## Purpose

Use this runbook when operators or SDK consumers need to exercise the
browser-only render preview path for interactive policy validation through the
public SDK, CLI, or API surfaces.

Current implementation surface:

- `src/sdk/scraper.ts`
- `src/sdk/schemas.ts`
- `src/api.ts`
- `src/standalone.ts`
- `tests/sdk/scraper.test.ts`
- `tests/apps/api-app.test.ts`
- `tests/apps/cli-app.test.ts`

Policy baseline:

- Effect v4 only
- no manual `_tag` inspection
- no manual `instanceof`
- no type-safety bypasses

## Current Contract

Public entrypoints:

- SDK: `renderPreview(...)`
- CLI: `effect-scrapling render preview ...`
- API: `POST /render/preview`

Current response contract:

- `command === "render preview"`
- `data.mode === "browser"`
- `data.status` is a typed status envelope with:
  - `code`
  - `ok`
  - `redirected`
  - `family`
- `data.artifacts` is a deterministic tuple in this order:
  1. `navigation`
  2. `renderedDom`
  3. `timings`

Current artifact details:

- `navigation`
  - `finalUrl`
  - `contentType`
  - `contentLength`
- `renderedDom`
  - `title`
  - `textPreview`
  - `linkTargets`
  - `hiddenFieldCount`
- `timings`
  - `durationMs`

## Practical Execution

### CLI

```bash
bun run standalone -- render preview \
  --url "https://example.com" \
  --wait-until networkidle \
  --wait-ms 300
```

### API

```bash
curl -sS -X POST http://127.0.0.1:3000/render/preview \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://example.com",
    "browser": {
      "wait-until": "networkidle",
      "timeout-ms": "300"
    }
  }'
```

### SDK

```ts
import { Effect } from "effect";
import { FetchServiceLive, renderPreview } from "effect-scrapling/sdk";

const preview = await Effect.runPromise(
  renderPreview({
    url: "https://example.com",
    browser: {
      waitUntil: "networkidle",
      timeoutMs: 300,
    },
  }).pipe(Effect.provide(FetchServiceLive)),
);

console.log(preview.data.status);
console.log(preview.data.artifacts);
```

## Focused Validation

```bash
bun test tests/sdk/scraper.test.ts --test-name-pattern "renderPreview"
bun test tests/apps/api-app.test.ts --test-name-pattern "render preview"
bun test tests/apps/cli-app.test.ts --test-name-pattern "render preview"
```

Run full repository gates before promotion:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

## Troubleshooting

### The route or command is missing

The supported public surfaces are:

- `effect-scrapling render preview`
- `POST /render/preview`
- `renderPreview(...)`

Do not route render-preview traffic through `accessPreview`. That command keeps
its existing flat access summary contract.

### `data.mode` is not `browser`

That is a regression. Render preview is the browser-only public validation path.

### Artifact ordering changed

Treat that as a contract regression. Downstream tooling can depend on the tuple
order staying:

1. `navigation`
2. `renderedDom`
3. `timings`

### The browser path fails before rendering

Re-run browser bootstrap:

```bash
bun install --frozen-lockfile
bun run browser:install
bun run check:playwright
```

## Related Runbooks

- `docs/runbooks/e4-browser-access-lifecycle.md`
- `docs/runbooks/e4-browser-pool-controls.md`
