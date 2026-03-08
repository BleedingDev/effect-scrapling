# effect-scrapling

EffectTS + Bun reimplementation of Scrapling with:

- `effect-scrapling` CLI
- `effect-scrapling-api` HTTP API
- reusable SDK functions through the public `effect-scrapling/sdk` export

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
Browser security isolation and capability-slice validation guidance live in
[`docs/runbooks/e4-browser-security-isolation.md`](docs/runbooks/e4-browser-security-isolation.md).
E4 threat-review and redaction-hardening guidance live in
[`docs/runbooks/e4-security-review.md`](docs/runbooks/e4-security-review.md).
E4 performance budgets and scorecard usage live in
[`docs/runbooks/e4-performance-budget.md`](docs/runbooks/e4-performance-budget.md).
E4 rollout, rollback, and recovery-drill evidence live in
[`docs/runbooks/e4-operations-rollback-drill.md`](docs/runbooks/e4-operations-rollback-drill.md)
and [`docs/artifacts/e4-rollback-drill.md`](docs/artifacts/e4-rollback-drill.md).
Post-validation E4 triage evidence lives in
[`docs/artifacts/e4-post-validation-triage.md`](docs/artifacts/e4-post-validation-triage.md).
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

bun run ultracite:check
bun run oxlint:check
bun run format:check
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
- [E2 extractor orchestration](docs/runbooks/e2-extractor-orchestration.md)
- [E2 deterministic parser pipeline](docs/runbooks/e2-deterministic-parser.md)
- [E2 domain normalizers](docs/runbooks/e2-domain-normalizers.md)
- [E2 assertion engine](docs/runbooks/e2-assertion-engine.md)
- [E2 selector precedence](docs/runbooks/e2-selector-precedence.md)
- [E2 selector relocation](docs/runbooks/e2-selector-relocation.md)
- [E2 evidence manifest](docs/runbooks/e2-evidence-manifest.md)
- [E2 snapshot builder](docs/runbooks/e2-snapshot-builder.md)
- [E2 snapshot diff engine](docs/runbooks/e2-snapshot-diff-engine.md)
- [E2 golden fixtures](docs/runbooks/e2-golden-fixtures.md)
- [E2 security review](docs/runbooks/e2-security-review.md)
- [E2 performance budget](docs/runbooks/e2-performance-budget.md)
- [E2 operations and rollback drill](docs/runbooks/e2-operations-rollback-drill.md)
- [E3 HTTP access execution](docs/runbooks/e3-http-access-execution.md)
- [E3 access planner policy](docs/runbooks/e3-access-planner-policy.md)
- [E3 identity lease management](docs/runbooks/e3-identity-lease-management.md)
- [E3 egress lease management](docs/runbooks/e3-egress-lease-management.md)
- [E3 operations and rollback drill](docs/runbooks/e3-operations-rollback-drill.md)
- [E4 browser security isolation](docs/runbooks/e4-browser-security-isolation.md)
- [E4 security review](docs/runbooks/e4-security-review.md)
- [E4 performance budget](docs/runbooks/e4-performance-budget.md)
- [E4 operations and rollback drill](docs/runbooks/e4-operations-rollback-drill.md)
- [E5 crawl plan compilation](docs/runbooks/e5-crawl-plan-compilation.md)
- [E5 durable workflow graph fanout fanin](docs/runbooks/e5-durable-workflow-graph-fanout-fanin.md)
- [E5 checkpoint persistence and restore](docs/runbooks/e5-checkpoint-persistence-restore.md)
- [E5 crash resume harness](docs/runbooks/e5-crash-resume-harness.md)
- [E5 duplicate work suppression](docs/runbooks/e5-duplicate-work-suppression.md)
- [E5 workflow operational controls](docs/runbooks/e5-workflow-operational-controls.md)
- [E5 resume and replay operations](docs/runbooks/e5-resume-replay-operations.md)
- [E5 workflow inspection read models](docs/runbooks/e5-workflow-inspection-read-models.md)
- [E5 workflow budget integration](docs/runbooks/e5-workflow-budget-integration.md)
- [E5 workflow simulation](docs/runbooks/e5-workflow-simulation.md)
- [E5 operations and rollback drill](docs/runbooks/e5-operations-rollback-drill.md)
- [E5 security review](docs/runbooks/e5-security-review.md)
- [E6 pack registry resolution](docs/runbooks/e6-pack-registry-resolution.md)
- [E6 site pack DSL contracts](docs/runbooks/e6-site-pack-dsl-contracts.md)
- [E6 pack lifecycle state machine](docs/runbooks/e6-pack-lifecycle-state-machine.md)
- [E6 selector trust decay](docs/runbooks/e6-selector-trust-decay.md)
- [E6 pack candidate generator](docs/runbooks/e6-pack-candidate-generator.md)
- [E6 pack governance actions](docs/runbooks/e6-pack-governance-actions.md)
- [E6 shadow to active governance automation](docs/runbooks/e6-shadow-active-governance-automation.md)
- [E6 pack versioning and immutable active policy](docs/runbooks/e6-pack-versioning-immutable-active.md)
- [E6 reflector clustering](docs/runbooks/e6-reflector-clustering.md)
- [E6 validator ladder](docs/runbooks/e6-validator-ladder.md)
- [E6 security review](docs/runbooks/e6-security-review.md)
- [E6 performance budget](docs/runbooks/e6-performance-budget.md)
- [E6 operations and rollback drill](docs/runbooks/e6-operations-rollback-drill.md)
- [E7 drift regression analysis](docs/runbooks/e7-drift-regression-analysis.md)
- [E7 baseline corpus](docs/runbooks/e7-baseline-corpus.md)
- [E7 incumbent comparison](docs/runbooks/e7-incumbent-comparison.md)
- [E7 quality metrics](docs/runbooks/e7-quality-metrics.md)
- [E7 live canary](docs/runbooks/e7-live-canary.md)
- [E7 chaos provider suite](docs/runbooks/e7-chaos-provider-suite.md)
- [E7 performance budget](docs/runbooks/e7-performance-budget.md)
- [E7 promotion gate policy](docs/runbooks/e7-promotion-gate-policy.md)
- [E7 quality report exports](docs/runbooks/e7-quality-report.md)
- [E7 security review](docs/runbooks/e7-security-review.md)
- [E7 soak and endurance suite](docs/runbooks/e7-soak-endurance-suite.md)
- [E8 benchmark and artifact export](docs/runbooks/e8-benchmark-artifact-export.md)
- [E8 parity dry-run replay](docs/runbooks/e8-parity-dry-run-replay.md)
- [E8 public SDK package](docs/runbooks/e8-public-sdk-package.md)
- [E6 post-validation triage](docs/artifacts/e6-post-validation-triage.md)
- [E5 post-validation triage](docs/artifacts/e5-post-validation-triage.md)
- `docs/artifacts/e0-post-validation-triage.md`

