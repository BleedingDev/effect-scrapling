# Lint and Format Policy Runbook (Oxlint, Oxfmt, Ultracite)

## Purpose

Operate and troubleshoot the lint/format guardrail suite with deterministic local and CI behavior.

Source of truth:

- `package.json` scripts: `ultracite`, `oxlint`, `format`, `format:check`, `oxfmt`, `lint`, `lint:fix`, `check`
- `.oxlintrc.json`
- `.oxfmtrc.json`
- `.github/workflows/pr-affected-gates.yml`
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

CI wiring is split across two workflows:

- `.github/workflows/pr-affected-gates.yml`
  - Matrix jobs: `gate / ultracite`, `gate / oxlint`, `gate / oxfmt`
  - Summary job: `pr-gates-status`
  - Role: merge-blocking PR status for repo-wide guardrail checks plus affected Nx targets
- `.github/workflows/build-sfe.yml`
  - Job: `build`
  - Matrix target gating: guardrail checks run on `bun-linux-x64`
  - Step: `Guardrails (lint, format, type-safety)`
  - Command: `bun run check`

Operationally, CI uses the same script contract as local runs. Keep script names and order in `package.json#scripts.check` stable unless intentionally changing policy.

Deterministic PR status contract:

- Every matrix entry under `gate / ...` must finish with exit code `0`.
- `pr-gates-status` fails unless the aggregate `gate-matrix` result is `success`.
- Do not treat a cancelled or skipped gate as equivalent to success when triaging PR readiness.

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
TARGET_BRANCH="${TARGET_BRANCH:-origin/master}"
NX_BASE="${NX_BASE:-$(git rev-parse "$TARGET_BRANCH")}"
NX_HEAD="${NX_HEAD:-$(git rev-parse HEAD)}"

bun run lint
bun run oxfmt
bun run nx affected -t lint --base="$NX_BASE" --head="$NX_HEAD" --parallel=1
bun run nx affected -t test --base="$NX_BASE" --head="$NX_HEAD" --parallel=1
bun run nx affected -t typecheck --base="$NX_BASE" --head="$NX_HEAD" --parallel=1
bun run nx affected -t build --base="$NX_BASE" --head="$NX_HEAD" --parallel=1
bun run check
```

The defaults above approximate the PR matrix against the current target branch
tip. For exact CI parity after a PR exists, export the workflow's exact
`github.event.pull_request.base.sha` as `NX_BASE` and
`github.event.pull_request.head.sha` as `NX_HEAD` before replaying the commands.

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

### `pr-gates-status` fails

1. Open the same workflow run and inspect the `gate / ...` matrix entry that failed or was cancelled.
2. Recompute the exact PR range locally with `git merge-base` and `git rev-parse HEAD`, then replay the commands from `Pre-PR guardrail flow`.
3. If only `ultracite`, `oxlint`, or `oxfmt` fail, fix the repo-wide guardrail issue first; these gates are not scoped by Nx affected detection.
4. If only `affected-*` gates fail, continue with `docs/runbooks/nx-workspace-graph.md`.

## Rollout guidance

1. Keep policy edits atomic: update scripts/config/docs in one PR.
2. Run targeted suite commands (`ultracite`, `oxlint`, `oxfmt`) while iterating.
3. Run `bun run check` before review.
4. Ensure CI `pr-gates-status` and `build-sfe` guardrail steps are green before merge.
5. Merge only when lint/format policy checks pass in both local and CI.

## Rollback guidance

1. Revert the offending lint/format policy commit.
2. Re-run `bun install --frozen-lockfile` if lockfile or tool versions changed.
3. Re-run `bun run ultracite`, `bun run oxlint`, `bun run oxfmt`, affected Nx gates for the PR range, then `bun run check`.
4. Re-open a corrected PR with explicit policy intent.

Forbidden rollback actions:

- Removing `ultracite`, `oxlint`, or `oxfmt` from `package.json#scripts.check`.
- Removing a guardrail entry from `.github/workflows/pr-affected-gates.yml`.
- Weakening `pr-gates-status` so non-success matrix results still report green.
- Disabling or skipping CI guardrail steps to force green builds.
- Introducing blanket lint-disable comments or policy bypasses.
