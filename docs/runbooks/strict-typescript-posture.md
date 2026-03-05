# Strict TypeScript Compiler Posture Runbook

## Scope

This runbook operationalizes strict TypeScript compiler posture for this Bun + Effect v4 workspace.

Policy baseline:
- `tsconfig.base.json#compilerOptions.strict` must be `true`.
- `tsconfig.base.json` must enforce `noImplicitAny` via `strict: true` or explicit `noImplicitAny: true`.
- `tsconfig.guardrails.json` must extend `tsconfig.base.json`.
- `tsconfig.guardrails.json#compilerOptions.exactOptionalPropertyTypes` must be `true`.
- `tsconfig.guardrails.json#compilerOptions.noUncheckedIndexedAccess` must be `true`.
- Every workspace `tsconfig.json` under `apps/`, `libs/`, and `tools/` must inherit from `tsconfig.base.json` and must not disable strict posture flags.
- Effect dependency posture remains v4-only (`bun run check:effect-v4-policy`) as part of release gates.

Primary enforcement points:
- `package.json#scripts.check:strict-ts-posture`
- `tsconfig.base.json`
- `tsconfig.guardrails.json`
- `package.json#scripts.typecheck`
- `package.json#scripts.check`

## Command Usage

Run from repository root.

Targeted strict-posture guardrail:

```bash
bun run check:strict-ts-posture
```

Targeted compiler verification:

```bash
bun run typecheck
```

Required full gates:

```bash
bun run check
```

Related guardrails often triaged together:

```bash
bun run lint:typesafety
bun run check:effect-v4-policy
bun run nx:typecheck
```

## Practical Usage Examples

### 1) Pre-PR strict posture verification

```bash
bun install --frozen-lockfile
bun run check:strict-ts-posture
bun run typecheck
bun run check
```

Use this sequence before requesting review on compiler/config changes.

### 2) Onboard a new workspace project without breaking strict posture

```bash
# Example for a new app/lib/tool tsconfig path:
cat > apps/new-app/tsconfig.json <<'JSON'
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler"
  },
  "include": ["src/**/*.ts"]
}
JSON

bun run check:strict-ts-posture
bun run typecheck
```

If `apps/new-app/**/*.ts` is not covered by `tsconfig.guardrails.json#include`, add/adjust include patterns and re-run the same checks.

### 3) Fast isolate of a strict TS posture failure

```bash
bun run check:strict-ts-posture
bun run typecheck
bun run lint:typesafety
```

This isolates config posture, compiler diagnostics, and bypass-pattern violations before running full gates.

## Expected Output

Pass output:

```text
Strict TypeScript posture check passed: <N> workspace tsconfig files inherit strict posture and guardrail coverage.
```

Fail output starts with:

```text
Strict TypeScript posture check failed:
```

Typical failure lines:

```text
- tsconfig.guardrails.json#compilerOptions.exactOptionalPropertyTypes must be true.
- apps/api/tsconfig.json must extend tsconfig.base.json.
- apps/api/tsconfig.json#compilerOptions.noImplicitAny must resolve to true.
```

## Troubleshooting

### `tsconfig.base.json#compilerOptions.strict must be true.`

- Set `"strict": true` in `tsconfig.base.json#compilerOptions`.
- Re-run:
  - `bun run check:strict-ts-posture`
  - `bun run typecheck`

### `tsconfig.guardrails.json must extend tsconfig.base.json to inherit strict compiler posture.`

- Set `"extends": "./tsconfig.base.json"` in `tsconfig.guardrails.json`.
- Re-run `bun run check:strict-ts-posture`.

### `tsconfig.guardrails.json#include must contain "<root>/**/*.ts".`

- Ensure `tsconfig.guardrails.json#include` covers each discovered workspace root (`apps/**/*.ts`, `libs/**/*.ts`, `tools/**/*.ts`).
- Re-run `bun run check:strict-ts-posture`.

### `<project>/tsconfig.json must extend tsconfig.base.json.`

- Add a valid relative `extends` path back to root base config, for example:
  - `"extends": "../../tsconfig.base.json"` for `apps/*`, `libs/*`, `tools/*`.
- Re-run:
  - `bun run check:strict-ts-posture`
  - `bun run typecheck`

### `<project>/tsconfig.json#compilerOptions.noImplicitAny must resolve to true.`

- Remove local `"noImplicitAny": false` overrides.
- Keep strict posture inherited from base config.
- Re-run:
  - `bun run check:strict-ts-posture`
  - `bun run typecheck`

### `<project>/tsconfig.json must not disable compilerOptions.exactOptionalPropertyTypes` or `noUncheckedIndexedAccess`

- Remove local `false` overrides for those options.
- Keep these options enabled in guardrail posture.
- Re-run:
  - `bun run check:strict-ts-posture`
  - `bun run typecheck`

### Strict posture check passes but CI still fails

- Run full gates locally in CI order:

```bash
bun run ultracite
bun run oxlint
bun run oxfmt
bun run lint:typesafety
bun run check:governance
bun run check:lockstep-version
bun run check:effect-v4-policy
bun run typecheck
bun test
bun run build
```

- Then run Nx checks:

```bash
bun run nx:show-projects
bun run nx:lint
bun run nx:typecheck
```

## Rollout Guidance

1. Prepare
- Create a branch for strict posture config/code changes.
- Confirm clean baseline:
  - `bun run check:strict-ts-posture`
  - `bun run typecheck`

2. Apply
- Update `tsconfig.base.json`, `tsconfig.guardrails.json`, and workspace `tsconfig.json` files as needed.
- Keep strict defaults inherited; do not add local relaxations.

3. Verify
- Run targeted checks:
  - `bun run check:strict-ts-posture`
  - `bun run typecheck`
  - `bun run check:effect-v4-policy`
- Run full gates:
  - `bun run check`
  - `bun run nx:show-projects && bun run nx:lint && bun run nx:typecheck`

4. Promote
- Merge only when local and CI checks are green.
- Treat strict posture regressions as release-blocking.

## Rollback Guidance

Use rollback only when a strict posture rollout introduces regressions that cannot be fixed quickly.

1. Identify the offending commit touching TS config/compiler posture.
2. Revert the offending config/code change (not guardrails).
3. Re-run:
   - `bun run check:strict-ts-posture`
   - `bun run typecheck`
   - `bun run check`
4. Re-attempt rollout with corrected strict-compatible changes.

Forbidden rollback actions:
- Setting `strict` to `false`.
- Disabling `exactOptionalPropertyTypes` or `noUncheckedIndexedAccess`.
- Introducing `noImplicitAny: false`.
- Removing strict checks from `check` pipeline.
- Adding any type-safety bypass patterns (`@ts-ignore`, `@ts-nocheck`, `as any`, `as unknown as`).

## Operator Notes

- Keep strict compiler posture as a non-negotiable baseline for all workspace projects.
- Fix code to satisfy strict checks; do not relax policy to make failing code pass.
- Keep Effect dependency posture on v4 during strict posture work (`bun run check:effect-v4-policy`).