E5 crawl-plan operators can validate the compiler with
`bun test tests/libs/foundation-core-crawl-plan-runtime.test.ts`. Today the
surface is library-level through `compileCrawlPlans(...)`, `compileCrawlPlan(...)`,
and `CrawlPlanCompiler`.

E5 workflow-graph operators can validate durable fanout/fanin execution with
`bun test tests/libs/foundation-core-durable-workflow-runtime.test.ts`. The
shipped runtime models the graph as canonical workflow stages inside one run
plan; it does not expose a separate CLI or API control surface for those stage
transitions today.

E5 workflow-control operators can validate the current control surface with
`bun test tests/libs/foundation-core-durable-workflow-runtime.test.ts`. Today
that surface is library-level through `WorkflowRunner.inspect(runId)`,
`WorkflowRunner.cancelRun(runId)`, `WorkflowRunner.deferRun(runId)`,
`WorkflowRunner.resumeRun(runId)`, `WorkflowRunner.replayRun(runId)`, and
`WorkflowRunner.retryRun(runId)`; there is no dedicated CLI or API wrapper yet.

E5 workflow inspection operators can run
`bun test tests/libs/foundation-core-workflow.test.ts tests/libs/foundation-core-durable-workflow-runtime.test.ts`,
`bun run check:e1-capability-slice`, or `bun run example:e1-capability-slice`
to inspect the current typed read model behavior.

E5 capability-slice operators can run `bun run check:e5-capability-slice` or
`bun run example:e5-capability-slice` to validate the current end-to-end
durable orchestration path with typed restart, inspection, budget, and
duplicate-work evidence.

E5 security reviewers can run `bun run check:e5-security-review` to replay the
current planner sanitization and durable resume-token tamper protections.
Post-validation E5 triage evidence lives in
[`docs/artifacts/e5-post-validation-triage.md`](docs/artifacts/e5-post-validation-triage.md).

