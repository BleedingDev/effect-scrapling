# E3 Timeout And Cancellation Handling Runbook

## Purpose

Use this runbook when operators, runtime authors, or SDK consumers need to
validate, troubleshoot, or roll back timeout and cancellation behavior in:

- `libs/foundation/core/src/access-timeout-runtime.ts`
- `libs/foundation/core/src/access-retry-runtime.ts`
- `libs/foundation/core/src/http-access-runtime.ts`
- `libs/foundation/core/src/browser-access-runtime.ts`
- `src/sdk/scraper.ts`
- `src/sdk/schemas.ts`
- `src/standalone.ts`
- `src/api-request-payload.ts`
- `tests/libs/foundation-core-access-timeout.test.ts`
- `tests/libs/foundation-core-access-retry.test.ts`
- `tests/libs/foundation-core-e3-runtime.test.ts`
- `tests/libs/foundation-core-browser-access-runtime.test.ts`
- `tests/sdk/scraper.test.ts`
- `tests/apps/cli-app.test.ts`
- `tests/apps/api-app.test.ts`
- `tests/guardrails/e0-security-review.verify.test.ts`

This document is intentionally limited to behavior that exists today. It does
not assume:

- hidden timeout extension or clamping inside the runtime
- automatic browser capture replay inside the same scope after timeout
- public SDK exposure of foundation-core tagged errors
- cancellation recovery that ignores `AbortSignal`
- retry of terminal `PolicyViolation` failures

Policy baseline:

- Effect v4 only.
- Foundation-core timeout failures stay typed as `TimeoutError`.
- HTTP cancellation is cooperative and signal-based.
- Browser timeout uses a single per-plan deadline plus scoped cleanup.
- No manual `_tag`, `instanceof`, or type-safety bypass shortcuts.

## Current Runtime Contract

### Foundation-core timeout boundary

Current timeout exports:

- `AccessTimeoutPolicy`
- `withAccessTimeout(...)`
- `tryAbortableAccess(...)`

Current retry exports relevant to timeout/cancellation:

- `AccessRetryPolicy`
- `AccessRetryDecision`
- `AccessRetryReport`
- `executeWithAccessRetry(...)`
- `isRetryableAccessFailure(...)`

What the timeout runtime does now:

- `AccessTimeoutPolicy` decodes `timeoutMs` and `timeoutMessage` through shared
  schemas before any work starts.
- `withAccessTimeout(...)` turns an expired deadline into a typed
  `TimeoutError`.
- `tryAbortableAccess(...)` passes an `AbortSignal` into the async operation and
  also turns timeout expiry into a typed `TimeoutError`.
- `tryAbortableAccess(...)` aborts the running signal on both:
  - deadline expiry
  - fiber interruption
- invalid timeout policy input fails with `PolicyViolation` instead of guessing
  defaults.

Validated by:

- `tests/libs/foundation-core-access-timeout.test.ts`

### HTTP runtime timeout and cancellation boundary

Current HTTP caller:

- `captureHttpArtifacts(...)`

What the HTTP runtime does now:

- decodes the run plan through shared contracts before issuing a request
- rejects plans without a capture step
- rejects capture steps that require browser resources
- wraps the outbound `fetch(...)` call in `tryAbortableAccess(...)`
- wraps `response.text()` in `withAccessTimeout(...)`
- uses `plan.timeoutMs` for both the request phase and the body-read phase
- maps timeout failures to typed `TimeoutError`
- retries `TimeoutError` and `ProviderUnavailable`
- does not retry `PolicyViolation`
- emits a structured exhaustion report through `onRetryExhausted(...)` when a
  retryable failure runs out of budget

Important cancellation behavior:

- if the request times out, the runtime aborts the passed `AbortSignal`
- if the caller interrupts the running fiber, the request signal is aborted
- retry backoff delay timers are also cancellation-aware and clear themselves on
  interruption

Validated by:

- `tests/libs/foundation-core-access-timeout.test.ts`
- `tests/libs/foundation-core-access-retry.test.ts`
- `tests/libs/foundation-core-e3-runtime.test.ts`

### Browser runtime timeout and cancellation boundary

Current browser caller:

- `captureBrowserArtifacts(...)`
- `BrowserAccessLive(...)`

What the browser runtime does now:

- derives one deadline from `plan.timeoutMs` for the full browser capture
- spends that single deadline across:
  - `browser.newContext()`
  - `context.newPage()`
  - `page.goto(...)`
  - `page.content()`
  - `page.screenshot(...)`
  - performance-entry capture for the network summary
