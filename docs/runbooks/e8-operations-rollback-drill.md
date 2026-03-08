# E8 Operations And Rollback Drill

Use this runbook for the current E8 operator-visible control-plane surface:

- workspace operations
- capability slice
- security review
- performance budget
- benchmark and artifact export
- parity replay
- public SDK consumer path

This drill validates rebuild-and-recovery on the current overlaid source tree.
It does not claim a rollback to an older git revision.

Primary commands:

```sh
bun install --frozen-lockfile
bun run check:e8-workspace-operations
bun run check:e8-capability-slice
bun run check:e8-security-review
bun run check:e8-performance-budget
bun run check:e8-benchmark-export
bun run check:e8-parity-dry-run
bun run check:e8-sdk-consumer
```

Repository gates before closure:

```sh
bun run lint
bun run check
NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run nx:lint
NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run nx:typecheck
NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run nx:build
```

Rollback drill procedure:

```sh
TEMP_DIR="$(mktemp -d -t e8-rollback-drill.XXXXXX)"
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
bun run check:e8-workspace-operations
bun run check:e8-capability-slice
bun run check:e8-security-review
bun run check:e8-performance-budget
bun run check:e8-benchmark-export
bun run check:e8-parity-dry-run
bun run check:e8-sdk-consumer
rm -rf node_modules dist docs/artifacts/e8-performance-budget-scorecard.json docs/artifacts/e8-benchmark-run-artifact.json docs/artifacts/e8-artifact-export-artifact.json docs/artifacts/e8-parity-dry-run-artifact.json
bun install --frozen-lockfile
bun run check:e8-workspace-operations
bun run check:e8-capability-slice
bun run check:e8-security-review
bun run check:e8-performance-budget
bun run check:e8-benchmark-export
bun run check:e8-parity-dry-run
bun run check:e8-sdk-consumer
```

Record the executed evidence in `docs/artifacts/e8-rollback-drill.md`.
