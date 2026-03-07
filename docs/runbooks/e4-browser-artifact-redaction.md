# E4 Browser Artifact Redaction Runbook

## Purpose

Use this runbook when operators, SDK consumers, or runtime authors need to
validate the browser artifact redaction path before sending browser artifacts to
logs, prompts, or downstream telemetry.

Current implementation boundary:

- `libs/foundation/core/src/browser-access-runtime.ts`
- `tests/libs/foundation-core-browser-capture-bundle.test.ts`

Policy baseline:

- Effect v4 only
- no manual `_tag` branching
- no manual `instanceof`
- no raw browser payload export to prompts or logs

## Current Contract

`buildRedactedBrowserArtifactExports(bundle)` is the export boundary for browser
artifact payloads.

What it does today:

- keeps stored artifact metadata intact
- redacts sensitive query params and credentials from browser URLs
- strips fragments from exported URLs
- removes raw screenshot bytes from exports
- converts raw rendered DOM into a structured summary with:
  - `title`
  - `textPreview`
  - `linkTargets`
  - `hiddenFieldCount`
- re-sanitizes `networkSummary` payloads before export, even if an upstream
  payload was already marked `redacted`
- passes through `timings` as JSON because it contains no secret-bearing
  browser content in the current contract

What it does not do:

- return raw DOM HTML to prompts or logs
- return raw base64 screenshot bodies to prompts or logs
- export HAR or DevTools trace payloads

## Focused Checks

Run the deterministic redaction verification suite:

```bash
bun test tests/libs/foundation-core-browser-capture-bundle.test.ts
```

Recommended focused checks:

```bash
bun test tests/libs/foundation-core-browser-capture-bundle.test.ts \
  --test-name-pattern "captures rendered DOM screenshot network summary and timings as a complete bundle"

bun test tests/libs/foundation-core-browser-capture-bundle.test.ts \
  --test-name-pattern "re-sanitizes browser payloads before prompt or log export"

bun test tests/libs/foundation-core-browser-capture-bundle.test.ts \
  --test-name-pattern "emits a deterministic redacted export fallback when a browser payload is missing"

bun test tests/libs/foundation-core-browser-capture-bundle.test.ts \
  --test-name-pattern "emits a deterministic redacted export fallback when a network summary payload is malformed JSON"

bun test tests/libs/foundation-core-browser-capture-bundle.test.ts \
  --test-name-pattern "emits a deterministic redacted export fallback when a network summary payload fails schema validation"
```

Run full repository gates before bead closure or rollout:

```bash
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

Replay the merge-blocking affected-target matrix before pushing:

```bash
TARGET_BRANCH="${TARGET_BRANCH:-origin/master}"
NX_BASE="${NX_BASE:-$(git rev-parse "$TARGET_BRANCH")}"
NX_HEAD="${NX_HEAD:-$(git rev-parse HEAD)}"

bun run ultracite
bun run oxlint
bun run oxfmt
bun run nx affected -t lint --base="$NX_BASE" --head="$NX_HEAD" --parallel=1
bun run nx affected -t test --base="$NX_BASE" --head="$NX_HEAD" --parallel=1
bun run nx affected -t typecheck --base="$NX_BASE" --head="$NX_HEAD" --parallel=1
bun run nx affected -t build --base="$NX_BASE" --head="$NX_HEAD" --parallel=1
```

`pr-gates-status` is the deterministic summary emitted by CI for that matrix.
Use the README gate section as the source of truth if the command list changes:

- `README.md#CI Affected Gates`

## Expected Evidence

Treat the redaction path as healthy only when all of the following are true:

- rendered DOM exports contain summary JSON, not raw HTML
- screenshot exports contain metadata plus the omission note, not raw base64
- exported link targets never contain credentials, fragments, or secret query
  param values
- exported DOM text previews redact inline `token=...`, `secret=...`, and
  `Bearer ...` values
- missing payload fallback stays deterministic and does not invent replacement
  content
- invalid redacted payloads fall back to a deterministic note instead of
  throwing or exporting unvalidated content

## Troubleshooting

### Redacted export still contains a secret

Check both boundaries:

- `captureBrowserArtifacts(...)` for the first sanitization pass
- `buildRedactedBrowserArtifactExports(...)` for the export pass

Do not patch this by relabeling a raw artifact as `redacted`. Fix the
sanitization path.

### Export ordering changed unexpectedly

The export bundle follows artifact order. Treat order drift as a contract
regression because downstream consumers may align metadata and payloads by that
stable order.

### Screenshot export contains binary payload

That is a blocker. The current contract explicitly drops screenshot bytes at the
export boundary and replaces them with metadata plus the omission note.

## Rollout Guidance

1. Verify the focused bundle tests above.
2. Run the browser bundle runbook if bundle completeness also changed:
   - `docs/runbooks/e4-browser-capture-bundle.md`
3. Re-run full repository gates.
4. Promote only when both the focused redaction checks and the full gate set are
   green.

## Rollback Guidance

1. Restore the last known-good redaction implementation.
2. Re-run the focused redaction tests.
3. Re-run full repository gates before re-promoting.

Forbidden shortcuts:

- exporting raw DOM because prompt consumers "need more context"
- exporting screenshot base64 for debugging convenience
- bypassing URL sanitization because a payload is already marked `redacted`
