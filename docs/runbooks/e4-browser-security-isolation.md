# E4 Browser Security Isolation Runbook

## Purpose

Use this runbook when runtime authors, operators, or SDK consumers need to
validate the current browser session-isolation and origin-restriction contract
implemented in:

- `libs/foundation/core/src/browser-access-policy.ts`
- `libs/foundation/core/src/browser-access-runtime.ts`
- `tests/libs/foundation-core-browser-security-isolation.test.ts`

This runbook is intentionally limited to behavior that exists today. It does
not assume:

- cross-origin redirect allowlists
- persisted browser-session ledgers across process restarts
- browser-state reuse across capture attempts in the same scope
- silent policy denials without observable decision records

Policy baseline:

- Effect v4 only
- schema-first policy contracts and decision records
- no manual `_tag` inspection
- no manual `instanceof`
- no type-safety bypasses

## Current Security Contract

Every browser capture attempt in `BrowserAccessLive(...)` now creates a unique
browser security session derived from the run plan.

Current guarantees:

- a fresh browser security session is created per `capture(plan)` call
- browser contexts are bound to exactly one browser security session
- browser pages are bound to exactly one browser security session
- reusing a previously bound context or page in a later session fails with
  `PolicyViolation`
- after a runtime-level isolation failure, the current browser generation is
  recycled before the next capture attempt
- browser navigation must remain on the exact origin derived from
  `plan.entryUrl`
- origin drift blocks capture before DOM, screenshot, or network-summary reads
- every allow/block decision is emitted through `Effect.log(...)`
- decisions are also readable from the in-memory policy helper used in tests or
  custom runtime wiring

## Practical Verification Flow

Run from repository root:

```bash
bun test tests/libs/foundation-core-browser-security-isolation.test.ts
```

Focused checks:

```bash
bun test tests/libs/foundation-core-browser-security-isolation.test.ts \
  --test-name-pattern "blocks reused browser contexts across capture sessions"

bun test tests/libs/foundation-core-browser-security-isolation.test.ts \
  --test-name-pattern "blocks cross-origin redirects before DOM capture"
```

What to inspect:

- a reused context from an earlier capture session is denied with
  `PolicyViolation`
- the denial is followed by a fresh browser launch on the next capture
- a cross-origin redirect is denied before DOM or screenshot capture runs
- decision records include both `sessionIsolation` and `originRestriction`
  entries with `allowed` / `blocked` outcomes

## Failure Interpretation

### `PolicyViolation` on `sessionIsolation`

Meaning:

- the runtime observed a browser context or page object that was already bound
  to a different browser security session

Operational response:

- treat the current browser generation as tainted
- confirm the next capture launches a fresh browser generation
- inspect the decision stream for the blocked carrier and owning session id

### `PolicyViolation` on `originRestriction`

Meaning:

- navigation completed on an origin other than the canonical origin from
  `plan.entryUrl`

Operational response:

- verify the target did not start redirecting to a new host or protocol
- update upstream target configuration before widening browser policy
- do not bypass the guard by capturing post-redirect content directly

## Full Gate Replay

Use the standard repository gates after browser-security edits:

```bash
bun run ultracite:check
bun run oxlint:check
bun run format:check
bun run typecheck
bun run build
bun test tests/libs/foundation-core-browser-access-runtime.test.ts
bun test tests/libs/foundation-core-browser-crash-recovery.test.ts
bun test tests/libs/foundation-core-browser-security-isolation.test.ts
```

## Residual Limits

Current non-goals to keep in mind:

- the runtime enforces exact-origin redirects, not broader same-site policies
- direct callers of `captureBrowserArtifacts(...)` only get cross-call
  contamination detection when they share the same security-policy instance
- decision persistence is in-memory unless the caller forwards logs or wraps the
  policy monitor
