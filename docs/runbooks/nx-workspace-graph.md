# Nx Workspace Graph and Boundary Guardrails Runbook

## Purpose

This runbook defines how to operate and verify Nx workspace graph integrity and module-boundary guardrails in this repository.

Primary controls:

- Project discovery: `bun run nx:show-projects`
- Workspace graph export: `bun run nx:graph`
- PR affected targets: `bun run nx affected -t <target> --base="$NX_BASE" --head="$NX_HEAD" --parallel=1`
- Boundary enforcement: `@nx/enforce-module-boundaries` in `.oxlintrc.json`
- CI workflow: `.github/workflows/pr-affected-gates.yml`

This policy is blocking for local release readiness and CI. Do not bypass it.

## Boundary Policy Baseline

Boundary rules are enforced by `@nx/enforce-module-boundaries` with these tag constraints:

- `type:app` can depend only on `type:lib`
- `type:lib` can depend only on `type:lib`
- `type:tool` can depend on `type:lib` and `type:tool`
- `type:sf` can depend only on `type:sf`

Current project tags are declared in each `project.json` (for example: `apps/api/project.json`, `apps/cli/project.json`, `libs/foundation/core/project.json`, `tools/ci/project.json`).

## How To Run Nx Graph and Project Checks

Run from repository root.

### 1) Show all projects

```bash
bun run nx:show-projects
```

Expected behavior:

- Command exits `0`.
- Outputs known workspace projects (for example `api-app`, `cli-app`, `foundation-core`, `ci-tooling`, `sf-assets`).

If you need machine-readable output:

```bash
bunx --bun nx show projects --json
```

### 2) Export workspace graph

```bash
bun run nx:graph
```

This writes graph JSON to `tmp/nx-graph.json`.

Recommended deterministic mode:

```bash
bunx --bun nx graph --file=tmp/nx-graph.json --open=false
```

Quick sanity check on graph nodes:

```bash
jq -r '.graph.nodes | keys[]' tmp/nx-graph.json
```

### 3) Scaffold a compliant Effect module

Use the compliant module generator through Bun-based Nx:

```bash
bunx --bun nx g @effect-scrapling/ci-tooling:compliant-module \
  --project=foundation-core \
  --name=my-module \
  --directory=generated-modules \
  --no-interactive
```

Expected behavior:

- Command exits `0`.
- Generates schema, errors, tag, layer, effect, and test files in deterministic shape.
- Generated files are lint/type/test compatible with repository guardrails.

### 4) Replay PR affected Nx gates locally

Use the same base/head contract as `.github/workflows/pr-affected-gates.yml`.

```bash
TARGET_BRANCH="${TARGET_BRANCH:-origin/master}"
NX_BASE="${NX_BASE:-$(git rev-parse "$TARGET_BRANCH")}"
NX_HEAD="${NX_HEAD:-$(git rev-parse HEAD)}"

bun run nx affected -t lint --base="$NX_BASE" --head="$NX_HEAD" --parallel=1
bun run nx affected -t test --base="$NX_BASE" --head="$NX_HEAD" --parallel=1
bun run nx affected -t typecheck --base="$NX_BASE" --head="$NX_HEAD" --parallel=1
bun run nx affected -t build --base="$NX_BASE" --head="$NX_HEAD" --parallel=1
```

The defaults above approximate the PR matrix against the current target branch
tip. For exact CI parity after a PR exists, export the workflow's exact
`github.event.pull_request.base.sha` as `NX_BASE` and
`github.event.pull_request.head.sha` as `NX_HEAD` before replaying the commands.

Expected behavior:

- Each command exits `0` when every affected target passes.
- Failures identify the specific project and target that blocked the PR matrix.
- The command contract must stay aligned with workflow gate names:
  `affected-lint`, `affected-test`, `affected-typecheck`, `affected-build`.
- Guardrail-specific operator workflow, troubleshooting, and rollback guidance
  live in this runbook plus `docs/runbooks/lint-format-policy.md`.

## How To Verify Boundary Rule Enforcement

Use a temporary illegal import from an app (`type:app`) to a tool (`type:tool`). This must fail.

```bash
fixture="apps/api/src/__nx-boundary-fixture.ts"
cat > "$fixture" <<'EOF'
import { projectHealthSummary } from "@effect-scrapling/ci-tooling";

export const illegalBoundaryFixture = projectHealthSummary;
EOF

bunx --bun oxlint "$fixture"
exit_code=$?
rm -f "$fixture"
test "$exit_code" -eq 1
```

Expected result:

- Exit code is `1`.
- Output includes `@nx(enforce-module-boundaries)`.
- Output includes:
  `A project tagged with "type:app" can only depend on libs tagged with "type:lib"`.

Automated verification gate:

```bash
bun run check:e0-capability-slice
```

## Troubleshooting

### `bun run nx:show-projects` fails or returns empty

