# E9 High-Friction Canary

Use this runbook to replay the authorized E9 high-friction bypass canary suite
for Alza, Datart, and TS Bohemia retailer targets.

## Scope

- validates browser escalation on authorized high-friction retailer scenarios
- proves policy-compliant canary inputs
- records reproducible bypass-quality metrics for the E9 retailer corpus

## Commands

```bash
bun run check:e9-high-friction-canary
```

Focused replay:

```bash
bun test tests/scripts/e9-high-friction-canary.test.ts
bun run benchmark:e9-high-friction-canary
```

## Artifact

- `docs/artifacts/e9-high-friction-canary-artifact.json`

## Practical notes

1. Every scenario is restricted to an authorized `https` retailer URL.
2. The suite intentionally injects recent access failures so hybrid mode must
   escalate product-page traffic to the browser provider.
3. A passing run requires:
   - `browserEscalationRate = 1`
   - `bypassSuccessRate = 1`
   - `policyViolationCount = 0`

## Failure triage

1. If policy validation fails, inspect `seedUrls` and host alignment first.
2. If browser escalation regresses, inspect access-planner rationale under
   `liveCanary.results[*].plannerRationale`.
3. If promotion verdict degrades, inspect validator inputs before touching the
   policy contract.
