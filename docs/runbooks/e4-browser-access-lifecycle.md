# E4 BrowserAccess Lifecycle Runbook

## Purpose

Use this runbook when operators, runtime authors, or SDK consumers need to
validate the current `BrowserAccess` startup, sharing, cleanup, retry, and
rollback behavior in:

- `libs/foundation/core/src/browser-access-runtime.ts`
- `tests/libs/foundation-core-browser-access-runtime.test.ts`
- `tests/libs/foundation-core-browser-crash-recovery.test.ts`
- `tests/libs/foundation-core-browser-leak-detection.test.ts`

This runbook is intentionally limited to behavior that exists today. It does
not assume:

- eager browser startup when the layer is constructed
- global or process-wide browser singletons
- automatic replay of a failed capture after crash recycle
- crash telemetry without a configured detector
- cross-provider browser failover

Policy baseline:

- Effect v4 only
- no manual `_tag` inspection
- no manual `instanceof`
- no hidden singleton browser state outside the provided layer scope
- no type-safety bypasses

## Current Lifecycle Contract

`BrowserAccessLive(...)` currently has two lifecycle boundaries that operators
need to keep distinct.

### Scoped service boundary

The outer service layer owns a scoped runtime handle with this contract:

- resolving `BrowserAccess` alone does not launch a browser runtime
- `capture(plan)` validates the plan before any launch attempt
- only plans whose first step is `stage: "capture"` with
  `requiresBrowser: true` can reach launch
- one runtime handle is shared per `Effect.scoped(...)` layer instance
- concurrent valid captures in the same scope wait on the same in-flight
  runtime launch
- a failed runtime startup resets the scoped state back to idle so the next
  capture can retry
- scope finalization runs runtime shutdown at most once
- an unused scope does not emit launch, capture, or shutdown activity

### Default Playwright runtime boundary

When `BrowserAccessLive(...)` uses the default Playwright launcher instead of an
injected `launch` effect:

- Playwright is imported lazily on the first real browser launch path
- one browser process generation stays open per healthy scope
- each capture allocates a fresh browser context and page
- each capture closes its page and context before returning or failing
- the browser process stays open after a successful capture and closes on scope
  finalization
- `RenderCrashError` closes the current browser generation immediately, marks
  the process state idle, and attempts to launch the next generation in the
  same scope
- the original crashed `capture(plan)` still fails even if recycle succeeds
- if recycle succeeds, the next `capture(plan)` in the same scope can run on
  the new generation
- if recycle fails, the runtime still closes the crashed generation and does
  not leak page, context, or browser resources

## Current Failure Surfaces

Current typed lifecycle-related failures covered by the implementation and tests:

- `PolicyViolation`
  - plan does not start with a capture step
  - capture step does not require browser resources
- `ProviderUnavailable`
  - Playwright import fails
  - browser launch fails
  - runtime is used after scoped closure
- `RenderCrashError`
  - context allocation fails
  - page allocation fails
  - navigation fails
  - rendered DOM capture fails
  - screenshot capture fails
  - network-summary capture fails
- `TimeoutError`
  - the shared per-plan deadline expires during any timed browser step

Important current timeout behavior:

- one deadline is derived from `plan.timeoutMs` for the full browser capture
- context creation, page creation, navigation, DOM capture, screenshot capture,
  and network-summary capture all spend against that same deadline
- the validated recovery path today is a fresh scoped layer after timeout
- the current tests do not claim in-scope timeout recycle semantics

## Browser Preflight

Run from repository root before browser-backed lifecycle validation:

```bash
bun install --frozen-lockfile
bun run browser:install
bun run check:playwright
```

Operational interpretation:

- `browser:install` installs the Chromium browser used by Playwright
- `check:playwright` verifies the Playwright CLI/package is available locally
- if the default launcher is never exercised because an injected engine or
  `launch` effect is used, Playwright is not imported

## Command Usage

Focused lifecycle verification:

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts
bun test tests/libs/foundation-core-browser-crash-recovery.test.ts
bun test tests/libs/foundation-core-browser-leak-detection.test.ts
```

Bead-specific soak/load verification:

```bash
bun run check:e4-browser-soak-load
```

Recommended full-repository gate stack before merge:

```bash
bun run lint
bun run test
bun run build
bun run check
```

Actual merge-blocking CI parity replay before pushing:

```bash
TARGET_BRANCH="${TARGET_BRANCH:-origin/master}"
NX_BASE="${NX_BASE:-$(git rev-parse "$TARGET_BRANCH")}"
NX_HEAD="${NX_HEAD:-$(git rev-parse HEAD)}"

