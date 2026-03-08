# E9 Security Review

## Purpose

Review the E9 hardening slice for secret redaction regressions and raw-versus-redacted artifact boundary drift before reference-pack and parity work builds on top of it.

This review is currently enforced by:

- guardrail test: `tests/guardrails/e9-security-review.verify.test.ts`
- focused checks:
  - `bun run check:e9-security-review`
  - `bun run check:e9-artifact-segregation`

## Threat Checklist

| Threat | Status | Control |
| --- | --- | --- |
| Secret-bearing request or response metadata leaks through exported HTTP artifacts | Mitigated | `captureHttpArtifacts(...)` sanitizes URLs and headers before persistence, and `buildRedactedHttpArtifactExports(...)` defaults to redacted export bodies |
| Prompt or log consumers receive secret-bearing DOM bodies, hidden-field values, or screenshot bytes | Mitigated | `summarizeHtmlForRedactedExport(...)` emits a bounded summary and `buildRedactedBrowserArtifactExports(...)` strips screenshot payloads from redacted output |
| Raw artifacts drift into redacted namespaces or vice versa | Mitigated | `enforceCaptureArtifactBoundary(...)` and `makeInMemoryCaptureBundleStore().persistBundle(...)` reject namespace mismatches |
| Security-sensitive E9 drift slips in through unreviewed helper changes | Mitigated | focused E9 checks are expected on top of repository-wide `lint:typesafety`, `check:governance`, and `check:effect-v4-policy` |

## Verification Evidence

- `tests/libs/foundation-core-secret-sanitization.test.ts` verifies:
  - header redaction
  - absolute and relative URL sanitization
  - inline secret redaction
  - hidden-field and meta-content omission from summarized HTML exports
- `tests/guardrails/e9-security-review.verify.test.ts` verifies:
  - HTTP artifact exports sanitize secret-bearing metadata and default to redacted payloads
  - browser redacted exports sanitize DOM and network content while stripping screenshot bytes
  - capture-store persistence rejects raw-versus-redacted namespace drift
- `tests/libs/foundation-core-capture-store.test.ts` keeps the boundary deterministic in the lower-level storage runtime

## Commands

Run the focused E9 security review:

```bash
bun run check:e9-security-review
bun run check:e9-artifact-segregation
```

Run the underlying suites directly:

```bash
bun test tests/libs/foundation-core-secret-sanitization.test.ts
bun test tests/guardrails/e9-security-review.verify.test.ts
bun test tests/libs/foundation-core-capture-store.test.ts
```

## Operator Guidance

1. Treat changes to these files as security-sensitive:
   - `libs/foundation/core/src/secret-sanitization.ts`
   - `libs/foundation/core/src/capture-artifact-storage.ts`
   - `libs/foundation/core/src/http-access-runtime.ts`
   - `libs/foundation/core/src/browser-access-runtime.ts`
   - `libs/foundation/core/src/capture-store-runtime.ts`
2. Re-run the focused E9 checks after any secret-handling, export, or artifact-storage change.
3. Keep redacted export as the default posture. Raw artifacts remain internal evidence, not prompt/log/public output.
4. Replay repository gates before bead closure or merge:
   - `bun run lint`
   - `bun run check`
   - `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run nx:lint`
   - `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run nx:typecheck`
   - `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run nx:build`

## Rollback Guidance

1. Revert the offending sanitization or storage-routing change instead of weakening the redaction boundary.
2. Re-run:

```bash
bun run check:e9-security-review
bun run check:e9-artifact-segregation
```

3. Do not roll back by:
   - forwarding raw HTML or screenshot payloads into exported redacted surfaces
   - relabeling a raw artifact as `redacted`
   - bypassing URL or header sanitization because an upstream producer is "already trusted"
   - reintroducing manual `_tag`, `instanceof`, unsafe casts, or non-Effect-v4 dependencies
