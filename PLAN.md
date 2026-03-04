Rewritten PRD. Hard-aligned to your constraints: **Effect v4 everywhere**, **Nx monorepo**, **lockstep versions**, **CLI + API first**, **no Zod**, **no Redis**, **no AGENTS.md**, **strict repo enforcement**, **minimal external deps**.

# Product Requirements Document — Scrape Foundation (Effect v4 / Nx)

## 1) Executive Summary

### Problem Statement

We need a **foundational scraping library** for two classes of products built on top:

* **e-commerce intelligence**

  * ~10k owned products
  * ~20 reseller partners
  * price, stock, description, imagery, variant, misleading content, reseller mapping
* **marketing / market intelligence**

  * blogs, press releases, product mentions, campaigns, launch/acquisition signals, social discovery

The foundation must deliver:

* equal or better crawl throughput than incumbent
* equal or better parallelisation
* equal or better extraction quality
* equal or better **authorized high-friction access quality**
* strict maintainability
* deterministic quality gates
* scalable durable execution
* minimal dependency sprawl

### Non-Negotiable Constraints

| Constraint                   | Decision                                             |
| ---------------------------- | ---------------------------------------------------- |
| Runtime model                | **Effect v4 mandatory**                              |
| Validation / schemas         | **Effect Schema only**                               |
| DI / services                | **Context / Layer only**                             |
| Durable runs / distribution  | **Effect Workflow**                                  |
| Queue/orchestration sidecars | **No Redis/BullMQ/Temporal in core**                 |
| Repo shape                   | **Nx monorepo**                                      |
| Versioning                   | **Single lockstep workspace version**                |
| CLI/API                      | **Priority**                                         |
| MCP                          | optional, later                                      |
| Static rules                 | **Ultracite + Oxlint + Oxfmt enforced**              |
| Type safety                  | **No `any`, no `as unknown as X`, no rule bypasses** |
| External libs                | minimal; Effect-first                                |

### Three-Layer Solution

| Layer                       | Purpose                  | Core components                                                                                 |
| --------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| **Access Runtime**          | acquire content reliably | Access planning, HTTP/browser execution, identity, egress, rate budgets, Workflow orchestration |
| **Extraction Intelligence** | turn captures into data  | parser, selectors, relocation, normalizers, field assertions, snapshots, diffs                  |
| **Quality Control Loop**    | improve safely at scale  | comparison harness, golden fixtures, live canaries, reflection, promotion/quarantine            |

### Key Innovations

| Innovation                        | Why it exists                                                        |
| --------------------------------- | -------------------------------------------------------------------- |
| **Effect-first architecture**     | one model for schemas, services, runtime, config, CLI, API, workflow |
| **Site Packs**                    | isolate domain logic from core                                       |
| **Access Providers**              | isolate volatile access/render capabilities from deterministic core  |
| **Evidence-backed observations**  | every extracted field must point to capture evidence                 |
| **Selector reliability decay**    | selector trust must degrade if not re-proven                         |
| **Pack state machine**            | draft → shadow → active → guarded → quarantined                      |
| **Incumbent comparison harness**  | candidate behavior must beat baseline before promotion               |
| **Lockstep workspace versioning** | no internal compatibility hell                                       |
| **Hard policy enforcement**       | repo rules are enforced, not suggested                               |

### Success Criteria

| Area                                    | Requirement                              |
| --------------------------------------- | ---------------------------------------- |
| Throughput                              | `>=` incumbent on benchmark corpus       |
| Extraction completeness                 | `>=` incumbent on required fields        |
| False positives                         | `<=` incumbent                           |
| Drift recovery                          | `>=` incumbent                           |
| Checkpoint recovery                     | resumable with negligible duplicate work |
| Browser/resource stability              | no leaked contexts, no unbounded pools   |
| Authorized high-friction access quality | `>=` incumbent on canary set             |
| Maintainability                         | new site pack without core edits         |
| Governance                              | zero lint/type rule bypass in mainline   |

### External Dependency Policy

