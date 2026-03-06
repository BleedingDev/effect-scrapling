# E4 Browser Capture Bundle Runbook

## Purpose

Use this runbook when operators, runtime authors, or SDK consumers need to
validate the current browser capture bundle contract for DOM screenshots and
network capture completeness in:

- `libs/foundation/core/src/browser-access-runtime.ts`
- `tests/libs/foundation-core-browser-capture-bundle.test.ts`
- `tests/libs/foundation-core-browser-access-runtime.test.ts`
- `tests/libs/foundation-core-browser-crash-recovery.test.ts`
- `scripts/benchmarks/e4-browser-soak-load.ts`

This runbook is intentionally limited to behavior that exists today. It does
not assume:

- a public SDK API that returns browser capture bundles
- persisted browser bundle reads through `capture-store-runtime`
- HAR export, DevTools trace export, or any other browser artifact beyond the
  current four-item bundle

Policy baseline:

- Effect v4 only
- no manual `_tag` inspection
- no manual `instanceof`
- no type-safety bypasses

## Current Contract

Current browser completeness behavior:

- `captureBrowserArtifacts(plan, browser, now)` decodes the shared `RunPlan`
  contract and rejects invalid plans before opening a browser context
- the plan must start with a `capture` step and that step must declare
  `requiresBrowser: true`
- a complete browser bundle contains exactly four artifacts and four payloads in
  deterministic order:
  - `renderedDom`
  - `screenshot`
  - `networkSummary`
  - `timings`
- every artifact record carries `runId = plan.id`
- every payload locator uses `namespace = "captures/<targetId>"`
- every payload locator key is prefixed with `<plan.id>/`
- `BrowserAccess.capture(plan)` returns artifact metadata only; payload-level
  inspection happens at the `captureBrowserArtifacts(...)` boundary today

Current per-artifact contract:

- `renderedDom`
  - locator key: `<plan.id>/rendered-dom.html`
  - media type: `text/html`
  - visibility: `raw`
  - payload encoding: `utf8`
- `screenshot`
  - locator key: `<plan.id>/screenshot.png`
  - media type: `image/png`
  - visibility: `raw`
  - payload encoding: `base64`
- `networkSummary`
  - locator key: `<plan.id>/network-summary.json`
  - media type: `application/json`
  - visibility: `redacted`
  - payload encoding: `utf8`
- `timings`
  - locator key: `<plan.id>/timings.json`
  - media type: `application/json`
  - visibility: `redacted`
  - payload encoding: `utf8`

Additional details validated by the current tests:

- `timings.json` contains `startedAt`, `completedAt`, and `elapsedMs`
- `networkSummary` is decoded through `BrowserNetworkSummarySchema` and
  normalized into deterministic ordering before it is serialized
- screenshot artifact metadata size tracks the original screenshot byte length,
  while the payload body is base64 text

## Browser Preflight

Run from repository root:

```bash
bun install --frozen-lockfile
bun run browser:install
bun run check:playwright
```

Current SDK boundary to keep in mind:

- `effect-scrapling/sdk` supports browser mode through Playwright
- the public SDK currently returns preview and extract responses, not browser
  bundle payloads
- browser bundle completeness verification therefore stays at the
  `foundation-core` runtime and test boundary today

## Command Usage

Run the focused completeness checks:

```bash
bun test tests/libs/foundation-core-browser-capture-bundle.test.ts \
  --test-name-pattern "captures rendered DOM screenshot network summary and timings as a complete bundle"

bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "captures rendered DOM screenshot network summary and timings through the default launcher path"

bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "maps browser screenshot failures to RenderCrashError recycles the browser and releases resources"

bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "maps browser network summary failures to RenderCrashError recycles the browser and releases resources"

bun test tests/libs/foundation-core-browser-crash-recovery.test.ts \
  --test-name-pattern "recycles crashed browser generations and stores typed crash telemetry"
```

Run the bounded soak/load harness and persist an operator artifact:

```bash
bun run benchmark:e4-browser-soak-load -- \
  --rounds 8 \
  --concurrency 6 \
  --warmup 1 \
  --artifact tmp/e4-browser-soak-load.json
```

Run the bead-specific harness entrypoint:

```bash
bun run check:e4-browser-soak-load
```

Run full repository gates before bead closure or rollout:

```bash
bun run ultracite:check
bun run oxlint:check
bun run format:check
bun run test
bun run build
bun run check
```

## Expected Evidence

### Bundle Evidence

Treat the completeness contract as healthy only when all of the following are
true:

- the bundle-level test reports exactly four artifact kinds in this order:
  - `renderedDom`
  - `screenshot`
  - `networkSummary`
  - `timings`
- the runtime-level test returns four artifact metadata records with locator
  keys:
  - `<plan.id>/rendered-dom.html`
  - `<plan.id>/screenshot.png`
  - `<plan.id>/network-summary.json`
  - `<plan.id>/timings.json`
- every artifact locator namespace equals `captures/<plan.targetId>`
- the screenshot artifact stays `image/png`
- the network summary and timings artifacts stay `redacted`

