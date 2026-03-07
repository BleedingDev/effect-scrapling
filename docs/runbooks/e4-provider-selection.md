# E4 Provider Selection Runbook

## Purpose

Use this runbook when operators or planner authors need to validate, observe, or
troubleshoot the current provider-selection heuristics in:

- `libs/foundation/core/src/access-planner-runtime.ts`
- `tests/libs/foundation-core-e3-runtime.test.ts`
- `tests/examples/e3-capability-slice.test.ts`
- `examples/e3-capability-slice.ts`

This document is intentionally limited to behavior that exists today. It does
not assume:

- persisted provider preferences across runs
- automatic provider fallback after the plan is generated
- provider-health snapshots feeding back into planner selection
- browser-path performance coverage in the current benchmark harness

Policy baseline:

- Effect v4 only.
- Selection stays deterministic from decoded planner input.
- Provider evidence stays explicit in `AccessPlannerDecision.rationale`.
- No manual `_tag` probing, `instanceof` shortcuts, or type-safety bypasses.

## Current Planner Contract

Current planner entrypoints and outputs:

- `planAccessExecution`
- `AccessPlannerInputSchema`
- `AccessPlannerDecision`
- `AccessPlannerDecisionSchema`
- `AccessPlannerLive`

What the planner emits today:

- `plan.steps[0]` is always the `capture` step.
- `plan.steps[0].requiresBrowser === true` means the planner selected the
  browser-backed path.
- `plan.steps[0].artifactKind` is:
  - `html` for HTTP capture
  - `renderedDom` for browser-backed capture
- `concurrencyBudget.maxPerDomain` and `concurrencyBudget.globalConcurrency`
  are copied directly from the access policy.
- `rationale` always contains these keys in order:
  - `mode`
  - `rendering`
  - `budget`
  - `capture-path`

Inputs that affect provider selection today:

- `accessPolicy.mode`
- `accessPolicy.render`
- `target.kind`
- `failureContext.recentFailureCount`
- `failureContext.lastFailureCode`

Signals that do not affect provider selection today:

- provider health snapshots
- identity or egress lease state
- previous successful provider choice
- site-pack lifecycle state after the pack/policy/domain validations succeed

## Selection Heuristics

Current provider outcomes:

| Input shape | Selected provider | Observable plan change | Evidence string shape |
| --- | --- | --- | --- |
| `mode: "http"` and `render: "never"` | `http` | `requiresBrowser: false`, `artifactKind: "html"` | `HTTP mode with render: "never" keeps capture on the plain HTTP provider.` |
| `mode: "browser"` | `browser` | `requiresBrowser: true`, `artifactKind: "renderedDom"` | `Browser mode requires browser-backed capture.` |
| `mode: "managed"` | `browser` | `requiresBrowser: true`, `artifactKind: "renderedDom"` | `Managed mode delegates capture to a browser-capable provider.` |
| `mode: "hybrid"` and `render: "always"` | `browser` | `requiresBrowser: true`, `artifactKind: "renderedDom"` | `Hybrid mode with render: "always" requires browser-backed capture.` |
| `mode: "hybrid"`, `render: "onDemand"`, target kind in `productListing`, `searchResult`, `socialPost` | `browser` | `requiresBrowser: true`, `artifactKind: "renderedDom"` | `Hybrid mode escalated to browser for high-friction <kind> targets.` |
| `mode: "hybrid"`, `render: "onDemand"`, `recentFailureCount >= 2` | `browser` | `requiresBrowser: true`, `artifactKind: "renderedDom"` | `Hybrid mode escalated to browser after <n> recent access failure(s), latest <code>.` If `lastFailureCode` is absent, the planner emits `unspecified-access-failure`. |
| `mode: "hybrid"`, `render: "onDemand"`, `recentFailureCount > 0`, latest failure in `timeout`, `provider_unavailable`, `render_crash` | `browser` | `requiresBrowser: true`, `artifactKind: "renderedDom"` | same failure-escalation message as above |
| `mode: "hybrid"`, `render: "onDemand"`, no high-friction kind, no escalation failures | `http` | `requiresBrowser: false`, `artifactKind: "html"` | `Hybrid mode kept the HTTP-first path for <kind> targets without browser escalation signals.` |

Current high-friction target kinds:

- `productListing`
- `searchResult`
- `socialPost`

Current failure codes that can trigger hybrid escalation:

- `timeout`
- `provider_unavailable`
- `render_crash`

Important implementation detail:

