# E3 Capture Store Artifact Persistence Runbook

## Purpose

Use this runbook when operators, runtime authors, or in-repo SDK consumers need
to validate the current E3 capture-store artifact persistence flow in:

- `libs/foundation/core/src/capture-store-runtime.ts`
- `libs/foundation/core/src/http-access-runtime.ts`
- `examples/e3-capability-slice.ts`
- `tests/libs/foundation-core-capture-store.test.ts`
- `tests/examples/e3-capability-slice.test.ts`
- `scripts/benchmarks/e3-access-runtime.ts`

This runbook is intentionally limited to behavior that exists today. It does
not assume:

- disk-backed or object-store-backed persistence
- cross-process shared state
- partial bundle writes
- a package-root export for `capture-store-runtime`
- bundle payload reads through the metadata-only `CaptureStore` service in
  `libs/foundation/core/src/service-topology.ts`

Policy baseline:

- Effect v4 only
- run IDs and bundles decode through shared schemas before mutation
- no manual `_tag` branching, `instanceof`, or type-safety bypasses

## Current Contract

Current capture-store exports:

- `makeInMemoryCaptureBundleStore`
- `StoredCaptureBundle`
- `StoredCaptureBundleSchema`

Current store behavior:

- `persistBundle(runId, bundle)` decodes `runId` through
  `CanonicalIdentifierSchema`
- `persistBundle(runId, bundle)` decodes `bundle` through
  `HttpCaptureBundleSchema`
- `readBundle(runId)` returns `Option.none()` when the run is not present
- the store keeps artifacts, payloads, and `capturedAt` partitioned by `runId`
- payloads are keyed internally by
  `<locator.namespace>/<locator.key>`
- writes fail with `PolicyViolation` when artifact locators and payload locators
  do not form a one-to-one mapping after deterministic sorting
- reads fail with `PolicyViolation` when the payload partition for an existing
  run is missing or when an expected payload is missing from that partition

Deterministic ordering rules from the current implementation:

- `captureHttpArtifacts(...)` emits artifacts in this HTTP capture order:
  - `requestMetadata`
  - `responseMetadata`
  - `html`
  - `timings`
- `persistBundle(...)` reorders both `artifacts` and `payloads` by the fully
  qualified storage key `<locator.namespace>/<locator.key>`
- for the current HTTP capture bundle, persisted read order becomes:
  - `<plan.id>/body.html`
  - `<plan.id>/request-metadata.json`
  - `<plan.id>/response-metadata.json`
  - `<plan.id>/timings.json`

Current HTTP artifact contract that feeds the store:

- every artifact record carries `runId = plan.id`
- every locator namespace is `captures/<plan.targetId>`
- every locator key is prefixed with `<plan.id>/`
- current HTTP bundle contains exactly four artifact/payload pairs:
  - `requestMetadata`
  - `responseMetadata`
  - `html`
  - `timings`
- request and response metadata headers are sanitized before persistence, so
  secret-bearing names such as `authorization`, `cookie`, `set-cookie`, and
  `x-api-key` persist as `[REDACTED]`

Important boundary for consumers:

- `examples/e3-capability-slice.ts` imports
  `makeInMemoryCaptureBundleStore` directly from
  `libs/foundation/core/src/capture-store-runtime.ts`
- `@effect-scrapling/foundation-core` currently exports the metadata-level
  `CaptureStore` service from `src/index.ts`, but not the bundle-store runtime
  itself
- if a consumer needs payload readback today, stay at the current
  `capture-store-runtime` boundary instead of assuming package-root access

## Command Usage

Run the focused persistence checks from repository root:

```bash
bun test tests/libs/foundation-core-capture-store.test.ts
bun test tests/libs/foundation-core-e3-runtime.test.ts
bun test tests/examples/e3-capability-slice.test.ts
bun run example:e3-capability-slice
```

Run the existing E3 validation aliases that exercise capture persistence:

```bash
bun run check:e3-capability-slice
bun run check:e3-access-runtime
```

Run a persisted benchmark spot-check and write a disposable scorecard:

```bash
bun run scripts/benchmarks/e3-access-runtime.ts \
  --baseline docs/artifacts/e3-access-runtime-baseline.json \
  --artifact tmp/e3-capture-store-scorecard.json \
  --sample-size 3 \
  --warmup 1
```

Run full repository gates before promotion:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

Replay the merge-blocking affected-target matrix before push if the rollout
touches runtime code as well as docs:

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

