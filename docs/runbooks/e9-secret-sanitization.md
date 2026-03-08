# E9 Secret Sanitization

Use this runbook when validating or troubleshooting E9 secret-handling boundaries across logs, exports, prompts, and operator-facing artifacts.

## Current Contract

- `sanitizeHeaderEntries(...)` redacts secret-bearing request and response headers.
- `sanitizeUrlForExport(...)` strips credentials and fragments and redacts sensitive query values.
- `sanitizeInlineSecrets(...)` redacts token, password, cookie, csrf, and bearer-style inline secrets.
- `summarizeHtmlForRedactedExport(...)` emits:
  - sanitized `title`
  - sanitized `textPreview`
  - sanitized `linkTargets`
  - `hiddenFieldCount`

It intentionally does **not** export raw hidden-field values, meta values, or raw DOM bodies.

## Primary Commands

```bash
bun run check:e9-security-review
bun test tests/libs/foundation-core-secret-sanitization.test.ts
bun test tests/guardrails/e9-security-review.verify.test.ts
```

## Expected Outcomes

- secret-bearing headers render as `[REDACTED]`
- credential-bearing and fragment-bearing URLs are sanitized before export
- DOM summaries expose only redacted summaries, not raw hidden values or prompt-unsafe bodies
- HTTP redacted exports never leak raw request, response, or DOM secrets
- browser redacted exports never leak raw screenshot bytes

## Troubleshooting

If a secret leaks:

1. Check whether the leak entered through:
   - URL handling
   - header handling
   - inline DOM/text handling
   - a caller that bypassed redacted export helpers
2. Reproduce with the focused suites above.
3. Fix the boundary helper, not the symptom in one caller.

## Rollback Guidance

If an E9 sanitization change regresses:

1. Revert the helper or export-boundary change.
2. Re-run the focused E9 checks.
3. Do not "fix" the regression by:
   - suppressing tests
   - removing assertions
   - relabeling raw artifacts as redacted
   - shipping prompt or log consumers that parse raw DOM directly
