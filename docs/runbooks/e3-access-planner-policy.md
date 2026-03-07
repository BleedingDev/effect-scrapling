# E3 Access Planner Policy

## Purpose

Operate and troubleshoot the E3 access-planner boundary that converts target,
site-pack, and access-policy inputs into deterministic run plans, concurrency
budgets, and explicit planner rationale.

Primary implementation and validation surfaces:

- `libs/foundation/core/src/access-planner-runtime.ts`
- `tests/libs/foundation-core-e3-runtime.test.ts`
- `tests/libs/foundation-core-access-retry.test.ts`
- `docs/runbooks/e3-http-access-execution.md`
- `docs/runbooks/e4-provider-selection.md`

## Contract

`planAccessExecution(...)` is schema-backed and deterministic.

Current guarantees:

- target, site pack, and access policy must agree on `packId` and
  `accessPolicyId`
- seed URLs must remain inside the target domain and pack pattern
- every decision emits:
  - `plan`
  - `concurrencyBudget`
  - ordered planner rationale keys:
    - `mode`
    - `rendering`
    - `budget`
    - `capture-path`
- low-friction HTTP and eligible hybrid traffic stay on the HTTP-first path
- browser-backed capture is selected only when policy or escalation evidence
  requires it

Current examples proven by `tests/libs/foundation-core-e3-runtime.test.ts`:

- `mode: "http"` keeps capture on the HTTP provider
- low-friction `hybrid` blog-post traffic stays HTTP-first
- `hybrid` plus `render: "always"` escalates to browser
- `browser` and `managed` modes always require browser-backed capture
- high-friction targets escalate to browser
- repeated or browser-worthy failures escalate hybrid traffic to browser with
  explicit rationale
- invalid domain, pack, or policy alignment fails through `PolicyViolation`

## Validation Commands

Focused planner validation:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts
```

Retry-context validation:

```bash
bun test tests/libs/foundation-core-access-retry.test.ts
```

Integrated E3 replay:

```bash
bun run check:e3-capability-slice
bun run check:e3-access-runtime
```

## Operator Workflow

### 1. Validate the direct planner contract

Run:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts
```

This suite currently proves:

- identical inputs yield identical decisions
- concurrency budgets are explicit
- rationale keys stay ordered and stable
- policy-domain drift fails before capture execution starts

### 2. Inspect browser escalation as policy evidence, not a surprise

When a plan switches to browser-backed capture, use the `capture-path`
rationale entry first.

The current planner escalates when:

- the access mode is already `browser`
- the access mode is `managed`
- `hybrid` requires `render: "always"`
- `hybrid` sees high-friction target kinds
- `hybrid` sees repeated or browser-worthy failure context

If you need deeper browser-path semantics, continue with:

```text
docs/runbooks/e4-provider-selection.md
```

### 3. Confirm the planner still composes with retry and benchmark signals

Run:

```bash
bun test tests/libs/foundation-core-access-retry.test.ts
bun run check:e3-access-runtime
```

This proves the access planner still produces plans that the real E3 runtime
can execute and benchmark deterministically.

## Troubleshooting

### The planner rejects a target before capture starts

Most direct causes:

- target domain does not match the site-pack pattern
- `packId` drift between target and pack
- `accessPolicyId` drift between target, pack, and policy
- seed URL host escapes the target domain

These should remain terminal `PolicyViolation` failures. Do not weaken them.

### Hybrid traffic unexpectedly escalated to browser

Inspect:

- target kind
- `render` mode
- failure context
- `capture-path` rationale message

If the escalation is policy-correct, keep it. If the rationale is wrong, fix
the planner logic instead of overriding the plan downstream.

### HTTP capture rejects the plan as browser-required

That usually means the planner is correct and the wrong runtime was chosen.

Continue with:

```text
docs/runbooks/e3-http-access-execution.md
```

## Rollout and Rollback

Roll forward only after:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts
bun test tests/libs/foundation-core-access-retry.test.ts
bun run check:e3-capability-slice
bun run check:e3-access-runtime
```

Rollback by reverting the planner change and rerunning the same commands.

Do not roll back by:

- defaulting more traffic to browser without explicit rationale
- bypassing domain and policy alignment checks
- hiding planner rationale from the decision surface
- introducing manual `_tag`, `instanceof`, or unsafe casts
