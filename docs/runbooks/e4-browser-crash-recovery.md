# E4 Browser Crash Recovery Runbook

## Purpose

Use this runbook when operators, runtime authors, or SDK consumers need to
validate, observe, or troubleshoot the current browser crash-recovery and
recycle flow in:

- `libs/foundation/core/src/browser-access-runtime.ts`
- `libs/foundation/core/src/browser-leak-detection.ts`
- `tests/libs/foundation-core-browser-crash-recovery.test.ts`
- `tests/libs/foundation-core-browser-access-runtime.test.ts`
- `tests/libs/foundation-core-browser-leak-detection.test.ts`
- `scripts/benchmarks/e4-browser-soak-load.ts`
- `tests/scripts/e4-browser-soak-load.test.ts`

This runbook is intentionally limited to behavior that exists today. It does
not assume:

- automatic replay of the crashed capture after recycle
- crash telemetry without a configured detector
- cross-provider browser failover
- persisted crash telemetry outside `detector.readCrashTelemetry`

Policy baseline:

- Effect v4 only
- no manual `_tag` inspection
- no manual `instanceof`
- no type-safety bypasses

## Current Recovery Contract

`BrowserAccessLive(...)` currently handles browser crash recovery like this:

- browser launch is still lazy and scoped
- the runtime keeps one active browser generation per scoped layer instance
- a `RenderCrashError` during browser capture closes the current browser
  generation and marks the process state idle
- the runtime immediately attempts to launch the next browser generation in the
  same scope
- the original `capture(plan)` call still fails with the original
  `RenderCrashError`
- if recycle succeeds, the next `capture(plan)` call in the same scope can
  proceed on the new generation
- if recycle fails, telemetry is still recorded and the runtime does not leak
  browser, context, or page resources
- typed crash telemetry is emitted only when `BrowserAccessLive` is created
  with `detector`

Current browser crash surfaces covered by tests:

- rendered DOM capture crash
- screenshot capture crash
- network summary capture crash

Current post-crash artifact set on a successful follow-up capture:

- `renderedDom`
- `screenshot`
- `networkSummary`
- `timings`

## Typed Telemetry Expectations

Crash telemetry is stored through `BrowserCrashTelemetrySchema` with these
fields:

- `planId`
- `browserGeneration`
- `recycledToGeneration`
- `recovered`
- `failure`
- `recordedAt`

The `failure` payload is the shared typed error envelope from
`CoreErrorEnvelopeSchema`. For the current crash-recovery path the tests expect:

- `failure.code === "render_crash"`
- `failure.retryable === true`
- `failure.message` preserves the browser failure message

Recovered recycle example from
`tests/libs/foundation-core-browser-crash-recovery.test.ts`:

```json
{
  "planId": "plan-browser-crash-recovery-001",
  "browserGeneration": 0,
  "recycledToGeneration": 1,
  "recovered": true,
  "failure": {
    "code": "render_crash",
    "retryable": true,
    "message": "Browser access failed to capture rendered DOM: page crashed in browser-1"
  }
}
```

Unrecovered recycle example from the same suite:

```json
{
  "planId": "plan-browser-crash-recovery-001",
  "browserGeneration": 0,
  "recycledToGeneration": null,
  "recovered": false,
  "failure": {
    "code": "render_crash",
    "retryable": true,
    "message": "Browser access failed to capture rendered DOM: page crashed in browser-1"
  }
}
```

Operational interpretation:

- `recovered: true` means the runtime launched the next browser generation
  successfully, but the crashed capture still failed
- `recovered: false` means the recycle launch failed and the current crashed
  capture did not recover
- `recycledToGeneration: null` is expected only when relaunch fails

## Command Usage

Run the focused crash-recovery verification suites:

