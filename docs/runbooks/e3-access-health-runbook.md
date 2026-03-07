# E3 Access Health Telemetry And Quarantine Runbook

## Purpose

Use this runbook when operators or SDK consumers need to validate, observe, or
troubleshoot the E3 access-health runtime in:

- `libs/foundation/core/src/access-health-runtime.ts`
- `examples/e3-capability-slice.ts`

This document is intentionally limited to the behavior that exists today. It
does not assume persisted telemetry, shared cross-process quarantine state,
automatic enforcement outside explicit caller checks, or automatic restore on
clock expiry alone.

Policy baseline:

- Effect v4 only.
- Subjects and policies are decoded through shared schemas before mutation.
- Health state and event history are in-memory per runtime instance.
- Quarantine only blocks execution where the caller explicitly invokes
  `assertHealthy(...)`.

## Current Runtime Contract

Current access-health exports:

- `DomainHealthSubject`
- `ProviderHealthSubject`
- `IdentityHealthSubject`
- `AccessHealthPolicy`
- `AccessHealthSnapshot`
- `AccessHealthEvent`
- `AccessPathQuarantined`
- `makeInMemoryAccessHealthRuntime`

Current subject shapes:

- domain subject:

```ts
{
  kind: "domain",
  domain: "example.com",
}
```

- provider subject:

```ts
{
  kind: "provider",
  providerId: "provider-http-main",
}
```

- identity subject:

```ts
{
  kind: "identity",
  tenantId: "tenant-main",
  domain: "example.com",
  identityKey: "identity-a",
}
```

Current policy shape:

```ts
{
  failureThreshold: 2,
  recoveryThreshold: 2,
  quarantineMs: 1_000,
}
```

Schema rules enforced by the runtime:

- `failureThreshold` and `recoveryThreshold` must be integers in `1..16`.
- `quarantineMs` must be an integer in `100..600000`.
- domains must satisfy the canonical-domain schema.
- provider and identity identifiers must satisfy the canonical-identifier
  schema.

Snapshot fields:

- `successCount`
- `failureCount`
- `successStreak`
- `failureStreak`
- `score`
- `quarantinedUntil`

What the runtime does now:

- `inspect(subject)` returns a typed snapshot for the subject.
- unseen subjects start with:
  - zero success and failure counts
  - zero success and failure streaks
  - `score = 100`
  - `quarantinedUntil = null`
- `score` is computed as:
  - `100` when the subject has no history
  - otherwise `successCount / (successCount + failureCount) * 100`, rounded to
    two decimals
- `recordFailure(subject, policy, reason)`:
  - increments `failureCount`
  - increments `failureStreak`
  - resets `successStreak` to `0`
  - emits a `failure` event
  - sets `quarantinedUntil = now + quarantineMs` once
    `failureStreak >= failureThreshold`
  - emits a `quarantined` event whenever the returned snapshot is quarantined
- `recordSuccess(subject, policy)`:
  - increments `successCount`
  - increments `successStreak`
  - resets `failureStreak` to `0`
  - emits a `success` event
  - clears `quarantinedUntil` only when:
    - the subject was already quarantined
    - `quarantinedUntil <= now`
    - the new `successStreak >= recoveryThreshold`
  - emits a `restored` event only on the transition where
    `quarantinedUntil` becomes `null`
- repeated failures after the threshold keep rewriting `quarantinedUntil`, so
  an unhealthy subject can extend its own quarantine window.
- `events()` returns the append-only event list for the current runtime scope.

Current event fields:

- `kind`
- `subject`
- `score`
- `quarantinedUntil`
- `reason`
- `recordedAt`

Current event kinds:

- `success`
- `failure`
- `quarantined`
- `restored`

## `assertHealthy(...)` Usage

`assertHealthy(subject)` is the enforcement boundary. It first inspects the
subject and then:

- fails with `AccessPathQuarantined` when
  `snapshot.quarantinedUntil > now`
- returns the current snapshot otherwise

The error carries:

- `subjectKey`
- `quarantinedUntil`
- `message`

Current `subjectKey` formats:

- domain: `["domain","example.com"]`
- provider: `["provider","provider-http-main"]`
- identity: `["identity","tenant-main","example.com","identity-a"]`

The runtime uses JSON array encoding for the key, so separator characters inside
identity values do not collide with each other. The unit test explicitly keeps
`tenant|main` distinct from `tenant` plus `main|identity-a`.