**Allowed in core**:

* Effect ecosystem
* browser runtime dependency if needed for browser execution
* SQL drivers required by Effect SQL / Workflow persistence

**Disallowed in core**:

* Zod / Joi / Yup / Typia
* Axios / Got wrappers unless forced by a provider adapter
* BullMQ / Redis queues
* DI frameworks
* ad hoc schema libs
* ad hoc CLI frameworks
* per-package version drift

---

## 2) Core Architecture

### System Model

The foundation is not “a crawler.”
It is a **durable acquisition + extraction + quality runtime**.

```text
Targets / Schedules / Site Packs
                │
                ▼
        Access Planner
                │
                ▼
     Effect Workflow Run Graph
   ┌────────────┼────────────┐
   ▼            ▼            ▼
HTTP Access   Browser Access  Managed/Optional Access
   └────────────┬────────────┘
                ▼
          Capture Store
                ▼
         Extraction Engine
                ▼
      Snapshot / Diff / Quality
                ▼
 Reflection / Validation / Curation
```

### ACE Pipeline

**A — Access**
Choose mode, identity, egress, concurrency, timeout, retry, artifact policy.

**C — Capture**
Acquire normalized artifacts: request, response, HTML, DOM, screenshot, timings.

**E — Extract**
Run deterministic extraction, relocation, normalization, assertions, snapshotting, diffing.

### Effect v4 as the Only Core Primitive Set

| Concern               | Effect primitive                  |
| --------------------- | --------------------------------- |
| schemas               | `Schema`                          |
| service boundaries    | `Context` / `Layer`               |
| runtime logic         | `Effect`                          |
| durable orchestration | `Workflow`                        |
| config                | `Config`                          |
| errors                | `Data.TaggedError` / typed causes |
| CLI                   | Effect CLI                        |
| API                   | Effect HTTP / HttpApi             |
| resource safety       | scoped acquisition/release        |
| concurrency           | fibers, queues, semaphores        |
| persistence           | Effect SQL + Workflow persistence |
| observability         | Effect logging/metrics/tracing    |

### Service Topology

All core modules must be expressed as **Schema + Tag + Layer + Effect**, not DTOs plus loose helpers.

Core services:

* `TargetRegistry`
* `PackRegistry`
* `AccessPlanner`
* `HttpAccess`
* `BrowserAccess`
* `CaptureStore`
* `Extractor`
* `SnapshotStore`
* `DiffEngine`
* `QualityGate`
* `ReflectionEngine`
* `WorkflowRunner`
* `ArtifactExporter`

### Nx Monorepo Structure

```text
apps/
  cli/
  api/

libs/
  foundation/
    core/
    config/
    runtime/
    workflow/
    access/
    browser/
    extraction/
    adaptive/
    quality/
    storage/
    observability/

tools/
  nx-generators/
  ci/
  scripts/

.sf/
  packs/
  fixtures/
  baselines/
  policies/
  targets/
```

### Lockstep Versioning

Rules:

* one root workspace version
* all internal libs share that version
* no independent internal package versioning
* one Effect version across workspace
* one TypeScript version across workspace
* one lint/format/type policy across workspace
* all releases move together

This is a **single release train**, not a marketplace of semi-compatible packages.

### Seven Design Principles

| Principle                       | Rule                                                    |
| ------------------------------- | ------------------------------------------------------- |
| **1. Effect everywhere**        | no parallel framework stack                             |
| **2. Deterministic core**       | extraction/diff/quality must be testable and replayable |
| **3. Volatile access isolated** | access/render specifics never leak into core models     |
| **4. Evidence first**           | no field without evidence                               |
| **5. Durable by default**       | runs survive crashes and resume cleanly                 |
| **6. Bounded scale**            | concurrency, memory, and browser pools always bounded   |
| **7. Governance is code**       | repo rules enforced in CI and generators                |

### Repository Enforcement Rules

Mandatory:

