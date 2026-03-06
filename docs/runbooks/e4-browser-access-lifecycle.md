# E4 BrowserAccess Lifecycle Runbook

## Purpose

Use this runbook when runtime authors or operators need to validate the
`BrowserAccess` lifecycle service in:

- `libs/foundation/core/src/browser-access-runtime.ts`
- `tests/libs/foundation-core-browser-access-runtime.test.ts`

This runbook is intentionally limited to behavior that exists today.

Policy baseline:

- Effect v4 only.
- No manual `_tag` inspection.
- No manual `instanceof`.
- No hidden singleton browser state outside the provided layer scope.

## Lifecycle Contract

Current `BrowserAccessLive` behavior:

- browser launch is lazy; resolving the service alone does not start Chromium
- one browser runtime is shared per `Effect.scoped` layer instance
- concurrent captures within the same scope wait on the same in-flight launch
- failed startup resets the runtime state so the next capture can retry
- scope finalization shuts the runtime down exactly once
- plans without a browser-backed capture step fail before launch

Current browser capture failure families:

- `PolicyViolation`
- `ProviderUnavailable`
- `RenderCrashError`
- `TimeoutError`

## Command Usage

Run targeted verification from the repository root:

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts
bunx --bun tsc --noEmit -p libs/foundation/core/tsconfig.json
```

Run full repository gates before bead closure or merge:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

## Practical Checks

### Confirm lazy startup

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "does not launch or shutdown a browser runtime when the service stays unused"
```

What to inspect:

- browser launch count stays `0`
- capture count stays `0`
- shutdown count stays `0`

### Confirm non-browser plans fail before launch

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "rejects non-browser capture plans without launching a browser runtime"
```

What to inspect:

- failure message contains `does not require browser resources`
- browser launch count stays `0`

### Confirm capture-first validation

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "rejects plans that do not start with a capture step before launching a browser runtime"
```

What to inspect:

- failure family is `PolicyViolation`
- failure message contains `must start with a capture step`
- browser launch count stays `0`

### Confirm scoped sharing under concurrency

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "launches once per scope under concurrent capture and shuts down exactly once"
```

What to inspect:

- launch count is `1`
- concurrent captures both succeed
- shutdown count is `1`

### Confirm startup retry behavior

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "does not orphan a failed startup and retries launch on the next capture"
```

What to inspect:

- first capture fails with `browser launch failed`
- second capture retries launch and succeeds
- shutdown count remains bounded

### Confirm timeout and crash surfaces

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "times out browser capture on a shared deadline and retries cleanly in a new scope"

bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "maps browser page crashes to RenderCrashError"

bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "maps browser network summary failures to RenderCrashError and releases browser resources"
```

What to inspect:

- timeout path fails with `TimeoutError`
- a new scope can capture successfully after the timeout path
- crash path fails with `RenderCrashError`
- network-summary capture failure also fails with `RenderCrashError`
- subsequent capture can still recover if the runtime is retried in a new scope

## Troubleshooting

### Browser launch happens before capture

That is a lifecycle regression. `BrowserAccessLive` must stay lazy and scoped.
Do not work around it with module-level caching.

### Concurrent captures start more than one browser

That is a launch coordination bug. Fix the scoped state machine instead of
adding sleeps, global mutexes, or ad hoc retry loops.

### Browser contexts or pages survive scope exit

That is a cleanup regression. Finalization must release page, context, and
browser resources in the same scoped path that acquired them.

### Timeout or crash paths are untested

Do not close the verification bead. Add deterministic tests that inject the
failure branch directly instead of relying on flaky real-browser timing.

## Rollout Guidance

1. Prepare
- keep lifecycle state scoped to `BrowserAccessLive`
- keep browser failures typed
- keep browser plans validated before launch

2. Validate
- run the targeted lifecycle tests
- run touched-project typecheck
- run full repository gates

3. Promote
- close the bead only when lifecycle tests, typecheck, and full gates are green

## Rollback Guidance

1. Revert the lifecycle change.
2. Re-run:

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts
bun run check
```

3. Do not patch regressions with global browser instances or untyped error
   coercion.
