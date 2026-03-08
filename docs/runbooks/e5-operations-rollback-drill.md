# E5 Operations And Rollback Drill

## Purpose

Give operators a single E5 runbook for:

- durable-workflow setup and readiness
- routine E5 execution commands
- rollback and recovery drill execution
- evidence locations and focused troubleshooting

This runbook consolidates the current E5 operational contract without inventing
new control planes, persistence backends, or recovery shortcuts that do not
exist today.

## Command Contract

Primary E5 setup and validation commands:

```bash
bun install --frozen-lockfile
bun run check:e5-capability-slice
bun run check:e5-checkpoint-persistence-restore
bun run check:e5-duplicate-work-suppression
bun run check:e5-workflow-budget-integration
bun run check:e5-crash-resume-harness
```

Operator-visible E5 performance status command:

```bash
bun run check:e5-workflow-simulation
```

The rollback drill in this runbook does not require the default `200000`
observation simulation gate to pass. That gate is tracked separately as the E5
performance lane, and operators should read its current status from
`docs/artifacts/e5-workflow-simulation-scorecard.json` instead of assuming it
is green.

Focused E5 diagnostics:

```bash
bun test tests/libs/foundation-core-crawl-plan-runtime.test.ts
bun test tests/libs/foundation-core-durable-workflow-runtime.test.ts
bun test tests/libs/foundation-core-sqlite-run-checkpoint-store.test.ts
bun test tests/libs/foundation-core-workflow-budget-runtime.test.ts
bun test tests/libs/foundation-core-workflow-work-claim-store.test.ts
bun test tests/examples/e5-capability-slice.test.ts
bun test tests/scripts/e5-crash-resume-harness.test.ts
bun test tests/scripts/e5-workflow-simulation.test.ts
```

Reduced persisted drill artifacts:

```bash
bun run scripts/benchmarks/e5-workflow-simulation.ts \
  --artifact tmp/e5-workflow-simulation-scorecard.json \
  --targets 50 \
  --observations-per-target 1000 \
  --sample-size 1 \
  --warmup 0

bun run scripts/benchmarks/e5-crash-resume-harness.ts \
  --artifact tmp/e5-crash-resume-harness-scorecard.json \
  --targets 2 \
  --observations-per-target 6 \
  --crash-after-sequence 1 \
  --crash-after-sequence 2
```

Merge-blocking repository gates before bead closure:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

Supporting E5 runbooks:

- `docs/runbooks/e5-crawl-plan-compilation.md`
- `docs/runbooks/e5-durable-workflow-graph-fanout-fanin.md`
- `docs/runbooks/e5-checkpoint-persistence-restore.md`
- `docs/runbooks/e5-crash-resume-harness.md`
- `docs/runbooks/e5-duplicate-work-suppression.md`
- `docs/runbooks/e5-workflow-operational-controls.md`
- `docs/runbooks/e5-resume-replay-operations.md`
- `docs/runbooks/e5-workflow-inspection-read-models.md`
- `docs/runbooks/e5-workflow-budget-integration.md`
- `docs/runbooks/e5-workflow-simulation.md`

## Current Runtime Contract

Operators should read the integrated E5 evidence with these current guarantees
in mind:

- crawl-plan compilation preserves canonical target ordering and appends the
  durable stages `diff`, `quality`, and `reflect`
- durable execution persists three post-start checkpoints in order:
  `snapshot`, `quality`, `reflect`
- checkpoint restore remains checksum-verified and fails on a corrupted latest
  persisted row instead of silently falling back to older state
- duplicate-work suppression is keyed per run and step lineage and preserves a
  clean happy-path claim history without takeover drift
- workflow-budget enforcement is exercised at capture boundaries and reports
  structured budget events
- crash-resume replay preserves output parity, budget-event parity, and
  work-claim parity across deterministic restart boundaries
- the default `100 x 2000` simulation scorecard is a separate performance gate;
  it is not the rollback-drill success signal in this runbook