* Ultracite
* Oxlint
* Oxfmt
* `tsc --noEmit` strict
* Nx affected gates
* no `any`
* no `as unknown as X`
* no `@ts-ignore`
* no `eslint-disable` / `oxlint-disable` in mainline
* no bypassing project rules

Recommended compiler posture:

* `strict`
* `noImplicitAny`
* `exactOptionalPropertyTypes`
* `noUncheckedIndexedAccess`
* `useUnknownInCatchVariables`
* `verbatimModuleSyntax`

---

## 3) Data Models

### Modeling Rule

No ad hoc interfaces as the primary contract surface.
All persisted and transported shapes are defined as **Effect Schema**.

### Canonical Schemas

```ts
import { Schema } from "effect"

export const TargetKind = Schema.Literal(
  "productPage",
  "productListing",
  "marketingPost",
  "blogPost",
  "pressRelease",
  "socialPost",
  "searchResult"
)

export class TargetProfile extends Schema.Class<TargetProfile>("TargetProfile")({
  id: Schema.String,
  tenantId: Schema.String,
  domain: Schema.String,
  kind: TargetKind,
  canonicalKey: Schema.String,
  seedUrls: Schema.Array(Schema.String),
  accessPolicyId: Schema.String,
  packId: Schema.String,
  priority: Schema.Number
}) {}

export const AccessMode = Schema.Literal("http", "browser", "hybrid", "managed")

export class AccessPolicy extends Schema.Class<AccessPolicy>("AccessPolicy")({
  id: Schema.String,
  mode: AccessMode,
  perDomainConcurrency: Schema.Number,
  globalConcurrency: Schema.Number,
  timeoutMs: Schema.Number,
  maxRetries: Schema.Number,
  render: Schema.Literal("never", "onDemand", "always")
}) {}

export const PackState = Schema.Literal(
  "draft",
  "shadow",
  "active",
  "guarded",
  "quarantined",
  "retired"
)

export class SitePack extends Schema.Class<SitePack>("SitePack")({
  id: Schema.String,
  domainPattern: Schema.String,
  state: PackState,
  accessPolicyId: Schema.String,
  version: Schema.String
}) {}

export class Observation extends Schema.Class<Observation>("Observation")({
  field: Schema.String,
  normalizedValue: Schema.Unknown,
  confidence: Schema.Number,
  evidenceRefs: Schema.Array(Schema.String)
}) {}

export class Snapshot extends Schema.Class<Snapshot>("Snapshot")({
  id: Schema.String,
  targetId: Schema.String,
  observations: Schema.Array(Observation),
  qualityScore: Schema.Number,
  createdAt: Schema.String
}) {}
```

### Workflow Models

Core run state is also Schema-defined:

* `RunPlan`
* `RunCheckpoint`
* `RunStats`
* `ConcurrencyBudget`
* `EgressLease`
* `IdentityLease`
* `ArtifactRef`
* `SnapshotDiff`
* `QualityVerdict`
* `PackPromotionDecision`

### Error Models

Errors must be typed with `Data.TaggedError`.

Examples:

* `TimeoutError`
* `RenderCrashError`
* `ParserFailure`
* `ExtractionMismatch`
* `DriftDetected`
* `CheckpointCorruption`
* `PolicyViolation`
* `ProviderUnavailable`

### Confidence Decay Algorithm

Used for selector trust and pack trust.

* recent successes increase trust
* failures are weighted more heavily than successes
* trust decays over time if not re-proven
* state transitions are based on trust bands

Reference function:

```ts
const FAILURE_WEIGHT = 4

const reliability = ({
  successes,
  failures,
  halfLifeDays,
  now
}: {
  readonly successes: ReadonlyArray<number>
  readonly failures: ReadonlyArray<number>
  readonly halfLifeDays: number
  readonly now: number
}) => {
  const decay = (ts: number) =>
    Math.pow(0.5, (now - ts) / (1000 * 60 * 60 * 24 * halfLifeDays))

  const successScore = successes.reduce((n, ts) => n + decay(ts), 0)
  const failureScore = failures.reduce((n, ts) => n + decay(ts), 0)

  return successScore - FAILURE_WEIGHT * failureScore
}
```

