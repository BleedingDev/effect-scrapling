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
- `POST /extract/run`

Example:

```bash
curl -sS http://127.0.0.1:3000/health

curl -sS -X POST http://127.0.0.1:3000/access/preview \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'

curl -sS -X POST http://127.0.0.1:3000/extract/run \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","selector":"h1"}'
```

## SDK (library mode)

Use SDK effects directly from TypeScript:

```ts
import { Effect } from "effect";
import { extractRun } from "effect-scrapling/sdk";

const result = await Effect.runPromise(
  extractRun({
    url: "https://example.com",
    selector: "h1",
  })
);

console.log(result.data.values);
```

Public consumer example:

```bash
bun run example:sdk-consumer
```

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
