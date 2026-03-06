# E1 Tagged Errors Runbook

## Purpose

Use this runbook when operators, SDK consumers, or API/CLI authors need to
validate or troubleshoot the canonical tagged error hierarchy in
`@effect-scrapling/foundation-core`.

This contract keeps workflow and runtime failures discriminated, machine
readable, and routable without manual tag probing.

Policy baseline:
- Effect v4 only.
- No Effect v3 dependencies or compatibility shims.
- No manual `instanceof`, manual `_tag`, or type-safety bypass shortcuts.

## Public Contract

Current exports:
- `TimeoutError`
- `RenderCrashError`
- `ParserFailure`
- `ExtractionMismatch`
- `DriftDetected`
- `CheckpointCorruption`
- `PolicyViolation`
- `ProviderUnavailable`
- `CoreErrorCodeSchema`
- `CoreErrorEnvelopeSchema`
- `toCoreErrorEnvelope`

Stable machine-readable codes:
- `timeout`
- `render_crash`
- `parser_failure`
- `extraction_mismatch`
- `drift_detected`
- `checkpoint_corruption`
- `policy_violation`
- `provider_unavailable`

Retryable families:
- retryable: `timeout`, `render_crash`, `provider_unavailable`
- non-retryable: `parser_failure`, `extraction_mismatch`, `drift_detected`,
  `checkpoint_corruption`, `policy_violation`

## Command Usage

Run repository-root validation:

```bash
bun test tests/libs/foundation-core-run-state.test.ts
bun test tests/guardrails/e1-schema-runbooks.verify.test.ts
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
import {
  PolicyViolation,
  TimeoutError,
  toCoreErrorEnvelope,
} from "@effect-scrapling/foundation-core";

const timeoutEnvelope = toCoreErrorEnvelope(
  new TimeoutError({ message: "Timed out waiting for response" }),
);

const policyEnvelope = toCoreErrorEnvelope(
  new PolicyViolation({ message: "Execution policy denied access" }),
);
```

Expected behavior:
- consumers branch on `code` or `retryable` from the envelope, not on manual
  `_tag` inspection
- error families remain stable across CLI, API, and workflow adapters

## Troubleshooting

### Envelope mapping is inconsistent

Always project errors through `toCoreErrorEnvelope`. Do not duplicate mapping
tables in CLI or API handlers, because that drifts machine-readable codes over
time.

### Retry behavior looks wrong

Check the retryable family first:
- `timeout`
- `render_crash`
- `provider_unavailable`

The remaining error codes are intentionally non-retryable because the plan
treats them as policy, data, or integrity failures rather than transient noise.

### New tagged error is needed

Add the new class, extend `CoreErrorCodeSchema`, and update
`toCoreErrorEnvelope` in the same change. Do not route unknown runtime failures
through a generic fallback code if the failure reason is distinct.

## Rollout Guidance

1. Prepare
- update CLI, API, and workflow adapters to consume error envelopes
- verify representative mappings with
  `bun test tests/libs/foundation-core-run-state.test.ts`

2. Apply
- remove duplicate error-code translation logic from boundary handlers
- keep the shared foundation-core mapping as the single source of truth

3. Verify
- run targeted tests
- run touched-project typechecks
- run `bun run check`

4. Promote
- merge only when tagged error tests and full gates are green

## Rollback Guidance

1. Revert the change that introduced inconsistent codes, retryability flags, or
   divergent adapter mappings.
2. Re-run:

```bash
bun test tests/libs/foundation-core-run-state.test.ts
bun test tests/guardrails/e1-schema-runbooks.verify.test.ts
bun run check
```

3. Keep the shared tagged hierarchy intact; do not patch around regressions with
   manual `instanceof`, manual `_tag`, or ad hoc string matching in handlers.
4. Re-attempt rollout only after the shared envelope mapping is green again.

## Operator Notes

- Stable machine-readable codes are part of the public contract.
- Prefer explicit error families over generic fallback buckets.
- Effect v4 only remains mandatory for future tagged error extensions.