State bands:

| Score   | State     |
| ------- | --------- |
| `>= 5`  | trusted   |
| `>= 1`  | candidate |
| `> -2`  | degraded  |
| `<= -2` | blocked   |

### Validation Rules

#### Pack validation

* no active pack without owner
* no active pack without baseline
* required fields must have deterministic extraction paths
* no pack promotion without comparison results

#### Observation validation

* no observation without evidence
* no diff without both snapshots passing minimum quality
* no normalized price without currency context

#### Workflow validation

* no run plan without explicit concurrency budgets
* no unbounded queue or pool
* no managed mode without allow-listed policy

#### Repo validation

* no `any`
* no double cast
* no suppressed diagnostics in shipping code

---

## 4) CLI Commands

### Command Model

CLI and API must share the same handlers, schemas, services, and error model.

* CLI = operator ergonomics
* API = product integration
* both call the same internal Effects

### Core Command Set

| Command               | Purpose                         | API route                     |
| --------------------- | ------------------------------- | ----------------------------- |
| `sf init`             | bootstrap workspace             | `POST /workspace/init`        |
| `sf doctor`           | verify runtime/store/providers  | `GET /doctor`                 |
| `sf config show`      | merged config                   | `GET /config`                 |
| `sf target import`    | import targets/bindings         | `POST /targets/import`        |
| `sf target list`      | query targets                   | `GET /targets`                |
| `sf pack create`      | scaffold site pack              | `POST /packs`                 |
| `sf pack inspect`     | inspect pack and trust state    | `GET /packs/:id`              |
| `sf pack validate`    | run pack schema + fixture gates | `POST /packs/:id/validate`    |
| `sf pack promote`     | move pack state                 | `POST /packs/:id/promote`     |
| `sf access preview`   | single access attempt           | `POST /access/preview`        |
| `sf render preview`   | single browser render           | `POST /render/preview`        |
| `sf crawl plan`       | compile run plan                | `POST /crawl/plans`           |
| `sf crawl run`        | execute durable crawl workflow  | `POST /crawl/runs`            |
| `sf crawl resume`     | resume run                      | `POST /crawl/runs/:id/resume` |
| `sf workflow inspect` | inspect workflow state          | `GET /workflows/:id`          |
| `sf extract run`      | extract one target/capture      | `POST /extract/run`           |
| `sf snapshot diff`    | compare snapshots               | `POST /snapshots/diff`        |
| `sf quality verify`   | deterministic quality gates     | `POST /quality/verify`        |
| `sf quality compare`  | compare candidate vs baseline   | `POST /quality/compare`       |
| `sf benchmark run`    | throughput/latency benchmark    | `POST /benchmarks/run`        |
| `sf artifact export`  | export redacted artifacts       | `POST /artifacts/export`      |
| `sf api serve`        | run HTTP API                    | —                             |
| `sf mcp serve`        | optional compatibility layer    | —                             |

### Usage Examples

```bash
sf crawl plan reseller-prices --json
sf crawl run reseller-prices --json
sf quality compare pack-alza-product --baseline incumbent --json
sf benchmark run partner-corpus-q1 --json
sf workflow inspect run_2026_03_04_001 --json
```

### Example JSON Output — `sf crawl run`

```json
{
  "ok": true,
  "command": "crawl run",
  "data": {
    "runId": "run_2026_03_04_001",
    "workflowId": "wf_2026_03_04_001",
    "plannedTargets": 200000,
    "modeBreakdown": {
      "http": 151000,
      "browser": 43000,
      "managed": 6000
    },
    "budgets": {
      "globalConcurrency": 120,
      "maxPerDomain": 8
    }
  },
  "warnings": []
}
```

### Example JSON Output — `sf quality compare`