```bash
bun test tests/libs/foundation-core-browser-crash-recovery.test.ts
bun test tests/libs/foundation-core-browser-leak-detection.test.ts \
  --test-name-pattern "stores crash telemetry entries with typed failure envelopes"
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "maps browser page crashes to RenderCrashError and allows later captures"
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "maps browser screenshot failures to RenderCrashError recycles the browser and releases resources"
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "maps browser network summary failures to RenderCrashError recycles the browser and releases resources"
bun test tests/scripts/e4-browser-soak-load.test.ts
```

Run the soak/load harness directly:

```bash
bun run benchmark:e4-browser-soak-load -- --rounds 8 --concurrency 6 --warmup 1
```

Write a benchmark artifact for later inspection:

```bash
bun run benchmark:e4-browser-soak-load -- \
  --rounds 8 \
  --concurrency 6 \
  --warmup 1 \
  --artifact tmp/e4-browser-crash-recovery.json
```

Run repository gates before bead closure or merge:

```bash
bun run ultracite:check
bun run oxlint:check
bun run format:check
bun run build
bun run check
```

## Practical Execution Flow

### 1. Confirm the recovered recycle path

```bash
bun test tests/libs/foundation-core-browser-crash-recovery.test.ts \
  --test-name-pattern "recycles crashed browser generations and stores typed crash telemetry"
```

What to inspect:

- the first capture fails with `RenderCrashError`
- the failure message contains `failed to capture rendered DOM`
- the second capture in the same scope succeeds and returns:
  - `renderedDom`
  - `screenshot`
  - `networkSummary`
  - `timings`
- crash telemetry contains one entry with:
  - `browserGeneration: 0`
  - `recycledToGeneration: 1`
  - `recovered: true`
- detector inspection ends with:
  - `openBrowsers: 0`
  - `openContexts: 0`
  - `openPages: 0`
- alarms stay empty

### 2. Confirm the unrecovered recycle path

```bash
bun test tests/libs/foundation-core-browser-crash-recovery.test.ts \
  --test-name-pattern "records unrecovered crash telemetry when browser recycle relaunch fails without leaks"
```

What to inspect:

- the capture still fails with `RenderCrashError`
- crash telemetry contains one entry with:
  - `browserGeneration: 0`
  - `recycledToGeneration: null`
  - `recovered: false`
- the detector inspection still ends with zero open browsers, contexts, and
  pages
- alarms stay empty
- the synthetic lifecycle state proves no extra leaked browser generation was
  left behind

### 3. Confirm steady-state after recovery

```bash
bun test tests/libs/foundation-core-browser-crash-recovery.test.ts \
  --test-name-pattern "reports zero dangling browser resources after a passing soak run"

bun run benchmark:e4-browser-soak-load -- --rounds 4 --concurrency 2 --warmup 0
```

What to inspect:

- the final detector snapshot is all zeros
- leak alarms stay empty
- crash telemetry stays empty on the happy path
- the benchmark artifact reports `status: "pass"`

### 4. Confirm crash mapping on the runtime entrypoint

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "maps browser page crashes to RenderCrashError and allows later captures"
```

What to inspect:

- the first browser-backed capture fails with `RenderCrashError`
- a later capture in the same scope succeeds after recycle
- page, context, and browser close counts remain balanced

Current companion coverage in the same suite also proves the screenshot and
network-summary crash paths recycle the browser and release resources.

## SDK Consumer Flow

Use crash telemetry only from the same scoped browser layer that performs
capture:

```ts
import { Effect } from "effect";
import { BrowserAccessLive } from "../../libs/foundation/core/src/browser-access-runtime.ts";
import { makeInMemoryBrowserLeakDetector } from "../../libs/foundation/core/src/browser-leak-detection.ts";
import { RunPlanSchema } from "../../libs/foundation/core/src/run-state.ts";
import { BrowserAccess } from "../../libs/foundation/core/src/service-topology.ts";

const detector = await Effect.runPromise(
  makeInMemoryBrowserLeakDetector({
    maxOpenBrowsers: 1,
    maxOpenContexts: 1,
    maxOpenPages: 1,
    consecutiveViolationThreshold: 2,
    sampleIntervalMs: 100,
  }),
);

