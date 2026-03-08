# E7 Security Review

## Purpose

Use this runbook when validating the E7 quality lane for authorization,
evidence-integrity, and sanitization failures before promotion.

This review is currently enforced by:

- guardrail test: `tests/guardrails/e7-security-review.verify.test.ts`
- command: `bun run check:e7-security-review`

## What This Review Covers

The current E7 security lane verifies:

1. live-canary scenarios reject unauthorized or malformed seed URLs before
   execution
2. quality-report export refuses chaos evidence that lost deterministic planner
   rationale traces
3. promotion and report generation keep evidence integrity strict instead of
   tolerating ambiguous or forged inputs

## Commands

Run the focused security review:

```bash
bun run check:e7-security-review
```

Run the underlying guardrail directly:

```bash
bun test tests/guardrails/e7-security-review.verify.test.ts
```

## Current Expectations

- unauthorized canary targets must fail before any evaluation completes
- quality report export must fail when planner rationale traces are missing
- failures must stay typed and deterministic instead of silently degrading to a
  partial report

## Troubleshooting

### A live-canary scenario unexpectedly succeeds

Inspect the target seed URL first. E7 canary scenarios are restricted to:

- `https`
- no credentials
- no fragments
- no host escape outside the declared target domain

### The quality report export fails on planner rationale integrity

Treat that as corrupted or incomplete chaos evidence. Fix the upstream chaos
producer; do not patch the emitted report or drop the failing section.