## Practical Execution Examples

### Persist and reload the current E3 HTTP bundle

This is the current in-repo usage shape from `examples/e3-capability-slice.ts`:

```ts
import { Effect } from "effect";
import { makeInMemoryCaptureBundleStore } from "../libs/foundation/core/src/capture-store-runtime.ts";
import { captureHttpArtifacts } from "../libs/foundation/core/src/http-access-runtime.ts";

const captureStore = yield* makeInMemoryCaptureBundleStore();
const captureBundle = yield* captureHttpArtifacts(servicePlan, fetchImpl, () => currentTime);
const storedCapture = yield* captureStore.persistBundle(servicePlan.id, captureBundle);
const reloadedCapture = yield* captureStore.readBundle(servicePlan.id);
```

Operational rules:

- use `servicePlan.id` as the store key
- persist the exact `HttpCaptureBundle` returned by
  `captureHttpArtifacts(...)`
- read back using the same `runId`
- treat `Option.none()` as "no persisted bundle for this run yet", not as a
  decode failure

### Inspect the persisted keys from the deterministic example

Run:

```bash
bun run example:e3-capability-slice | jq '{
  runId: .storedCapture.runId,
  storedKeys: [.storedCapture.bundle.artifacts[].locator.key],
  reloadedKeys: [.reloadedCapture.bundle.artifacts[].locator.key]
}'
```

Healthy evidence:

- `runId` equals `.servicePlan.id`
- `storedKeys` equals `reloadedKeys`
- current key order is:
  - `<plan.id>/body.html`
  - `<plan.id>/request-metadata.json`
  - `<plan.id>/response-metadata.json`
  - `<plan.id>/timings.json`

### Inspect persisted metadata payload structure from the example output

Run:

```bash
bun run example:e3-capability-slice | jq -r '
  .reloadedCapture.bundle.payloads[]
  | select(.locator.key | endswith("request-metadata.json") or endswith("response-metadata.json"))
  | .body
'
```

Healthy evidence:

- request metadata still keeps non-secret headers such as `accept`
- response metadata still keeps non-secret headers such as `content-type`
- the example's current header set stays non-secret, so this command validates
  payload shape and persisted metadata content, not secret redaction coverage

For actual redaction verification, use the focused runtime test:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "sanitizes secret-bearing request and response headers before persisting metadata"
```

### Prove the benchmark path persists a real bundle

Run:

```bash
bun run scripts/benchmarks/e3-access-runtime.ts \
  --baseline docs/artifacts/e3-access-runtime-baseline.json \
  --artifact tmp/e3-capture-store-scorecard.json \
  --sample-size 3 \
  --warmup 1

jq '{status, measurements, comparison}' tmp/e3-capture-store-scorecard.json
```

What this proves today:

- `candidateAccess` persists a successful HTTP bundle through
  `makeInMemoryCaptureBundleStore()`
- `retryRecovery` persists a recovered bundle after one transient fetch failure
- the harness still validates the current capture persistence path without
  requiring external storage

## Expected Evidence

Treat capture persistence as healthy only when all of the following are true:

- `tests/libs/foundation-core-capture-store.test.ts` is green
- `tests/examples/e3-capability-slice.test.ts` is green
- `bun run example:e3-capability-slice` returns valid
  `E3CapabilitySliceEvidenceSchema` JSON
- `storedCapture.runId`, `reloadedCapture.runId`, and `servicePlan.id` all
  match
- `storedCapture` equals `reloadedCapture`
- stored artifact locator keys and payload locator keys match one-to-one
- the persisted bundle still contains exactly four HTTP artifacts:
  - `html`
  - `requestMetadata`
  - `responseMetadata`
  - `timings`
- metadata payloads keep redacted header values
- `bun run check:e3-access-runtime` produces a scorecard with `status: "pass"`

## Troubleshooting

### `PolicyViolation` says the run id failed to decode

The caller is passing a store key that does not satisfy
`CanonicalIdentifierSchema`.

Recovery:

- use `servicePlan.id` or another already-decoded canonical identifier
- rerun:

```bash
bun test tests/libs/foundation-core-capture-store.test.ts
bun run check:e3-capability-slice
```

Do not patch around this by stringifying arbitrary objects into run IDs.

### `PolicyViolation` says the bundle failed to decode

The caller is mutating the capture bundle or constructing an ad hoc object that
does not satisfy `HttpCaptureBundleSchema`.

Recovery:

- persist the exact `captureHttpArtifacts(...)` return value
- if custom code needs to transform payloads, decode through the shared schema
  again before persisting
- rerun:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts
bun run check:e3-capability-slice
```