E5 checkpoint-restore operators can run
`bun run check:e5-checkpoint-persistence-restore`,
`bun run check:e5-crash-resume-harness`, or
`bun test tests/libs/foundation-core-sqlite-run-checkpoint-store.test.ts`
to validate the current SQLite persistence and restore surface.

E5 duplicate-work operators can run
`bun run check:e5-duplicate-work-suppression`,
`bun test tests/libs/foundation-core-workflow-work-claim-store.test.ts`, or
`bun test tests/libs/foundation-core-durable-workflow-runtime.test.ts`
to validate the current work-claim and duplicate-runner suppression surface.

E5 workflow-budget operators can run
`bun run check:e5-workflow-budget-integration`,
`bun test tests/libs/foundation-core-workflow-budget-runtime.test.ts`, or
`bun run check:e5-workflow-simulation` to inspect the current operator-visible
scale-harness status. The latest committed scorecard artifact is
[`docs/artifacts/e5-workflow-simulation-scorecard.json`](docs/artifacts/e5-workflow-simulation-scorecard.json),
and that performance lane should be read independently from the rollback drill.

E5 workflow simulation operators can run
`bun run benchmark:e5-workflow-simulation`,
`bun run check:e5-workflow-simulation`, or
`bun test tests/scripts/e5-workflow-simulation.test.ts`. The default scorecard
artifact is
[`docs/artifacts/e5-workflow-simulation-scorecard.json`](docs/artifacts/e5-workflow-simulation-scorecard.json).

E5 crash-resume operators can run
`bun run benchmark:e5-crash-resume-harness`,
`bun run check:e5-crash-resume-harness`, or
`bun test tests/scripts/e5-crash-resume-harness.test.ts`. The default
scorecard artifact is
[`docs/artifacts/e5-crash-resume-harness-scorecard.json`](docs/artifacts/e5-crash-resume-harness-scorecard.json).

E5 rollback operators can follow
[`docs/runbooks/e5-operations-rollback-drill.md`](docs/runbooks/e5-operations-rollback-drill.md)
and record the latest executed recovery evidence in
[`docs/artifacts/e5-rollback-drill.md`](docs/artifacts/e5-rollback-drill.md).

E5 consumer validation can run `bun run check:e5-sdk-consumer` or
`bun run example:e5-sdk-consumer` through the public
[`effect-scrapling/e5`](./src/e5.ts) entrypoint.

E6 pack-registry operators can run
`bun test tests/libs/foundation-core-pack-registry-runtime.test.ts` and
`bun test tests/libs/foundation-core-site-pack.test.ts`. Today that surface is
library-level through `@effect-scrapling/foundation-core/pack-registry-runtime`
and `@effect-scrapling/foundation-core/site-pack`; there is no dedicated CLI or
API wrapper yet.

E6 reflection operators can run
`bun test tests/libs/foundation-core-reflection-engine-runtime.test.ts` and
`bun test tests/libs/foundation-core-validator-ladder-runtime.test.ts`. Today
that surface is library-level through
`@effect-scrapling/foundation-core/reflection-engine-runtime`; there is no
dedicated CLI or API wrapper yet.

E6 shadow-to-active automation operators can run
`bun test tests/libs/foundation-core-validator-ladder-runtime.test.ts`,
`bun test tests/libs/foundation-core-reflection-engine-runtime.test.ts`,
`bun test tests/libs/foundation-core-pack-governance-runtime.test.ts`, and
`bun run check:e6-capability-slice`. That is the current truthful replay path
for typed validator gating, reflected promotion decisions, and governed
activation of `shadow` candidates into fresh `active` versions.

E6 pack-governance operators can run
`bun test tests/libs/foundation-core-pack-governance-runtime.test.ts` and
`bun test tests/libs/foundation-core-pack-lifecycle-runtime.test.ts`. Today that
surface is library-level through
`@effect-scrapling/foundation-core/pack-governance-runtime`; there is no
dedicated CLI or API wrapper yet. The end-to-end operator workflow for
validator gates, reflected promotion decisions, rollback, and audit expectations
is documented in
[`docs/runbooks/e6-shadow-active-governance-automation.md`](docs/runbooks/e6-shadow-active-governance-automation.md).

