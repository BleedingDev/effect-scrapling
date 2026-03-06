# E1 Operations And Rollback Drill

## Purpose

Give operators a single E1 runbook for:

- setup and readiness entrypoints
- routine verification commands
- rollback and recovery drill execution
- evidence locations

## Command Contract

Primary E1 commands:

```bash
bun install --frozen-lockfile
bun run check:e1-capability-slice
bun run check:e1-security-review
bun run check:e1-performance-budget
bun run check:e1-foundation-core-consumer
```

Supporting runbooks:

- `docs/runbooks/e1-security-review.md`
- `docs/runbooks/e1-performance-budget.md`
- `docs/runbooks/e1-workflow-run-state.md`
- `docs/runbooks/e1-config-storage.md`

## Rollback Drill Procedure

Run the drill in an isolated clone or disposable worktree.

```bash
TEMP_DIR="$(mktemp -d -t e1-rollback-drill.XXXXXX)"
git clone . "$TEMP_DIR/repo"
cd "$TEMP_DIR/repo"
bun install --frozen-lockfile
bun run check:e1-capability-slice
bun run example:e1-foundation-core-consumer
bun run scripts/benchmarks/e1-performance-budget.ts --sample-size 3 --warmup 1
rm -rf node_modules dist
bun install --frozen-lockfile
bun run check:e1-capability-slice
bun run example:e1-foundation-core-consumer
bun run scripts/benchmarks/e1-performance-budget.ts --sample-size 3 --warmup 1
```

Record the actual disposable clone path in `docs/artifacts/e1-rollback-drill.md`
after the drill completes.

Success criteria:

- frozen install is green before the rollback step
- `check:e1-capability-slice` is green before the rollback step
- the public consumer example runs before and after recovery
- the E1 performance benchmark stays green before and after recovery
- generated state (`node_modules`, `dist`) is removed successfully
- frozen reinstall succeeds

Evidence for the latest executed drill lives in:

- `docs/artifacts/e1-rollback-drill.md`

## Troubleshooting

### Frozen install fails

- Re-check `bun.lock`, Bun version, and local registry/network state.
- Do not continue into capability or benchmark verification until install is
  green.

### Capability slice fails after recovery

- Re-run `bun run check:e1-capability-slice` first.
- If it still fails, use the failing schema/contract boundary in the output to
  isolate the regression before rerunning broader gates.

### Consumer example or benchmark fails after recovery

- Re-run the exact failing command first:
  - `bun run example:e1-foundation-core-consumer`
  - `bun run scripts/benchmarks/e1-performance-budget.ts --sample-size 3 --warmup 1`
- If the benchmark status is `fail`, create a blocking remediation bead instead
  of weakening the budget.

## Rollback Policy

Allowed rollback actions:

1. Revert the offending E1 change.
2. Re-run the drill until the workspace recovers cleanly.
3. Merge only when `bun run check` is green again.

Forbidden rollback actions:

- weakening E1 security or performance gates
- skipping `--frozen-lockfile`
- dropping verify tests to make the drill pass
- reintroducing Effect v3 dependencies or type-safety bypasses