Important current behavior:

- an expired quarantine no longer blocks `assertHealthy(...)`
- the snapshot may still contain a non-null `quarantinedUntil` after expiry
- the runtime does not emit `restored` on expiry alone
- the caller must record enough post-expiry successes to clear the quarantine
  and emit `restored`

Current E3 caller pattern from `examples/e3-capability-slice.ts`:

```ts
yield* healthRuntime.assertHealthy(domainHealthSubject);
yield* healthRuntime.assertHealthy(providerHealthSubject);
yield* healthRuntime.assertHealthy(identityHealthSubject);

const captureBundle = yield* captureHttpArtifacts(...);

const domainHealth = yield* healthRuntime.recordSuccess(domainHealthSubject, healthPolicy);
const providerHealth = yield* healthRuntime.recordSuccess(providerHealthSubject, healthPolicy);
const identityHealth = yield* healthRuntime.recordSuccess(identityHealthSubject, healthPolicy);
```

Use the same pattern in real callers:

1. `assertHealthy(...)` before the risky access step.
2. `recordFailure(...)` on bounded access failures with a stable reason string.
3. `recordSuccess(...)` only after the access attempt succeeds.

## Command Usage

Run targeted verification from repository root:

```bash
bun test tests/libs/foundation-core-access-health.test.ts
bun test tests/examples/e3-capability-slice.test.ts
bun run example:e3-capability-slice
```

Run the existing E3 example test plus standalone example in one command:

```bash
bun run check:e3-capability-slice
```

Run full repository gates before bead closure or merge:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

Useful entrypoints:

- `examples/e3-capability-slice.ts`
- `tests/libs/foundation-core-access-health.test.ts`
- `tests/examples/e3-capability-slice.test.ts`

## Practical Execution Examples

### Reproduce quarantine and restore behavior

The unit test drives the current quarantine contract with:

```ts
let currentTime = new Date("2026-03-06T14:00:00.000Z");
const runtime = yield* makeInMemoryAccessHealthRuntime(() => currentTime);

yield* runtime.recordFailure(domainSubject, policy, "timeout");
yield* runtime.recordFailure(domainSubject, policy, "timeout");

const blocked = yield* runtime.assertHealthy(domainSubject).pipe(
  Effect.match({
    onFailure: ({ subjectKey, quarantinedUntil, message }) => ({
      subjectKey,
      quarantinedUntil,
      message,
    }),
    onSuccess: () => "unexpected-success",
  }),
);

currentTime = new Date("2026-03-06T14:00:02.500Z");
yield* runtime.recordSuccess(domainSubject, policy);
const restored = yield* runtime.recordSuccess(domainSubject, policy);
const events = yield* runtime.events();
```

What to expect:

- the second failure quarantines the subject
- `blocked.message` contains `quarantined`
- `blocked.subjectKey` is `["domain","example.com"]`
- `restored.quarantinedUntil` becomes `null` on the second recovery success
- the event kinds are:

```ts
["failure", "failure", "quarantined", "success", "success", "restored"]
```

The current deterministic values from the test flow are:

```json
[
  {
    "kind": "failure",
    "score": 0,
    "quarantinedUntil": null,
    "reason": "timeout"
  },
  {
    "kind": "failure",
    "score": 0,
    "quarantinedUntil": "2026-03-06T14:00:01.000Z",
    "reason": "timeout"
  },
  {
    "kind": "quarantined",
    "score": 0,
    "quarantinedUntil": "2026-03-06T14:00:01.000Z",
    "reason": "timeout"
  },
  {
    "kind": "success",
    "score": 33.33,
    "quarantinedUntil": "2026-03-06T14:00:01.000Z"
  },
  {
    "kind": "success",
    "score": 50,
    "quarantinedUntil": null
  },
  {
    "kind": "restored",
    "score": 50,
    "quarantinedUntil": null
  }
]
```

### Verify the healthy path in the E3 capability slice

Run:

```bash
bun run example:e3-capability-slice | jq '{domainHealth, providerHealth, identityHealth, healthEvents}'
```

What to look for:

- the example performs three `assertHealthy(...)` checks before capture
- `domainHealth.successCount = 1`
- `providerHealth.successCount = 1`
- `identityHealth.successCount = 1`
- all three snapshots report `quarantinedUntil = null`
- `healthEvents` contains only:

```ts
["success", "success", "success"]
```

