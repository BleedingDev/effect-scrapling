# E4 Browser Pool Controls Runbook

## Purpose

Use this runbook when operators, runtime authors, or SDK consumers need to
validate, observe, or roll out the current bounded browser context/page pool
controls in:

- `src/sdk/browser-pool.ts`
- `src/sdk/scraper.ts`
- `tests/sdk/browser-pool.test.ts`
- `tests/apps/cli-app.test.ts`
- `tests/apps/api-app.test.ts`

This runbook is intentionally limited to behavior that exists today. It does
not assume:

- public environment-variable, CLI, or API knobs for `maxContexts`,
  `maxPages`, or `maxQueue`
- separate context-only and page-only slot accounting
- external metrics export beyond response warnings and the in-repo snapshot
  helper
- dynamic pool resizing, per-domain pools, or queue-priority rules

Policy baseline:

- Effect v4 only
- no manual `_tag` inspection
- no manual `instanceof`
- no type-safety bypasses
- no use of `setBrowserPoolTestConfig(...)` outside tests

## Current Contract

Current bounded-pool behavior:

- the SDK keeps one shared browser runtime per process-local pool instance
- default limits are fixed in code:
  - `maxContexts = 2`
  - `maxPages = 2`
  - `maxQueue = 8`
- one granted slot always reserves one browser context and one page together
- `activeContexts` and `activePages` therefore move in lockstep today
- immediate acquisition is allowed only when:
  - no other waiter is already queued
  - `activeContexts < maxContexts`
  - `activePages < maxPages`
- queued waiters are granted in FIFO order
- a queued request that eventually succeeds emits one response warning with:
  - waited milliseconds
  - queue position at admission time
  - the active pool limits
- a request that cannot enter the queue fails immediately with a typed
  `BrowserError`
- the queue-overflow failure detail currently contains:
  - `Queue limit <n> was reached while waiting for a browser context/page slot`

Diagnostics exposed today:

- public CLI, API, and SDK browser calls expose backpressure only through
  response `warnings` or a `BrowserError`
- the in-repo helper `getBrowserPoolSnapshot()` exposes:
  - `activeContexts`
  - `activePages`
  - `queuedRequests`
  - `maxObservedActiveContexts`
  - `maxObservedActivePages`
  - `maxObservedQueuedRequests`

## Public Command Surface

CLI browser-mode aliases:

- `--mode browser`
- `--wait-until <load|domcontentloaded|networkidle|commit>`
- `--wait-ms <ms>`
- `--browser-user-agent "<ua>"`

API browser-mode payload shape:

```json
{
  "url": "https://example.com/articles/effect-scrapling",
  "mode": "browser",
  "browser": {
    "wait-until": "commit",
    "timeout-ms": "450",
    "user-agent": "Nested Browser"
  }
}
```

Current public SDK shape:

```ts
import { Effect } from "effect";
import { accessPreview, FetchServiceLive } from "effect-scrapling/sdk";

const preview = await Effect.runPromise(
  accessPreview({
    url: "https://example.com/articles/effect-scrapling",
    mode: "browser",
    browser: {
      waitUntil: "commit",
      timeoutMs: 450,
      userAgent: "Browser Pool Smoke",
    },
  }).pipe(Effect.provide(FetchServiceLive)),
);

console.log(preview.warnings);
```

Important current limitation:

- pool sizing is not a public consumer setting yet
- if limits need to change, treat that as a code rollout, not a live
  configuration tweak

## Practical Execution Examples

### Browser Preflight

Run this once on the machine that will execute browser-mode checks:

```bash
bun install --frozen-lockfile
bun run browser:install
bun run check:playwright
```

### CLI Smoke

Run one browser-backed preview through the public CLI boundary:

```bash
bun run standalone -- access preview \
  --url "https://example.com/articles/effect-scrapling" \
  --mode browser \
  --wait-until commit \
  --wait-ms 450 \
  --browser-user-agent "Browser Pool Smoke"
```

What to inspect:

- `ok` is `true`
- `command` is `access preview`
- `warnings` is:
  - `[]` when the request did not wait for a slot
  - a single backpressure warning when the pool was saturated but the request
    still drained successfully

### API Smoke

Start the API in one shell:

```bash
PORT=3000 bun run api
```

Then send a browser-backed preview request from another shell:

```bash
curl -sS -X POST http://127.0.0.1:3000/access/preview \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://example.com/articles/effect-scrapling",
    "mode": "browser",
    "browser": {
      "wait-until": "commit",
      "timeout-ms": "450",
      "user-agent": "Nested Browser"
    }
  }'
```

What to inspect:

- HTTP status is `200`
- the JSON response `warnings` array follows the same interpretation as the CLI
- any queue-overflow path returns HTTP `502` with `code: "BrowserError"`

### Deterministic Backpressure Proof

Use the focused suite when you need deterministic evidence instead of relying on
real target latency:

```bash
bun test tests/sdk/browser-pool.test.ts \
  --test-name-pattern "bounds browser concurrency and exposes queue backpressure warnings"
```

What this test proves:

