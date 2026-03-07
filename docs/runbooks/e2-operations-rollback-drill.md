# E2 Operations And Rollback Drill

## Purpose

Give operators a single E2 runbook for:

- setup and readiness entrypoints
- routine E2 validation commands
- rollback and recovery drill execution
- evidence locations and focused troubleshooting

## Command Contract

Primary E2 setup and validation commands:

```bash
bun install --frozen-lockfile
bun run check:e2-capability-slice
bun run check:e2-sdk-consumer
bun run check:e2-security-review
bun run scripts/benchmarks/e2-performance-budget.ts \
  --sample-size 3 \
  --warmup 1 \
  --artifact tmp/e2-performance-budget-scorecard.json
```

Focused E2 diagnostics:

```bash
bun test tests/libs/foundation-core-e2-runtime.test.ts
bun test tests/libs/foundation-core-extractor-runtime.test.ts
bun test tests/libs/foundation-core-domain-normalizers.test.ts
bun test tests/libs/foundation-core-assertion-engine.test.ts
bun test tests/libs/foundation-core-evidence-manifest.test.ts
bun test tests/libs/foundation-core-snapshot-builder.test.ts
bun test tests/libs/foundation-core-snapshot-diff-engine.test.ts
bun test tests/libs/foundation-core-golden-fixtures.test.ts
bun test tests/examples/e2-capability-slice.test.ts
bun test tests/sdk/e2-consumer-example.test.ts
```

Merge-blocking repository gates before bead closure:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

Supporting E2 runbooks:

- `docs/runbooks/e2-extractor-orchestration.md`
- `docs/runbooks/e2-deterministic-parser.md`
- `docs/runbooks/e2-selector-precedence.md`
- `docs/runbooks/e2-selector-relocation.md`
- `docs/runbooks/e2-security-review.md`
- `docs/runbooks/e2-performance-budget.md`

## Rollback Drill Procedure

Run the drill in an isolated clone or disposable worktree.

```bash
TEMP_DIR="$(mktemp -d -t e2-rollback-drill.XXXXXX)"
git clone . "$TEMP_DIR/repo"
cd "$TEMP_DIR/repo"
bun install --frozen-lockfile
bun run check:e2-capability-slice
bun run example:e2-sdk-consumer
bun run check:e2-security-review
bun run scripts/benchmarks/e2-performance-budget.ts \
  --sample-size 3 \
  --warmup 1 \
  --artifact tmp/e2-performance-budget-scorecard.json
rm -rf node_modules dist tmp/e2-performance-budget-scorecard.json
bun install --frozen-lockfile
bun run check:e2-capability-slice
bun run example:e2-sdk-consumer
bun run check:e2-security-review
bun run scripts/benchmarks/e2-performance-budget.ts \
  --sample-size 3 \
  --warmup 1 \
  --artifact tmp/e2-performance-budget-scorecard.json
```

Record the actual disposable clone path in `docs/artifacts/e2-rollback-drill.md`
after the drill completes.

Success criteria:

- frozen install is green before and after rollback
- `check:e2-capability-slice` is green before and after rollback
- the public SDK consumer example runs before and after recovery
- the E2 security review stays green before and after recovery
- the reduced E2 performance artifact reports `status: "pass"` before and after
  rollback
- generated workspace state (`node_modules`, `dist`, tmp benchmark artifacts) is
  removed successfully

Evidence for the latest executed drill lives in:

- `docs/artifacts/e2-rollback-drill.md`

## Troubleshooting

### Frozen install fails

- Re-check `bun.lock`, Bun version, and local registry/network state.
- Do not continue into capability, consumer, or benchmark validation until the
  frozen install is green.

### Capability slice or consumer example fails after recovery

- Re-run the failing public command first:
  - `bun run check:e2-capability-slice`
  - `bun run example:e2-sdk-consumer`
- If the failure persists, isolate the affected subsystem with the focused E2
  diagnostics above before rerunning broader gates.

### Security review or performance budget fails after recovery

- Re-run the exact failing command first:
  - `bun run check:e2-security-review`
  - `bun run scripts/benchmarks/e2-performance-budget.ts --sample-size 3 --warmup 1 --artifact tmp/e2-performance-budget-scorecard.json`
- If the benchmark artifact reports `status: "fail"`, create a blocking
  remediation bead instead of weakening the budget.

## Rollback Policy

Allowed rollback actions:

1. Revert the offending E2 change.
2. Re-run the drill until the workspace recovers cleanly.
3. Merge only when `bun run check` is green again.

Forbidden rollback actions:

- weakening E2 security or performance gates
- skipping `--frozen-lockfile`
- dropping deterministic verify coverage to make the drill pass
- relaxing the current bounded selector and typed assertion contracts
- reintroducing Effect v3 dependencies or type-safety bypasses
