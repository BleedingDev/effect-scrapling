# E6 Operations And Rollback Drill

## Purpose

Give operators one truthful E6 runbook for:

- setup and readiness
- focused E6 execution commands
- bounded rebuild-and-recovery drill execution
- evidence locations and troubleshooting

This runbook documents the current E6 surface only. It does not invent a CLI,
API route, or persistence backend that does not exist today.
The current drill validates operator recovery after deleting local install/build
artifacts and regenerating persisted E6 evidence on the same overlaid source
tree. It does not claim a code-level rollback to an older commit.

## Command Contract

Primary E6 setup and validation commands:

```bash
bun install --frozen-lockfile
bun run check:e6-capability-slice
bun run check:e6-security-review
bun run check:e6-performance-budget
bun run check:e6-sdk-consumer
```

Focused E6 diagnostics:

```bash
bun test tests/examples/e6-capability-slice.test.ts
bun test tests/guardrails/e6-security-review.verify.test.ts
bun test tests/scripts/e6-performance-budget.test.ts
bun test tests/sdk/e6-consumer-example.test.ts
bun test tests/libs/foundation-core-reflection-engine-runtime.test.ts
bun test tests/libs/foundation-core-pack-governance-runtime.test.ts
```

Persisted operator artifacts:

```bash
bun run check:e6-performance-budget
```

Repository gates before bead closure:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

## Current Runtime Contract

The current E6 operator-visible surface is library and example driven:

- `bun run check:e6-capability-slice` replays the full domain-adaptation path
- `bun run check:e6-security-review` replays pack-domain, reflection, and
  governance hardening
- `bun run check:e6-performance-budget` emits the current operator scorecard
  from the 3-run capability-slice micro-batch plus the fixed registry,
  reflector, and governance workloads
- `bun run check:e6-sdk-consumer` proves public-consumer ergonomics without
  private imports

Supporting runbooks:

- `docs/runbooks/e6-site-pack-dsl-contracts.md`
- `docs/runbooks/e6-pack-registry-resolution.md`
- `docs/runbooks/e6-pack-lifecycle-state-machine.md`
- `docs/runbooks/e6-selector-trust-decay.md`
- `docs/runbooks/e6-pack-candidate-generator.md`
- `docs/runbooks/e6-reflector-clustering.md`
- `docs/runbooks/e6-validator-ladder.md`
- `docs/runbooks/e6-shadow-active-governance-automation.md`
- `docs/runbooks/e6-pack-governance-actions.md`
- `docs/runbooks/e6-pack-versioning-immutable-active.md`
- `docs/runbooks/e6-security-review.md`
- `docs/runbooks/e6-performance-budget.md`

## Standard Execution Flow

### 1. Setup The Repository

```bash
bun install --frozen-lockfile
```

### 2. Replay The Integrated E6 Surface

```bash
bun run check:e6-capability-slice
bun run check:e6-security-review
bun run check:e6-performance-budget
bun run check:e6-sdk-consumer
```

### 3. Persist A Bounded E6 Artifact

```bash
bun run scripts/benchmarks/e6-performance-budget.ts \
  --artifact docs/artifacts/e6-performance-budget-scorecard.json \
  --baseline docs/artifacts/e6-performance-budget-baseline.json
```

Inspect:

- `status === "pass"`
- no `violations`
- `stability.*.consistent === true`

### 4. Replay Repository Gates

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

## Rebuild And Recovery Drill Procedure

Run the current recovery drill in an isolated disposable clone or worktree:

```bash
TEMP_DIR="$(mktemp -d -t e6-rollback-drill.XXXXXX)"
git clone . "$TEMP_DIR/repo"
rsync -a \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'tmp/' \
  --exclude '.beads/dolt-monitor.pid.lock' \
  ./ "$TEMP_DIR/repo/"
cd "$TEMP_DIR/repo"
bun install --frozen-lockfile
bun run check:e6-capability-slice
bun run check:e6-security-review
bun run check:e6-performance-budget
bun run check:e6-sdk-consumer
rm -rf node_modules dist docs/artifacts/e6-performance-budget-scorecard.json
bun install --frozen-lockfile
bun run check:e6-capability-slice
bun run check:e6-security-review
bun run check:e6-performance-budget
bun run check:e6-sdk-consumer
```

Record the executed evidence in `docs/artifacts/e6-rollback-drill.md`.
Capture only the compact scorecard summary there, not the full JSON artifact.

## Troubleshooting

### Security review failed

1. rerun `bun test tests/guardrails/e6-security-review.verify.test.ts`
2. inspect recent changes in:
   - `libs/foundation/core/src/site-pack.ts`
   - `libs/foundation/core/src/reflection-engine-runtime.ts`
   - `libs/foundation/core/src/pack-governance-runtime.ts`

### Performance budget failed

1. rerun `bun run check:e6-capability-slice`
2. rerun `bun test tests/scripts/e6-performance-budget.test.ts`
3. compare against `docs/artifacts/e6-performance-budget-baseline.json`
4. rerun `bun run check:e6-performance-budget` on an otherwise idle machine
   before opening remediation, because the E6 gate is intentionally local and
   machine-sensitive within its current bounded scope

### Consumer example failed

1. rerun `bun test tests/sdk/e6-consumer-example.test.ts`
2. verify imports stay on public `@effect-scrapling/foundation-core/*` subpaths

## Rollback Guidance

1. revert the offending E6 change instead of weakening the benchmark or
   governance rules
2. rerun:

```bash
bun run check:e6-capability-slice
bun run check:e6-security-review
bun run check:e6-performance-budget
bun run check:e6-sdk-consumer
```

3. do not roll back by:
   - hand-editing governance artifacts to hide active-version drift
   - relaxing the E6 benchmark budgets without evidence
   - reintroducing private imports into downstream examples

## Scope Boundary

This runbook's executable drill proves:

- frozen-install recovery
- regenerated `dist/`
- regenerated E6 performance scorecard
- green E6 capability, security, and consumer checks on the same source tree

It does not, by itself, prove a rollback to a previous git commit or release
tag. If you need commit-level rollback evidence, run a separate release
rollback procedure against the specific known-good revision.
