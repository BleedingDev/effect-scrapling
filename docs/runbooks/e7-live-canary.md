# E7 Live Canary

## Purpose

Operate controlled live-canary executions for explicitly authorized targets and
feed the result into the E7 promotion gate.

## Command Surface

```bash
bun run benchmark:e7-live-canary
bun run check:e7-live-canary
```

Direct artifact replay:

```bash
bun run scripts/benchmarks/e7-live-canary.ts \
  --artifact docs/artifacts/e7-live-canary-artifact.json
```

## Safety Contract

- only authorized `https` targets are accepted
- targets with credentials, fragments, or host escape are rejected before any
  live execution
- planner rationale evidence must remain attached to every scenario result

## Practical Use

Refresh the committed artifact:

```bash
bun run benchmark:e7-live-canary
```

Inspect the canary summary:

```bash
jq '{summary, results}' docs/artifacts/e7-live-canary-artifact.json
```

## Troubleshooting

### The harness rejects a target before execution

That is expected for unauthorized or unsafe input. Fix the target definition;
do not weaken the preflight checks.

### Canary results hold promotion without quarantining

That means scenarios failed without crossing the quarantine threshold. Use the
recorded failed scenario ids and rationale evidence before changing policy.
