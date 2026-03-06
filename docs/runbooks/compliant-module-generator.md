# Compliant Module Generator Runbook

## Purpose

Operate the `@effect-scrapling/ci-tooling:compliant-module` Nx generator with a
deterministic command contract, practical verification steps, and rollback
guidance.

This runbook is for operators and SDK consumers who need a strict Effect v4
module scaffold without weakening repository guardrails.

## Command Contract

Run from repository root:

```bash
bunx --bun nx g @effect-scrapling/ci-tooling:compliant-module \
  --project=<nx-project> \
  --name=<module-name> \
  [--directory=<source-subdirectory>] \
  --no-interactive
```

Generator options:

| Option | Required | Meaning |
| --- | --- | --- |
| `--project` | Yes | Existing Nx project name. The generator reads its `sourceRoot` from `project.json`. |
| `--name` | Yes | Module name. Normalized to kebab-case and must start with a letter. |
| `--directory` | No | Optional subdirectory under the target project's `sourceRoot`. Each path segment is normalized to kebab-case. |

Operational notes:

- Re-running the generator with the same options rewrites the same files deterministically.
- Use a fresh branch or review the diff carefully before pointing the generator at an existing module path.
- Keep the generator output Effect v4 only. Do not introduce compatibility shims or type-safety bypasses into generated modules.

## Practical Execution Examples

### Scaffold into `foundation-core/src/generated-modules`

```bash
bunx --bun nx g @effect-scrapling/ci-tooling:compliant-module \
  --project=foundation-core \
  --name=html-normalizer \
  --directory=generated-modules \
  --no-interactive
```

Expected output layout:

```text
libs/foundation/core/src/generated-modules/html-normalizer/html-normalizer.schema.ts
libs/foundation/core/src/generated-modules/html-normalizer/html-normalizer.errors.ts
libs/foundation/core/src/generated-modules/html-normalizer/html-normalizer.tag.ts
libs/foundation/core/src/generated-modules/html-normalizer/html-normalizer.layer.ts
libs/foundation/core/src/generated-modules/html-normalizer/html-normalizer.effect.ts
tests/generated-modules/foundation-core/generated-modules/html-normalizer.test.ts
```

### Scaffold into a nested subdirectory

```bash
bunx --bun nx g @effect-scrapling/ci-tooling:compliant-module \
  --project=foundation-core \
  --name=request-sanitizer \
  --directory=generated-modules/http \
  --no-interactive
```

Expected test path:

```text
tests/generated-modules/foundation-core/generated-modules/http/request-sanitizer.test.ts
```

## Verification Flow

After scaffolding a module, verify both the generated module and the repository
guardrails.

### 1. Confirm project discovery

```bash
bun run nx:show-projects
```

The `--project` value you passed to the generator must appear in this list.

### 2. Run the generated module test

For the `html-normalizer` example:

```bash
bun test tests/generated-modules/foundation-core/generated-modules/html-normalizer.test.ts
```

### 3. Run the generator contract verification

```bash
bun test tests/guardrails/nx-compliant-module-generator.verify.test.ts
```

This validates that generated modules stay lintable, typecheckable, runnable,
and deterministic.

### 4. Run repository gates before merge

```bash
bun run ultracite
bun run oxlint
bun run oxfmt
bun run test
bun run build
```

For full local promotion parity with the repository guardrails plus the affected
target PR matrix:

```bash
bun run check:e0-capability-slice
```

If you only need the root repository guardrails and not the affected-target PR
matrix, `bun run check` remains the narrower local gate.

## Troubleshooting

### Nx cannot find the project

Symptom:

```text
Cannot find configuration for '<project-name>'
```

Actions:

1. Run `bun run nx:show-projects`.
2. Use the exact project name from Nx output, not a directory path.
3. Confirm the target project still has a valid `project.json` with `sourceRoot`.

### `name` or `directory` validation fails

Typical failure text:

```text
The "name" option must normalize to kebab-case with a leading letter
```

Actions:

1. Use names like `html-normalizer`, not `HtmlNormalizer`, `html_normalizer`, or `123-parser`.
2. If `--directory` is set, make every path segment kebab-case as well.
3. Re-run the generator only after the normalized path matches the intended module location.

### Generated files landed in the wrong place

Actions:

1. Inspect the target project's `sourceRoot` in its `project.json`.
2. Combine `sourceRoot`, `--directory`, and `--name` to determine the expected source path.
3. Confirm the test file under `tests/generated-modules/<normalized-project>/...` matches the same directory suffix.
4. If the command was wrong, remove the generated files and re-run with corrected options.

### Generated module passes its own test but repository gates fail

Actions:

1. Run the failing command directly (`bun run ultracite`, `bun run oxlint`, `bun run oxfmt`, `bun run test`, or `bun run build`).
2. Confirm you did not hand-edit generated files into a non-compliant shape.
3. If the issue is generator output drift, fix the generator implementation instead of weakening lint, type, or test policy.
4. Re-run `bun test tests/guardrails/nx-compliant-module-generator.verify.test.ts`.
5. If the failure came from PR affected execution, rerun `bun run check:e0-capability-slice`.

## Rollout Guidance

1. Start from a clean branch and confirm dependencies are installed: `bun install --frozen-lockfile`.
2. Confirm the destination project exists: `bun run nx:show-projects`.
3. Run the generator with an explicit `--project`, `--name`, and, when needed, `--directory`.
4. Review the generated source and test files before any hand edits.
5. Run the verification flow in this runbook.
6. Merge only when the generator contract test and repository gates are green.

## Rollback Guidance

Use rollback when a scaffold lands in the wrong project, uses the wrong module
name, or reveals a generator regression late in the rollout.

### Roll back a generated module

1. Remove the generated source directory under the target project's `sourceRoot`.
2. Remove the matching generated test file under `tests/generated-modules/<normalized-project>/...`.
3. Re-run `bun run ultracite`, `bun run oxlint`, `bun run oxfmt`, `bun run test`, and `bun run build`.
4. If the scaffold should still exist, re-run the generator with corrected options.

For the `html-normalizer` example:

```bash
rm -rf libs/foundation/core/src/generated-modules/html-normalizer
rm -f tests/generated-modules/foundation-core/generated-modules/html-normalizer.test.ts
```

### Roll back a generator behavior change

1. Revert the offending generator implementation or schema change.
2. Re-run `bun test tests/guardrails/nx-compliant-module-generator.verify.test.ts`.
3. Re-run `bun run check`.
4. Re-issue the scaffold only after the generator contract is green again.

Forbidden rollback actions:

- Disabling `ultracite`, `oxlint`, `oxfmt`, tests, or build gates to make generated code appear valid.
- Introducing `@ts-ignore`, double-casts, `as unknown as`, or lint-disable comments into generated modules.
- Keeping partially rolled back generated files in source control.