1. Confirm dependencies are installed: `bun install --frozen-lockfile`.
2. Verify Nx is available: `bunx --bun nx --version`.
3. Confirm `project.json` files exist under `apps/`, `libs/`, and `tools/`.
4. Re-run with JSON mode to diagnose parsing noise:
   `bunx --bun nx show projects --json`.

### Graph file is missing `graph.nodes`

1. Re-run in deterministic mode:
   `bunx --bun nx graph --file=tmp/nx-graph.json --open=false`.
2. Ensure `tmp/` is writable.
3. Inspect generated file:
   `cat tmp/nx-graph.json`.
4. If malformed, clear local Nx cache and retry:
   `rm -rf .nx && bunx --bun nx graph --file=tmp/nx-graph.json --open=false`.

### Boundary violation is not reported when expected

1. Confirm fixture file path is under `apps/api/src` (tagged `type:app`).
2. Confirm imported package maps to `tools/ci` (`type:tool`).
3. Confirm `.oxlintrc.json` still contains `@nx/enforce-module-boundaries`.
4. Verify command targets only the fixture:
   `bunx --bun oxlint apps/api/src/__nx-boundary-fixture.ts`.
5. Re-run the full affected-target gate:
   `bun run check:e0-capability-slice`.

### `nx affected` selects the wrong projects or none at all

1. Fetch the current remote history for the PR target branch: `git fetch origin`.
2. Recompute `NX_BASE` from the actual target branch (`origin/main` or `origin/master`).
3. Re-run `bun run nx:show-projects` and `bun run nx:graph` to verify the workspace graph still resolves cleanly.
4. Re-run only the failing affected target with the recomputed SHAs.

### `nx affected` fails before target selection or cannot load the TypeScript runtime

1. Re-run `bun install --frozen-lockfile` so local dependencies match the lockfile exactly.
2. Confirm the root toolchain still includes `@swc-node/register` and `@swc/core`; Nx uses them to execute local TypeScript workspace files.
3. Re-run `bun run nx:show-projects` to prove the workspace graph can load before you retry `nx affected`.
4. In CI, verify the failure happened after the workflow install step completed successfully and before any operator retries.
5. Do not replace `nx affected` with `run-many`, a hard-coded project list, or manual gate skipping as a workaround.

### `affected-build` or `affected-typecheck` fails after workspace metadata changes

1. Inspect the touched `project.json`, tag, and import changes before changing workflow behavior.
2. Re-run `bun run nx:graph` and confirm `tmp/nx-graph.json` contains the expected project edges.
3. Re-run the failing target with the same `NX_BASE` and `NX_HEAD` used by the PR.
4. If the failure came from incorrect graph metadata, revert the metadata change rather than weakening the affected gate.

## Rollout (Strict Non-Bypass)

1. Baseline
- Run `bun run nx:show-projects`.
- Run `bun run nx:graph`.
- Run `bun run check:e0-capability-slice`.
- Compute `NX_BASE`/`NX_HEAD` for the PR range and run all four affected targets locally.

2. Apply change
- Update project wiring (`project.json`, tags, imports) only through reviewed code changes.
- Keep `@nx/enforce-module-boundaries` enabled and unchanged unless policy change is explicitly approved in review.

3. Verify
- Re-run the three baseline commands.
- If boundary behavior changed, add or update guardrail test assertions first, then re-run tests.

4. Promote
- Merge only when commands and tests are green.
- Require the PR workflow summary check `pr-gates-status` to be green.
- Treat boundary failures as release blockers.

Forbidden actions during rollout:

- Disabling `@nx/enforce-module-boundaries`.
- Weakening `depConstraints` to make failing imports pass.
- Introducing allowlist shortcuts for violating imports.
- Adding lint suppressions to bypass boundary failures.

## Rollback (Strict Non-Bypass)

If rollout introduces boundary regressions:

1. Revert offending changes to tags/imports/project config.
2. Keep guardrails intact; do not disable lint rules, tests, or affected workflow jobs.
3. Re-run:
   - `bun run nx:show-projects`
   - `bun run nx:graph`
   - `bun run nx affected -t lint --base="$NX_BASE" --head="$NX_HEAD" --parallel=1`
   - `bun run nx affected -t test --base="$NX_BASE" --head="$NX_HEAD" --parallel=1`
   - `bun run nx affected -t typecheck --base="$NX_BASE" --head="$NX_HEAD" --parallel=1`
   - `bun run nx affected -t build --base="$NX_BASE" --head="$NX_HEAD" --parallel=1`
   - `bun run check:e0-capability-slice`
4. Re-attempt rollout with corrected project boundaries.

Forbidden rollback actions:

- Removing boundary tests.
- Disabling Nx/Oxlint boundary checks.
- Replacing PR affected gates with `run-many` or a hard-coded project list.
- Hard-coding `NX_BASE` or `NX_HEAD` to something other than the actual PR comparison range.
- Committing temporary bypasses with intent to fix later.