```json
{
  "ok": true,
  "command": "quality compare",
  "data": {
    "packId": "pack-alza-product",
    "baseline": {
      "fieldRecall": 0.94,
      "falsePositiveRate": 0.03,
      "medianLatencyMs": 740
    },
    "candidate": {
      "fieldRecall": 0.97,
      "falsePositiveRate": 0.02,
      "medianLatencyMs": 690
    },
    "verdict": "promote-shadow"
  },
  "warnings": []
}
```

### CLI/API Design Rules

* JSON-first always available
* stable machine-readable error codes
* same schema contracts on CLI and API
* dry-run support where meaningful
* replayable commands for debugging
* no hidden side effects in inspect commands

---

## 5) Reflection Pipeline

The system improves packs and extraction safely through four phases.

```text
Generator -> Reflector -> Validator -> Curator
```

### Generator

Purpose:

* produce typed candidate deltas

Inputs:

* failed captures
* missing fields
* wrong-field extractions
* golden fixtures
* incumbent outputs
* live canary regressions

Outputs:

* new selector candidates
* fallback candidates
* blocked-pattern candidates
* access-policy candidates
* assertion refinements

Rules:

* deterministic generation first
* no direct mutation of active packs
* every candidate must reference evidence

### Reflector

Purpose:

* transform noisy failures into recurring patterns

Responsibilities:

* cluster failures by pack/field/template
* identify brittle selectors
* detect wrong-field patterns
* detect access mode overuse
* recommend pack-level changes, not one-off hacks

### Validator

Purpose:

* decide whether a candidate is safe

Validation ladder:

1. schema validation
2. parser fixture tests
3. golden corpus tests
4. incumbent differential tests
5. workflow replay tests
6. benchmark gates
7. live canaries
8. soak/chaos stability checks

Validator outputs:

* field recall delta
* false positive delta
* drift delta
* latency delta
* memory delta
* pack verdict

### Curator

Purpose:

* apply approved typed deltas only

Rules:

* active packs are immutable except through state transitions
* every promotion creates new pack version
* rollback is first-class
* curator can quarantine packs automatically on repeated critical regressions

### Pack Lifecycle

| State       | Meaning                               |
| ----------- | ------------------------------------- |
| draft       | under construction                    |
| shadow      | evaluated live, not authoritative     |
| active      | production authoritative              |
| guarded     | production but under regression watch |
| quarantined | blocked from normal promotion/use     |
| retired     | superseded                            |

### Mandatory Comparison Test Families

* parser fixture tests
* extractor replay tests
* snapshot diff correctness tests
* incumbent differential tests
* crash/resume tests
* load tests
* soak tests
* chaos/provider degradation tests
* authorized live canaries

### Promotion Gates

A pack may move `shadow -> active` only if:

* required field coverage meets threshold
* false positive rate is at or below baseline
* incumbent comparison is neutral or better
* replay tests are deterministic
* workflow resume tests pass
* soak tests show no leaks
* security/redaction gates pass

---

## 6) Integration

### Search Wrapper

Discovery must be abstracted as a service, not scattered.

Discovery sources:

* sitemap
* RSS/Atom
* category pages
* internal site search
* imported URL lists
* optional external discovery adapters

Rules:

* discovery is advisory, not truth
* dedupe on canonical target identity
* discovery quality measured separately from extraction quality

### Error Handling

Errors are typed and routed by policy.

| Error                 | Retry | Handling                        |
| --------------------- | ----- | ------------------------------- |
| timeout               | yes   | backoff with policy             |
| DNS/network           | yes   | retry budgeted                  |
| render crash          | yes   | recycle browser resources       |
| parser failure        | no    | fail validation / open incident |
| extraction mismatch   | no    | quality gate failure            |
| drift detected        | no    | send to reflector               |
| checkpoint corruption | no    | stop and rescue                 |
| policy violation      | no    | block execution                 |
| provider unavailable  | yes   | use fallback chain if allowed   |

Rules:

* retries belong to access/runtime, not extractor logic
* no infinite retries
* no hidden retries outside policy
* all retry behavior observable in run artifacts

### Secret Sanitization

Everything exported, logged, or sent to optional model providers must be sanitized.

Sanitize:

