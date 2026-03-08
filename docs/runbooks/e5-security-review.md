# E5 Security Review

## Purpose

Review the E5 durable workflow orchestration slice for unsafe crawl-plan input,
operator-control tampering, and durable-state sanitization gaps before
promotion.

This review covers:

- `libs/foundation/core/src/crawl-plan-runtime.ts`
- `libs/foundation/core/src/durable-workflow-runtime.ts`
- `libs/foundation/core/src/run-state.ts`
- `tests/libs/foundation-core-crawl-plan-runtime.test.ts`
- `tests/libs/foundation-core-durable-workflow-runtime.test.ts`

## Threat Checklist

| Threat | Status | Control |
| --- | --- | --- |
| Credential-bearing or fragment-bearing `entryUrl` overrides smuggle secrets into durable plans | Mitigated | `RunExecutionConfigOverrideSchema` uses `CanonicalHttpUrlSchema`, so `compileCrawlPlans(...)` rejects those overrides before a plan is emitted |
| Operator controls infer graph state from a missing or tampered `resumeToken` | Mitigated | `cancelRun(...)`, `resumeRun(...)`, and `replayRun(...)` all restore from the persisted checkpoint boundary only when `resumeToken` exists and decodes through `WorkflowResumeContextSchema` |
| Replay or resume continues from graph-drifted durable state | Mitigated | checkpoint restore validates the latest checkpoint against the canonical encoded plan before work resumes or replay begins |
| Cancelled or failed runs are resumed implicitly through operator controls | Mitigated | `resumeRun(...)` rejects cancelled and failed checkpoints, while `retryRun(...)` is explicitly gated on a retryable failure envelope |
| Direct checkpoint-store writes forge a fully self-consistent checkpoint plus `resumeToken` | Residual risk | the runtime validates schemas and graph alignment, but it does not cryptographically sign persisted resume tokens |

## Findings

### Fixed in this review

- Medium severity coverage gap: the E5 runtime already failed closed on unsafe
  compiler overrides and corrupted resume tokens, but the slice lacked explicit
  proof that:
  - credential-bearing and fragment-bearing `entryUrl` overrides are rejected
    through the real `compileCrawlPlans(...)` surface
  - `cancelRun(...)`, `resumeRun(...)`, and `replayRun(...)` all reject missing
    or tampered latest `resumeToken` state through the real `WorkflowRunner`
    surface
- Added those proof points in the owned E5 runtime suites and cited them in the
  E5 runbooks.

### Current severity summary

- Open high-severity findings: none
- Open medium-severity findings: none inside the current E5 slice after the
  coverage hardening above
- Residual risk: checkpoint-store integrity remains a trust boundary because
  `resumeToken` is JSON-encoded and schema-validated, but not signed. Manual row
  edits or unauthorized storage writes can still create self-consistent state
  outside the in-process controls.

## Verification Evidence

- `tests/libs/foundation-core-crawl-plan-runtime.test.ts` proves that
  `compileCrawlPlans(...)` rejects credential-bearing and fragment-bearing
  `entryUrl` overrides through shared contracts, while preserving existing
  ownership and domain-boundary checks.
- `tests/libs/foundation-core-durable-workflow-runtime.test.ts` proves that the
  real `WorkflowRunner.cancelRun(...)`, `WorkflowRunner.replayRun(...)`, and
  `WorkflowRunner.resumeRun(...)` surfaces all reject latest checkpoints whose
  `resumeToken` is missing or corrupted.
- The same durable-workflow suite already proves the neighboring integrity
  guards that matter for E5 security review:
  - malformed run ids are rejected through shared contracts
  - replay and inspection reject graph-order drift
  - failed and cancelled checkpoints remain gated behind explicit operator
    intent

## Operator Guidance

1. Treat any change to `CanonicalHttpUrlSchema`,
   `RunExecutionConfigOverrideSchema`, `restoreExecutionState(...)`,
   `startReplay(...)`, or the checkpoint-store adapters as security-sensitive.
2. Re-run the focused proof suites after any E5 compiler or control-surface
   change:

```bash
bun run check:e5-security-review
bun test tests/libs/foundation-core-crawl-plan-runtime.test.ts
bun test tests/libs/foundation-core-durable-workflow-runtime.test.ts
```

3. Do not manually repair a checkpoint by deleting or rewriting `resumeToken`.
   Recover from a trusted backup or replay from a known-good lineage instead.
4. Re-run the repository security and release gates before promotion:
   `ultracite`, `oxlint`, `oxfmt`, tests, and build.

## Rollback Guidance

1. Revert the offending compiler, checkpoint-store, or workflow-runtime change
   rather than weakening the URL or resume-token guards.
2. Re-run:

```bash
bun test tests/libs/foundation-core-crawl-plan-runtime.test.ts
bun test tests/libs/foundation-core-durable-workflow-runtime.test.ts
```

3. Do not roll back by:
   - accepting credential-bearing or fragment-bearing `entryUrl` overrides
   - treating missing `resumeToken` state as optional during cancel, replay, or
     resume controls
   - bypassing schema validation, graph validation, or retry/cancel outcome
     guards
   - introducing manual `instanceof`, manual `_tag`, unsafe casts, or Effect v3
     compatibility code
