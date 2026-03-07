# E4 Security Review

## Purpose

Review the E4 multi-provider browser slice for provider-selection drift,
browser-session policy regressions, and artifact-export sanitization gaps before
promotion.

This review covers:

- provider selection in `libs/foundation/core/src/access-planner-runtime.ts`
- browser session isolation and origin restrictions in
  `libs/foundation/core/src/browser-access-policy.ts`
- browser capture and redacted export boundaries in
  `libs/foundation/core/src/browser-access-runtime.ts`
- the executable slice in `examples/e4-capability-slice.ts`

## Threat Checklist

| Threat | Status | Control |
| --- | --- | --- |
| Browser capture becomes the default for low-friction hybrid targets | Mitigated | `planAccessExecution(...)` keeps low-friction `hybrid` traffic on HTTP unless high-friction target kinds or failure escalation signals require browser capture |
| Planner accepts unsafe entry URLs for browser execution | Mitigated | `TargetProfileSchema` and `CanonicalHttpUrlSchema` reject non-HTTP(S), credential-bearing, and fragment-bearing seed URLs before planner output is created |
| Browser session or page objects leak across capture sessions | Mitigated | `makeInMemoryBrowserAccessSecurityPolicy(...)` binds contexts and pages to one browser security session and blocks reuse with `PolicyViolation` |
| Cross-origin browser navigation captures off-origin content | Mitigated | `verifyOrigin(...)` enforces exact-origin navigation before DOM, screenshot, or network-summary reads |
| Prompt/log export leaks secrets through DOM titles or relative browser targets | Mitigated in this review | `buildRedactedBrowserArtifactExports(...)` now re-sanitizes DOM titles, inline text, and both absolute and relative export targets before emitting redacted JSON |
| Prompt/log export leaks raw screenshot bytes or unsanitized network URLs | Mitigated | screenshot exports omit binary bodies and network-summary exports re-sanitize URLs before emission |
| Type-safety or Effect-policy regressions weaken security controls | Mitigated | repository policy still requires `lint:typesafety`, `check:governance`, and `check:effect-v4-policy` |

## Findings

### Fixed in this review

- High severity: the browser redaction export boundary previously passed through
  secret-bearing `<title>` content unchanged and left relative browser targets
  such as `/checkout?session=...#frag` unsanitized when exporting prompt/log
  summaries.
- `buildRedactedBrowserArtifactExports(...)` now applies the same inline-secret
  redaction to DOM titles and sanitizes both absolute and relative URL targets
  before they leave the E4 export boundary.

### Current severity summary

- Open high-severity findings: none
- Open medium-severity findings: none inside the current E4 slice after export
  hardening
- Residual risk: raw rendered DOM and screenshot payloads intentionally remain
  internal `raw` artifacts inside the browser capture bundle. Future consumers
  must continue to use `buildRedactedBrowserArtifactExports(...)` or an
  equivalent redaction boundary before sending those artifacts to prompts, logs,
  or public transports.

## Verification Evidence

- `tests/guardrails/e4-security-review.verify.test.ts` verifies that:
  - low-friction `hybrid` plans stay HTTP-first while high-friction and
    failure-escalated cases remain explicitly browser-selected
  - redacted DOM exports sanitize secret-bearing titles and relative link or
    form targets
  - the deterministic E4 capability slice emits only allowed browser-policy
    decisions with zero leak alarms and no prompt/log secret leakage
- `tests/libs/foundation-core-browser-security-isolation.test.ts` proves reused
  contexts are blocked across browser sessions and cross-origin redirects are
  denied before DOM capture.
- `tests/libs/foundation-core-browser-capture-bundle.test.ts` verifies the
  browser bundle and export boundary still drop screenshot bytes, sanitize
  network summaries, and re-sanitize prompt/log exports.
- `tests/examples/e4-capability-slice.test.ts` confirms the current E4 slice
  remains deterministic with sanitized exports, explicit policy evidence, and a
  zero-leak lifecycle snapshot.

## Operator Guidance

1. Treat any change to `selectCaptureProvider(...)`,
   `makeInMemoryBrowserAccessSecurityPolicy(...)`, or
   `buildRedactedBrowserArtifactExports(...)` as security-sensitive.
2. Re-run `bun test tests/guardrails/e4-security-review.verify.test.ts` after
   any E4 planner, browser-policy, or browser-export change.
3. Re-run the focused E4 runtime suites before promotion:

```bash
bun test tests/libs/foundation-core-browser-capture-bundle.test.ts
bun test tests/libs/foundation-core-browser-security-isolation.test.ts
bun test tests/examples/e4-capability-slice.test.ts
```

4. Replay full repository gates before bead closure or merge:
   `bun run ultracite:check`, `bun run oxlint:check`, `bun run format:check`, `bun run test`, `bun run build`.

## Rollback Guidance

1. Revert the offending planner, browser-policy, or export-boundary change
   rather than weakening sanitization or isolation rules.
2. Re-run:

```bash
bun test tests/guardrails/e4-security-review.verify.test.ts
bun test tests/libs/foundation-core-browser-capture-bundle.test.ts
bun test tests/libs/foundation-core-browser-security-isolation.test.ts
bun test tests/examples/e4-capability-slice.test.ts
```

3. Do not roll back by:
   - defaulting low-friction `hybrid` plans to browser capture
   - bypassing browser session isolation or origin restriction checks
   - exporting raw DOM or screenshot payloads for debugging convenience
   - reintroducing manual `_tag`, `instanceof`, or unsafe cast shortcuts