- `failureContext.lastFailureCode` does nothing unless
  `failureContext.recentFailureCount > 0`.
- If both a high-friction target and an escalation-worthy failure context are
  present, the rationale combines both signals in one browser-escalation
  message.

## Command Usage

Run targeted verification from the repository root:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts
bun test tests/examples/e3-capability-slice.test.ts
bun test tests/libs/foundation-core-browser-access-runtime.test.ts
bun run check:e3-capability-slice
bun run check:e3-access-runtime
```

Run full repository gates before bead closure or merge:

```bash
bun run ultracite:check
bun run oxlint:check
bun run format:check
bun run build
bun run check
```

Useful entrypoints and related runbooks:

- `examples/e3-capability-slice.ts`
- `scripts/benchmarks/e3-access-runtime.ts`
- `docs/artifacts/e3-access-runtime-baseline.json`
- `docs/runbooks/e3-access-runtime-benchmark.md`
- `docs/runbooks/e1-access-policy.md`
- `docs/runbooks/e1-tagged-errors.md`
- `docs/runbooks/e3-retry-backoff-runbook.md`

## Practical Execution Examples

### Confirm the low-friction hybrid path stays HTTP-first

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "keeps low-friction hybrid targets on the HTTP-first provider and records evidence"
```

What to inspect:

- `plan.steps[0].requiresBrowser === false`
- `plan.steps[0].artifactKind === "html"`
- the `capture-path` rationale contains `selected http provider`
- the `capture-path` rationale contains `HTTP-first path for blogPost targets`

### Force browser capture through rendering policy

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "escalates hybrid targets with `render: \"always\"` to the browser provider"
```

What to inspect:

- `plan.steps[0].requiresBrowser === true`
- `plan.steps[0].artifactKind === "renderedDom"`
- the `capture-path` rationale contains `render: "always"`

### Confirm browser-only and managed policies stay browser-backed

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "keeps browser and managed policies on browser-backed capture"
```

What to inspect:

- both cases emit `plan.steps[0].requiresBrowser === true`
- both cases emit `plan.steps[0].artifactKind === "renderedDom"`
- browser mode rationale contains `Browser mode requires browser-backed capture.`
- managed mode rationale contains `Managed mode delegates capture to a browser-capable provider.`

### Confirm high-friction hybrid escalation

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "escalates all high-friction hybrid targets to the browser provider"
```

What to inspect:

- `productListing`, `searchResult`, and `socialPost` each emit `plan.steps[0].requiresBrowser === true`
- each case emits `plan.steps[0].artifactKind === "renderedDom"`
- each `capture-path` rationale contains `selected browser provider`
- each `capture-path` rationale contains `high-friction <kind> targets`

### Confirm failure-context escalation

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "escalates hybrid targets after repeated access failures and records policy evidence"

bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "escalates hybrid targets for every browser-worthy failure code"

bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "ignores lastFailureCode when there are no recent failures to escalate"
```

What to inspect:

- `plan.steps[0].requiresBrowser === true`
- the `capture-path` rationale contains `2 recent access failure`
- the `capture-path` rationale contains `provider_unavailable`
- the one-failure matrix covers `timeout`, `provider_unavailable`, and `render_crash`
- the zero-failure case stays `requiresBrowser === false` and keeps the HTTP-first rationale
- repeated failures without a `lastFailureCode` fall back to `unspecified-access-failure`
- a high-friction target plus a browser-worthy failure code produces one combined browser-escalation rationale

### Inspect the end-to-end planner evidence payload

```bash
bun run example:e3-capability-slice
```

What to inspect in the JSON payload:

- `plannerDecision.plan.steps[0]`
- `plannerDecision.rationale`
- `plannerDecision.concurrencyBudget`
- `servicePlan`

Current expectations from `tests/examples/e3-capability-slice.test.ts`:

- `plannerDecision.plan` equals `servicePlan`
- rationale keys remain `mode`, `rendering`, `budget`, `capture-path`
- the capability slice shows provider health after execution, but that health
  snapshot is not an input to the planner selection heuristic

### Check the HTTP-path performance harness

Use `docs/runbooks/e3-access-runtime-benchmark.md` when you need the full
benchmark command contract, artifact lifecycle, or rollout/rollback procedure.
This section stays focused on the provider-selection signal only.

```bash
bun run scripts/benchmarks/e3-access-runtime.ts \
  --baseline docs/artifacts/e3-access-runtime-baseline.json \
  --sample-size 3 \
  --warmup 1
```

What this does and does not prove:

