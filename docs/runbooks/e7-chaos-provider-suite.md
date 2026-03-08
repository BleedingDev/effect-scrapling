# E7 Chaos Provider Suite

## Purpose

Exercise provider outages, throttling, and degradation paths and verify that the
planner and validation layers respond with the expected fallback decisions.

## Command Surface

```bash
bun run benchmark:e7-chaos-provider-suite
bun run check:e7-chaos-provider-suite
```

Direct artifact replay:

```bash
bun run scripts/benchmarks/e7-chaos-provider-suite.ts \
  --artifact docs/artifacts/e7-chaos-provider-suite-artifact.json
```

## What It Produces

- committed artifact: `docs/artifacts/e7-chaos-provider-suite-artifact.json`
- deterministic scenario outcomes for degraded provider conditions
- explicit planner rationale and failed validator stage evidence

## Practical Use

Refresh the committed artifact:

```bash
bun run benchmark:e7-chaos-provider-suite
```

Inspect scenario outcomes:

```bash
jq '.results[] | {scenarioId, provider, action, failedValidatorStages}' \
  docs/artifacts/e7-chaos-provider-suite-artifact.json
```

## Troubleshooting

### Planner rationale is missing from a result

Treat that as an artifact integrity bug. The chaos suite must preserve planner
evidence, otherwise promotion-gate reasoning becomes unverifiable.

### Unexpected provider action

Check the scenario input and validator-stage evidence first. The suite is
supposed to validate fallback semantics, not hide them behind a final status bit.
