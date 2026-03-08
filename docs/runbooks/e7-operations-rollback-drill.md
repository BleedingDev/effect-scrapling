# E7 Operations And Rollback Drill

## Purpose

Give operators one truthful E7 runbook for:

- setup and readiness
- focused E7 execution commands
- bounded rebuild-and-recovery drill execution
- evidence locations and troubleshooting

This runbook documents the current E7 quality-harness surface only. It does not
claim live-site parity, production launch readiness, or rollback to an older
git revision. The current drill validates rebuild and recovery on the same
overlaid source tree after local install/build/artifact cleanup.

## Command Contract

Primary E7 setup and validation commands:

```bash
bun install --frozen-lockfile
bun run check:e7-baseline-corpus
bun run check:e7-incumbent-comparison
bun run check:e7-drift-regression
bun run check:e7-performance-budget
bun run check:e7-chaos-provider-suite
bun run check:e7-promotion-gate-policy
bun run check:e7-quality-report
bun run check:e7-soak-endurance-suite
bun run check:e7-quality-metrics
bun run check:e7-live-canary
bun run check:e7-security-review
bun run check:e7-sdk-consumer
bun run check:e7-capability-slice
```

Focused E7 diagnostics:

```bash
bun test tests/libs/foundation-core-baseline-corpus-runtime.test.ts
bun test tests/libs/foundation-core-incumbent-comparison-runtime.test.ts
bun test tests/libs/foundation-core-drift-regression-runtime.test.ts
bun test tests/libs/foundation-core-performance-gate-runtime.test.ts
bun test tests/libs/foundation-core-chaos-provider-suite-runtime.test.ts
bun test tests/libs/foundation-core-promotion-gate-policy-runtime.test.ts
bun test tests/libs/foundation-core-quality-report-runtime.test.ts
bun test tests/libs/foundation-core-quality-soak-suite-runtime.test.ts
bun test tests/libs/foundation-core-quality-metrics-runtime.test.ts
bun test tests/libs/foundation-core-live-canary-runtime.test.ts
bun test tests/guardrails/e7-security-review.verify.test.ts
bun test tests/sdk/e7-consumer-example.test.ts
bun test tests/examples/e7-capability-slice.test.ts
```

Repository gates before bead closure:

```bash
bun run lint
bun run check
NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run nx:lint
NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run nx:typecheck
NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run nx:build
```

## Current Runtime Contract

The current E7 operator-visible surface is deterministic and local:

- `check:e7-baseline-corpus` persists the fixed baseline corpus artifact
- `check:e7-incumbent-comparison` persists candidate versus incumbent deltas
- `check:e7-drift-regression` verifies typed drift severity classification
- `check:e7-performance-budget` persists the committed E7 latency and memory
  scorecard
- `check:e7-quality-report` persists the machine-readable quality report
- `check:e7-soak-endurance-suite` persists the bounded-growth stability report
- `check:e7-quality-metrics`, `check:e7-live-canary`, `check:e7-chaos-provider-suite`,
  and `check:e7-promotion-gate-policy` validate the remaining promotion inputs
- `check:e7-security-review`, `check:e7-sdk-consumer`, and
  `check:e7-capability-slice` validate the public review, consumer, and
  integration boundaries

Supporting runbooks:

- `docs/runbooks/e7-baseline-corpus.md`
- `docs/runbooks/e7-incumbent-comparison.md`
- `docs/runbooks/e7-drift-regression-analysis.md`
- `docs/runbooks/e7-performance-budget.md`
- `docs/runbooks/e7-chaos-provider-suite.md`
- `docs/runbooks/e7-promotion-gate-policy.md`
- `docs/runbooks/e7-quality-report.md`
- `docs/runbooks/e7-soak-endurance-suite.md`
- `docs/runbooks/e7-quality-metrics.md`
- `docs/runbooks/e7-live-canary.md`
- `docs/runbooks/e7-security-review.md`

## Standard Execution Flow

### 1. Setup The Repository

```bash
bun install --frozen-lockfile
```

### 2. Replay The Integrated E7 Surface

```bash
bun run check:e7-baseline-corpus
bun run check:e7-incumbent-comparison
bun run check:e7-drift-regression
bun run check:e7-performance-budget
bun run check:e7-chaos-provider-suite
bun run check:e7-promotion-gate-policy
bun run check:e7-quality-report
bun run check:e7-soak-endurance-suite
bun run check:e7-quality-metrics
bun run check:e7-live-canary
bun run check:e7-security-review
bun run check:e7-sdk-consumer
bun run check:e7-capability-slice
```

### 3. Persist The Current E7 Artifacts

