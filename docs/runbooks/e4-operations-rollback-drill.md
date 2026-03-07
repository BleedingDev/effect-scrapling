# E4 Operations And Rollback Drill

## Purpose

Give operators a single E4 runbook for:

- browser-runtime setup and readiness
- routine E4 execution commands
- rollback and recovery drill execution
- evidence locations and focused troubleshooting

This runbook consolidates the current E4 operational contract without inventing
new feature flags, live tuning knobs, or fallback behavior that does not exist
today.

## Command Contract

Primary E4 setup and validation commands:

```bash
bun install --frozen-lockfile
bun run browser:install
bun run check:playwright
bun run check:e4-capability-slice
bun run benchmark:e4-browser-soak-load -- --rounds 2 --concurrency 2 --warmup 0 --artifact tmp/e4-browser-soak-load.json
bun run check:e4-browser-soak-load
```

Focused E4 diagnostics:

```bash
bun test tests/libs/foundation-core-browser-access-runtime.test.ts
bun test tests/libs/foundation-core-browser-capture-bundle.test.ts
bun test tests/libs/foundation-core-browser-crash-recovery.test.ts
bun test tests/libs/foundation-core-browser-leak-detection.test.ts
bun test tests/libs/foundation-core-browser-security-isolation.test.ts
bun test tests/examples/e4-capability-slice.test.ts
```

Public browser-surface smoke checks:

```bash
bun run standalone -- render preview \
  --url "https://example.com" \
  --wait-until networkidle \
  --wait-ms 300

PORT=3000 bun run api

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

Merge-blocking repository gates before bead closure:

```bash
bun run ultracite:check
bun run oxlint:check
bun run format:check
bun run build
bun run check
```

Supporting E4 runbooks:

- `docs/runbooks/e4-provider-selection.md`
- `docs/runbooks/e4-browser-access-lifecycle.md`
- `docs/runbooks/e4-browser-pool-controls.md`
- `docs/runbooks/e4-browser-capture-bundle.md`
- `docs/runbooks/e4-browser-artifact-redaction.md`
- `docs/runbooks/e4-browser-crash-recovery.md`
- `docs/runbooks/e4-browser-leak-detection.md`
- `docs/runbooks/e4-browser-security-isolation.md`
- `docs/runbooks/e4-render-preview.md`
- `docs/runbooks/e4-browser-soak-load.md`

## Current Runtime Contract

Operators should read the integrated E4 evidence with these current guarantees
in mind:

- provider selection is deterministic and schema-backed
- browser capture is policy-selected, not the default path
- the current planner escalates to browser for:
  - `mode: "browser"`
  - `mode: "managed"`
  - `mode: "hybrid"` with `render: "always"`
  - `mode: "hybrid"` with `render: "onDemand"` plus high-friction
    `productListing`, `searchResult`, or `socialPost` targets
  - `mode: "hybrid"` with repeated browser-worthy failure context
- `check:e4-capability-slice` currently proves an integrated browser-backed
  flow where:
  - `plannerDecision.plan.steps[0].requiresBrowser === true`
  - planner rationale keys stay ordered as `mode`, `rendering`, `budget`,
    `capture-path`
  - the raw browser bundle emits exactly four artifacts in order:
    `renderedDom`, `screenshot`, `networkSummary`, `timings`
  - redacted exports preserve artifact order and do not leak raw secrets
  - policy decisions remain explicit for `sessionIsolation` and
    `originRestriction`
  - the healthy path ends with `openBrowsers = 0`, `openContexts = 0`,
    `openPages = 0`
- every browser capture currently allocates a fresh security session and must
  stay on the exact origin derived from `plan.entryUrl`
- a browser crash recycles the browser generation for the next capture in the
  same scope, but the original crashed capture still fails
- a healthy soak/load run ends with:
  - `status === "pass"`
  - `violations = []`
  - `alarms = []`
  - `crashTelemetry = []`
  - `finalSnapshot.openBrowsers = 0`
  - `finalSnapshot.openContexts = 0`
  - `finalSnapshot.openPages = 0`
- the public `render preview` surface remains browser-only and returns
  `navigation`, `renderedDom`, then `timings`

## Standard Execution Flow

### 1. Setup The Browser Runtime

Run from repository root:

```bash
bun install --frozen-lockfile
bun run browser:install
bun run check:playwright
```

What this proves today:

- dependencies match `bun.lock`
- Chromium is available for Playwright-backed flows
- the Playwright CLI package is resolvable in the current workspace

### 2. Run The Integrated E4 Capability Slice

```bash
bun run check:e4-capability-slice
```

What to inspect:

- the example test passes
- the emitted JSON evidence shows:
  - browser planner selection
  - four browser artifact kinds in deterministic order
  - explicit policy decisions
  - zero leak alarms and zero crash telemetry

If you need a persisted evidence file instead of stdout only:

```bash
bun run example:e4-capability-slice > tmp/e4-capability-slice.json
```

### 3. Persist A Bounded Soak Artifact

```bash
bun run benchmark:e4-browser-soak-load -- \
  --rounds 2 \
  --concurrency 2 \
  --warmup 0 \
  --artifact tmp/e4-browser-soak-load.json