* cookies
* auth/session headers
* tokens in URLs
* hidden form values
* provider credentials
* raw request bodies if sensitive

Rules:

* raw and redacted artifacts stored separately
* redacted export is default
* no secrets in prompts
* logs use hashes/placeholders, not values

### API Integration

API is first-class, not a wrapper around CLI.

* Effect HttpApi
* same services as CLI
* same schemas as CLI
* stable error envelope
* long-running operations return workflow IDs
* follow-up inspection done through workflow/snapshot endpoints

---

## 7) LLM Integration

### Positioning

LLM support is **optional**, **disabled by default**, and **never in the hot path** of normal crawl execution.

### Allowed Use Cases

* site pack scaffolding from sample captures
* selector candidate generation
* drift explanation
* fixture gap suggestion
* test case suggestion
* anomaly summarization

### Disallowed Use Cases

* direct mutation of active packs
* direct authoritative extraction in core flows
* unsanitized artifact exposure
* replacing deterministic diff/normalization logic

### Provider Abstraction

Use an Effect service, not ad hoc client code.

```ts
// conceptual: Schema + Tag + Layer + Effect
```

Outputs must be validated with **Effect Schema**, not Zod.

### Response Schemas

Examples:

* `SelectorCandidate`
* `DriftHypothesis`
* `FixtureSuggestion`
* `PackDeltaCandidate`

All must be Schema-defined and validated before entering the validator pipeline.

### Prompt Templates

Templates needed:

* pack scaffold prompt
* drift diagnosis prompt
* test expansion prompt
* anomaly explanation prompt

Rules:

* prompts receive redacted artifacts only
* prompts produce typed outputs only
* all outputs enter shadow flow first
* model cost/latency recorded
* no model dependency in baseline runtime

---

## 8) Storage & Persistence

### Persistence Strategy

No Redis. No external queue dependency in core.

Durable execution is handled by **Effect Workflow** with SQL-backed persistence.

### Default Environments

#### Local/dev

* SQLite for metadata/workflow state
* filesystem for artifacts
* local CLI/API profile configs

#### Production

* Postgres for metadata/workflow state
* object storage for large artifacts
* SQL-backed workflow durability
* no separate vector store initially

### Directory Structure

```text
apps/
  cli/
  api/

libs/
  foundation/
    core/
    config/
    runtime/
    workflow/
    access/
    browser/
    extraction/
    adaptive/
    quality/
    storage/
    observability/

.sf/
  targets/
  packs/
  fixtures/
  baselines/
  policies/
  artifacts/
  checkpoints/
  logs/
```

### Cascading Config

Use Effect Config.

Merge order:

1. library defaults
2. user profile
3. workspace config
4. environment config
5. tenant config
6. pack/domain policy
7. CLI/API overrides

Rules:

* lower scopes may tighten budgets
* lower scopes may not bypass sanitization
* policy invariants cannot be overridden ad hoc

### Artifact Persistence

Artifacts:

* request metadata
* response metadata
* HTML
* rendered DOM
* screenshot
* network summary
* extraction evidence manifests
* quality reports

### Embeddings

Embeddings are **optional**, **off by default**, and **not a separate infra tier initially**.

Initial approach:

* store vectors in SQL tables if enabled
* use only for clustering, retrieval, pack suggestion
* not required for core extraction

---

## 9) Agent Integration

### No AGENTS.md

This project will **not** use AGENTS.md.

Agent behavior must be controlled through:

* repository-enforced rules
* stable CLI contracts
* stable API contracts
* deterministic schemas
* reproducible workflows
* pack state machine
* CI gates

### Agent Operating Model

Agents should operate through:

1. `sf doctor`
2. `sf pack inspect`
3. `sf access preview` / `sf render preview`
4. `sf extract run`
5. `sf quality verify`
6. `sf quality compare`
7. `sf pack promote`

That keeps agents inside the same governed surface as humans.

### Repository Enforcement Contract

Hard rules:

