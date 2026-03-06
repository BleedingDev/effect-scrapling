# E0 Workspace Foundation Capability Slice

## Purpose

Run one deterministic command that exercises the full E0 workspace foundation:

- bootstrap preflight
- bootstrap doctor
- Nx workspace project discovery and target execution
- CI workflow contract verification
- compliant-module generator verification
- E0 security, performance, rollback, and consumer-contract verification
- post-validation triage evidence verification
- root guardrail, test, and build gates

Use this when you need a single executable evidence path for promotion,
operations, or downstream epic handoff.

## Command Contract

Run from repository root:

```bash
bun run check:e0-capability-slice
```

By default the slice approximates PR affected gates against `origin/master`.
For exact CI parity after a PR exists, export the workflow's exact
`github.event.pull_request.base.sha` as `NX_BASE` and
`github.event.pull_request.head.sha` as `NX_HEAD` before running it.

The command executes this sequence in order:

1. `bun run scripts/preflight-bootstrap.ts`
2. `bun run scripts/bootstrap-doctor.ts`
3. `bun run nx:show-projects`
4. `bun run nx:graph`
5. `bun run nx:lint`
6. `bun run nx:typecheck`
7. `bun run nx:build`
8. `bun run nx affected -t lint --base="$NX_BASE" --head="$NX_HEAD" --parallel=1`
9. `bun run nx affected -t test --base="$NX_BASE" --head="$NX_HEAD" --parallel=1`
10. `bun run nx affected -t typecheck --base="$NX_BASE" --head="$NX_HEAD" --parallel=1`
11. `bun run nx affected -t build --base="$NX_BASE" --head="$NX_HEAD" --parallel=1`
12. `bun test tests/guardrails/e0-security-review.verify.test.ts`
13. `bun run check:e0-performance-budget`
14. `bun test tests/sdk/consumer-example.test.ts`
15. `bun run check`

The slice is deterministic: any failing step stops the command immediately.

## Evidence Artifacts

Successful execution gives downstream reviewers enough evidence to evaluate the
E0 foundation without reading the entire implementation:

- bootstrap readiness output from preflight and doctor
- Nx project discovery, graph export, and target execution
- actual `nx affected` execution against a concrete base/head range
- committed security review and request-sanitization verification
- committed performance budget benchmark output
- committed public consumer example that imports `effect-scrapling/sdk`
- final root guardrail, test, and build output from `bun run check`

## Troubleshooting

### Preflight or doctor fails

Follow the failure-specific remediation in
[`bootstrap-doctor.md`](bootstrap-doctor.md), then rerun the full slice.

### Nx commands fail

Follow the affected-target troubleshooting in
[`nx-workspace-graph.md`](nx-workspace-graph.md), then rerun the full slice.

### Slice-specific verification fails

Run the failing step directly, fix the runtime or workspace issue, then rerun
the full slice:

```bash
bun run scripts/bootstrap-doctor.ts
bun run nx:graph
bun test tests/guardrails/e0-security-review.verify.test.ts
bun run check:e0-performance-budget
bun test tests/sdk/consumer-example.test.ts
```

### Root guardrails fail at the end

Run `bun run check` directly, fix the failing guardrail or build, then rerun the
full slice.

## Rollback Guidance

1. Revert the offending E0 foundation change.
2. Run `bun install --frozen-lockfile` if dependencies or lockfile changed.
3. Rerun `bun run check:e0-capability-slice`.
4. Promote only when the entire slice is green again.