### Soak/Load Evidence

The persisted `tmp/e4-browser-soak-load.json` artifact should show:

- `status: "pass"`
- `captures.artifactKinds` equal to:
  - `renderedDom`
  - `screenshot`
  - `networkSummary`
  - `timings`
- `captures.totalArtifacts = captures.totalRuns * 4`
- `finalSnapshot.openBrowsers = 0`
- `finalSnapshot.openContexts = 0`
- `finalSnapshot.openPages = 0`
- `alarms` is empty for a healthy bounded run
- `crashTelemetry` is empty for a healthy bounded run

The current harness test also proves one concrete passing fixture:

- `rounds = 3`
- `concurrency = 4`
- `warmup = 0`
- `captures.totalRuns = 12`
- `captures.totalArtifacts = 48`
- `peaks.openBrowsers = 1`
- `peaks.openContexts = 4`
- `peaks.openPages = 4`

## Troubleshooting

### `ProviderUnavailable` before capture starts

Current runtime behavior loads Playwright lazily. If Chromium is missing, the
failure should mention:

- `Playwright is unavailable for browser access; run bun run browser:install`

Recovery:

```bash
bun run browser:install
bun run check:playwright
```

### `PolicyViolation` says the plan does not require browser resources

That means the first capture step is still HTTP-backed. The current browser
runtime must reject it before browser allocation. Do not force HTTP plans
through the browser path.

Re-run:

```bash
bun test tests/libs/foundation-core-browser-capture-bundle.test.ts \
  --test-name-pattern "rejects non-browser plans before allocating browser context"

bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "rejects non-browser capture plans without launching a browser runtime"
```

### The bundle is missing `screenshot` or `networkSummary`

Treat that as a completeness regression. The current contract is a four-artifact
bundle, not a best-effort bundle.

Check:

- `tests/libs/foundation-core-browser-capture-bundle.test.ts`
- `tests/libs/foundation-core-browser-access-runtime.test.ts`
- `libs/foundation/core/src/browser-access-runtime.ts`

Do not patch this by silently dropping the missing artifact or by changing the
expected artifact order.

### Screenshot capture fails

The failure should be a typed `RenderCrashError`, and the runtime tests prove
the page, context, and browser cleanup path still runs.

Re-run:

```bash
bun test tests/libs/foundation-core-browser-capture-bundle.test.ts \
  --test-name-pattern "maps browser screenshot failures to RenderCrashError and releases scoped resources"

bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "maps browser screenshot failures to RenderCrashError recycles the browser and releases resources"
```

### Network summary capture fails

The failure should also be a typed `RenderCrashError`. The current implementation
captures the network summary through `page.evaluate(...)`, then normalizes it
through `BrowserNetworkSummarySchema`.

Re-run:

```bash
bun test tests/libs/foundation-core-browser-capture-bundle.test.ts \
  --test-name-pattern "maps browser network summary failures to RenderCrashError and releases scoped resources"

bun test tests/libs/foundation-core-browser-access-runtime.test.ts \
  --test-name-pattern "maps browser network summary failures to RenderCrashError recycles the browser and releases resources"
```

### Soak artifact shows alarms or non-zero open resources

That is not a documentation problem; it is a browser lifecycle or leak
regression. Use the existing leak-detection runbook:

- `docs/runbooks/e4-browser-leak-detection.md`

Do not weaken the leak policy or suppress the final snapshot.

### You need to read a persisted browser bundle by run id

That is outside the current contract. `capture-store-runtime` currently decodes
`HttpCaptureBundleSchema`, not `BrowserCaptureBundleSchema`.

Do not invent a browser-bundle read path in operator automation or SDK
documentation until the runtime actually exposes one.

## Rollout

1. Bootstrap Chromium with `bun run browser:install` and verify it with
   `bun run check:playwright`.
2. Run the focused bundle, runtime, and crash-recovery tests.
3. Run `bun run benchmark:e4-browser-soak-load -- --artifact tmp/e4-browser-soak-load.json`.
4. Inspect the artifact count, artifact kinds, peak resource usage, final
   snapshot, alarms, and crash telemetry.
5. Run the full repository gates.
6. Promote only when the four-artifact contract, failure recovery paths, and
   soak/load signals are all green.

For public SDK rollouts, keep bundle-completeness validation in operator
preflight until the SDK exposes browser artifact payloads directly.

## Rollback

1. Revert the browser runtime change that broke completeness or recovery.
2. Re-run:

```bash
bun test tests/libs/foundation-core-browser-capture-bundle.test.ts
bun test tests/libs/foundation-core-browser-access-runtime.test.ts
bun test tests/libs/foundation-core-browser-crash-recovery.test.ts
bun run check:e4-browser-soak-load
bun run check
```

3. Do not roll back by:
  - removing `screenshot` or `networkSummary` from the bundle
  - changing locator keys away from the current `<plan.id>/...` contract
  - inventing SDK-only fallback artifact shapes that do not exist in the
    runtime today