- the E5 capability slice currently emits typed evidence for:
  - compiled crawl plans
  - restart-boundary run summaries with typed inspections
  - budget-event summaries
  - work-claim summaries

## Standard Execution Flow

### 1. Setup The Repository

Run from repository root:

```bash
bun install --frozen-lockfile
```

What this proves today:

- dependencies match `bun.lock`
- the current Bun workspace is installable without mutating the lockfile

### 2. Run The Integrated E5 Capability Slice

```bash
bun run check:e5-capability-slice
```

What to inspect:

- the example test passes
- the emitted JSON evidence shows:
  - canonical six-stage run plans
  - a deterministic crash/resume sample on two targets
  - matching baseline and recovered outputs
  - matching baseline and recovered budget/work-claim summaries

If you need a persisted evidence file instead of stdout only:

```bash
bun run example:e5-capability-slice > tmp/e5-capability-slice.json
```

### 3. Revalidate Restore, Dedupe, And Budget Paths

```bash
bun run check:e5-checkpoint-persistence-restore
bun run check:e5-duplicate-work-suppression
bun run check:e5-workflow-budget-integration
```

Use these gates before escalating to broader repository checks. They isolate
the current durable-state, work-claim, and permit-enforcement surfaces.

### 4. Persist Bounded E5 Artifacts

```bash
bun run scripts/benchmarks/e5-workflow-simulation.ts \
  --artifact tmp/e5-workflow-simulation-scorecard.json \
  --targets 50 \
  --observations-per-target 1000 \
  --sample-size 1 \
  --warmup 0

bun run scripts/benchmarks/e5-crash-resume-harness.ts \
  --artifact tmp/e5-crash-resume-harness-scorecard.json \
  --targets 2 \
  --observations-per-target 6 \
  --crash-after-sequence 1 \
  --crash-after-sequence 2
```

What to inspect:

- both artifacts report `status === "pass"`
- the simulation artifact keeps `violations = []`
- the crash-resume artifact keeps:
  - `sample.matchedOutputs === true`
  - `sample.matchedBudgetEvents === true`
  - `sample.matchedWorkClaims === true`

Why this runbook uses the reduced simulation profile:

- the rollback drill is validating recoverability and operator repeatability,
  not signing off the separate default `200000` observation performance gate
- the current operator-visible performance status for the default profile lives
  in `docs/artifacts/e5-workflow-simulation-scorecard.json`
- if the default scorecard is red, preserve that artifact for the performance
  lane instead of mutating the rollback procedure to hide it

### 5. Replay Repository Gates Before Closure

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

## Rollback Drill Procedure

Run the drill in an isolated clone or disposable worktree.

```bash
TEMP_DIR="$(mktemp -d -t e5-rollback-drill.XXXXXX)"
git clone . "$TEMP_DIR/repo"
cd "$TEMP_DIR/repo"
bun install --frozen-lockfile
bun run check:e5-capability-slice
bun run check:e5-checkpoint-persistence-restore
bun run check:e5-duplicate-work-suppression
bun run check:e5-workflow-budget-integration
bun run scripts/benchmarks/e5-workflow-simulation.ts \
  --artifact tmp/e5-workflow-simulation-scorecard.json \
  --targets 50 \
  --observations-per-target 1000 \
  --sample-size 1 \
  --warmup 0
bun run scripts/benchmarks/e5-crash-resume-harness.ts \
  --artifact tmp/e5-crash-resume-harness-scorecard.json \
  --targets 2 \
  --observations-per-target 6 \
  --crash-after-sequence 1 \
  --crash-after-sequence 2
rm -rf node_modules dist tmp/e5-capability-slice.json tmp/e5-workflow-simulation-scorecard.json tmp/e5-crash-resume-harness-scorecard.json
bun install --frozen-lockfile
bun run check:e5-capability-slice
bun run check:e5-checkpoint-persistence-restore
bun run check:e5-duplicate-work-suppression
bun run check:e5-workflow-budget-integration
bun run scripts/benchmarks/e5-workflow-simulation.ts \
  --artifact tmp/e5-workflow-simulation-scorecard.json \
  --targets 50 \
  --observations-per-target 1000 \
  --sample-size 1 \
  --warmup 0
bun run scripts/benchmarks/e5-crash-resume-harness.ts \
  --artifact tmp/e5-crash-resume-harness-scorecard.json \
  --targets 2 \
  --observations-per-target 6 \
  --crash-after-sequence 1 \
  --crash-after-sequence 2
```

