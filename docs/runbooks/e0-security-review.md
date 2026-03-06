# E0 Security Review

## Purpose

Review the E0 workspace foundation slice for threat exposure, sanitization gaps,
and policy regressions before promotion.

This review covers:

- SDK URL intake in `src/sdk/scraper.ts`
- CLI/API consumers in `src/standalone.ts` and `src/api.ts`
- existing governance and Effect v4 guardrails

## Threat Checklist

| Threat | Status | Control |
| --- | --- | --- |
| Non-HTTP(S) target URLs | Mitigated | `src/sdk/scraper.ts` rejects non-`http`/`https` user input before any fetch |
| Credential-bearing URLs | Mitigated | URL validation rejects embedded username/password |
| Direct SSRF to localhost/private IPs | Mitigated | URL policy blocks loopback, private, link-local, carrier-grade NAT, benchmark, and multicast/reserved IP ranges |
| Redirect-based SSRF pivot | Mitigated | HTTP path uses `redirect: "manual"` and validates every redirect target before following |
| Browser-mode subrequest pivot | Mitigated | Browser path installs `page.route("**/*", ...)` and aborts disallowed requests |
| Type-safety or governance bypass | Mitigated | `bun run lint:typesafety`, `bun run check:governance`, and `bun run check:effect-v4-policy` remain required |
| Secret/header/cookie logging | Mitigated in current scope | E0 inputs do not accept secret-bearing fields and error rendering avoids stack dumps |

## Findings

### Fixed in this review

- High severity: SDK/API surfaces previously accepted arbitrary non-empty URLs and
  allowed automatic redirect following. That exposed a practical SSRF path to
  localhost/private targets.
- The HTTP execution path is now redirect-aware and validates every hop.
- Browser mode now blocks disallowed request URLs instead of trusting all page
  subrequests.

### Current severity summary

- Open high-severity findings: none
- Open medium-severity findings: one residual class remains possible if a
  publicly routable hostname later resolves to private infrastructure via DNS
  changes outside this process boundary. E0 does not currently maintain a
  resolver-backed allowlist service, so this is documented as residual risk,
  not an open blocker for the current slice.

## Verification Evidence

- Runtime verification: `tests/guardrails/e0-security-review.verify.test.ts`
  proves that `accessPreview` and `extractRun` reject direct private URLs before
  network I/O and block redirect pivots to localhost targets.
- Mocked Playwright runtime coverage in the same test file proves that browser
  mode blocks a localhost subrequest through `page.route("**/*", ...)`.
- Static contract verification in the same test file checks that the HTTP path
  remains on `redirect: "manual"` and browser mode keeps request interception in
  place.
- Policy guardrails remain enforced by:
  - `bun run lint:typesafety`
  - `bun run check:governance`
  - `bun run check:effect-v4-policy`

## Operator Guidance

1. Treat any request-surface change that expands accepted URL formats, redirect
   handling, or browser network behavior as security-sensitive.
2. Re-run `bun test tests/guardrails/e0-security-review.verify.test.ts` after
   any SDK/API request-surface change.
3. Re-run full repository gates before closing related beads:
   `bun run ultracite`, `bun run oxlint`, `bun run oxfmt`, `bun run test`, `bun run build`.

## Rollback Guidance

1. Revert the offending URL-policy change rather than weakening the security
   rules.
2. Re-run `bun test tests/guardrails/e0-security-review.verify.test.ts`.
3. Re-run `bun run check`.

Forbidden rollback actions:

- Reverting to `redirect: "follow"` without equivalent redirect-target checks
- Removing browser request interception
- Relaxing URL validation to permit localhost/private targets
- Adding bypass markers, unsafe casts, or Effect v3 dependencies