E6 capability-slice operators can run `bun run check:e6-capability-slice` or
`bun run example:e6-capability-slice` to validate the current end-to-end domain
adaptation path with typed lifecycle, registry, trust, reflection, validation,
automation, and governance evidence.

E6 security reviewers can run `bun run check:e6-security-review` to replay the
current pack-domain, version-bound governance decision, and immutable-active
governance controls.
Post-validation E6 triage evidence lives in
[`docs/artifacts/e6-post-validation-triage.md`](docs/artifacts/e6-post-validation-triage.md).

E6 performance operators can run `bun run benchmark:e6-performance-budget`,
`bun run check:e6-performance-budget`, or
`bun test tests/scripts/e6-performance-budget.test.ts`. The latest committed
scorecard artifact is
[`docs/artifacts/e6-performance-budget-scorecard.json`](docs/artifacts/e6-performance-budget-scorecard.json).
The capability-slice lane in that scorecard is measured as a 3-run micro-batch
average per sample so the p95 reflects steady-state E6 work instead of a single
runtime spike.

E6 consumer validation can run `bun run check:e6-sdk-consumer` or
`bun run example:e6-sdk-consumer` through workspace
`@effect-scrapling/foundation-core/*` subpath contracts only.

E6 rollback operators can follow
[`docs/runbooks/e6-operations-rollback-drill.md`](docs/runbooks/e6-operations-rollback-drill.md)
and record the latest executed evidence in
[`docs/artifacts/e6-rollback-drill.md`](docs/artifacts/e6-rollback-drill.md).

## CLI

```bash
bun run standalone -- doctor

bun run standalone -- access preview \
  --url "https://example.com"

bun run standalone -- render preview \
  --url "https://example.com" \
  --wait-until networkidle \
  --wait-ms 300

bun run standalone -- extract run \
  --url "https://example.com" \
  --selector "h1"

bun run standalone -- extract run \
  --url "https://example.com" \
  --selector "a" \
  --attr "href" \
  --all \
  --limit 10
```

Shortcut command:

```bash
bun run standalone -- scrape \
  --url "https://example.com" \
  --selector ".product-title"
```

## API

```bash
PORT=3000 bun run api
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
bun run example:e2-sdk-consumer
bun run example:e4-sdk-consumer
bun run example:e5-sdk-consumer
bun run example:e8-sdk-consumer
```

The example at `examples/sdk-consumer.ts` is the supported consumer-facing SDK
contract demonstration for this repository. It imports only from
`effect-scrapling/sdk` and prints JSON with repository-example metadata plus the
public contract surface:

- `importPath`, pinned to the public SDK entrypoint
- `prerequisites`, the setup needed to run this repository's example command
- `pitfalls`, the integration mistakes the example is designed to prevent
- `payload.expectedError`, an intentionally triggered `InvalidInputError`

The extraction-oriented E2 example at `examples/e2-sdk-consumer.ts` stays on
the same public package boundary and demonstrates:

- public `extractRun` usage through `effect-scrapling/sdk`
- typed warning handling for no-match selectors
- typed `InvalidInputError` and `ExtractionError` examples
- prerequisite and pitfall reporting for downstream extraction consumers

The browser-oriented E4 example at `examples/e4-sdk-consumer.ts` stays on the
same public package boundary and demonstrates:

- browser-mode `accessPreview` through `effect-scrapling/sdk`
- browser-only `renderPreview` with typed artifact output
- prerequisite and pitfall reporting for real browser-mode consumers
- one intentional `InvalidInputError` path for invalid private-network targets

The durable-workflow E5 example at `examples/e5-sdk-consumer.ts` stays on the
public `effect-scrapling/e5` package boundary and demonstrates:

- public crawl-plan compilation through `effect-scrapling/e5`
- `WorkflowRunner.start`, `inspect`, `resumeRun`, and `replayRun` with
  synthetic in-memory dependencies
- prerequisite and pitfall reporting for downstream E5 integrators
- one intentional `PolicyViolation` path from a synthetic extractor failure

The control-plane E8 example at `examples/e8-sdk-consumer.ts` stays on the
public `effect-scrapling/e8` package boundary and demonstrates:

- workspace doctor and config-show through the public E8 surface
- benchmark metadata generation through the same package subpath
- sanitized artifact export through the same package subpath
- prerequisite and pitfall reporting for downstream E8 consumers

Replay it with:

