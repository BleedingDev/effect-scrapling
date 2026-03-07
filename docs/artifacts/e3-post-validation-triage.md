# E3 Post-Validation Triage Summary

## Scope

Review the completed E3 validation wave and determine whether any new follow-up
beads must be opened before the epic can be considered complete.

Reviewed evidence:

- `docs/runbooks/e3-retry-backoff-runbook.md`
- `docs/artifacts/e3-access-runtime-scorecard.json`
- `tests/libs/foundation-core-access-retry.test.ts`
- `tests/libs/foundation-core-e3-runtime.test.ts`
- `tests/scripts/e3-access-runtime-benchmark.test.ts`
- `examples/e3-capability-slice.ts`

## Summary

- New E3-blocking defects discovered during post-validation triage: none
- New follow-up beads required from this triage pass: `bd-afb.37`,
  `bd-afb.38`
- Current E3 validation remains green, but HTTP-first rollout should address
  the remaining scoped limitations below before relying on retry evidence as a
  complete operator signal

## Findings

| Finding | Severity | Current tracking | Recommended sequencing | New bead |
| --- | --- | --- | --- | --- |
| Response body-read failures used to bypass the retry loop after a successful fetch, so a transient stream-read failure could lose the capture even when retry budget remained. This is now remediated by retrying retryable body-read failures through the same bounded attempt budget while keeping `PolicyViolation` terminal. | Remediated | `docs/runbooks/e3-retry-backoff-runbook.md`, `tests/libs/foundation-core-e3-runtime.test.ts`, and `tests/scripts/e3-access-runtime-benchmark.test.ts` now cover retryable and terminal body-read paths. | Landed first so later exhaustion reporting (`bd-afb.38`) can reason about the full HTTP capture retry surface. | `bd-afb.37` |
| Exhausted retry budgets used to return only the terminal typed error, so operators had to reconstruct exhaustion from logs and attempt counts. This is now remediated by emitting a structured exhaustion report through the retry caller boundary while preserving the original typed failure. | Remediated | `docs/runbooks/e3-retry-backoff-runbook.md`, `tests/libs/foundation-core-access-retry.test.ts`, `tests/libs/foundation-core-e3-runtime.test.ts`, and `tests/scripts/e3-access-runtime-benchmark.test.ts` now cover exhausted-budget reporting directly. | Landed after `bd-afb.37`, so the exhaustion report reflects the full HTTP capture retry surface including post-fetch retries. | `bd-afb.38` |
| Jitter and a persisted retry ledger remain intentionally out of scope for the current E3 runtime contract. | Low scoped deferment | `docs/runbooks/e3-retry-backoff-runbook.md` already documents these as non-current behavior assumptions rather than validation regressions. | Revisit only after `bd-afb.37` and `bd-afb.38` land or a later phase explicitly needs richer retry-state persistence. | None. This remains a documented scope limit, not a newly discovered defect. |

## Conclusion

`bd-afb.36` created two child follow-up beads: `bd-afb.37` and `bd-afb.38`.
They capture the only new E3 work required from the current validation wave;
the committed performance scorecard remains passing and the reviewed evidence
did not uncover an additional sanitization blocker.
