# E2 Assertion Engine

## Purpose

Operate and troubleshoot the E2 assertion boundary that enforces required-field
coverage, minimum-confidence rules, and business invariants on assembled
snapshots.

Primary implementation and validation surfaces:

- `libs/foundation/core/src/assertion-engine.ts`
- `tests/libs/foundation-core-assertion-engine.test.ts`
- `tests/guardrails/e2-security-review.verify.test.ts`
- `docs/runbooks/e2-extractor-orchestration.md`

## Contract

`runAssertionEngine(...)` accepts a decoded snapshot plus:

- `requiredFields`
- `businessInvariants`

Current guarantees:

- failures are typed through `AssertionEngineFailure`
- each emitted failure keeps concrete field context
- evidence references remain attached to the failure context
- decode failures are surfaced as structured failures instead of raw exceptions
- secret-bearing observed values are not echoed into failure messages

Current failure kinds:

- `missingRequiredField`
- `businessInvariantFailure`

Current examples proven by `tests/libs/foundation-core-assertion-engine.test.ts`:

- complete snapshots return:
  - `snapshotId`
  - `evaluatedRuleCount`
  - `assertedFields`
- low-confidence required fields emit:
  - `businessInvariantFailure`
  - concrete `snapshotId`
  - concrete `field`
  - preserved `evidenceRefs`
- missing required fields emit:
  - `missingRequiredField`
  - empty `evidenceRefs` when the field was never observed
- numeric-range and string-one-of rules preserve the originating evidence refs
- secret-bearing normalized values are intentionally omitted from messages
- invalid engine input still returns a typed failure envelope

## Validation Commands

Focused assertion validation:

```bash
bun test tests/libs/foundation-core-assertion-engine.test.ts
```

Security regression coverage:

```bash
bun test tests/guardrails/e2-security-review.verify.test.ts
```

Integrated E2 replay:

```bash
bun run check:e2-capability-slice
bun run check:e2-sdk-consumer
```

## Operator Workflow

### 1. Validate the direct assertion boundary

Run:

```bash
bun test tests/libs/foundation-core-assertion-engine.test.ts
```

This suite currently proves:

- successful required-field and invariant evaluation for complete snapshots
- missing-field reporting with field-level context
- low-confidence reporting with the exact evidence reference that triggered it
- invariant violations without leaking observed normalized values
- structured decode failures for malformed assertion-engine input

### 2. Re-run the E2 security review on any assertion-message change

Run:

```bash
bun run check:e2-security-review
```

Treat any change to assertion messages or public extraction summaries as
security-sensitive. This is the guardrail that prevents value leakage back into
public envelopes.

### 3. Confirm the integrated orchestration path

Run:

```bash
bun run check:e2-capability-slice
bun run check:e2-sdk-consumer
```

The focused suite proves the direct contract. The integrated commands prove the
same behavior survives extractor orchestration and the public SDK example.

## Reading Failures

Use the failure `kind` plus `context` as the diagnostic boundary:

- `missingRequiredField` means the field was absent from the snapshot
- `businessInvariantFailure` means the field existed but violated confidence or
  invariant expectations

Always inspect:

- `context.snapshotId`
- `context.field`
- `context.evidenceRefs`

Do not reconstruct failures from logs or from raw capture payloads when the
typed context is already sufficient.

## Troubleshooting

### A required field now fails on confidence

Confirm whether selector relocation lowered confidence before relaxing the
assertion. The assertion engine is downstream from selector resolution and
should not hide degraded extraction quality.

Check:

```bash
bun test tests/libs/foundation-core-e2-runtime.test.ts
bun test tests/libs/foundation-core-extractor-runtime.test.ts
```

### A business invariant suddenly fails after normalization changes

Distinguish between:

- a real normalized-value change
- a bad assertion threshold
- upstream selector drift that produced the wrong normalized input

Validate the normalizer and selector boundaries before changing the invariant:

```bash
bun test tests/libs/foundation-core-domain-normalizers.test.ts
bun test tests/libs/foundation-core-e2-runtime.test.ts
```

### The failure message seems too vague

Preserve the current rule:

- keep field and evidence context
- do not embed captured values

Add specificity through typed context or threshold wording, not through raw
observed payload replay.

## Rollout and Rollback

Roll forward only after:

```bash
bun test tests/libs/foundation-core-assertion-engine.test.ts
bun run check:e2-security-review
bun run check:e2-capability-slice
bun run check:e2-sdk-consumer
```

Rollback by reverting the assertion change and rerunning the same commands.

Do not roll back by:

- embedding normalized values back into failure messages
- converting failures to untyped exceptions
- dropping `evidenceRefs` from the failure context
- introducing manual `_tag`, `instanceof`, or unsafe casts
