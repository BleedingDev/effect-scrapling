# E9 Launch Readiness

Use this runbook to verify that E9 launch evidence is complete, truthful, and
operationally actionable.

## Commands

```bash
bun run check:e9-launch-readiness
```

Focused replay:

```bash
bun test tests/scripts/e9-launch-readiness.test.ts
bun run benchmark:e9-launch-readiness
```

## Artifact

- `docs/artifacts/e9-launch-readiness-artifact.json`

## Required evidence

- `docs/artifacts/e9-reference-pack-validation-artifact.json`
- `docs/artifacts/e9-scrapling-parity-artifact.json`
- `docs/artifacts/e9-high-friction-canary-artifact.json`
- this document plus the E9 rollback and migration runbooks

## Passing conditions

- reference-pack validation is green
- parity benchmark is green
- high-friction canary is green
- launch docs are present
- rollback and promotion paths are documented