- converts a missed deadline into `TimeoutError`
- closes page, context, and browser resources through scoped finalization even
  when timeout happens
- requires a fresh `Effect.scoped(...)` layer as the validated recovery path
  after timeout

Current non-timeout browser cancellation behavior:

- SDK browser mode aborts policy-violating subrequests with
  `route.abort("blockedbyclient")`
- the current security test covers localhost/private-network blocking during
  browser navigation

Validated by:

- `tests/libs/foundation-core-browser-access-runtime.test.ts`
- `tests/guardrails/e0-security-review.verify.test.ts`

### Public SDK, CLI, and API boundary

Current public SDK request defaults from `src/sdk/schemas.ts`:

- `timeoutMs` default: `15_000`
- `mode` default: `http`
- browser `waitUntil` accepts:
  - `load`
  - `domcontentloaded`
  - `networkidle`
  - `commit`

Current timeout inputs:

- SDK:
  - top-level `timeoutMs` controls the HTTP path
  - browser `timeoutMs` overrides the browser navigation/load timeout
- CLI:
  - `--timeout-ms` / `--timeoutMs`
  - `--wait-ms` / `--waitMs`
  - `--browserTimeoutMs` / `--browser-timeout-ms`
- API payload aliases:
  - top-level `timeoutMs` / `timeout-ms`
  - nested browser `timeoutMs` / `timeout-ms`
  - browser timeout aliases promoted from `waitMs` / `wait-ms` /
    `browserTimeoutMs` / `browser-timeout-ms`

Observed public-boundary behavior today:

- CLI and API normalize timeout aliases before shared schema decoding
- SDK HTTP mode uses `AbortController` plus `setTimeout(...)` to cancel the
  in-flight fetch on timeout
- SDK browser mode passes the timeout through to Playwright `goto(...)` and
  `waitForLoadState(...)`

Inference from `src/sdk/scraper.ts`, not directly asserted by current tests:

- public SDK consumers see timeout failures as `NetworkError` or `BrowserError`
  with timeout details, not as exported foundation-core `TimeoutError`

Validated input-shape coverage:

- `tests/sdk/scraper.test.ts`
- `tests/apps/cli-app.test.ts`
- `tests/apps/api-app.test.ts`

## Command Usage

Run targeted timeout/cancellation verification from repository root:

```bash
bun test tests/libs/foundation-core-access-timeout.test.ts
bun test tests/libs/foundation-core-access-retry.test.ts
bun test tests/libs/foundation-core-e3-runtime.test.ts
bun test tests/libs/foundation-core-browser-access-runtime.test.ts
bun test tests/sdk/scraper.test.ts
bun test tests/apps/cli-app.test.ts
bun test tests/apps/api-app.test.ts
```

Run the current browser prerequisite checks before browser-backed validation:

```bash
bun install --frozen-lockfile
bun run browser:install
bun run check:playwright
```

Recommended full gate stack before bead closure or merge:

```bash
bun run ultracite:check
bun run oxlint:check
bun run format:check
bun run test
bun run build
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

Useful entrypoints:

- `examples/e3-capability-slice.ts`
- `examples/sdk-consumer.ts`
- `docs/runbooks/e1-access-policy.md`
- `docs/runbooks/e1-tagged-errors.md`
- `docs/runbooks/e3-retry-backoff-runbook.md`
- `docs/runbooks/e4-browser-access-lifecycle.md`

## Practical Execution Examples

### 1. Prove that timeout expiry aborts the underlying HTTP operation

Run the direct timeout runtime test:

```bash
bun test tests/libs/foundation-core-access-timeout.test.ts \
  --test-name-pattern "fails slow abortable operations with TimeoutError and aborts the signal"
```

What to inspect:

- the failure message is `Access operation timed out.`
- the test-local `aborted` flag becomes `true`
- no fallback success path is observed

This is the narrowest proof that timeout expiry is not only reported, but also
cancels the in-flight async operation through `AbortSignal`.

### 2. Prove that caller interruption also cancels the underlying HTTP operation

```bash
bun test tests/libs/foundation-core-access-timeout.test.ts \
  --test-name-pattern "aborts in-flight operations when the running fiber is interrupted"
```

What to inspect:

- the fiber is interrupted before the timeout deadline
- the test-local `aborted` flag still becomes `true`

Use this when you need to verify cooperative cancellation instead of
deadline-driven timeout.

### 3. Prove that the real HTTP capture runtime returns typed timeout failures

```bash
bun test tests/libs/foundation-core-access-timeout.test.ts \
  --test-name-pattern "threads typed timeout failures into the real HTTP capture runtime"
