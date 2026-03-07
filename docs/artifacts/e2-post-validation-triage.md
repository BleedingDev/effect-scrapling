# E2 Post-Validation Triage Summary

## Scope

Review the completed E2 validation wave and determine whether any new follow-up
beads must be opened before the epic can be considered complete.

Reviewed evidence:

- `docs/runbooks/e2-extractor-orchestration.md`
- `docs/runbooks/e2-domain-normalizers.md`
- `docs/runbooks/e2-assertion-engine.md`
- `docs/runbooks/e2-selector-precedence.md`
- `docs/runbooks/e2-selector-relocation.md`
- `docs/runbooks/e2-evidence-manifest.md`
- `docs/runbooks/e2-snapshot-builder.md`
- `docs/runbooks/e2-snapshot-diff-engine.md`
- `docs/runbooks/e2-golden-fixtures.md`
- `docs/runbooks/e2-security-review.md`
- `docs/runbooks/e2-performance-budget.md`
- `docs/artifacts/e2-performance-budget-scorecard.json`
- `examples/e2-capability-slice.ts`
- `examples/e2-sdk-consumer.ts`

## Summary

- New E2-blocking defects discovered during post-validation triage: none
- New follow-up beads required from this triage pass: none
- E2 remains complete at the current extraction-core scope and can hand off to
  downstream epics without opening a new E2-local blocker

## Findings

| Finding | Severity | Current tracking | Recommended sequencing | New bead |
| --- | --- | --- | --- | --- |
| Raw HTML payloads remain internal capture artifacts and should not be logged, prompted, or transported outside internal E2 tooling without an explicit redaction boundary. | Medium residual risk | `docs/runbooks/e2-security-review.md` already tracks this as the only remaining non-blocking E2 residual risk. | Revisit only when a later epic needs to export raw capture artifacts outside the current internal replay boundary. | None. Current E2 security review already tracks the risk and the public SDK example does not expose raw HTML. |
| Performance evidence remains a local-machine scorecard, so a failing run should create a remediation bead instead of casually widening budgets. | Low operational caveat | `docs/runbooks/e2-performance-budget.md` and `docs/artifacts/e2-performance-budget-scorecard.json` already define the budget contract and remediation path. | Revisit only on an actual budget breach. Do not spend follow-up capacity on speculative tuning while the scorecard remains green. | None. Current benchmark evidence is reproducible and passing. |
| Selector relocation is intentionally bounded by fallback count and confidence impact, so later matching selectors can still be skipped once the deterministic fallback policy is exhausted. | Low scoped contract limit | `docs/runbooks/e2-selector-relocation.md` and `docs/runbooks/e2-selector-precedence.md` now document this as an intentional determinism tradeoff rather than a regression. | Revisit only if a later phase requires a different selector-search contract. Do not weaken the current bounded-fallback behavior within E2. | None. Current relocation behavior is explicit, tested, and consistent with the present E2 scope. |

## Conclusion

No new child beads were created by `bd-8en.36`. The post-validation review
found no fresh defects beyond residual or intentionally scoped items that are
already tracked in committed documentation with recommended future sequencing.