* Ultracite mandatory
* Oxlint mandatory
* Oxfmt mandatory
* no `any`
* no `as unknown as X`
* no lint disable directives in mainline
* no type ignore directives in mainline
* no local rule bypass via generators
* no direct edits to generated pack state artifacts without validator pass

### Nx Enforcement

* affected lint/test/typecheck/build on PRs
* project graph boundaries enforced
* no cross-lib private imports
* no circular deps
* generators create compliant modules only
* release train validated at root, not package-by-package

### MCP Position

MCP is **optional** and **deferred**.

Priority order:

1. CLI
2. API
3. optional MCP adapter

If MCP exists, it must wrap the same CLI/API services and schemas. It is never the primary control plane.

---

## 10) Implementation Roadmap

### Delivery Strategy

This program is sized for **300+ tasks**, but this document stops at PRD/phase level.

### Phase 0 — Workspace Foundation

Goals:

* Nx monorepo
* lockstep versioning
* Effect baseline
* repository enforcement
* CI gates
* local dev bootstrap

Deliverables:

* root tsconfig
* lint/format/type policies
* workspace generators
* shared release/version policy

Exit gates:

* zero-warning CI
* affected graph working
* sample app + lib compile cleanly

### Phase 1 — Core Schemas and Services

Goals:

* canonical Schema models
* Tag/Layer service boundaries
* typed error hierarchy
* Config cascade
* basic storage abstractions

Deliverables:

* target/pack/snapshot/run schemas
* config loading
* error model
* base services

Exit gates:

* schema roundtrip tests
* config precedence tests
* no untyped boundaries

### Phase 2 — Extraction Core

Goals:

* parser
* selector engine
* normalizers
* assertions
* evidence model
* snapshot model

Deliverables:

* deterministic extractor core
* fixture bank
* diff-safe normalizers

Exit gates:

* parser fixture pass
* deterministic replay pass
* required field extraction stable on golden corpus

### Phase 3 — Access Runtime

Goals:

* HTTP access
* identity/egress policies
* budgeted retries
* artifact capture
* access planning

Deliverables:

* `AccessPlanner`
* `HttpAccess`
* identity/eject lease services
* capture persistence

Exit gates:

* throughput baseline established
* retry behavior deterministic
* health/quarantine rules working

### Phase 4 — Browser Runtime

Goals:

* browser/page/context lifecycle
* render capture
* bounded pools
* resource cleanup guarantees

Deliverables:

* `BrowserAccess`
* screenshot/DOM capture
* pool/budget management
* browser stability tests

Exit gates:

* no leaked contexts in soak test
* bounded parallelism proven
* artifact capture complete

### Phase 5 — Workflow Orchestration

Goals:

* Effect Workflow durable runs
* fan-out/fan-in crawl orchestration
* run planning
* checkpoints
* resume/replay

Deliverables:

* crawl workflow graph
* run inspection
* resume flows
* checkpoint store

Exit gates:

* crash/resume tests pass
* duplicate work under threshold
* 200k observation simulation passes

### Phase 6 — Site Packs and Reflection

Goals:

* pack DSL
* selector trust decay
* reflection/validator/curator loop
* pack lifecycle transitions

Deliverables:

* pack registry
* pack versioning
* promotion/quarantine mechanics
* reflection outputs

Exit gates:

* shadow to active path works
* rollback path works
* blocked selector state works

### Phase 7 — Quality Harness

Goals:

* incumbent comparison
* benchmark suite
* golden corpus
* live canaries
* chaos/soak suite

Deliverables:

* baseline corpus runner
* candidate comparison runner
* regression reports
* promotion gates

Exit gates:

* candidate vs incumbent scoreboard live
* live canaries integrated
* promotion policy enforced

### Phase 8 — CLI and API

Goals:

* production CLI
* production API
* shared handlers/services
* export/report flows

Deliverables:

* Effect CLI app
* Effect HttpApi app
* stable JSON envelopes
* artifact export

Exit gates:

* CLI/API parity tests pass
* workflow endpoints stable
* operator runbook complete

### Phase 9 — Hardening and Reference Packs