const plan = RunPlanSchema.make({
  id: "plan-browser-crash-recovery-001",
  targetId: "target-product-001",
  packId: "pack-example-com",
  accessPolicyId: "policy-browser",
  concurrencyBudgetId: "budget-browser-001",
  entryUrl: "https://example.com/products/001",
  maxAttempts: 2,
  timeoutMs: 30_000,
  checkpointInterval: 2,
  steps: [
    {
      id: "step-capture-001",
      stage: "capture",
      requiresBrowser: true,
      artifactKind: "renderedDom",
    },
    {
      id: "step-extract-001",
      stage: "extract",
      requiresBrowser: false,
    },
  ],
  createdAt: "2026-03-06T10:00:00.000Z",
});

const { firstFailure, secondArtifacts } = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const access = yield* BrowserAccess;
      const firstFailure = yield* access.capture(plan).pipe(Effect.flip);
      const secondArtifacts = yield* access.capture(plan);

      return { firstFailure, secondArtifacts };
    }).pipe(Effect.provide(BrowserAccessLive({ detector }))),
  ),
);

const crashTelemetry = await Effect.runPromise(detector.readCrashTelemetry);
const snapshot = await Effect.runPromise(detector.inspect);
const alarms = await Effect.runPromise(detector.readAlarms);
```

What to inspect:

- `firstFailure.name === "RenderCrashError"`
- `secondArtifacts` contains `renderedDom`, `screenshot`, `networkSummary`,
  and `timings`
- `crashTelemetry.length === 1` after an injected crash
- `snapshot.openBrowsers === 0`, `snapshot.openContexts === 0`,
  `snapshot.openPages === 0` after scope exit
- `alarms.length === 0`

Consumer rule:

- do not treat a recovered recycle as a hidden success path for the original
  failed capture
- issue a new capture call after the crash if the surrounding workflow wants to
  continue in the same scope

## Troubleshooting

### Crash telemetry never appears

Check whether `BrowserAccessLive(...)` was provided with `detector`. The runtime
only calls `recordCrashTelemetry(...)` when a detector exists.

### The first crashed capture does not auto-retry

That is current behavior, not a bug in the runbook. Recovery today recycles the
browser generation for the next capture, then rethrows the original
`RenderCrashError`.

### `recycledToGeneration` stays `null`

That means the recycle launch failed. Use the unrecovered recycle test as the
reference behavior and inspect the provider launch path rather than mutating the
telemetry contract.

### Crash paths leave non-zero open resources

That is a cleanup regression. Fix the scoped browser/context/page release path
in `BrowserAccessLive(...)`. Do not patch over it with singleton cleanup code or
manual counter resets.

### The happy-path soak/load run records crash telemetry

That means an unexpected recycle happened during a run that should have been
stable. Inspect the crash-recovery suite before widening thresholds or muting
telemetry.

## Rollout

1. Run the targeted crash-recovery suites.
2. Run the soak/load harness with the intended concurrency.
3. Inspect:
   - final leak snapshot
   - leak alarms
   - crash telemetry
4. Run the repository gates.
5. Promote only when:
   - crash telemetry appears only in injected crash scenarios
   - recycle leaves zero dangling browser resources
   - the soak/load artifact remains `pass`

## Rollback

1. Revert the crash-recovery runtime change.
2. Re-run:

```bash
bun test tests/libs/foundation-core-browser-crash-recovery.test.ts
bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "maps browser page crashes to RenderCrashError and allows later captures"
bun run benchmark:e4-browser-soak-load -- --rounds 4 --concurrency 2 --warmup 0
bun run check
```

3. Do not "fix" regressions by:
   - disabling the detector
   - dropping typed crash telemetry
   - swallowing `RenderCrashError`
   - adding global browser singleton recovery
