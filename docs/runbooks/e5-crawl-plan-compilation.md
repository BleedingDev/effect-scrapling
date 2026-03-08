# E5 Crawl Plan Compilation Runbook

## Purpose

Use this runbook when operators or SDK consumers need to validate or
troubleshoot the E5 crawl-plan compilation surface that turns target, pack, and
access-policy inputs into deterministic durable workflow plans.

This runbook is intentionally limited to behavior that exists today in:

- `libs/foundation/core/src/crawl-plan-runtime.ts`
- `tests/libs/foundation-core-crawl-plan-runtime.test.ts`

## Current Contract Surface

There is no standalone CLI or API wrapper for crawl-plan compilation today.

The supported surfaces are:

- `compileCrawlPlans(input)`
- `compileCrawlPlan(input)`
- `CrawlPlanCompiler`

Current contract guarantees:

- compiler input is schema-decoded through shared contracts
- entries are compiled in deterministic order by priority, domain,
  `canonicalKey`, and `id`
- every compiled plan gets a canonical durable workflow graph with
  `capture -> extract -> snapshot -> diff -> quality -> reflect`
- every compiled plan includes an initial durable checkpoint
- exact-domain and wildcard domain pack patterns are both supported
- resolved config must preserve `targetId`, `packId`, and `accessPolicyId`
- resolved entry URLs must stay inside both the target domain and the pack
  domain pattern

## Practical Execution

Run the focused compiler suite:

```bash
bun test tests/libs/foundation-core-crawl-plan-runtime.test.ts
```

Run the full repository gates when validating a candidate compiler change:

```bash
bun run check
bun run nx:typecheck
bun run nx:build
```

The focused suite currently proves:

- deterministic compilation from identical and reordered inputs
- helper and service surfaces agree on emitted plans
- exact-domain pack support
- malformed-input rejection
- ownership drift rejection
- domain escape and access-policy compatibility rejection

## Troubleshooting

### Compilation fails through shared-contract decode

The input no longer matches `CrawlPlanCompilerInputSchema`. Fix the upstream
input shape before treating this as a planner bug.

### Compilation fails before planning because the entry set is invalid

The compiler requires at least one entry and unique `target.id` values across
the batch. If the shared-contract decode fails before planning starts, check for
an empty `entries` array or duplicate target identifiers first.

### Compilation fails because the target lacks a seed URL

The compiler requires at least one seed URL per target in order to derive the
initial entry URL.

### Compilation fails because identifiers drift

The resolved run config must preserve the entry target, pack, and access-policy
identity. Do not patch around this in downstream consumers; fix the input or
config override.

### Compilation fails because the entry URL escapes the target or pack domain

The resolved entry URL must remain inside both the target domain and the pack
domain pattern. Treat that as a boundary violation, not as a compiler feature.

### Compilation fails because target, pack, and access policy identities drift

Each entry must keep `target.packId === pack.id`, and the target profile, site
pack, and access policy must agree on the same `accessPolicyId`. If those
identities drift, fix the source entry instead of trying to coerce the compiler
into accepting mismatched ownership.

### Compilation fails because the target domain does not match the pack pattern

The target domain must satisfy the provided `pack.domainPattern` before
planning starts. If those disagree, fix the pack or target fixture rather than
trying to override the planner boundary.

### Compilation fails because the resolved config violates the access policy contract

Resolved overrides still have to decode through the shared `AccessPolicySchema`.
If a candidate override breaks mode, render, timeout, or concurrency invariants,
fix the override instead of weakening compiler validation.

## Rollout And Rollback

Use this sequence before promoting a compiler change:

1. Run the focused crawl-plan compiler suite.
2. Confirm deterministic ordering and fail-path coverage still hold.
3. Run the full repository gates.
4. Keep the failing input fixture unchanged if any gate fails.

Rollback guidance:

- if emitted plans stop being reproducible from reordered inputs, roll back
  immediately because downstream durable workflow behavior stops being
  deterministic
- if config overrides start mutating identity fields or escaping domains, roll
  back rather than weakening shared-contract validation
- if resolved overrides stop satisfying the access-policy contract, roll back
  the candidate change instead of bypassing schema validation