### `PolicyViolation` says the bundle is not a one-to-one artifact/payload mapping

The current store rejects any bundle where artifact locator keys and payload
locator keys drift.

Recovery:

- confirm the bundle still has exactly one payload for each artifact locator
- do not drop `timings`, metadata, or HTML payloads before persistence
- rerun:

```bash
bun test tests/libs/foundation-core-capture-store.test.ts
bun test tests/libs/foundation-core-e3-runtime.test.ts
```

Do not "fix" this by silently writing a partial bundle.

### `readBundle(runId)` returns `Option.none()`

Current meaning:

- nothing was persisted for that `runId` in the current runtime instance

Checks:

- confirm `persistBundle(...)` ran before `readBundle(...)`
- confirm the same `runId` is used for both calls
- remember that the store is in-memory only, so process restart clears all
  persisted bundles

### Stored and reloaded key order drift from the expected locator order

The current store sorts by `<locator.namespace>/<locator.key>`, not by artifact
kind and not by original capture order.

Recovery:

- inspect `.storedCapture.bundle.artifacts[].locator.key`
- verify locators still use `captures/<plan.targetId>` plus `<plan.id>/...`
- rerun:

```bash
bun run example:e3-capability-slice | jq '[.storedCapture.bundle.artifacts[].locator.key]'
```

If ordering changed unintentionally, treat that as a deterministic contract
regression because downstream consumers can depend on stable readback.

### Secrets appear in persisted metadata payloads

That indicates the header sanitization path regressed before persistence.

Recovery:

- rerun:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts \
  --test-name-pattern "sanitizes secret-bearing request and response headers before persisting metadata"
```

- inspect `libs/foundation/core/src/http-access-runtime.ts`
  `sanitizeHttpHeaders(...)`
- do not promote until persisted request and response metadata replace sensitive
  header values with `[REDACTED]`

## Rollout Guidance

1. Prepare
- verify the focused persistence commands are green
- decide which caller owns the `runId`; the current contract expects
  `RunPlan.id`
- confirm whether the consumer needs metadata-only persistence through
  `CaptureStore.persist(...)` or full bundle readback through
  `capture-store-runtime`

2. Apply
- persist the exact `HttpCaptureBundle` returned by `captureHttpArtifacts(...)`
- read back using the same `runId`
- keep locator namespace and key generation unchanged
- keep request and response metadata on the sanitized path

3. Verify
- run:
  - `bun test tests/libs/foundation-core-capture-store.test.ts`
  - `bun run check:e3-capability-slice`
  - `bun run check:e3-access-runtime`
- inspect:
  - `.storedCapture.bundle.artifacts[].locator.key`
  - `.reloadedCapture.bundle.artifacts[].locator.key`
  - `tmp/e3-capture-store-scorecard.json` or
    `docs/artifacts/e3-access-runtime-scorecard.json`
- confirm:
  - stored and reloaded bundles match
  - benchmark status stays `pass`
  - metadata payloads remain redacted

4. Promote
- run full repository gates
- merge only when focused E3 checks and full gates are green

## Rollback Guidance

1. Restore the last known-good caller integration first.
- if the regression came from a new persistence hook, stop invoking
  `persistBundle(...)` / `readBundle(...)` for that caller
- if the regression came from bundle construction, restore the last known-good
  `captureHttpArtifacts(...)` path

2. Revert the runtime change if deterministic keying, payload mapping, or
   redaction regressed.

3. If bad in-memory state must be cleared after evidence capture, recycle the
   runtime instance or process.
- the current store keeps state only in local `Ref`s
- restart clears stored bundles for all runs in that process

4. Re-run:

```bash
bun test tests/libs/foundation-core-capture-store.test.ts
bun test tests/libs/foundation-core-e3-runtime.test.ts
bun test tests/examples/e3-capability-slice.test.ts
bun run check:e3-capability-slice
bun run check:e3-access-runtime
```

5. Before re-promoting, rerun the full repository gates:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

Forbidden rollback shortcuts:

- changing the run ID shape without updating the shared schema contract
- dropping artifacts or payloads to make one-to-one mapping checks pass
- treating process restart as a substitute for fixing decode or redaction bugs
- claiming rollback is complete without rerunning the targeted E3 checks
