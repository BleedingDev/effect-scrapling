# Nx Workspace Graph and Boundary Guardrails Runbook

## Purpose

This runbook defines how to operate and verify Nx workspace graph integrity and module-boundary guardrails in this repository.

Primary controls:

- Project discovery: `bun run nx:show-projects`
- Workspace graph export: `bun run nx:graph`
- Boundary enforcement: `@nx/enforce-module-boundaries` in `.oxlintrc.json`

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

## How To Verify Boundary Rule Enforcement

Use a temporary illegal import from an app (`type:app`) to a tool (`type:tool`). This must fail.

```bash
fixture="apps/api/src/__nx-boundary-fixture.ts"
cat > "$fixture" <<'EOF'
import { reportProjectHealth } from "@effect-scrapling/ci-tooling";

export const illegalBoundaryFixture = reportProjectHealth;
EOF

bunx --bun oxlint "$fixture"
status=$?
rm -f "$fixture"
test "$status" -eq 1
```

Expected result:

- Exit code is `1`.
- Output includes `@nx(enforce-module-boundaries)`.
- Output includes:
  `A project tagged with "type:app" can only depend on libs tagged with "type:lib"`.

Automated verification gate:

```bash
bun test tests/guardrails/nx-workspace.verify.test.ts
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
5. Re-run guardrail test:
   `bun test tests/guardrails/nx-workspace.verify.test.ts`.

## Rollout (Strict Non-Bypass)

1. Baseline
- Run `bun run nx:show-projects`.
- Run `bun run nx:graph`.
- Run `bun test tests/guardrails/nx-workspace.verify.test.ts`.

2. Apply change
- Update project wiring (`project.json`, tags, imports) only through reviewed code changes.
- Keep `@nx/enforce-module-boundaries` enabled and unchanged unless policy change is explicitly approved in review.

3. Verify
- Re-run the three baseline commands.
- If boundary behavior changed, add or update guardrail test assertions first, then re-run tests.

4. Promote
- Merge only when commands and tests are green.
- Treat boundary failures as release blockers.

Forbidden actions during rollout:

- Disabling `@nx/enforce-module-boundaries`.
- Weakening `depConstraints` to make failing imports pass.
- Introducing allowlist shortcuts for violating imports.
- Adding lint suppressions to bypass boundary failures.

## Rollback (Strict Non-Bypass)

If rollout introduces boundary regressions:

1. Revert offending changes to tags/imports/project config.
2. Keep guardrails intact; do not disable lint rules or tests.
3. Re-run:
   - `bun run nx:show-projects`
   - `bun run nx:graph`
   - `bun test tests/guardrails/nx-workspace.verify.test.ts`
4. Re-attempt rollout with corrected project boundaries.

Forbidden rollback actions:

- Removing boundary tests.
- Disabling Nx/Oxlint boundary checks.
- Committing temporary bypasses with intent to fix later.
