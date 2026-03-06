# E1 Access Policy Schema Runbook

## Purpose

Use this runbook when operators, SDK consumers, or planner authors need to
validate or troubleshoot canonical `AccessPolicy`, `AccessMode`, and
`RenderingPolicy` contracts in `@effect-scrapling/foundation-core`.

This schema boundary exists to keep access strategy, rendering expectations, and
concurrency budgets explicit before any access planner or runtime service makes
execution decisions.

Policy baseline:
- Effect v4 only.
- No Effect v3 dependencies or compatibility shims.
- No manual tag inspection, `instanceof`, or type-safety bypass shortcuts.

## Public Contract

Current exports:
- `AccessModeSchema`
- `RenderingPolicySchema`
- `AccessPolicySchema`
- `CanonicalIdentifierSchema`

Field bounds:
- `perDomainConcurrency`: integer `1..128`
- `globalConcurrency`: integer `1..4096`
- `timeoutMs`: integer `100..600000`
- `maxRetries`: integer `0..10`

Additional invariants:
- `globalConcurrency >= perDomainConcurrency`
- `http` mode only supports `render: "never"`
- non-HTTP modes reject `render: "never"`

Supported mode/render combinations:

| Mode | Supported render values |
| --- | --- |
| `http` | `never` |
| `browser` | `onDemand`, `always` |
| `hybrid` | `onDemand`, `always` |
| `managed` | `onDemand`, `always` |

Note: higher-level allow-listing for managed execution belongs in planner or
service policy code, not in this schema contract.

## Command Usage

Run targeted verification from repository root:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts
bun test tests/guardrails/e1-capability-slice.verify.test.ts
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
import { AccessPolicySchema } from "@effect-scrapling/foundation-core";

const accessPolicy = Schema.decodeUnknownSync(AccessPolicySchema)({
  id: "policy-browser-fallback",
  mode: "browser",
  perDomainConcurrency: 8,
  globalConcurrency: 64,
  timeoutMs: 30000,
  maxRetries: 3,
  render: "always",
});
```

Expected behavior:
- decode succeeds only for supported mode/render combinations
- budget and retry bounds fail fast at the schema boundary
- encode returns a stable transport payload for CLI, SDK, and workflow use

## Troubleshooting

### HTTP policies fail render validation

`http` mode accepts only `render: "never"`. If a caller requests rendering,
switch to `browser`, `hybrid`, or `managed` explicitly instead of weakening the
schema.

### Browser, hybrid, or managed policies fail render validation

Non-HTTP modes reject `render: "never"`. If a caller wants no rendering, use
`http` mode or revisit the planner contract intentionally with matching schema
and test updates.

### Concurrency or timeout validation fails

Check the bounded values first:
- `perDomainConcurrency >= 1`
- `globalConcurrency >= perDomainConcurrency`
- `globalConcurrency <= 4096`
- `timeoutMs` between `100` and `600000`
- `maxRetries` between `0` and `10`

Do not silently clamp values. Fix the upstream source and keep the schema strict.

## Rollout Guidance

1. Prepare
- update planners and config producers to emit only supported mode/render pairs
- verify the runtime path with `bun test tests/guardrails/e1-capability-slice.verify.test.ts`

2. Apply
- decode policy payloads through `AccessPolicySchema`
- remove ad hoc policy coercion or fallback render logic

3. Verify
- run targeted tests
- run touched-project typechecks
- run `bun run check`

4. Promote
- merge only when the access runtime and capability slice are green

## Rollback Guidance

1. Revert the producer change that introduced invalid policy payloads or numeric
   budgets.
2. Re-run:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts
bun test tests/guardrails/e1-capability-slice.verify.test.ts
bun run check
```

3. Keep the schema invariants intact; do not introduce fallback matrix handling
   or silent numeric coercion to force green runs.
4. Re-attempt rollout only after producers emit compliant access policy payloads.

## Operator Notes

- Use schema failures to surface contract drift early in planners and config
  producers.
- Keep managed-mode authorization checks in higher-level services rather than
  hiding them inside schema side effects.
- Effect v4 only remains mandatory for any future access policy extensions.