- the pool enforces bounded concurrency under load
- queued work updates `queuedRequests`
- the second successful request returns one
  `Browser pool backpressure: waited ...` warning
- an overflow request fails with queue-limit details instead of waiting forever

Boundary normalization checks for the public interfaces:

```bash
bun test tests/apps/cli-app.test.ts \
  --test-name-pattern "normalizes browser-mode aliases through the CLI boundary"

bun test tests/apps/api-app.test.ts \
  --test-name-pattern "normalizes nested browser aliases through the public access-preview route"
```

## Queue And Backpressure Interpretation

Use these signals in order:

| Signal | Meaning today | Operational interpretation |
| --- | --- | --- |
| `warnings: []` | the request never waited for a pool slot | the pool had spare capacity for that call |
| `Browser pool backpressure: waited <ms>ms at queue position <n> ...` | the request entered the queue and later succeeded | soft saturation; the system drained, but upstream fan-out is pushing against the fixed limits |
| `queuedRequests` | the number of currently parked waiters | this excludes active slots; it is the live queue depth, not total in-flight work |
| `maxObservedQueuedRequests` | the peak queue depth since pool init or test reset | if this stays non-zero during routine traffic, the pool has already hit backpressure in this process |
| `Queue limit <n> was reached while waiting for a browser context/page slot` | the request could not enter the queue at all | hard saturation; admission control is rejecting work and upstream concurrency must be reduced or the rollout must be reverted |

Important details:

- `queue position` in the warning is the position at queue admission time
- `activeContexts` and `activePages` should rise and fall together under the
  current design
- a warning is emitted only on a successful request that waited more than
  `0ms`

## Troubleshooting

### Browser mode fails before pool semantics show up

If the error mentions Playwright or Chromium availability, fix the browser
runtime first:

```bash
bun run browser:install
bun run check:playwright
```

Do not treat missing Chromium as a pool-control regression.

### You see repeated backpressure warnings but no queue-limit failures

That means the pool is saturated but still draining. Current actions:

- reduce upstream parallelism if the warnings are unexpected
- keep the rollout paused if sustained waiting degrades latency
- raise a follow-up code change if the fixed limits are genuinely too small

Do not patch this by calling `setBrowserPoolTestConfig(...)` in runtime code.

### You hit immediate `Queue limit 8` failures

That is hard admission failure under the current defaults. Treat it as a real
capacity miss:

- stop increasing traffic
- reduce upstream browser fan-out
- run the focused pool and soak/load checks before continuing
- roll back if the new limits or accounting behavior caused the regression

### Snapshot counters do not return to zero after the traffic drains

That is a cleanup or release-path regression. Re-run:

```bash
bun test tests/sdk/browser-pool.test.ts
bun run check:e4-browser-soak-load
```

Do not close the operational task until `activeContexts`, `activePages`, and
`queuedRequests` return to zero at the end of the proof.

### `activeContexts` or `activePages` exceed the configured limits

That is an accounting bug, not an operator-tuning problem. Stop rollout and
inspect `src/sdk/browser-pool.ts` before continuing.

## Rollout

Because there is no live pool-sizing knob today, rollout means promoting the
code that contains the bounded-pool behavior.

1. Prepare the browser runtime.

```bash
bun install --frozen-lockfile
bun run browser:install
bun run check:playwright
```

2. Run the focused pool checks.

```bash
bun test tests/sdk/browser-pool.test.ts
bun test tests/apps/cli-app.test.ts \
  --test-name-pattern "normalizes browser-mode aliases through the CLI boundary"
bun test tests/apps/api-app.test.ts \
  --test-name-pattern "normalizes nested browser aliases through the public access-preview route"
bun run check:e4-browser-soak-load
```

3. Run repository gates before promotion.

```bash
bun run ultracite:check
bun run oxlint:check
bun run format:check
bun run build
bun run check
```

4. Run one CLI or API smoke request in the target environment and inspect:

- whether successful responses carry unexpected backpressure warnings
- whether any request returns a queue-limit `BrowserError`
- whether the observed behavior matches the intended traffic envelope

5. Promote only when the pool checks, soak/load check, and repository gates are
   green.

## Rollback

Rollback is a code rollback, not a live knob change.

1. Revert or redeploy the previous browser-pool implementation.
2. Re-run:

```bash
bun test tests/sdk/browser-pool.test.ts
bun run check:e4-browser-soak-load
bun run standalone -- access preview \
  --url "https://example.com/articles/effect-scrapling" \
  --mode browser
```

3. Confirm:

- successful browser requests no longer show the unexpected saturation behavior
- queue-limit failures are gone for the intended traffic shape
- the bounded soak/load suite is back to green

4. Do not patch rollback verification by:

- weakening the tests
- mutating runtime state manually
- reusing `setBrowserPoolTestConfig(...)` outside tests

## Related Runbooks

- `docs/runbooks/e4-browser-soak-load.md`
- `docs/runbooks/e4-browser-leak-detection.md`
- `docs/runbooks/e4-browser-crash-recovery.md`
- `docs/runbooks/e4-browser-capture-bundle.md`
