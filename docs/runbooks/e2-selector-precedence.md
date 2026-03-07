# E2 Selector Precedence

## Purpose

Operate and troubleshoot the deterministic selector-ordering boundary used by
the E2 extraction runtime.

Primary implementation and validation surfaces:

- `libs/foundation/core/src/selector-engine.ts`
- `tests/libs/foundation-core-e2-runtime.test.ts`
- `tests/libs/foundation-core-extractor-runtime.test.ts`
- `tests/libs/foundation-core-evidence-manifest.test.ts`

## Contract

`resolveSelectorPrecedence(...)` evaluates selector candidates in configured
order and returns the first candidate that matches within the fallback policy.

Current guarantees:

- candidates are evaluated in declared order
- the chosen selector path is returned as `selectorPath`
- `candidateOrder` preserves the full ordered candidate list
- the selected resolution records `matchedCount`, `values`, and `confidence`
- every successful selection includes a deterministic `relocationTrace`
- failures remain typed through `ExtractionMismatch`

Current examples proven by `tests/libs/foundation-core-e2-runtime.test.ts`:

- `[data-testid='price']` wins over `.price-fallback` when both are present
- the returned `selectorPath` is `price/primary`
- `candidateOrder` remains `["price/primary", "price/fallback"]`
- no relocation happens when the primary selector matches

## Validation Commands

Focused selector-order validation:

```bash
bun test tests/libs/foundation-core-e2-runtime.test.ts
```

Integrated propagation into extraction output:

```bash
bun test tests/libs/foundation-core-extractor-runtime.test.ts
bun test tests/libs/foundation-core-evidence-manifest.test.ts
```

Full E2 replay:

```bash
bun run check:e2-capability-slice
```

## Operator Workflow

### 1. Prove the configured order directly

Run:

```bash
bun test tests/libs/foundation-core-e2-runtime.test.ts
```

That suite currently proves:

- configured order is stable across reruns
- the selected path is emitted explicitly
- no-match failures are deterministic
- bounded fallback decisions stop before out-of-policy candidates

### 2. Confirm selector order survives orchestration

Run:

```bash
bun test tests/libs/foundation-core-extractor-runtime.test.ts
bun test tests/libs/foundation-core-evidence-manifest.test.ts
```

These suites prove selector order is not lost after normalization, snapshot
assembly, and evidence-manifest generation.

### 3. Use `selectorPath` as the first triage signal

When extraction regresses, start with the chosen selector path:

- expected `selectorPath` means precedence is still correct
- unexpected `selectorPath` means selector ordering or upstream HTML changed
- no `selectorPath` means the boundary failed before a match

Do not infer the winner from raw HTML. Use the recorded selector resolution.

## Troubleshooting

### The wrong selector won

Inspect the candidate list ordering in the recipe and re-run:

```bash
bun test tests/libs/foundation-core-e2-runtime.test.ts
```

If the order is wrong, fix the recipe or selector list. Do not add ad hoc
post-selection rewriting.

### A later selector should have matched but was never attempted

This usually means fallback bounds stopped evaluation before reaching it. That
behavior is intentional and belongs to relocation policy, not precedence.

Continue with:

```bash
docs/runbooks/e2-selector-relocation.md
```

### Values differ between direct selector tests and E2 orchestration

Re-run:

```bash
bun test tests/libs/foundation-core-extractor-runtime.test.ts
bun test tests/libs/foundation-core-evidence-manifest.test.ts
```

If the direct selector result is correct but later output is wrong, the defect
is downstream in normalization or snapshot assembly, not in precedence.

## Rollout and Rollback

Roll forward only after:

```bash
bun test tests/libs/foundation-core-e2-runtime.test.ts
bun test tests/libs/foundation-core-extractor-runtime.test.ts
bun test tests/libs/foundation-core-evidence-manifest.test.ts
bun run check:e2-capability-slice
```

Rollback by reverting the precedence change and rerunning the same commands.

Do not roll back by:

- making selector choice implicit again
- adding unbounded fallback search
- bypassing typed `ExtractionMismatch` failures
- introducing manual `_tag`, `instanceof`, or unsafe casts
