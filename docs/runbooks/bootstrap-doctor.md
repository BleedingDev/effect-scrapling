# Bootstrap Doctor and Preflight Runbook

## Scope

This runbook defines deterministic fresh-clone readiness for this workspace.

Goals:
- Validate local prerequisites before any install/build work.
- Bootstrap dependencies in a reproducible way.
- Prove readiness through a single doctor command that runs required gates.

## Command Flow

Run from repository root.

### 1) Preflight

```bash
bun run scripts/preflight-bootstrap.ts
```

This checks:
- Required repository files and package scripts
- Git availability and repository root execution
- Bun availability and `package.json#engines.bun` compatibility

### 2) Bootstrap

```bash
bun install --frozen-lockfile
# Optional: needed only for browser-mode workflows.
bun run browser:install
```

`bun install --frozen-lockfile` is required for deterministic dependency resolution.

`browser:install` installs Chromium for Playwright browser-mode usage.
It is not required for the core lint/type/test/build readiness gates.

### 3) Doctor

```bash
bun run scripts/bootstrap-doctor.ts
```

This runs:
1. Preflight again (to detect drift between bootstrap and doctor)
2. Frozen dependency install verification (`bun install --frozen-lockfile`)
3. Required readiness gates in fixed order:
   - `dependencies:frozen-lockfile`
   - `ultracite`
   - `oxlint`
   - `oxfmt`
   - `lint:typesafety`
   - `check:governance`
   - `check:lockstep-version`
   - `check:effect-v4-policy`
   - `check:strict-ts-posture`
   - `typecheck`
   - `test`
   - `build`

## Expected Output

Preflight success ends with:

```text
Preflight passed (5/5 checks).
```

Doctor success ends with:

```text
Bootstrap doctor passed (12 readiness gates).
```

Failures are deterministic and action-oriented. Each failed check/gate prints:
- failing check id
- exact command (for gate failures)
- remediation action
- captured output excerpt

## Troubleshooting

### `FAIL bun-version`

- Install or upgrade Bun to satisfy `package.json#engines.bun`.
- Re-run:
  - `bun run scripts/preflight-bootstrap.ts`

### `FAIL git-root`

- The command was executed outside repository root.
- Change into the repo root and re-run preflight/doctor.

### `FAIL dependencies:frozen-lockfile`

- Lockfile and installed dependency graph are out of sync.
- Run:
  - `bun install --frozen-lockfile`
- If it still fails, restore `package.json` / `bun.lock` consistency first.
- Then re-run doctor.

### Any readiness gate fails

1. Follow the `Action:` line printed by doctor.
2. Fix the underlying issue.
3. Re-run the failing command directly.
4. Re-run doctor:
   - `bun run scripts/bootstrap-doctor.ts`

## Operator Workflow

For fresh clones:

```bash
bun run scripts/preflight-bootstrap.ts
bun install --frozen-lockfile
bun run browser:install
bun run scripts/bootstrap-doctor.ts
```

A clone is considered ready only when both preflight and bootstrap doctor exit with code `0`.
