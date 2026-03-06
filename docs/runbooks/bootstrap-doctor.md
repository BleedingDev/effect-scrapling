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

## Executable Evidence

The documented preflight + doctor path is verified by:

```bash
bun test tests/guardrails/bootstrap-doctor.verify.test.ts
```

This suite provisions an isolated workspace fixture with stubbed `bun` and `git`
commands so it can prove both:
- green preflight and doctor execution with all readiness gates wired
- bootstrap doctor reruns preflight and aborts before readiness gates when preflight is red
- red-path behavior that stops at the first failing gate and prints remediation evidence

## Troubleshooting

### `FAIL repo-files`

- One or more baseline workspace files are missing:
  - `AGENTS.md`
  - `package.json`
  - `bun.lock`
  - `tsconfig.base.json`
  - `tsconfig.guardrails.json`
- Restore the missing file(s) from Git or reclone the repository.
- Re-run:
  - `bun run scripts/preflight-bootstrap.ts`

### `FAIL git-cli`

- Git is not installed or not available in `PATH`.
- Install Git, open a new shell, and confirm:
  - `git --version`
- Re-run:
  - `bun run scripts/preflight-bootstrap.ts`

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

### `FAIL package-scripts`

- One or more required readiness scripts are missing from `package.json`.
- Restore the missing scripts from Git before continuing.
- Re-run:
  - `bun run scripts/preflight-bootstrap.ts`

### Any readiness gate fails

1. Follow the `Action:` line printed by doctor.
2. Fix the underlying issue.
3. Re-run the failing command directly.
4. Re-run doctor:
   - `bun run scripts/bootstrap-doctor.ts`

### Optional browser bootstrap fails

- `browser:install` is only required for Playwright browser-mode workflows.
- A failure there does not block the core readiness gates.
- For browser-mode recovery:
  1. Confirm the frozen install completed successfully:
     - `bun install --frozen-lockfile`
  2. Re-run:
     - `bun run browser:install`
  3. Verify Playwright:
     - `bun run check:playwright`

## Rollback / Recovery

Use the smallest rollback that matches the failure.

### Roll back generated bootstrap state

Use this when installs or builds left behind a partial local state but Git-tracked
inputs are still correct.

```bash
rm -rf node_modules dist
bun install --frozen-lockfile
bun run scripts/bootstrap-doctor.ts
```

### Roll back tracked bootstrap inputs

Use this when local edits to tracked workspace inputs caused preflight or doctor
to fail.

```bash
git restore AGENTS.md package.json bun.lock tsconfig.base.json tsconfig.guardrails.json
bun install --frozen-lockfile
bun run scripts/bootstrap-doctor.ts
```

### Roll back browser-mode provisioning

Use this only when the core doctor passes and the remaining failure is Playwright
browser provisioning.

```bash
bun run browser:install
bun run check:playwright
```

## Operator Workflow

For fresh clones:

```bash
bun run scripts/preflight-bootstrap.ts
bun install --frozen-lockfile
# Optional: only for browser-mode workflows.
bun run browser:install
bun run scripts/bootstrap-doctor.ts
```

A clone is considered ready only when both preflight and bootstrap doctor exit with code `0`.
