# effect-scrapling

EffectTS + Bun reimplementation of Scrapling with:

- `effect-scrapling` CLI
- `effect-scrapling-api` HTTP API
- reusable SDK functions in `src/sdk`

## CLI

```bash
./effect-scrapling doctor

./effect-scrapling access preview \
  --url "https://example.com"

./effect-scrapling extract run \
  --url "https://example.com" \
  --selector "h1"

./effect-scrapling extract run \
  --url "https://example.com" \
  --selector "a" \
  --attr "href" \
  --all \
  --limit 10
```

Shortcut command:

```bash
./effect-scrapling scrape \
  --url "https://example.com" \
  --selector ".product-title"
```

## API

```bash
PORT=3000 ./effect-scrapling-api
```

Endpoints:

- `GET /health`
- `GET /doctor`
- `POST /access/preview`
- `POST /extract/run`

Example:

```bash
curl -sS http://127.0.0.1:3000/health

curl -sS -X POST http://127.0.0.1:3000/access/preview \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'

curl -sS -X POST http://127.0.0.1:3000/extract/run \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","selector":"h1"}'
```

## SDK (library mode)

Use SDK effects directly from TypeScript:

```ts
import { Effect } from "effect";
import { extractRun } from "./src/sdk/scraper";

const result = await Effect.runPromise(
  extractRun({
    url: "https://example.com",
    selector: "h1",
  })
);

console.log(result.data.values);
```
