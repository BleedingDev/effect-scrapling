# Governance Audit Runbook

## Purpose

`bun run check:governance` enforces strict governance and anti-bypass rules across the repository.  
This check is mandatory in local development and CI.

Policy anchors:

- Root `AGENTS.md` step 7: reject hacks, shortcuts, black magic, and type-safety bypasses.
- Root `AGENTS.md` step 8: required gates must pass before closure (`ultracite`, `oxlint`, `oxfmt`, tests, build, bead-specific checks).
- No temporary bypass path is allowed for governance checks.

## What the audit enforces

Source scanning behavior is implemented in `scripts/guardrails/governance-audit.ts`.

- Scans JS/TS source files (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`) under repo roots.
- Fails on forbidden patterns:
  - `@ts-ignore`
  - `@ts-nocheck`
  - `@ts-expect-error`
  - `as unknown as`
  - `governance-audit-ignore`
  - `governance-bypass`
  - `guardrail-bypass`
  - `skip-governance-check`
  - blanket `eslint-disable` / `oxlint-disable` comments (except `-next-line` / `-line`)
- Fails if any non-root `AGENTS.md` exists (for example `docs/AGENTS.md`).

## How to run

### Local

```bash
bun install --frozen-lockfile
bun run check:governance
```

Expected pass output:

```text
Governance audit passed (...); no forbidden patterns or non-root AGENTS.md files found.
```

Expected fail output format:

```text
Governance audit failed. Forbidden patterns found:
- src/example.ts:12 [@ts-ignore] // @ts-ignore
```

Use this for full pre-merge parity with CI:

```bash
bun run check
```

### CI

CI enforcement is in `.github/workflows/build-sfe.yml`:

- `Guardrails (lint, format, type-safety)` runs `bun run check`
- `check` includes `bun run check:governance`

Do not remove or weaken this gate in workflow or script wiring.

## Compliant vs failing patterns

### Compliant

```ts
export const parseJobId = (input: unknown): string => {
  if (typeof input !== "string") {
    throw new Error("jobId must be a string");
  }
  return input.trim();
};
```

```ts
// Narrow through runtime checks, do not force-cast unknown values.
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
```

### Failing

```ts
// @ts-ignore
const forced = value as unknown as { id: string };
/* eslint-disable */
export const bypass = true; // governance-bypass
```

```text
docs/AGENTS.md
```

Why failing:

- Contains forbidden TS bypass and cast patterns.
- Uses blanket linter disable.
- Uses explicit governance bypass marker.
- Introduces non-root `AGENTS.md`.

## Troubleshooting

### Error: `[@ts-ignore]`, `[@ts-nocheck]`, `[@ts-expect-error]`

- Replace suppression with real typing or control-flow narrowing.
- If types are missing, add the type definitions instead of suppressing errors.

### Error: `[as unknown as]`

- Remove double-cast chains.
- Build a safe decoder/parser or guard function and narrow at runtime.

### Error: `[blanket-disable]`

- Remove file-wide disable comments.
- If a lint exception is unavoidable, scope it to one line with explicit rationale and resolve quickly.

### Error: `[non-root-AGENTS.md]`

- Keep exactly one governance file at repo root: `AGENTS.md`.
- Delete nested copies like `docs/AGENTS.md`.

### Audit flags test fixtures

- Do not commit bypass patterns in tracked JS/TS fixtures.
- Prefer runtime-generated temporary fixtures in ignored locations for negative tests.

## Rollout guidance

1. Baseline: run `bun run check:governance` on `main` and fix all violations.
2. Developer workflow: require local `bun run check` before pushing.
3. CI enforcement: keep `bun run check` required on protected branches.
4. Review rigor: any governance-rule change requires explicit review and full gate run (`ultracite`, `oxlint`, `oxfmt`, tests, build, governance checks).
5. Communication: remind contributors that bypass markers/suppressions are policy violations, not acceptable shortcuts.

## Rollback guidance (strict, no bypass)

Allowed rollback actions:

1. Revert the offending feature commit that introduced violations.
2. If a governance rule change is defective, revert that rule change via a normal reviewed PR.
3. Re-run full gates and merge only when green.

Forbidden rollback actions:

- Removing `check:governance` from `package.json`.
- Removing governance coverage from `bun run check`.
- Disabling `Guardrails` in CI.
- Adding skip markers or allowlist hacks to bypass enforcement.

If urgent delivery is blocked, rollback by code reversion, not by policy relaxation.