```bash
bun run benchmark:e7-baseline-corpus
bun run benchmark:e7-incumbent-comparison
bun run benchmark:e7-performance-budget
bun run benchmark:e7-chaos-provider-suite
bun run benchmark:e7-promotion-gate-policy
bun run benchmark:e7-quality-report
bun run benchmark:e7-soak-endurance-suite
bun run benchmark:e7-quality-metrics
bun run benchmark:e7-live-canary
```

Inspect:

- scorecards and artifacts stay `status === "pass"` unless a documented
  evaluator intentionally produces a `warn`/`hold` quality summary
- no new failing section keys appear in `docs/artifacts/e7-quality-report-artifact.json`
- no unbounded growth appears in `docs/artifacts/e7-soak-endurance-artifact.json`

### 4. Replay Repository Gates

```bash
bun run lint
bun run check
NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run nx:lint
NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run nx:typecheck
NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run nx:build
```

## Rebuild And Recovery Drill Procedure

Run the current recovery drill in an isolated disposable clone or worktree:

```bash
TEMP_DIR="$(mktemp -d -t e7-rollback-drill.XXXXXX)"
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
bun run check:e7-baseline-corpus
bun run check:e7-incumbent-comparison
bun run check:e7-drift-regression
bun run check:e7-performance-budget
bun run check:e7-chaos-provider-suite
bun run check:e7-promotion-gate-policy
bun run check:e7-quality-report
bun run check:e7-soak-endurance-suite
bun run check:e7-quality-metrics
bun run check:e7-live-canary
bun run check:e7-security-review
bun run check:e7-sdk-consumer
bun run check:e7-capability-slice
rm -rf node_modules dist \
  docs/artifacts/e7-baseline-corpus-artifact.json \
  docs/artifacts/e7-incumbent-comparison-artifact.json \
  docs/artifacts/e7-performance-budget-scorecard.json \
  docs/artifacts/e7-chaos-provider-suite-artifact.json \
  docs/artifacts/e7-promotion-gate-policy-artifact.json \
  docs/artifacts/e7-quality-report-artifact.json \
  docs/artifacts/e7-soak-endurance-artifact.json \
  docs/artifacts/e7-quality-metrics-artifact.json \
  docs/artifacts/e7-live-canary-artifact.json
bun install --frozen-lockfile
bun run check:e7-baseline-corpus
bun run check:e7-incumbent-comparison
bun run check:e7-drift-regression
bun run check:e7-performance-budget
bun run check:e7-chaos-provider-suite
bun run check:e7-promotion-gate-policy
bun run check:e7-quality-report
bun run check:e7-soak-endurance-suite
bun run check:e7-quality-metrics
bun run check:e7-live-canary
bun run check:e7-security-review
bun run check:e7-sdk-consumer
bun run check:e7-capability-slice
```

Record the executed evidence in `docs/artifacts/e7-rollback-drill.md`.
Capture only the compact summaries there, not the full JSON bodies.

## Troubleshooting

### Quality report is `warn`

1. inspect `docs/artifacts/e7-quality-report-artifact.json`
2. verify `summary.warningSectionKeys` is expected
3. if a new failing section appears, open remediation instead of downgrading the
   evaluator or deleting evidence

### Performance budget failed

1. rerun `bun run check:e7-baseline-corpus`
2. rerun `bun run check:e7-incumbent-comparison`
3. rerun `bun run check:e7-performance-budget`
4. compare against `docs/artifacts/e7-performance-budget-baseline.json`
5. only update the baseline when the workload shape changed intentionally

### Soak suite failed

1. rerun `bun run check:e7-soak-endurance-suite`
2. inspect `docs/artifacts/e7-soak-endurance-artifact.json`
3. treat `unboundedGrowthDetected` or fingerprint drift as blocking until
   explained by an intentional workload change

## Rollback Guidance

1. revert the offending E7 change instead of weakening the evaluator or artifact
   contract
2. rerun:

```bash
bun run check:e7-baseline-corpus
bun run check:e7-incumbent-comparison
bun run check:e7-performance-budget
bun run check:e7-quality-report
bun run check:e7-soak-endurance-suite
bun run check:e7-quality-metrics
bun run check:e7-live-canary
bun run check:e7-chaos-provider-suite
bun run check:e7-promotion-gate-policy
bun run check:e7-security-review
bun run check:e7-sdk-consumer
bun run check:e7-capability-slice
```

3. do not roll back by:
   - relaxing deterministic thresholds without new evidence
   - deleting comparable or failing artifacts to hide a regression
   - reintroducing private imports or non-public package surfaces

## Scope Boundary

This runbook's executable drill proves:

- frozen-install recovery
- regenerated `dist/`
- regenerated E7 benchmark and quality artifacts
- green E7 capability, review, and consumer checks on the same source tree

It does not, by itself, prove live-site extraction parity or a rollback to a
previous git commit or release tag. That remains downstream work.