```bash
bun run check:e2-sdk-consumer
bun run check:e4-sdk-consumer
bun run check:e5-sdk-consumer
bun run check:e8-sdk-consumer
```

To run the in-repo example:

- Bun `>= 1.3.10` and a successful `bun install --frozen-lockfile`
- `bun run example:sdk-consumer` does not require Playwright or live network
  access because it injects a mock `FetchService`
- `bun run example:e2-sdk-consumer` uses the same public SDK boundary for the
  E2 extraction core and documents expected warning/error paths without any
  private imports
- `bun run example:e4-sdk-consumer` uses the browser-facing public SDK
  contracts; replay `bun run check:e4-sdk-consumer` for the deterministic
  synthetic-browser path or install Chromium with `bun run browser:install` for
  real browser-mode usage
- `bun run example:e5-sdk-consumer` uses the public durable-workflow entrypoint
  at `effect-scrapling/e5`; replay `bun run check:e5-sdk-consumer` for the
  deterministic in-memory workflow path and `bun run check:e5-security-review`
  for the security control proofs
- `bun run example:e8-sdk-consumer` uses the public control-plane entrypoint at
  `effect-scrapling/e8`; replay `bun run check:e8-sdk-consumer`,
  `bun run check:e8-benchmark-export`, and `bun run check:e8-parity-dry-run`
  for the deterministic E8 consumer and parity surfaces. Local packed-install
  smoke tests install the `effect-scrapling` and
  `@effect-scrapling/foundation-core` tarballs together to simulate the
  published package family without relying on a live registry publish

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

## E2 Extraction Runtime

Run the deterministic extraction slice and its security/performance gates when
you need current operator evidence for parser, selector, normalizer, assertion,
evidence-manifest, and replay behavior:

```bash
bun run check:e2-capability-slice
bun run check:e2-sdk-consumer
bun run check:e2-security-review
bun run check:e2-performance-budget
```

Supporting runbooks:

- [`docs/runbooks/e2-extractor-orchestration.md`](docs/runbooks/e2-extractor-orchestration.md)
- [`docs/runbooks/e2-deterministic-parser.md`](docs/runbooks/e2-deterministic-parser.md)
- [`docs/runbooks/e2-domain-normalizers.md`](docs/runbooks/e2-domain-normalizers.md)
- [`docs/runbooks/e2-assertion-engine.md`](docs/runbooks/e2-assertion-engine.md)
- [`docs/runbooks/e2-selector-precedence.md`](docs/runbooks/e2-selector-precedence.md)
- [`docs/runbooks/e2-selector-relocation.md`](docs/runbooks/e2-selector-relocation.md)
- [`docs/runbooks/e2-evidence-manifest.md`](docs/runbooks/e2-evidence-manifest.md)
- [`docs/runbooks/e2-snapshot-builder.md`](docs/runbooks/e2-snapshot-builder.md)
- [`docs/runbooks/e2-snapshot-diff-engine.md`](docs/runbooks/e2-snapshot-diff-engine.md)
- [`docs/runbooks/e2-golden-fixtures.md`](docs/runbooks/e2-golden-fixtures.md)
- [`docs/runbooks/e2-security-review.md`](docs/runbooks/e2-security-review.md)
- [`docs/runbooks/e2-performance-budget.md`](docs/runbooks/e2-performance-budget.md)
- [`docs/runbooks/e2-operations-rollback-drill.md`](docs/runbooks/e2-operations-rollback-drill.md)

Recovery evidence:

- [`docs/artifacts/e2-rollback-drill.md`](docs/artifacts/e2-rollback-drill.md)

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
- [`docs/runbooks/e3-access-planner-policy.md`](docs/runbooks/e3-access-planner-policy.md)
- [`docs/runbooks/e3-identity-lease-management.md`](docs/runbooks/e3-identity-lease-management.md)
- [`docs/runbooks/e3-retry-backoff-runbook.md`](docs/runbooks/e3-retry-backoff-runbook.md)
- [`docs/runbooks/e3-access-health-runbook.md`](docs/runbooks/e3-access-health-runbook.md)
- [`docs/runbooks/e3-operations-rollback-drill.md`](docs/runbooks/e3-operations-rollback-drill.md)
- [`docs/runbooks/e4-provider-selection.md`](docs/runbooks/e4-provider-selection.md)

Recovery evidence:

- [`docs/artifacts/e3-rollback-drill.md`](docs/artifacts/e3-rollback-drill.md)
