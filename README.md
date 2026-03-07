# effect-scrapling

EffectTS + Bun reimplementation of Scrapling with:

- `effect-scrapling` CLI
- `effect-scrapling-api` HTTP API
- reusable SDK functions in `src/sdk`

## Bootstrap Readiness

Fresh clones should use the deterministic bootstrap flow before running CLI, API,
or SDK workflows:

```bash
bun run scripts/preflight-bootstrap.ts
bun install --frozen-lockfile
bun run scripts/bootstrap-doctor.ts
```

For browser-mode workflows, install Chromium after the frozen install succeeds:

```bash
bun run browser:install
```

Operational troubleshooting and rollback guidance live in
[`docs/runbooks/bootstrap-doctor.md`](docs/runbooks/bootstrap-doctor.md).

## Browser Mode (Playwright)

Browser-mode access uses Playwright + Chromium.

```bash
bun install --frozen-lockfile
bun run browser:install
bun run check:playwright
```

CI installs and verifies Chromium in the Linux x64 build lane using the same
Playwright scripts and strict `bun install --frozen-lockfile`.

Browser pool controls, queue/backpressure interpretation, and rollback guidance
live in [`docs/runbooks/e4-browser-pool-controls.md`](docs/runbooks/e4-browser-pool-controls.md).
BrowserAccess startup, scoped sharing, cleanup, troubleshooting, and rollback
guidance live in
[`docs/runbooks/e4-browser-access-lifecycle.md`](docs/runbooks/e4-browser-access-lifecycle.md).
Render preview command, API route, and SDK usage guidance live in
[`docs/runbooks/e4-render-preview.md`](docs/runbooks/e4-render-preview.md).
Browser capture completeness, redacted export verification, and crash recovery
guidance live in
[`docs/runbooks/e4-browser-capture-bundle.md`](docs/runbooks/e4-browser-capture-bundle.md),
[`docs/runbooks/e4-browser-artifact-redaction.md`](docs/runbooks/e4-browser-artifact-redaction.md),
and [`docs/runbooks/e4-browser-crash-recovery.md`](docs/runbooks/e4-browser-crash-recovery.md).

## CI Affected Gates

Pull requests run `.github/workflows/pr-affected-gates.yml`. The merge-blocking
gate set is:

- `ultracite`
- `oxlint`
- `oxfmt`
- `affected-lint`
- `affected-test`
- `affected-typecheck`
- `affected-build`
- `pr-gates-status` (deterministic summary status for the full matrix)

Replay the PR gate matrix locally before pushing:

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

The defaults above approximate the PR matrix against the current target branch
tip. For exact CI parity after a PR exists, export the workflow's exact
`github.event.pull_request.base.sha` as `NX_BASE` and
`github.event.pull_request.head.sha` as `NX_HEAD` before replaying the commands.

Operator runbooks:

- [Lint and format policy](docs/runbooks/lint-format-policy.md)
- [Nx workspace graph and affected targets](docs/runbooks/nx-workspace-graph.md)
- [E0 workspace foundation capability slice](docs/runbooks/e0-workspace-foundation.md)
- [E0 security review](docs/runbooks/e0-security-review.md)
- [E0 performance budget](docs/runbooks/e0-performance-budget.md)
- [E0 operations and rollback drill](docs/runbooks/e0-operations-rollback-drill.md)
- `docs/artifacts/e0-post-validation-triage.md`

## CLI

```bash
./effect-scrapling doctor

./effect-scrapling access preview \
  --url "https://example.com"

./effect-scrapling render preview \
  --url "https://example.com" \
  --wait-until networkidle \
  --wait-ms 300

./effect-scrapling extract run \
  --url "https://example.com" \
  --selector "h1"

./effect-scrapling extract run \
  --url "https://example.com" \
  --selector "a" \
  --attr "href" \
  --all \
  --limit 10
```

Shortcut command:

```bash
./effect-scrapling scrape \
  --url "https://example.com" \
  --selector ".product-title"
```

## API

```bash
PORT=3000 ./effect-scrapling-api
```

Endpoints:

- `GET /health`
- `GET /doctor`
- `POST /access/preview`
- `POST /render/preview`
- `POST /extract/run`

Example:

```bash
curl -sS http://127.0.0.1:3000/health

curl -sS -X POST http://127.0.0.1:3000/access/preview \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'

curl -sS -X POST http://127.0.0.1:3000/render/preview \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","browser":{"wait-until":"networkidle","timeout-ms":"300"}}'

curl -sS -X POST http://127.0.0.1:3000/extract/run \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","selector":"h1"}'
```

## SDK (library mode)

