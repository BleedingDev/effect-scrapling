# Guardrail Parity Report (bd-onp.1)

Reference repositories:
- `/Users/satan/code/coding-agent-zcp/template`
- `/Users/satan/code/coding-agent-zcp/platform`

Operations runbook:
- `docs/runbooks/guardrail-parity-operations.md`
- `docs/runbooks/strict-typescript-posture.md`
- `docs/runbooks/lint-format-policy.md`

## Implemented in this repository

| Guardrail | Status | Implementation |
| --- | --- | --- |
| Nx workspace graph | Implemented | `nx.json`, project files under `apps/`, `libs/`, `tools/`, `.sf/` |
| Module boundary enforcement | Implemented | `.oxlintrc.json` with `@nx/enforce-module-boundaries` constraints and Nx project tags |
| Oxlint policy | Implemented | `.oxlintrc.json`, `package.json` scripts `oxlint`, `lint` |
| Oxfmt policy | Implemented | `.oxfmtrc.json`, `package.json` scripts `format`, `format:check`, `oxfmt` |
| Ultracite checks | Implemented | `package.json` scripts `ultracite`, `check` |
| Type-safety bypass ban | Implemented | `scripts/guardrails/type-safety-bypass-check.ts`, script `lint:typesafety` |
| Effect v4 dependency policy | Implemented | `scripts/guardrails/effect-v4-policy.ts` (v4-only `effect` ranges + denylist scan across manifests and `bun.lock`) |
| Strict TS posture | Implemented | `scripts/guardrails/strict-ts-posture.ts`, `tsconfig.base.json`, `tsconfig.guardrails.json` (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, strict checks) |
| CI guardrail enforcement | Implemented | `.github/workflows/build-sfe.yml` steps `Guardrails` + `Nx workspace checks` |
| Semver release policy | Implemented | `scripts/validate-version.ts`, script `check:semver` |

## Tracked differences with rationale

| Upstream pattern | Status | Rationale |
| --- | --- | --- |
| `pnpm` + custom `tools/run-bun.sh` wrappers | Intentionally not mirrored | This repo uses Bun-native scripts and lockfile (`bun.lock`) to keep toolchain deterministic for this project. |
| Full enterprise check suite (`architecture`, `decision`, `knowledge`, `entropy`) | Deferred | Not yet required by E0 acceptance criteria; can be added in later E0 child beads without weakening current gates. |
| Complex multi-app tags (`tech:*`, `bc:*`) | Scoped variant implemented | Current project stage uses `type:*` tags only; constraints are enforced now and can be expanded as domains grow. |

## Validation commands

Run before bead closure:

```bash
bun run ultracite
bun run oxlint
bun run oxfmt
bun run check:strict-ts-posture
bun run typecheck
bun test
bun run build
bun run nx:show-projects
bun run nx:lint
bun run nx:typecheck
```

## Incremental update (bd-onp.28)

- Added `scripts/guardrails/governance-audit.ts` to fail on governance-forbidden patterns (`@ts-ignore`, `@ts-nocheck`, blanket `eslint-disable`/`oxlint-disable`, `as unknown as`, governance bypass markers) and on any non-root `AGENTS.md` reintroduction.

Lockstep policy update (bd-onp.13): workspace `package.json` files now have a dedicated guardrail at `scripts/guardrails/version-lockstep-policy.ts` to enforce a single release train against the root `version`.