bun run ultracite
bun run oxlint
bun run oxfmt
bun run nx affected -t lint --base="$NX_BASE" --head="$NX_HEAD" --parallel=1
bun run nx affected -t test --base="$NX_BASE" --head="$NX_HEAD" --parallel=1
bun run nx affected -t typecheck --base="$NX_BASE" --head="$NX_HEAD" --parallel=1
bun run nx affected -t build --base="$NX_BASE" --head="$NX_HEAD" --parallel=1
```

Use `README.md#CI Affected Gates` as the source of truth if the command list
changes.

## Practical Execution Flow

### 1. Confirm lazy scoped startup

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "does not launch or shutdown a browser runtime when the service stays unused"
```

What to inspect:

- launch count stays `0`
- capture count stays `0`
- shutdown count stays `0`

### 2. Confirm plan validation blocks launch

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "rejects non-browser capture plans without launching a browser runtime"

bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "rejects plans that do not start with a capture step before launching a browser runtime"
```

What to inspect:

- non-browser capture failure message contains
  `does not require browser resources`
- invalid first-step failure family is `PolicyViolation`
- invalid first-step failure message contains `must start with a capture step`
- launch count stays `0` on both paths

### 3. Confirm scoped sharing and browser lifetime

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "launches once per scope under concurrent capture and shuts down exactly once"

bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "keeps the launched browser open until scope finalization"
```

What to inspect:

- concurrent captures trigger exactly one runtime launch
- both captures succeed from the same scoped runtime
- page and context cleanup happens per capture
- browser cleanup does not happen until the surrounding scope exits
- final browser shutdown count is `1`

### 4. Confirm failed startup retries cleanly

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "does not orphan a failed startup and retries launch on the next capture"
```

What to inspect:

- the first valid capture fails with `browser launch failed`
- no capture work runs on the failed launch attempt
- the second valid capture retries launch and succeeds
- shutdown count stays bounded at `1`

### 5. Confirm the default Playwright runtime closes per-capture resources

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "captures rendered DOM screenshot network summary and timings through the default launcher path"
```

What to inspect:

- returned artifact kinds are exactly:
  - `renderedDom`
  - `screenshot`
  - `networkSummary`
  - `timings`
- page close count is `1`
- context close count is `1`
- browser close count is `1` after scope finalization

Use `docs/runbooks/e4-browser-capture-bundle.md` for the full artifact contract.

### 6. Confirm timeout behavior

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "times out browser capture on a shared deadline and retries cleanly in a new scope"
```

What to inspect:

- the failure family is `TimeoutError`
- the timeout message contains `timed out`
- the follow-up capture in a fresh scope succeeds
- final page, context, and browser close counts all stay balanced

### 7. Confirm crash recycle semantics

```bash
bun test tests/libs/foundation-core-browser-crash-recovery.test.ts \
  --test-name-pattern "recycles crashed browser generations and stores typed crash telemetry"

bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "maps browser page crashes to RenderCrashError and allows later captures"

bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "maps browser screenshot failures to RenderCrashError recycles the browser and releases resources"

bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "maps browser network summary failures to RenderCrashError recycles the browser and releases resources"
```

What to inspect:

- the original crashing capture fails with `RenderCrashError`
- the failure message preserves the failing browser step
- crash recycle closes the old browser generation immediately
- a later capture in the same scope can succeed on the recycled generation
- typed crash telemetry exists only when a detector was configured

Use `docs/runbooks/e4-browser-crash-recovery.md` for the full telemetry
contract.

### 8. Confirm no dangling resources under load

```bash
bun test tests/libs/foundation-core-browser-leak-detection.test.ts
bun run check:e4-browser-soak-load
```

What to inspect:

- final detector snapshot reports `openBrowsers = 0`
- final detector snapshot reports `openContexts = 0`
- final detector snapshot reports `openPages = 0`
- leak alarms stay empty on the passing path