Goals:

* security pass
* reference e-commerce packs
* reference marketing packs
* docs and migration guide

Deliverables:

* reseller-monitor reference pack
* marketing-monitor reference pack
* baseline performance report
* hardening checklists

Exit gates:

* reference packs promoted active
* benchmark targets met
* docs ready for task decomposition

### Mandatory Test Program Across Phases

* schema roundtrip tests
* deterministic replay tests
* parser corpus tests
* normalizer property tests
* snapshot diff correctness tests
* workflow crash/resume tests
* load tests
* soak tests
* chaos tests
* incumbent differential tests
* authorized live canary tests
* governance rule tests

---

## 11) Comparison Matrix

### Product / Stack Comparison

| Capability                                    | **This Foundation** | **Scrapling** | **Crawlee** | **Scrapy** | **Playwright-only stack** | **Selenium-only stack** |
| --------------------------------------------- | ------------------- | ------------: | ----------: | ---------: | ------------------------: | ----------------------: |
| Effect-native end-to-end                      | ✅                   |             ❌ |           ❌ |          ❌ |                         ❌ |                       ❌ |
| Durable workflows built in                    | ✅                   |             ◐ |           ◐ |          ◐ |                         ❌ |                       ❌ |
| Unified CLI + API from same core              | ✅                   |             ◐ |           ◐ |          ◐ |                         ❌ |                       ❌ |
| Lockstep monorepo governance                  | ✅                   |             ❌ |           ❌ |          ❌ |                   depends |                 depends |
| Single-schema system                          | ✅                   |             ❌ |           ❌ |          ❌ |                         ❌ |                       ❌ |
| Deterministic evidence-backed extraction      | ✅                   |             ◐ |           ❌ |          ◐ |                         ❌ |                       ❌ |
| Adaptive selector relocation                  | ✅                   |             ✅ |           ❌ |          ❌ |                         ❌ |                       ❌ |
| Pack lifecycle with promotion/quarantine      | ✅                   |             ❌ |           ❌ |          ❌ |                         ❌ |                       ❌ |
| Incumbent differential harness as first-class | ✅                   |             ❌ |           ❌ |          ❌ |                         ❌ |                       ❌ |
| Large-scale resumable workflow focus          | ✅                   |             ◐ |           ✅ |          ✅ |                         ❌ |                       ❌ |
| Minimal dependency philosophy                 | ✅                   |             ◐ |           ◐ |          ◐ |                         ✅ |                       ✅ |
| Strict repo rule enforcement model            | ✅                   |             ❌ |           ❌ |          ❌ |                   depends |                 depends |
| Site-pack maintainability model               | ✅                   |             ❌ |           ◐ |          ◐ |                         ❌ |                       ❌ |
| Authorized high-friction access isolation     | ✅                   |             ◐ |           ◐ |          ❌ |                         ◐ |                       ◐ |
| Product/reseller monitoring fit               | ✅                   |             ✅ |           ◐ |          ◐ |                         ❌ |                       ❌ |
| Marketing + ecommerce on one foundation       | ✅                   |             ◐ |           ◐ |          ◐ |                         ❌ |                       ❌ |

### Why This Plan Wins

Against **Scrapling**:

* keeps adaptive strengths
* adds stronger durable orchestration
* adds comparison-driven promotion
* adds strict governance and maintainability

Against **Crawlee / Scrapy**:

* stronger extraction intelligence
* stronger evidence model
* stronger pack lifecycle
* unified CLI/API/Workflow model

Against **Playwright-only / Selenium-only**:

* much stronger runtime governance
* much better deterministic extraction model
* much better scaling, checkpointing, and comparison testing

### Final Product Decision

Build a **single lockstep Nx monorepo** on **Effect v4 only**, with:

* Effect Schema for all contracts
* Context/Layer for all services
* Workflow for durable runs and distribution
* CLI + API as first-class operator surfaces
* pack-based maintainability
* strict repo enforcement
* minimal external libs
* comparison-driven promotion against incumbents and competitors