- it measures plan creation, HTTP capture, and retry recovery
- it can catch regressions if a change breaks the current HTTP-first path
- it does not benchmark browser-backed capture today

What to inspect in the JSON output:

- `measurements.baselineAccess.p95Ms`
- `measurements.candidateAccess.p95Ms`
- `measurements.retryRecovery.p95Ms`
- `comparison.deltas`
- `status`

## Failure-Path Reproduction

Reproduce planner validation failures directly from the E3 runtime test file:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "rejects access-planner input when the target domain does not match the site pack"

bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "rejects access-planner input when pack or access-policy identifiers drift"

bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "rejects access-planner input when the seed URL host escapes the target domain"
```

Expected failure evidence:

- domain mismatch: `does not match pack domain pattern`
- pack drift: `packId must resolve`
- policy drift: `must agree on accessPolicyId`
- seed-host escape: `must stay within target domain`

Reproduce provider/runtime mismatch failures:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "rejects browser-required plans for HTTP access"

bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "maps fetch failures to ProviderUnavailable and rejects plans without capture steps"
```

Expected failure evidence:

- browser-required plan passed into HTTP access: `requires browser resources`
- missing capture step: `requires a capture step`
- fetch/body-read failures surface the underlying message such as `network down`
  or `body read failed`

## Evidence And Logs To Inspect

Use these fields as the primary evidence set for a provider-selection decision:

- `plannerDecision.rationale`
- `plannerDecision.plan.steps[0].requiresBrowser`
- `plannerDecision.plan.steps[0].artifactKind`
- `plannerDecision.plan.maxAttempts`
- `plannerDecision.concurrencyBudget`

What each field answers:

- `rationale.mode`: which access mode was decoded
- `rationale.rendering`: which rendering policy was decoded
- `rationale.budget`: which concurrency budget was emitted
- `rationale.capture-path`: why the planner chose `http` or `browser`
- `plan.maxAttempts`: how retry pressure will behave downstream

When HTTP capture is involved, also inspect:

- retry-decision logs described in `docs/runbooks/e3-retry-backoff-runbook.md`
- terminal `ProviderUnavailable` or `PolicyViolation` messages from
  `captureHttpArtifacts`
- the stored capture bundle or example payload if the run reaches persistence

What not to infer from current evidence:

- there is no separate persisted provider-selection ledger
- successful provider health snapshots do not prove what the planner would have
  chosen on the next run
- the benchmark harness does not cover browser-backed performance today

## Rollout Guidance

1. Prepare
- change planner heuristics and planner tests in the same edit
- update this runbook if a new high-friction kind or escalation code is added
- verify any access-policy assumptions against
  `docs/runbooks/e1-access-policy.md`

2. Validate
- run `bun test tests/libs/foundation-core-e3-runtime.test.ts`
- run `bun test tests/examples/e3-capability-slice.test.ts`
- run `bun test tests/libs/foundation-core-browser-access-runtime.test.ts`
- run `bun run check:e3-capability-slice`
- run `bun run check:e3-access-runtime`

3. Promote
- run the full repository gates
- promote only when rationale strings, capture-step flags, and benchmark status
  are all green

4. Observe
- inspect `plannerDecision.rationale.capture-path` evidence on representative
  targets after rollout
- sample both low-friction and high-friction targets before considering the
  rollout stable

## Rollback Guidance

Use rollback when a heuristic change routes the wrong target class to browser,
keeps browser-required targets on HTTP, or invalidates current planner evidence.

1. Revert the heuristic or input-shaping change that altered planner selection.
2. Re-run:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts
bun test tests/examples/e3-capability-slice.test.ts
bun run check:e3-capability-slice
bun run check:e3-access-runtime
bun run check
```

3. Confirm the restored plan emits the prior `capture-path` evidence and the
   expected `requiresBrowser` / `artifactKind` pair.
4. Re-attempt rollout only after the heuristic change is corrected and the
   targeted E3 checks are green again.

Forbidden rollback shortcuts:

- weakening the high-friction target list without matching tests and runbook updates
- suppressing rationale messages to hide a selection regression
- forcing HTTP access to accept browser-required plans
- claiming rollback is complete without rerunning the targeted E3 checks

## Operator Notes

- The current planner selects between only two capture paths: `http` and
  `browser`.
- `managed` mode currently maps to the browser-backed path in the planner
  implementation; there is no dedicated managed-mode benchmark in the current
  suite.
- If selection behavior changes, update implementation, tests, benchmark
  expectations, and this runbook together.