```

What to inspect:

- the failure message contains `HTTP access timed out`
- the fetch implementation receives an aborted `init.signal`
- the runtime does not silently convert the timeout into a generic provider
  error

### 4. Prove retry behavior around timeout and body-read cancellation surfaces

Retryable body-read recovery:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "retries transient body-read failures through a fresh HTTP capture attempt"
```

Non-retryable body-read failure:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "does not retry non-retryable body-read failures"
```

Retry exhaustion evidence:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "surfaces retry exhaustion evidence separately from the terminal failure"
```

What to inspect:

- retryable failures use a fresh capture attempt
- `PolicyViolation` body-read failures remain terminal
- exhausted retry budget emits a structured report instead of forcing operators
  to reconstruct the history from logs

### 5. Prove browser timeout behavior and the current recovery path

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "times out browser capture on a shared deadline and retries cleanly in a new scope"
```

What to inspect:

- the failure family is `TimeoutError`
- the timeout message contains `timed out`
- a follow-up capture succeeds only in a fresh scope
- final page, context, and browser close counts stay balanced

Do not claim same-scope timeout recycle from this runbook. The validated path
today is a new `Effect.scoped(...)` layer after timeout.

### 6. Prove browser request cancellation for blocked subrequests

```bash
bun test tests/guardrails/e0-security-review.verify.test.ts \
  --test-name-pattern "blocks browser-mode subrequests into localhost targets at runtime"
```

What to inspect:

- the browser continues the first allowed request
- the runtime aborts the localhost follow-up request
- the failure details contain `Blocked browser request`

This is cancellation by security policy, not by timeout budget.

### 7. Exercise the public CLI timeout inputs

HTTP path:

```bash
bun run cli -- access preview \
  --url "https://example.com/articles/effect-scrapling" \
  --timeout-ms 1500
```

Browser path:

```bash
bun run cli -- access preview \
  --url "https://example.com/articles/effect-scrapling" \
  --mode browser \
  --waitUntil commit \
  --browserTimeoutMs 450 \
  --browserUserAgent "CLI Browser"
```

What to inspect:

- CLI returns JSON, not free-form text
- top-level `--timeout-ms` lands on request `timeoutMs`
- browser wait/budget aliases land on nested `browser.timeoutMs`

Alias coverage is validated by:

- `tests/apps/cli-app.test.ts`

### 8. Exercise the public API timeout aliases

```bash
PORT=3000 bun run api

curl -s http://127.0.0.1:3000/access/preview \
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

Operational note:

- the API tests validate alias normalization through `handleApiRequest(...)`
- use `tests/apps/api-app.test.ts` as the executable source of truth for the
  JSON payload shape

### 9. Use the public SDK with explicit timeout budgets

```ts
import { Effect } from "effect";
import {
  FetchServiceLive,
  accessPreview,
  renderPreview,
} from "effect-scrapling/sdk";

const httpPreview = accessPreview({
  url: "https://example.com/catalog/sku-123",
  timeoutMs: 1_500,
}).pipe(Effect.provide(FetchServiceLive));

const browserPreview = renderPreview({
  url: "https://example.com/catalog/sku-123",
  timeoutMs: 15_000,
  browser: {
    waitUntil: "commit",
    timeoutMs: 450,
    userAgent: "SDK Browser",
  },
}).pipe(Effect.provide(FetchServiceLive));
```

What to inspect:

- SDK request defaults and allowed values come from `src/sdk/schemas.ts`
- HTTP mode uses the top-level timeout
- browser mode prefers `browser.timeoutMs` over the top-level timeout

The current public example entrypoint is:

- `bun run example:sdk-consumer`

That example does not force a timeout path; use the targeted tests above when
you need timeout or cancellation evidence.

## Troubleshooting

### Timeout policy decode fails before work starts

Symptom:

- failure message contains `Failed to decode access-timeout policy`

What it means:

- `timeoutMs` or `timeoutMessage` violated the shared schema contract

What to do:

- verify `timeoutMs` still satisfies the shared timeout bound
- verify `timeoutMessage` is non-empty
- fix the producer or caller payload instead of clamping or defaulting

Primary evidence:

- `tests/libs/foundation-core-access-timeout.test.ts`
- `docs/runbooks/e1-access-policy.md`

### HTTP timeout fires but the upstream operation does not stop