```

What to inspect in `tmp/e4-browser-soak-load.json`:

- `status === "pass"`
- `violations` is empty
- `captures.totalRuns === 4`
- `captures.totalArtifacts === 16`
- `captures.artifactKinds` equals:
  - `renderedDom`
  - `screenshot`
  - `networkSummary`
  - `timings`
- `peaks.openBrowsers <= 1`
- `peaks.openContexts <= 2`
- `peaks.openPages <= 2`
- `finalSnapshot.openBrowsers === 0`
- `finalSnapshot.openContexts === 0`
- `finalSnapshot.openPages === 0`

If you only need the benchmark pass/fail status and do not need a persisted
artifact file:

```bash
bun run check:e4-browser-soak-load
```

### 4. Escalate To Focused Diagnostics Only When Needed

Use the focused suites to isolate the failing subsystem before rerunning broader
checks:

- `tests/libs/foundation-core-browser-access-runtime.test.ts`
- `tests/libs/foundation-core-browser-capture-bundle.test.ts`
- `tests/libs/foundation-core-browser-crash-recovery.test.ts`
- `tests/libs/foundation-core-browser-leak-detection.test.ts`
- `tests/libs/foundation-core-browser-security-isolation.test.ts`
- `tests/examples/e4-capability-slice.test.ts`

### 5. Replay Repository Gates Before Closure

```bash
bun run ultracite:check
bun run oxlint:check
bun run format:check
bun run build
bun run check
```

## Rollback Drill Procedure

Run the drill in an isolated clone or disposable worktree.

```bash
TEMP_DIR="$(mktemp -d -t e4-rollback-drill.XXXXXX)"
git clone . "$TEMP_DIR/repo"
cd "$TEMP_DIR/repo"
bun install --frozen-lockfile
bun run browser:install
bun run check:playwright
bun run check:e4-capability-slice
bun run benchmark:e4-browser-soak-load -- --rounds 2 --concurrency 2 --warmup 0 --artifact tmp/e4-browser-soak-load.json
rm -rf node_modules dist tmp/e4-browser-soak-load.json
bun install --frozen-lockfile
bun run check:playwright
bun run check:e4-capability-slice
bun run benchmark:e4-browser-soak-load -- --rounds 2 --concurrency 2 --warmup 0 --artifact tmp/e4-browser-soak-load.json
```

Important current boundary:

- the rollback step removes repository-generated state only
- Playwright's browser cache lives outside the repository, so the drill verifies
  workspace recovery rather than forcing a machine-wide Chromium reinstall

Success criteria:

- frozen install is green before and after rollback
- browser bootstrap is green before validation
- `check:e4-capability-slice` is green before and after rollback
- the reduced persisted soak artifact reports `status: "pass"` before and after
  rollback
- generated workspace state is removed successfully
- the recovered soak artifact still reports zero alarms, zero crash telemetry,
  and zero final open browser resources

Evidence for the latest executed drill lives in:

- `docs/artifacts/e4-rollback-drill.md`

## Troubleshooting

### `browser:install` or `check:playwright` fails

- fix the local Playwright or Chromium prerequisite first
- do not treat missing Chromium as an E4 runtime regression
- rerun:

```bash
bun run browser:install
bun run check:playwright
```

### `check:e4-capability-slice` fails

- inspect the emitted evidence in this order:
  - `plannerDecision`
  - `rawCaptureBundle`
  - `redactedExports`
  - `policyDecisions`
  - `leakSnapshot`
  - `crashTelemetry`
- rerun the focused suite that matches the first broken boundary:
  - planner/provider-selection issues: `docs/runbooks/e4-provider-selection.md`
  - artifact bundle or redaction issues:
    `docs/runbooks/e4-browser-capture-bundle.md`
  - lifecycle or recycle issues:
    `docs/runbooks/e4-browser-access-lifecycle.md`
  - security-session or origin issues:
    `docs/runbooks/e4-browser-security-isolation.md`

### The soak artifact reports `status: "fail"`

Inspect these fields in order:

1. `violations`
2. `finalSnapshot`
3. `alarms`
4. `crashTelemetry`
5. `peaks`
6. `captures`

Current interpretation:

- non-zero `finalSnapshot.*` means cleanup regressed
- non-empty `alarms` means the leak detector observed a real policy violation
- non-empty `crashTelemetry` means the run hit a crash/recycle path instead of
  the clean steady state
- peak counts above requested concurrency mean pool accounting regressed
- artifact-count or artifact-kind drift means the bundle contract changed

### Render-preview smoke checks fail

- keep `render preview` separate from `access preview`
- rerun the public-surface tests before changing CLI or API contracts:

```bash
bun test tests/sdk/scraper.test.ts --test-name-pattern "renderPreview"
bun test tests/apps/api-app.test.ts --test-name-pattern "render preview"
bun test tests/apps/cli-app.test.ts --test-name-pattern "render preview"
```

### Recovery still fails after removing generated workspace state

- revert the offending E4 runtime or policy change
- rerun the rollback drill from a fresh disposable clone
- do not weaken leak detection, crash telemetry, origin restriction, or
  redaction rules to make the drill pass

## Rollback Policy

Allowed rollback actions:

1. Revert the offending E4 runtime, policy, or artifact-contract change.
2. Remove repository-generated state and rerun the setup plus focused E4
   commands.
3. Promote only when the integrated E4 checks and repository gates are green
   again.

Forbidden rollback actions:

- forcing HTTP-backed plans through the browser runtime
- disabling leak alarms, crash telemetry, or security-policy checks
- exporting raw DOM or screenshot payloads to logs or prompts
- skipping `--frozen-lockfile`
- weakening Effect v4 guardrails or type-safety checks to hide a regression
