# E0 Operations And Rollback Drill

## Purpose

Give operators a single E0 runbook for:

- setup and readiness entrypoints
- routine verification commands
- rollback and recovery drill execution
- evidence locations

## Command Contract

Primary E0 commands:

```bash
bun run scripts/preflight-bootstrap.ts
bun install --frozen-lockfile
bun run scripts/bootstrap-doctor.ts
bun run check:e0-capability-slice
bun run check
```

Supporting runbooks:

- `docs/runbooks/bootstrap-doctor.md`
- `docs/runbooks/e0-workspace-foundation.md`
- `docs/runbooks/lint-format-policy.md`
- `docs/runbooks/nx-workspace-graph.md`

## Rollback Drill Procedure

Run the drill in an isolated clone or disposable worktree.

```bash
TEMP_DIR="$(mktemp -d -t e0-rollback-drill.XXXXXX)"
git clone . "$TEMP_DIR/repo"
cd "$TEMP_DIR/repo"
bun run scripts/preflight-bootstrap.ts
bun install --frozen-lockfile
bun run scripts/bootstrap-doctor.ts
rm -rf node_modules dist
bun install --frozen-lockfile
bun run scripts/bootstrap-doctor.ts
```

Record the actual disposable clone path in `docs/artifacts/e0-rollback-drill.md` after the
drill completes.

Success criteria:

- preflight is green before the rollback step
- bootstrap doctor is green before the rollback step
- generated state (`node_modules`, `dist`) is removed successfully
- frozen reinstall succeeds
- bootstrap doctor is green after recovery

Evidence for the latest executed drill lives in:

- `docs/artifacts/e0-rollback-drill.md`

## Troubleshooting

### Preflight fails

- Fix the reported prerequisite first.
- Do not continue into `bun install` or `bootstrap-doctor` until preflight is green.

### Frozen install fails after rollback

- Re-check `bun.lock`, Bun version, and local registry/network state.
- Re-run `bun run scripts/preflight-bootstrap.ts` before retrying.

### Bootstrap doctor fails after recovery

- Use the failing gate output in `bootstrap-doctor` to isolate the broken
  contract.
- Re-run the specific command first, then `bun run check`.

## Rollback Policy

Allowed rollback actions:

1. Revert the offending E0 change.
2. Re-run the drill until the workspace recovers cleanly.
3. Merge only when `bun run check` is green again.

Forbidden rollback actions:

- weakening E0 guardrail scripts
- skipping `--frozen-lockfile`
- dropping verify tests to make the drill pass
- reintroducing Effect v3 dependencies or type-safety bypasses
