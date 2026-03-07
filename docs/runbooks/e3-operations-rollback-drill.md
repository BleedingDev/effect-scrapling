# E3 Operations And Rollback Drill

## Purpose

Give operators a single E3 runbook for:

- setup and readiness entrypoints
- routine E3 validation commands
- rollback and recovery drill execution
- evidence locations and focused troubleshooting

## Command Contract

Primary E3 setup and validation commands:

```bash
bun install --frozen-lockfile
bun run check:e3-capability-slice
bun run example:e3-capability-slice
bun run scripts/benchmarks/e3-access-runtime.ts \
  --sample-size 3 \
  --warmup 1 \
  --artifact tmp/e3-access-runtime-scorecard.json
```

Focused E3 diagnostics:

```bash
bun test tests/libs/foundation-core-e3-runtime.test.ts
bun test tests/libs/foundation-core-access-retry.test.ts
bun test tests/libs/foundation-core-access-timeout.test.ts
bun test tests/libs/foundation-core-identity-lease.test.ts
bun test tests/examples/e3-capability-slice.test.ts
```

Merge-blocking repository gates before bead closure:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

Supporting E3 runbooks:

- `docs/runbooks/e3-http-access-execution.md`
- `docs/runbooks/e3-access-planner-policy.md`
- `docs/runbooks/e3-identity-lease-management.md`
- `docs/runbooks/e3-egress-lease-management.md`
- `docs/runbooks/e3-retry-backoff-runbook.md`
- `docs/runbooks/e3-timeout-cancellation-runbook.md`
- `docs/runbooks/e3-access-health-runbook.md`

## Rollback Drill Procedure

Run the drill in an isolated clone or disposable worktree.

```bash
TEMP_DIR="$(mktemp -d -t e3-rollback-drill.XXXXXX)"
git clone . "$TEMP_DIR/repo"
cd "$TEMP_DIR/repo"
bun install --frozen-lockfile
bun run check:e3-capability-slice
bun run example:e3-capability-slice > tmp/e3-capability-slice.json
bun run scripts/benchmarks/e3-access-runtime.ts \
  --sample-size 3 \
  --warmup 1 \
  --artifact tmp/e3-access-runtime-scorecard.json
rm -rf node_modules dist tmp/e3-capability-slice.json tmp/e3-access-runtime-scorecard.json
bun install --frozen-lockfile
bun run check:e3-capability-slice
bun run example:e3-capability-slice > tmp/e3-capability-slice.json
bun run scripts/benchmarks/e3-access-runtime.ts \
  --sample-size 3 \
  --warmup 1 \
  --artifact tmp/e3-access-runtime-scorecard.json
```

Record the actual disposable clone path in `docs/artifacts/e3-rollback-drill.md`
after the drill completes.

Success criteria:

- frozen install is green before and after rollback
- `check:e3-capability-slice` is green before and after rollback
- the public capability example runs before and after recovery
- the reduced E3 benchmark artifact reports `status: "pass"` before and after
  rollback
- generated workspace state (`node_modules`, `dist`, tmp capability and
  benchmark artifacts) is removed successfully
- the recovered benchmark still reports bounded baseline, candidate, and retry
  measurements

Evidence for the latest executed drill lives in:

- `docs/artifacts/e3-rollback-drill.md`

## Troubleshooting

### Frozen install fails

- Re-check `bun.lock`, Bun version, and local registry/network state.
- Do not continue into capability or benchmark validation until the frozen
  install is green.

### Capability slice fails after recovery

- Re-run `bun run check:e3-capability-slice` first.
- If it still fails, use the focused E3 diagnostics above to isolate whether
  the regression is in planner, retry, timeout, or lease behavior before
  rerunning broader gates.

### Benchmark fails after recovery

- Re-run the exact benchmark command first:
  - `bun run scripts/benchmarks/e3-access-runtime.ts --sample-size 3 --warmup 1 --artifact tmp/e3-access-runtime-scorecard.json`
- If the artifact reports `status: "fail"`, create a blocking remediation bead
  instead of widening the current access-runtime budgets.

## Rollback Policy

Allowed rollback actions:

1. Revert the offending E3 change.
2. Re-run the drill until the workspace recovers cleanly.
3. Merge only when `bun run check` is green again.

Forbidden rollback actions:

- weakening retry, timeout, or access-runtime budget checks
- skipping `--frozen-lockfile`
- dropping deterministic focused diagnostics to make the drill pass
- inventing queueing, persistence, or cookie-jar behavior that the current E3
  runtime does not implement
- reintroducing Effect v3 dependencies or type-safety bypasses