Use `docs/runbooks/e4-browser-leak-detection.md` for detector-specific
interpretation.

## Troubleshooting

### Browser launch happens before any valid capture call

That is a lifecycle regression. The layer must stay lazy. Fix the scoped
state-machine or an accidental eager call site. Do not patch it with module
singletons, daemon browsers, or process-global caches.

### Non-browser plans start Playwright anyway

That means plan validation moved after launch. Restore `ensureBrowserCapturePlan`
ahead of runtime acquisition. The current contract rejects invalid plans before
browser startup.

### Concurrent captures launch more than one browser in a healthy scope

That is a coordination bug in the scoped runtime or the default browser-process
state machine. Fix the `idle -> launching -> ready` transition logic instead of
adding sleeps, mutexes outside the layer, or ad hoc retries.

### Browser closes after every successful capture

That is not current default behavior. On the happy path, page and context close
per capture, but the browser remains open until scope finalization. If the
browser closes between healthy captures, inspect recent changes around browser
generation reset or scope finalizers.

### Page or context counts stay open after success or failure

That is a cleanup regression in `Effect.acquireUseRelease(...)`. Fix the same
scoped release path that acquired the page/context resources. Do not add
out-of-band cleanup hooks.

### Crashed captures start succeeding automatically

That would be a behavior change. The current runtime may recycle the browser
generation immediately, but the crashing `capture(plan)` still fails with the
original `RenderCrashError`. If you need a retry, it must happen in a later
capture call.

### Crash telemetry is missing

Check whether `BrowserAccessLive(...)` was created with `detector`. The current
runtime only emits crash telemetry when a detector is configured.

### `ProviderUnavailable` mentions Playwright or Chromium

Expected recovery path:

```bash
bun run browser:install
bun run check:playwright
```

If that still fails, inspect local Playwright installation and recent changes to
the default launcher. Do not replace the failure with an untyped catch-all.

### Timeout and crash behavior are getting conflated

Keep the distinction explicit:

- `TimeoutError` comes from the shared deadline budget expiring
- `RenderCrashError` comes from a browser operation failing or the browser
  target disappearing
- only `RenderCrashError` triggers the validated in-scope recycle path today

## Rollout Guidance

### 1. Prepare

- keep lifecycle state inside `BrowserAccessLive(...)`
- keep plan validation ahead of launch
- keep browser, context, and page ownership scoped
- keep typed error families intact

### 2. Validate

- run the focused lifecycle, crash-recovery, and leak-detection tests
- run `bun run check:e4-browser-soak-load`
- run `bun run ultracite:check`
- run `bun run oxlint:check`
- run `bun run format:check`
- run `bun run test`
- run `bun run build`
- run `bun run check`

### 3. Promote

- update any operator-facing links that point at this lifecycle contract
- close the bead only when lifecycle evidence, bead-specific checks, and full
  gates are green

## Rollback Guidance

Rollback means restoring the previously validated lifecycle contract, not
papering over regressions.

### 1. Revert the lifecycle change that altered one or more of these invariants

- lazy launch on first valid capture only
- one scoped runtime handle per layer instance
- one healthy browser generation per scope in the default Playwright runtime
- per-capture page/context cleanup
- original crash call still fails even if recycle succeeds
- typed `PolicyViolation`, `ProviderUnavailable`, `RenderCrashError`, and
  `TimeoutError` surfaces

### 2. Re-run the lifecycle evidence set

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts
bun test tests/libs/foundation-core-browser-crash-recovery.test.ts
bun test tests/libs/foundation-core-browser-leak-detection.test.ts
bun run check:e4-browser-soak-load
bun run check
```

### 3. Restore the local browser toolchain if bootstrap drift triggered rollback

```bash
bun install --frozen-lockfile
bun run browser:install
bun run check:playwright
```

### 4. Do not patch lifecycle regressions with

- global browser instances
- detached cleanup effects
- untyped error coercion
- test-only sleeps or retry loops masquerading as fixes

## Related Runbooks

- `docs/runbooks/e4-browser-capture-bundle.md`
- `docs/runbooks/e4-browser-artifact-redaction.md`
- `docs/runbooks/e4-browser-crash-recovery.md`
- `docs/runbooks/e4-browser-leak-detection.md`
- `docs/runbooks/e4-browser-pool-controls.md`
