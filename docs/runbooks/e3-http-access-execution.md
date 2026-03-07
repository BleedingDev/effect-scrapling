# E3 HTTP Access Execution Runbook

## Purpose

Use this runbook when operators or runtime authors need to validate the current
HTTP-first capture service implemented in:

- `libs/foundation/core/src/http-access-runtime.ts`
- `libs/foundation/core/src/access-retry-runtime.ts`
- `libs/foundation/core/src/access-timeout-runtime.ts`
- `tests/libs/foundation-core-e3-runtime.test.ts`
- `tests/libs/foundation-core-access-retry.test.ts`
- `tests/libs/foundation-core-access-timeout.test.ts`
- `examples/e3-capability-slice.ts`

This runbook is intentionally limited to behavior that exists today. It does
not assume:

- POST or form-submission capture flows
- cookie jar persistence across runs
- queue-based retry orchestration
- disk-backed artifact persistence inside `captureHttpArtifacts(...)`

Policy baseline:

- Effect v4 only
- plan decode through `RunPlanSchema` before execution
- retries and timeouts use typed Effect errors
- no manual `_tag`, no manual `instanceof`, no unsafe type bypasses

Related E3 runbooks:

- `docs/runbooks/e3-operations-rollback-drill.md`
- `docs/runbooks/e3-access-planner-policy.md`
- `docs/runbooks/e3-identity-lease-management.md`
- `docs/runbooks/e3-egress-lease-management.md`
- `docs/runbooks/e3-retry-backoff-runbook.md`
- `docs/runbooks/e3-access-health-runbook.md`

## Current Runtime Contract

Current exports from `http-access-runtime.ts`:

- `HttpCapturePayload`
- `HttpCaptureBundle`
- `HttpCapturePayloadSchema`
- `HttpCaptureBundleSchema`
- `sanitizeHttpHeaders`
- `captureHttpArtifacts`
- `makeHttpAccess`
- `HttpAccessLive`

What `captureHttpArtifacts(...)` does now:

1. Decodes the input through `RunPlanSchema`.
2. Rejects plans without a capture step.
3. Rejects plans whose capture step requires browser resources.
4. Executes a `GET` with default `accept: text/html,application/xhtml+xml`
   unless callers supply custom request headers.
5. Applies bounded retry logic through `executeWithAccessRetry(...)`.
6. Applies access timeout controls to both the fetch and the body read.
7. Persists four deterministic payloads in the returned bundle:
   - `requestMetadata`
   - `responseMetadata`
   - `html`
   - `timings`

Header sanitization rules that matter operationally:

- secret-bearing names such as `authorization`, `cookie`, `set-cookie`,
  `token`, `secret`, and `api-key` are emitted as `[REDACTED]`
- non-secret headers keep their original values
- request and response header rows are sorted by normalized lowercase name

Important current limits:

- the runtime always uses `GET`
- cookies are caller-supplied headers, not a managed cookie jar
- `HttpAccessLive` returns metadata records only; payload reads stay at the
  `captureHttpArtifacts(...)` / bundle-store boundary

## Command Usage

Run the focused HTTP execution checks from repository root:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts
bun test tests/libs/foundation-core-access-retry.test.ts
bun test tests/libs/foundation-core-access-timeout.test.ts
bun test tests/examples/e3-capability-slice.test.ts
bun run check:e3-capability-slice
bun run check:e3-access-runtime
```

Run the full repository gates before promotion:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

## Practical Execution Examples

### Inspect the deterministic E3 HTTP bundle

Run:

```bash
bun run example:e3-capability-slice | jq '{
  captureKinds: [.captureBundle.artifacts[].kind],
  requestLocator: .captureBundle.payloads[0].locator,
  responseLocator: .captureBundle.payloads[1].locator,
  timingsLocator: .captureBundle.payloads[3].locator
}'
```

Healthy evidence:

- `captureKinds == ["requestMetadata", "responseMetadata", "html", "timings"]`
- every locator namespace is `captures/<targetId>`
- every locator key is prefixed with `<plan.id>/`

### Validate header redaction and normalized metadata

Run the focused runtime test:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "sanitizes secret-bearing request and response headers before persisting metadata"
```

What it proves today:

- outbound `authorization` / `cookie` style names are redacted
- inbound `set-cookie` / `x-api-key` style names are redacted
- non-secret headers such as `accept` and `content-type` remain visible

### Validate retry exhaustion reporting

Run:

```bash
bun test tests/libs/foundation-core-access-retry.test.ts \
  --test-name-pattern "surfaces a structured report when a retryable failure exhausts the budget"
```

What it proves today:

- retryable failures stay bounded by the derived retry policy
- exhaustion reporting is emitted separately from the terminal failure
- callers can inspect the structured retry report instead of scraping strings

## Troubleshooting

### Capture rejects a browser-required plan

Meaning:

- the access planner resolved a browser-backed capture path
- HTTP capture cannot satisfy that plan safely

Response:

- route the plan through `BrowserAccess` instead of weakening the guard
- inspect the planner rationale before changing the access policy

### Fetch or body read times out

Meaning:

- `decodedPlan.timeoutMs` was exhausted during the network request or body read

Response:

- confirm the target is slow before raising the timeout
- check whether repeated timeouts are already triggering browser escalation in
  the planner

### Retry exhaustion fires

Meaning:

- the failure stayed retryable but exceeded the configured retry budget

Response:

- inspect the structured retry report from the benchmark/runtime tests
- do not add unbounded retries; fix the root access path or widen policy only
  intentionally

## Rollout And Rollback

Roll out HTTP access runtime changes only when:

- the focused HTTP runtime, retry, and timeout tests are green
- the E3 capability slice remains green
- the E3 benchmark remains green
- full repository gates are green

Rollback guidance today:

- there is no runtime toggle for the current HTTP capture implementation
- revert the `http-access-runtime.ts` change together with any touched retry or
  timeout helpers and test updates
- rerun the focused HTTP suite, E3 checks, and full repository gates