Success criteria:

- frozen install is green before and after rollback
- `check:e5-capability-slice` is green before and after rollback
- restore, duplicate-work, and budget checks stay green before and after rollback
- both reduced persisted artifacts report `status: "pass"` before and after
  rollback
- generated workspace state is removed successfully

Non-goals for this drill:

- proving that the default `200000` observation simulation performance gate is
  green
- replacing the E5 performance lane with a smaller rollback-only workload

Evidence for the latest executed drill lives in:

- `docs/artifacts/e5-rollback-drill.md`

## Troubleshooting

### Capability slice fails after recovery

- Re-run `bun run check:e5-capability-slice` first.
- If the failure persists, isolate the failing subsystem with:
  - `tests/libs/foundation-core-crawl-plan-runtime.test.ts`
  - `tests/libs/foundation-core-durable-workflow-runtime.test.ts`
  - `tests/scripts/e5-crash-resume-harness.test.ts`

### Restore or duplicate-work checks fail after recovery

- Re-run the exact failing command first:
  - `bun run check:e5-checkpoint-persistence-restore`
  - `bun run check:e5-duplicate-work-suppression`
- Preserve the failing checkpoint or work-claim evidence instead of deleting it.

### Budget integration or simulation artifacts fail

- Re-run the exact failing command first:
  - `bun run check:e5-workflow-budget-integration`
  - `bun run scripts/benchmarks/e5-workflow-simulation.ts --artifact tmp/e5-workflow-simulation-scorecard.json --targets 50 --observations-per-target 1000 --sample-size 1 --warmup 0`
- If a reduced simulation artifact reports `status: "fail"`, treat that as a
  blocking runtime regression, not as a docs-only issue.
- When a reduced or default simulation budget is breached, create a blocking
  remediation bead immediately before doing any budget changes. Use a command
  in this shape:

```bash
CI=1 bd create \
  --title "[E5] Remediate: workflow simulation budget breach" \
  --description $'Capture the breached metric names, measured values, artifact path, reproduction command, and suspected cause from the failing E5 simulation gate.' \
  --type task \
  --priority 1 \
  --labels epic-e5,lane-performance,phase-5
```

- If the reduced drill passes but `bun run check:e5-workflow-simulation` fails,
  treat that as a separate E5 performance-lane breach and preserve
  `docs/artifacts/e5-workflow-simulation-scorecard.json` as the operator
  status record.

### Crash-resume artifact drifts after recovery

- Re-run `bun run scripts/benchmarks/e5-crash-resume-harness.ts --artifact tmp/e5-crash-resume-harness-scorecard.json --targets 2 --observations-per-target 6 --crash-after-sequence 1 --crash-after-sequence 2`
- If parity fields drift, preserve the emitted artifact and roll back the
  candidate E5 runtime change instead of weakening the parity contract.

## Rollback Policy

Allowed rollback actions:

1. Revert the offending E5 change.
2. Re-run the drill until the workspace recovers cleanly.
3. Merge only when `bun run check` is green again.

Forbidden rollback actions:

- weakening checkpoint verification or duplicate-work invariants
- widening workflow budgets to hide regressions
- deleting emitted crash-resume or simulation evidence to make the drill look green
- skipping `--frozen-lockfile`
- introducing Effect v3 dependencies or type-safety bypasses
