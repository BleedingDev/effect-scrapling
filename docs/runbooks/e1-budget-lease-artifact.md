# E1 Budget, Lease, and Artifact Schema Runbook

## Purpose

Use this runbook when operators, SDK consumers, or workflow authors need to
validate or troubleshoot canonical `ConcurrencyBudget`, `EgressLease`,
`IdentityLease`, and `ArtifactRef` contracts in
`@effect-scrapling/foundation-core`.

These contracts keep run-state resources explicit before workflow orchestration,
access runtime, or artifact export code persists them.

Policy baseline:
- Effect v4 only.
- No Effect v3 dependencies or compatibility shims.
- No manual `instanceof`, manual `_tag`, or type-safety bypass shortcuts.

## Public Contract

Current exports:
- `ConcurrencyBudgetSchema`
- `EgressLease`
- `EgressLeaseSchema`
- `IdentityLease`
- `IdentityLeaseSchema`
- `ArtifactRef`
- `ArtifactRefSchema`
- `ArtifactKindSchema`
- `ArtifactVisibilitySchema`

Canonical expectations:
- `id`, `ownerId`, `runId`, `egressKey`, and `identityKey` must be canonical,
  whitespace-free identifiers.
- `globalConcurrency` is bounded to `1..4096`.
- `maxPerDomain` is bounded to `1..128`.
- `globalConcurrency >= maxPerDomain`.
- lease `expiresAt` values must be strict UTC ISO timestamps.
- `ArtifactRef.visibility` is explicitly `raw` or `redacted`.
- `ArtifactRef.locator` must be trimmed and non-empty.

Supported artifact kinds:
- `requestMetadata`
- `responseMetadata`
- `html`
- `renderedDom`
- `screenshot`
- `timings`

Supported artifact visibility:
- `raw`
- `redacted`

Operational posture from the current schema plus PLAN guidance:
- the schema enforces the `raw` versus `redacted` label only
- storage and export flows must keep raw and redacted artifacts separate
- redacted export is the default operating posture

## Command Usage

Run repository-root validation:

```bash
bun test tests/libs/foundation-core-run-state.test.ts
```

Run touched-project compilation checks:

```bash
bunx --bun tsc --noEmit -p libs/foundation/core/tsconfig.json
bunx --bun tsc --noEmit -p apps/api/tsconfig.json
bunx --bun tsc --noEmit -p apps/cli/tsconfig.json
```

Run the full repository gates before closure:

```bash
bun run check
bun run nx:show-projects
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

## Practical Example

```ts
import { Schema } from "effect";
import {
  ArtifactRefSchema,
  ConcurrencyBudgetSchema,
  EgressLeaseSchema,
  IdentityLeaseSchema,
} from "@effect-scrapling/foundation-core";

const budget = Schema.decodeUnknownSync(ConcurrencyBudgetSchema)({
  id: "budget-run-001",
  ownerId: "run-001",
  globalConcurrency: 120,
  maxPerDomain: 8,
});

const lease = Schema.decodeUnknownSync(EgressLeaseSchema)({
  id: "egress-lease-001",
  ownerId: "run-001",
  egressKey: "egress-pool-primary",
  expiresAt: "2026-03-06T00:05:00.000Z",
});

const identityLease = Schema.decodeUnknownSync(IdentityLeaseSchema)({
  id: "identity-lease-001",
  ownerId: "run-001",
  identityKey: "identity-browser-eu-1",
  expiresAt: "2026-03-06T00:05:00.000Z",
});

const artifact = Schema.decodeUnknownSync(ArtifactRefSchema)({
  id: "artifact-html-001",
  ownerId: "run-001",
  runId: "run-001",
  kind: "html",
  visibility: "redacted",
  locator: ".sf/artifacts/run-001/page.html",
});
```

## Troubleshooting

### Budget validation fails

Check these first:
- `globalConcurrency >= 1`
- `globalConcurrency <= 4096`
- `maxPerDomain >= 1`
- `maxPerDomain <= 128`
- `globalConcurrency >= maxPerDomain`

Do not silently clamp values. Fix the planner or config source instead.

### Lease validation fails

Common failures:
- missing or empty `ownerId`
- malformed `egressKey` or `identityKey`
- invalid UTC timestamp strings

Lease ownership is required. Do not substitute anonymous ownership or parse
non-deterministic timestamps at the boundary.

### Artifact validation fails

Check whether:
- `kind` is outside the supported artifact set
- `visibility` is missing or invalid
- `locator` is empty

Raw and redacted artifacts are intentionally explicit so export flows cannot
blur those classes accidentally.

### Raw versus redacted handling drifts

The schema labels visibility, but it does not itself move or sanitize artifact
payloads. Keep the operating posture explicit:
- store raw and redacted artifacts separately
- use redacted export as the default path
- keep raw artifact access restricted to the workflows that require it

Do not relabel a raw artifact as `redacted` to push an export through.

### Consumer code adds manual `instanceof` or manual `_tag` checks

That is a policy violation. Decode through the public schemas and use typed
Effect error handling instead of manual class or tag inspection.

## Rollout Guidance

1. Prepare
- update workflow and persistence code to decode through shared schema exports
- validate representative payloads with
  `bun test tests/libs/foundation-core-run-state.test.ts`

2. Apply
- persist only canonical budget, lease, and artifact payloads
- remove parallel ad hoc DTO validation around workflow resource records
- keep raw versus redacted routing explicit in storage and export flows

3. Verify
- run targeted tests
- run touched-project typechecks
- run `bun run check`

4. Promote
- merge only when run-state tests and full gates are green

## Rollback Guidance

1. Revert the producer change that started emitting invalid budget, lease, or
   artifact payloads.
2. Re-run:

```bash
bun test tests/libs/foundation-core-run-state.test.ts
bun run check
```

3. Keep the canonical schemas intact; do not add fallback parsing, manual
   `instanceof`, or manual `_tag` checks to force bad state through.
4. If rollout affected artifact exposure, restore the last known-good
   redacted-first path before re-enabling broader artifact access.
5. Re-attempt rollout only after the source payloads are fixed and the shared
   contracts are green again.

## Operator Notes

- Treat invalid run-state payloads as contract drift, not recoverable noise.
- Preserve explicit raw versus redacted artifact visibility through export flows.
- `ownerId` is required on budgets, leases, and artifact references so runtime
  ownership stays explicit.
- Effect v4 only remains mandatory for future run-state schema extensions.