Use SDK effects directly from TypeScript through the public package export and a
provided fetch layer:

```ts
import { Effect } from "effect";
import { extractRun, FetchServiceLive, renderPreview } from "effect-scrapling/sdk";

const result = await Effect.runPromise(
  extractRun({
    url: "https://example.com",
    selector: "h1",
  }).pipe(Effect.provide(FetchServiceLive))
);

console.log(result.data.values);

const preview = await Effect.runPromise(
  renderPreview({
    url: "https://example.com",
    browser: {
      waitUntil: "networkidle",
      timeoutMs: 300,
    },
  }).pipe(Effect.provide(FetchServiceLive))
);

console.log(preview.data.status);
```

In-repo demo for the public consumer integration:

```bash
bun install --frozen-lockfile
bun run example:sdk-consumer
```

The example at `examples/sdk-consumer.ts` is the supported consumer-facing SDK
contract demonstration for this repository. It imports only from
`effect-scrapling/sdk` and prints JSON with repository-example metadata plus the
public contract surface:

- `importPath`, pinned to the public SDK entrypoint
- `prerequisites`, the setup needed to run this repository's example command
- `pitfalls`, the integration mistakes the example is designed to prevent
- `payload.expectedError`, an intentionally triggered `InvalidInputError`

To run the in-repo example:

- Bun `>= 1.3.10` and a successful `bun install --frozen-lockfile`
- `bun run example:sdk-consumer` does not require Playwright or live network
  access because it injects a mock `FetchService`
- Browser-mode setup in this repository uses `bun run browser:install`

Public SDK contract notes:

- `accessPreview`, `renderPreview`, and `extractRun` need a `FetchService`; use
  `FetchServiceLive` for live HTTP access or provide a custom `FetchService` in
  tests and examples
- `renderPreview` is the browser-only public preview path with a typed status
  envelope and deterministic artifact bundle
- Browser-mode consumers need Playwright plus an installed Chromium browser
- Consumer code should import from `effect-scrapling/sdk`, never `src/sdk/*`

Expected public tagged errors:

- `InvalidInputError` for malformed payloads before any fetch starts
- `NetworkError` when live HTTP access fails while using `FetchServiceLive`
- `BrowserError` when Playwright is unavailable or browser-mode navigation fails
- `ExtractionError` when extraction or response validation cannot produce the
  public contract

## Nx Compliant Module Generator

Use the Nx generator when you need a strict Effect v4 module scaffold inside an
existing workspace project:

```bash
bunx --bun nx g @effect-scrapling/ci-tooling:compliant-module \
  --project=foundation-core \
  --name=html-normalizer \
  --directory=generated-modules \
  --no-interactive
```

The generator writes schema, errors, tag, layer, effect, and test files in a
deterministic layout under the target project's `sourceRoot` plus
`tests/generated-modules/`.

Operator workflow, troubleshooting, and rollback guidance:

- `docs/runbooks/compliant-module-generator.md`
- `docs/runbooks/nx-workspace-graph.md`

## E0 Capability Slice

Run the full E0 workspace foundation slice when you need end-to-end evidence that
bootstrap readiness, Nx workspace contracts, generator verification, CI workflow
contracts, and the root guardrail stack still compose cleanly:

```bash
bun run check:e0-capability-slice
```

The execution contract and evidence expectations are documented in
[`docs/runbooks/e0-workspace-foundation.md`](docs/runbooks/e0-workspace-foundation.md).

Performance and recovery evidence for the same slice:

- `bun run benchmark:e0-performance-budget`
- `docs/artifacts/e0-performance-budget-baseline.json`
- `docs/artifacts/e0-rollback-drill.md`
- `docs/artifacts/e0-post-validation-triage.md`

## E3 Access Runtime Benchmark

Run the deterministic HTTP-path throughput gate when you need current operator
evidence for E3 planner, capture, and retry-recovery latency:

```bash
bun run check:e3-access-runtime
```

The default command compares the current run against
`docs/artifacts/e3-access-runtime-baseline.json` and overwrites
`docs/artifacts/e3-access-runtime-scorecard.json`.

Operator workflow, troubleshooting, and rollback guidance:

- [`docs/runbooks/e3-access-runtime-benchmark.md`](docs/runbooks/e3-access-runtime-benchmark.md)
- [`docs/runbooks/e3-retry-backoff-runbook.md`](docs/runbooks/e3-retry-backoff-runbook.md)
- [`docs/runbooks/e3-access-health-runbook.md`](docs/runbooks/e3-access-health-runbook.md)
- [`docs/runbooks/e4-provider-selection.md`](docs/runbooks/e4-provider-selection.md)
