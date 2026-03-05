# Guardrail Parity Report (bd-onp.1)

Reference repositories:
- `/Users/satan/code/coding-agent-zcp/template`
- `/Users/satan/code/coding-agent-zcp/platform`

## Implemented in this repository

| Guardrail | Status | Implementation |
| --- | --- | --- |
| Nx workspace graph | Implemented | `nx.json`, project files under `apps/`, `libs/`, `tools/`, `.sf/` |
| Module boundary enforcement | Implemented | `.oxlintrc.json` with `@nx/enforce-module-boundaries` constraints and Nx project tags |
| Oxlint policy | Implemented | `.oxlintrc.json`, `package.json` scripts `oxlint`, `lint` |
| Oxfmt policy | Implemented | `.oxfmtrc.json`, `package.json` scripts `format`, `format:check`, `oxfmt` |
| Ultracite checks | Implemented | `package.json` scripts `ultracite`, `check` |
| Type-safety bypass ban | Implemented | `scripts/guardrails/type-safety-bypass-check.ts`, script `lint:typesafety` |
| Strict TS posture | Implemented | `tsconfig.guardrails.json` (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, strict checks) |
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
bun test
bun run build
bun run nx:show-projects
bun run nx:lint
bun run nx:typecheck
```

Lockstep policy update (bd-onp.13): workspace `package.json` files now have a dedicated guardrail at `scripts/guardrails/version-lockstep-policy.ts` to enforce a single release train against the root `version`.
