# E9 Raw Versus Redacted Artifact Segregation

Use this runbook when validating storage boundaries between raw artifacts and redacted artifacts.

## Current Contract

- raw artifacts live under `captures/raw/<targetId>`
- redacted artifacts live under `captures/redacted/<targetId>`
- `buildCaptureStorageLocator(...)` constructs locators through that contract
- `enforceCaptureArtifactBoundary(...)` rejects artifacts whose namespace does not match their declared visibility
- `makeInMemoryCaptureBundleStore().persistBundle(...)` rejects bundles that violate the boundary

## Primary Commands

```bash
bun run check:e9-artifact-segregation
bun test tests/libs/foundation-core-capture-store.test.ts
bun test tests/guardrails/e9-security-review.verify.test.ts
```

## Expected Outcomes

- raw HTML and raw browser screenshots stay in raw namespaces
- request metadata, response metadata, timings, and network summaries stay in redacted namespaces
- capture-store persistence rejects mixed or mislabeled namespaces deterministically

## Troubleshooting

If a bundle is rejected:

1. Inspect the artifact `visibility`.
2. Inspect `locator.namespace`.
3. Fix the producer that emitted the artifact. Do not patch the store to accept drift.

## Rollback Guidance

If a routing change regresses:

1. Revert the namespace-routing change in the producer.
2. Re-run the focused segregation checks.
3. Do not roll back by weakening `enforceCaptureArtifactBoundary(...)` or by silently remapping artifact visibility at read time.