This is the current healthy baseline. If the example starts emitting
`quarantined` or `restored`, the runtime behavior or the example flow changed.

### Capture and log a quarantine failure at the caller boundary

Use the tagged error directly instead of string parsing:

```ts
const accessGate = yield* healthRuntime.assertHealthy(domainHealthSubject).pipe(
  Effect.match({
    onFailure: ({ subjectKey, quarantinedUntil, message }) => ({
      blocked: true,
      subjectKey,
      quarantinedUntil,
      message,
    }),
    onSuccess: (snapshot) => ({
      blocked: false,
      score: snapshot.score,
      quarantinedUntil: snapshot.quarantinedUntil,
    }),
  }),
);
```

Use the returned payload to:

- fail fast before the access attempt
- log the exact quarantined subject granularity
- surface `quarantinedUntil` to operators or SDK consumers

## Troubleshooting

### `assertHealthy(...)` still blocks after the expected expiry time

Check these first:

- the caller and the runtime are using the same clock source
- the subject is identical to the one that was quarantined
- a later `recordFailure(...)` did not extend the quarantine window

Remember that the runtime blocks only while:

- `quarantinedUntil !== null`
- and `quarantinedUntil > now`

If any later failure was recorded after the threshold, the window moves forward.

### `assertHealthy(...)` stops blocking, but `quarantinedUntil` is still set

This is expected in the current implementation.

Why it happens:

- expiry only stops the guard from failing
- expiry does not clear the stored snapshot
- only `recordSuccess(...)` clears the quarantine
- `restored` is emitted only when a success call clears the field

Operational response:

1. run or wait for controlled recovery probes after the expiry time
2. call `recordSuccess(...)` on successful probes
3. verify `successStreak >= recoveryThreshold`
4. confirm a `restored` event was emitted

### `restored` never appears

Current causes:

- the subject never crossed the failure threshold
- the quarantine has not expired yet
- `recordSuccess(...)` is not being called after recovery
- the recovery streak has not reached `recoveryThreshold`

The current runtime does not emit `restored` for subjects that were never
quarantined.

### The runtime throws `PolicyViolation`

The runtime only throws `PolicyViolation` here when subject or policy decoding
fails.

Check:

- domain strings are canonical and lowercased
- provider and identity identifiers are non-empty canonical identifiers
- thresholds are in `1..16`
- `quarantineMs` is in `100..600000`

If the caller builds subjects dynamically, log the raw payload before the call
site and compare it against the subject examples in this runbook.

### Two identities appear to share health state unexpectedly

The current runtime keys identities by the full JSON tuple:

```ts
["identity", tenantId, domain, identityKey]
```

The unit test proves that embedded separator characters do not collide. If two
flows still merge, the caller is almost certainly reusing the same logical
identity tuple.

## Rollout And Rollback

### Rollout

1. Start with the current deterministic contract:
   - run `bun test tests/libs/foundation-core-access-health.test.ts`
   - run `bun run check:e3-capability-slice`
2. Wire `assertHealthy(...)` immediately before the access step you want to
   block. The current example does this for domain, provider, and identity
   checks right before HTTP capture.
3. Wire `recordFailure(...)` on access failures with stable operator-facing
   reason strings such as `timeout` or `proxy-reset`.
4. Wire `recordSuccess(...)` only after a successful access completes so the
   score and streaks remain meaningful.
5. Log or export `inspect(...)` and `events()` from the same runtime scope if
   operators need telemetry. The current implementation does not persist event
   history for you.
6. Treat the repo's `{ failureThreshold: 2, recoveryThreshold: 2, quarantineMs:
   1000 }` values as deterministic test and example settings, not as a
   production default.

### Rollback

1. If a rollout blocks too aggressively, disable or bypass the caller's
   `assertHealthy(...)` gate first. That stops hard blocking immediately without
   mutating historical telemetry.
2. If telemetry should stay active but quarantine should be softer, redeploy
   with a less aggressive `AccessHealthPolicy`.
3. If you must clear the in-memory quarantine state completely, recycle the
   runtime instance or process after capturing the evidence you need from
   `inspect(...)` and `events()`.
4. Re-run the targeted validation commands and one representative end-to-end
   flow after rollback.

Capture evidence before a restart. The current implementation stores state in
`Ref`s inside `makeInMemoryAccessHealthRuntime(...)`, so process recycle clears
both snapshots and event history.
