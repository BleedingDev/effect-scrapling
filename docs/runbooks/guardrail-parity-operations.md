# Guardrail Parity Operations Runbook

## Purpose

Operate the mirrored template/platform guardrail stack in this repository with reproducible, no-bypass enforcement.

Primary references:
- [Guardrail Parity Report](../guardrail-parity.md)
- [Effect v4 Dependency Policy Runbook](./effect-v4-policy.md)
- [Strict TypeScript Compiler Posture Runbook](./strict-typescript-posture.md)
- [Governance Audit Runbook](./governance-audit.md)

Primary implementation points:
- `package.json` scripts (`check`, `lint`, `check:*`, `nx:*`)
- `scripts/guardrails/effect-v4-policy.ts`
- `scripts/guardrails/governance-audit.ts`
- `scripts/guardrails/strict-ts-posture.ts`
- `scripts/guardrails/type-safety-bypass-check.ts`
- `scripts/guardrails/version-lockstep-policy.ts`
- `scripts/validate-version.ts`
- `.github/workflows/build-sfe.yml`

## Strict Operating Policy

- No bypasses, hacks, or temporary allowlists are permitted.
- Do not disable or weaken `bun run check`, guardrail scripts, CI guardrail steps, or lints to make a failing change pass.
- Effect baseline is v4-only and must remain v4-only in `package.json` files and `bun.lock`.
- Rollback is done by reverting offending code/config, never by relaxing guardrails.

## Guardrail Command Map

| Area | Source of truth | Operator command | Pass signal |
| --- | --- | --- | --- |
| Full gate | `package.json#scripts.check` | `bun run check` | Ends with successful `build` after all guardrails/test/typecheck |
| Lint policy | `package.json#scripts.ultracite` + `oxlint` | `bun run ultracite` / `bun run oxlint` | No lint violations |
| Format policy | `package.json#scripts.oxfmt` | `bun run oxfmt` | `oxfmt --check` exits clean |
| Type-safety bypass ban | `scripts/guardrails/type-safety-bypass-check.ts` | `bun run lint:typesafety` | `Type-safety bypass check passed (...)` |
| Governance audit | `scripts/guardrails/governance-audit.ts` | `bun run check:governance` | `Governance audit passed (...)` |
| Workspace lockstep version | `scripts/guardrails/version-lockstep-policy.ts` | `bun run check:lockstep-version` | `Workspace version lockstep policy OK ...` |
| Effect v4 dependency baseline | `scripts/guardrails/effect-v4-policy.ts` | `bun run check:effect-v4-policy` | `Effect v4 dependency policy check passed ...` |
| Strict TS posture | `scripts/guardrails/strict-ts-posture.ts`, `tsconfig.base.json`, `tsconfig.guardrails.json` | `bun run scripts/guardrails/strict-ts-posture.ts` | `Strict TypeScript posture check passed ...` |
| Semver release policy | `scripts/validate-version.ts` | `bun run check:semver` | `Version policy OK: ...` |
| Nx parity checks | `package.json#scripts.nx:*` | `bun run nx:show-projects && bun run nx:lint && bun run nx:typecheck` | Nx commands complete without errors |

## Practical Usage Examples

### 1) Pre-PR guardrail pass (local)

```bash
bun install --frozen-lockfile
bun run check
```

Use when preparing a merge candidate. This is the same chained gate order enforced by CI guardrail jobs.

### 2) Dependency update while preserving Effect v4 baseline

```bash
bun add effect@^4
bun install
bun run check:effect-v4-policy
rg -n '"effect"\\s*:' **/package.json
```

If the policy script fails, fix manifests and `bun.lock` until `check:effect-v4-policy` is clean before continuing.

### 3) Version bump with lockstep policy

```bash
# Update root version and every workspace package version together.
bun run check:lockstep-version
bun run check:semver
```

Run both checks before opening a release PR.

### 4) Fast isolate of the first failing guardrail

```bash
bun run ultracite
bun run oxlint
bun run oxfmt
bun run lint:typesafety
bun run check:governance
bun run check:lockstep-version
bun run check:effect-v4-policy
```

This mirrors the front half of `bun run check` and pinpoints the first failing gate quickly.

### 5) Parity verification against report expectations

```bash
bun run check
bun run nx:show-projects
bun run nx:lint
bun run nx:typecheck
```

Matches the validation set listed in [Guardrail Parity Report](../guardrail-parity.md).

## Troubleshooting

### `Type-safety bypass patterns are forbidden`

- Remove `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `as any`, `as unknown as`, and related bypasses.
- Replace with explicit type narrowing or typed parser/decoder logic.
- Re-run `bun run lint:typesafety`.

### `Governance audit failed. Forbidden patterns found`

- Remove governance bypass markers and blanket `eslint-disable` / `oxlint-disable`.
- Ensure only one `AGENTS.md` exists at repo root (no nested `AGENTS.md` files).
- Re-run `bun run check:governance`.

### `Workspace version lockstep policy failed`

- Align every workspace `package.json` `version` field to root `package.json#version`.
- Re-run `bun run check:lockstep-version`.

### `Effect v4 dependency policy violations detected`

- Fix any non-v4 `effect` range and remove denylisted legacy Effect packages.
- Regenerate lockfile with `bun install` if dependency graph changed.
- Re-run `bun run check:effect-v4-policy`.

### `Version ... is not allowed by pre-1.0 policy`

- Keep major version `0` unless running the controlled v1 release workflow.
- Only use `ALLOW_V1_RELEASE=1` in the explicit manual v1 release process.
- Re-run `bun run check:semver`.

### CI fails but local passes

- Re-run from a clean state (fresh clone or fresh worktree preferred):

```bash
git status --short
bun install --frozen-lockfile
bun run check
```

- Confirm no local-only bypassing changes exist in scripts or workflow files.

## Rollout Guidance

1. Create a branch for the guardrail/config/doc update.
2. Implement script/config changes and update parity docs in the same PR.
3. Run targeted checks for touched guardrails.
4. Run `bun run check` and Nx parity commands before requesting review.
5. Merge only when guardrails, tests, typecheck, and build are all green.
6. Monitor post-merge CI for the next run and treat any regression as blocking.

## Rollback Guidance

1. Identify the offending commit introducing the guardrail regression.
2. Revert the commit (or narrow revert to the faulty change) without disabling policy.
3. Re-run `bun install --frozen-lockfile` if dependency/lockfile changed.
4. Re-run `bun run check` and Nx parity commands.
5. Re-attempt rollout with corrected implementation.

Forbidden rollback actions:
- Removing guardrails from `package.json#scripts.check`.
- Weakening `scripts/guardrails/*` checks to allow known violations.
- Disabling CI guardrail steps in `.github/workflows/build-sfe.yml`.
- Introducing Effect v3 or denylisted legacy Effect packages as a “temporary” fix.
