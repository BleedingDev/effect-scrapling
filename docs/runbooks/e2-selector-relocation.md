# E2 Selector Relocation and Fallback

## Purpose

Operate and troubleshoot the bounded selector-relocation policy used when a
primary selector fails and E2 must attempt controlled fallback candidates.

Primary implementation and validation surfaces:

- `libs/foundation/core/src/selector-engine.ts`
- `tests/libs/foundation-core-e2-runtime.test.ts`
- `tests/libs/foundation-core-extractor-runtime.test.ts`
- `tests/libs/foundation-core-evidence-manifest.test.ts`

## Contract

Selector relocation is intentionally bounded.

Current guarantees:

- fallback attempts stop at `maxFallbackCount`
- fallback attempts also stop when raw confidence impact would exceed
  `maxConfidenceImpact`
- each attempted selector is recorded in `relocationTrace`
- successful fallback resolutions record:
  - `relocated: true`
  - `fallbackCount`
  - `confidenceImpact`
  - reduced `confidence`
- failed bounded searches return typed `ExtractionMismatch`

Current example proven by `tests/libs/foundation-core-e2-runtime.test.ts`:

- `.missing-price` fails at depth `0`
- `.price-fallback` matches at depth `1`
- `confidenceImpact` becomes `0.2`
- resulting `confidence` becomes `0.8`
- both attempts remain present in the recorded `relocationTrace`

The extractor runtime also proves that fallback confidence reduction propagates
into emitted observations rather than disappearing after selector resolution.

## Validation Commands

Focused relocation validation:

```bash
bun test tests/libs/foundation-core-e2-runtime.test.ts
```

Propagation into extraction output:

```bash
bun test tests/libs/foundation-core-extractor-runtime.test.ts
bun test tests/libs/foundation-core-evidence-manifest.test.ts
```

Integrated E2 replay:

```bash
bun run check:e2-capability-slice
```

## Operator Workflow

### 1. Reproduce the fallback path directly

Run:

```bash
bun test tests/libs/foundation-core-e2-runtime.test.ts
```

That suite currently proves:

- fallback success with explicit confidence loss
- termination before out-of-bounds fallback candidates
- termination before candidates that exceed maximum confidence impact
- deterministic mismatch messages when nothing valid matches

### 2. Confirm degraded confidence reaches downstream consumers

Run:

```bash
bun test tests/libs/foundation-core-extractor-runtime.test.ts
bun test tests/libs/foundation-core-evidence-manifest.test.ts
```

The selector engine alone is not enough. These suites prove the degraded
confidence and relocation trace remain visible in snapshot assembly and evidence
linkage.

### 3. Treat relocation as a signal, not a success condition

A relocated match is usable evidence, but it is lower-confidence evidence.

Use these fields for triage:

- `relocated`
- `fallbackCount`
- `confidence`
- `confidenceImpact`
- `relocationTrace`

Do not silently treat relocated output as equivalent to a primary selector hit.

## Troubleshooting

### A later selector exists but is skipped

The skip is expected when:

- the next fallback exceeds `maxFallbackCount`
- the next fallback would exceed `maxConfidenceImpact`

This is deliberate. The current contract prefers deterministic bounded search
over exhaustively walking every selector candidate.

### Confidence dropped enough to trip downstream assertions

That usually means the selector boundary degraded before the assertion engine
failed.

Validate in this order:

```bash
bun test tests/libs/foundation-core-e2-runtime.test.ts
bun test tests/libs/foundation-core-extractor-runtime.test.ts
bun test tests/libs/foundation-core-assertion-engine.test.ts
```

### Relocation succeeds, but the evidence manifest is incomplete

Check the field binding and artifact linkage with:

```bash
bun test tests/libs/foundation-core-evidence-manifest.test.ts
```

The selector engine can be correct while the evidence binding is wrong.

## Rollout and Rollback

Roll forward only after:

```bash
bun test tests/libs/foundation-core-e2-runtime.test.ts
bun test tests/libs/foundation-core-extractor-runtime.test.ts
bun test tests/libs/foundation-core-evidence-manifest.test.ts
bun run check:e2-capability-slice
```

Rollback by reverting the relocation policy change and rerunning the same
commands.

Do not roll back by:

- enabling unbounded selector fallback
- zeroing out fallback confidence impact
- hiding relocation traces from evidence output
- introducing manual `_tag`, `instanceof`, or unsafe casts