Symptom:

- caller observes a timeout error, but the underlying fetch implementation keeps
  running

What to check:

- the custom fetch implementation must respect `init.signal`
- your wrapper must not drop the `signal` passed by `captureHttpArtifacts(...)`
  or `src/sdk/scraper.ts`

Primary evidence:

- `tests/libs/foundation-core-access-timeout.test.ts`

### Retry behavior looks wrong after a timeout

Check the error family first:

- `TimeoutError`: retryable
- `ProviderUnavailable`: retryable
- `PolicyViolation`: terminal

Primary evidence:

- `tests/libs/foundation-core-access-retry.test.ts`
- `tests/libs/foundation-core-e3-runtime.test.ts`
- `docs/runbooks/e1-tagged-errors.md`
- `docs/runbooks/e3-retry-backoff-runbook.md`

### Browser captures keep timing out after rollout

What to check:

- `plan.timeoutMs` is one shared deadline for the full browser capture
- slow navigation plus DOM capture plus screenshot plus network-summary capture
  all spend from the same budget
- recovery is currently a fresh scoped layer, not same-scope replay

Primary evidence:

- `tests/libs/foundation-core-browser-access-runtime.test.ts`
- `docs/runbooks/e4-browser-access-lifecycle.md`

### CLI or API timeout flags appear to be ignored

What to check:

- top-level timeout is `timeoutMs` / `timeout-ms`
- browser timeout is nested at `browser.timeoutMs` / `browser.timeout-ms`
- CLI browser aliases are `--wait-ms`, `--waitMs`, `--browserTimeoutMs`, and
  `--browser-timeout-ms`

Primary evidence:

- `src/standalone.ts`
- `src/api-request-payload.ts`
- `tests/apps/cli-app.test.ts`
- `tests/apps/api-app.test.ts`

### SDK consumer expects foundation-core tagged timeout errors

Current state:

- foundation-core emits typed `TimeoutError`
- the public SDK boundary currently maps failures into `NetworkError` or
  `BrowserError`

This is an inference from `src/sdk/scraper.ts`, not a dedicated public-contract
test. If a consumer requires typed foundation-core failures, keep the
integration on the foundation-core services instead of the higher-level SDK.

## Rollout Guidance

1. Prepare
- confirm the timeout budget source you are changing:
  - `accessPolicy.timeoutMs`
  - foundation-core timeout policy input
  - SDK `timeoutMs`
  - nested browser `timeoutMs`
- install Playwright with `bun run browser:install` before browser validation
- keep timeout values inside the shared schema bounds

2. Apply
- wire cancellable HTTP work through `tryAbortableAccess(...)`
- keep body reads wrapped by `withAccessTimeout(...)`
- keep retryability decisions on the shared tagged error families
- preserve CLI/API alias normalization instead of adding parallel parsing rules

3. Verify
- run the targeted timeout/cancellation tests in this runbook
- run browser validation if the change touches browser-backed access
- run the full gate stack before merge

4. Promote
- merge only when timeout failure shape, cancellation behavior, and retry
  evidence are all green

## Rollback Guidance

1. Revert the timeout-budget or caller change that introduced the regression.
2. Re-run:

```bash
bun test tests/libs/foundation-core-access-timeout.test.ts
bun test tests/libs/foundation-core-access-retry.test.ts
bun test tests/libs/foundation-core-e3-runtime.test.ts
bun test tests/libs/foundation-core-browser-access-runtime.test.ts
bun test tests/sdk/scraper.test.ts
bun test tests/apps/cli-app.test.ts
bun test tests/apps/api-app.test.ts
bun run check
```

3. Restore the last known-good timeout source:
- prior `accessPolicy.timeoutMs`
- prior SDK `timeoutMs`
- prior nested browser timeout value

4. Do not patch around the regression by:
- swallowing `AbortSignal`
- broadening retry to `PolicyViolation`
- reusing a timed-out browser scope as if recovery were validated
- replacing typed timeout causes with generic string errors

5. Re-attempt rollout only after the targeted timeout/cancellation proofs and
   full gates are green again.

## Operator Notes

- `TimeoutError` maps to the machine-readable `timeout` code and is retryable in
  foundation-core.
- HTTP timeout and cancellation are cooperative; upstream fetch implementations
  must honor `AbortSignal`.
- Browser timeout budget is cumulative across the whole capture path, not per
  individual browser call.
- Public SDK timeout defaults are transport-friendly, but the typed
  foundation-core timeout cause remains the lower-level contract.
