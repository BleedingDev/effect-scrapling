# E4 Browser Leak Detection Runbook

## Purpose

Use this runbook when runtime authors, operators, or SDK consumers need to:

- validate browser lifecycle leak instrumentation
- run the bounded soak/load suite
- inspect leak alarms and crash telemetry after browser execution

Relevant implementation:

- `libs/foundation/core/src/browser-leak-detection.ts`
- `libs/foundation/core/src/browser-access-runtime.ts`
- `tests/libs/foundation-core-browser-leak-detection.test.ts`
- `tests/libs/foundation-core-browser-crash-recovery.test.ts`
- `scripts/benchmarks/e4-browser-soak-load.ts`

Policy baseline:

- Effect v4 only
- no manual `_tag` inspection
- no manual `instanceof`
- no type-safety bypasses

## What The Detector Tracks

`makeInMemoryBrowserLeakDetector(...)` records:

- open browser count
- open context count
- open page count
- consecutive violation streaks
- leak alarms when the configured threshold is reached
- typed crash telemetry for browser recycle paths

`BrowserAccessLive(...)` wires the detector into browser, context, and page
open/close events, plus crash-recovery telemetry.

## Practical Commands

Run the focused verification suite:

```bash
bun test tests/libs/foundation-core-browser-leak-detection.test.ts
bun test tests/libs/foundation-core-browser-crash-recovery.test.ts
```

Run the soak/load harness directly:

```bash
bun run benchmark:e4-browser-soak-load -- --rounds 8 --concurrency 6 --warmup 1
```

Write a JSON artifact for later inspection:

```bash
bun run benchmark:e4-browser-soak-load -- \
  --rounds 8 \
  --concurrency 6 \
  --warmup 1 \
  --artifact tmp/e4-browser-soak-load.json
```

Run the repository gates before bead closure:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

## SDK Consumer Example

Use the detector inside the same scoped browser layer that performs capture:

```ts
import { Effect } from "effect";
import { BrowserAccessLive } from "../../libs/foundation/core/src/browser-access-runtime.ts";
import { makeInMemoryBrowserLeakDetector } from "../../libs/foundation/core/src/browser-leak-detection.ts";
import { RunPlanSchema } from "../../libs/foundation/core/src/run-state.ts";
import { BrowserAccess } from "../../libs/foundation/core/src/service-topology.ts";

const detector = await Effect.runPromise(
  makeInMemoryBrowserLeakDetector({
    maxOpenBrowsers: 1,
    maxOpenContexts: 4,
    maxOpenPages: 4,
    consecutiveViolationThreshold: 1,
    sampleIntervalMs: 100,
  }),
);

const plan = RunPlanSchema.make({
  id: "plan-browser-001",
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
  createdAt: "2026-03-07T00:00:00.000Z",
});

const artifacts = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const access = yield* BrowserAccess;
      return yield* access.capture(plan);
    }).pipe(Effect.provide(BrowserAccessLive({ detector }))),
  ),
);

const snapshot = await Effect.runPromise(detector.inspect);
const alarms = await Effect.runPromise(detector.readAlarms);
const crashTelemetry = await Effect.runPromise(detector.readCrashTelemetry);
```

What to inspect:

- `snapshot.openBrowsers === 0`
- `snapshot.openContexts === 0`
- `snapshot.openPages === 0`
- `alarms.length === 0`
- `crashTelemetry.length === 0` for a passing soak/load run

## Expected Signals

A healthy soak/load result should show:

- one browser runtime per scoped round
- peak open contexts/pages bounded by requested concurrency
- zero dangling resources at the end of the run
- zero leak alarms under the default policy
- zero crash telemetry during a clean soak/load run

`tests/libs/foundation-core-browser-crash-recovery.test.ts` also covers the
unrecovered recycle path, where crash telemetry is expected and must remain
typed.

## Troubleshooting

### Leak alarms appear during the soak suite

Check:

- whether requested concurrency is higher than the configured
  `maxOpenContexts` or `maxOpenPages`
- whether a recent runtime change forgot to close page/context/browser
  resources on one branch

Do not suppress alarms by weakening the detector or by mutating counters
manually.

### Final snapshot is non-zero

That is a real cleanup regression. Fix the scoped acquisition/release path in
`BrowserAccessLive` or the underlying runtime. Do not patch over it with
singleton cleanup code.

### Crash telemetry appears in a supposed happy path

That means the browser runtime recycled during the soak/load run. Inspect:

- `tests/libs/foundation-core-browser-crash-recovery.test.ts`
- `libs/foundation/core/src/browser-access-runtime.ts`

The runtime must either recover cleanly with typed telemetry or fail cleanly
without leaking resources.

## Rollout

1. Run the targeted verification suites.
2. Run the soak/load harness with the intended concurrency.
3. Inspect the final snapshot, alarms, and crash telemetry.
4. Run full repository gates.
5. Close the bead only when all signals are clean.

## Rollback

1. Revert the runtime change that caused the alarm or dangling snapshot.
2. Re-run:

```bash
bun test tests/libs/foundation-core-browser-leak-detection.test.ts
bun test tests/libs/foundation-core-browser-crash-recovery.test.ts
bun run benchmark:e4-browser-soak-load -- --rounds 4 --concurrency 2 --warmup 0
bun run check
```

3. Do not “fix” the issue by disabling the detector or dropping typed crash
   telemetry.
