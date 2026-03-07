# E2 Deterministic Parser Pipeline

## Purpose

Operate and troubleshoot the deterministic HTML parser boundary that turns raw
HTML artifacts into stable parsed-document structures for the rest of the E2
extraction pipeline.

Primary implementation and validation surfaces:

- `libs/foundation/core/src/extraction-parser.ts`
- `tests/libs/foundation-core-e2-runtime.test.ts`
- `tests/libs/foundation-core-extractor-runtime.test.ts`
- `docs/runbooks/e2-extractor-orchestration.md`

## Contract

`parseDeterministicHtml(...)` is the only supported parser entrypoint for the
current E2 slice.

Current guarantees:

- input decodes through `DeterministicParserInputSchema`
- `html` must be non-empty after trimming
- repeated runs over the same HTML produce identical parsed output
- root output is always keyed from `document`
- node paths are deterministic and unique
- text content is whitespace-normalized
- attributes are sorted deterministically
- parse failures remain typed through `ParserFailure`

Current examples proven by `tests/libs/foundation-core-e2-runtime.test.ts`:

- repeated parses of the same product HTML encode identically
- `rootPath === "document"`
- the parsed tree contains stable `h1`, `span`, and attribute-bearing nodes
- whitespace-only HTML fails with the same `parser_failure` envelope on every
  rerun

Current integrated evidence proven by `tests/libs/foundation-core-extractor-runtime.test.ts`:

- parsed documents flow into selector resolution, snapshot assembly, assertion
  checks, and evidence manifests without hidden side effects
- document summaries stay deterministic for the same captured artifact

## Validation Commands

Focused parser validation:

```bash
bun test tests/libs/foundation-core-e2-runtime.test.ts
```

Integrated orchestration validation:

```bash
bun test tests/libs/foundation-core-extractor-runtime.test.ts
bun run check:e2-capability-slice
```

Public SDK replay:

```bash
bun run check:e2-sdk-consumer
```

## Operator Workflow

### 1. Reproduce the direct parser contract

Run:

```bash
bun test tests/libs/foundation-core-e2-runtime.test.ts
```

This suite currently proves:

- repeated parser output is stable
- repeated invalid input produces the same typed failure envelope
- selector execution starts from a deterministic parsed document shape

### 2. Inspect the parsed-document summary through orchestration

Run:

```bash
bun test tests/libs/foundation-core-extractor-runtime.test.ts
bun run check:e2-capability-slice
```

Use the focused suite first when changing parser internals. Use the integrated
commands when you need to confirm the parser still composes correctly with the
selector, normalization, and snapshot stages.

### 3. Use parser failures as the boundary, not raw parser exceptions

If parsing fails, route triage through the typed `ParserFailure` envelope.

Do not bypass it with ad hoc DOM-loader exceptions or raw stack traces. The
current contract intentionally keeps parser errors stable and machine-readable.

## Troubleshooting

### Repeated parses are no longer identical

Check for nondeterminism in:

- path generation
- attribute ordering
- whitespace normalization
- root-child enumeration

Validate with:

```bash
bun test tests/libs/foundation-core-e2-runtime.test.ts
```

### Parsing succeeds, but downstream extraction still drifts

Confirm whether the defect is actually downstream:

```bash
bun test tests/libs/foundation-core-extractor-runtime.test.ts
bun test tests/libs/foundation-core-evidence-manifest.test.ts
```

If the parsed-document summary is stable but selector or snapshot output is not,
the parser is probably not the broken boundary.

### A source starts emitting effectively empty HTML

Whitespace-only input should remain a typed parser failure. Do not coerce it
into an empty document just to keep the pipeline moving.

## Rollout and Rollback

Roll forward only after:

```bash
bun test tests/libs/foundation-core-e2-runtime.test.ts
bun test tests/libs/foundation-core-extractor-runtime.test.ts
bun run check:e2-capability-slice
bun run check:e2-sdk-consumer
```

Rollback by reverting the parser change and rerunning the same commands.

Do not roll back by:

- accepting whitespace-only HTML as a valid parsed document
- making node-path generation nondeterministic
- bypassing typed `ParserFailure` handling
- introducing manual `_tag`, `instanceof`, or unsafe casts
