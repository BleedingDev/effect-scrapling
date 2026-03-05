# Lint and Format Policy Runbook (Oxlint, Oxfmt, Ultracite)

## Purpose

Operate and troubleshoot the lint/format guardrail suite with deterministic local and CI behavior.

Source of truth:

- `package.json` scripts: `ultracite`, `oxlint`, `format`, `format:check`, `oxfmt`, `lint`, `lint:fix`, `check`
- `.oxlintrc.json`
- `.oxfmtrc.json`
- `.github/workflows/build-sfe.yml`

## Scope and command contract

All three suite commands run against the same file set:

```text
src tests apps libs tools scripts (TypeScript files only: *.ts)
```

| Policy | Canonical command | Script wiring | Pass signal |
| --- | --- | --- | --- |
| Ultracite checks | `bun run ultracite` | `bunx --bun ultracite check $(rg --files src tests apps libs tools scripts -g '*.ts')` | Exit code `0` |
| Oxlint checks | `bun run oxlint` | `bunx --bun oxlint $(rg --files src tests apps libs tools scripts -g '*.ts')` | Exit code `0` |
| Oxfmt checks | `bun run oxfmt` | `bun run format:check` -> `bunx --bun oxfmt --check ...` | Exit code `0` |

Aggregated gates:

- `bun run lint` = `ultracite` + `oxlint` + `lint:typesafety`
- `bun run check` includes `ultracite`, `oxlint`, and `oxfmt` before later guardrails/tests/build

## Local execution

Baseline setup:

```bash
bun install --frozen-lockfile
```

Run the suite directly:

```bash
bun run ultracite
bun run oxlint
bun run oxfmt
```

Run full local parity gate:

```bash
bun run check
```

## CI execution

CI wiring is in `.github/workflows/build-sfe.yml`.

- Job: `build`
- Matrix target gating: guardrail checks run on `bun-linux-x64`
- Step: `Guardrails (lint, format, type-safety)`
- Command: `bun run check`

Operationally, CI uses the same script contract as local runs. Keep script names and order in `package.json#scripts.check` stable unless intentionally changing policy.

## Practical command examples

### Check one file while iterating

```bash
file="apps/api/src/main.ts"
bunx --bun ultracite check "$file"
bunx --bun oxlint "$file"
bunx --bun oxfmt --check "$file"
```

### Apply safe auto-fixes, then re-check

```bash
bun run lint:fix
bun run ultracite
bun run oxfmt
```

### Pre-PR guardrail flow

```bash
bun run lint
bun run oxfmt
bun run check
```

## Troubleshooting

### `Format issues found` from `ultracite` or `oxfmt`

1. Run `bun run format`.
2. Re-run `bun run ultracite` and `bun run oxfmt`.
3. If still failing, inspect the reported file and apply deterministic formatting updates.

### `@nx/enforce-module-boundaries` failures from `oxlint`

1. Fix invalid cross-project imports to match `.oxlintrc.json` dependency constraints.
2. Re-run `bun run oxlint`.
3. Re-run `bun run check` for full parity.

### CI fails while local passes

1. Confirm clean lockfile state: `bun install --frozen-lockfile`.
2. Re-run local gate in the same order as CI: `bun run check`.
3. Confirm no local script/config drift in `package.json`, `.oxlintrc.json`, `.oxfmtrc.json`, or workflow files.

## Rollout guidance

1. Keep policy edits atomic: update scripts/config/docs in one PR.
2. Run targeted suite commands (`ultracite`, `oxlint`, `oxfmt`) while iterating.
3. Run `bun run check` before review.
4. Ensure CI `build-sfe` guardrail step is green before merge.
5. Merge only when lint/format policy checks pass in both local and CI.

## Rollback guidance

1. Revert the offending lint/format policy commit.
2. Re-run `bun install --frozen-lockfile` if lockfile or tool versions changed.
3. Re-run `bun run ultracite`, `bun run oxlint`, `bun run oxfmt`, then `bun run check`.
4. Re-open a corrected PR with explicit policy intent.

Forbidden rollback actions:

- Removing `ultracite`, `oxlint`, or `oxfmt` from `package.json#scripts.check`.
- Disabling or skipping CI guardrail steps to force green builds.
- Introducing blanket lint-disable comments or policy bypasses.
