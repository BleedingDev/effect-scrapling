# ADR 0001: Adopt A Canonical Access IR, Parameterized Access Programs, And A Resource Kernel

- Status: Accepted
- Date: 2026-03-12
- Decision Owners: effect-scrapling maintainers
- Implementation Status: Implemented in the current SDK runtime and validated
  against the focused E3 benchmark plus sampled live E9 regression traffic;
  release-grade evidence still requires the full-corpus live suite

## Implementation Snapshot

The current repository already ships the architectural seam introduced by this
ADR in the SDK runtime:

- canonical linking and program specialization via
  [`src/sdk/canonical-access-ir.ts`](../../src/sdk/canonical-access-ir.ts) and
  [`src/sdk/access-program-linker.ts`](../../src/sdk/access-program-linker.ts)
- resource-lifecycle ownership through
  [`src/sdk/access-resource-kernel.ts`](../../src/sdk/access-resource-kernel.ts)
- one public authoring model with a narrowed SDK facade in
  [`src/sdk/public.ts`](../../src/sdk/public.ts) and
  [`src/sdk/engine.ts`](../../src/sdk/engine.ts)
- mode-aware default and fallback resolution, with explicit provider overrides
  still remaining caller-controlled input, through
  [`src/sdk/access-policy-runtime.ts`](../../src/sdk/access-policy-runtime.ts),
  [`src/sdk/access-program-linker.ts`](../../src/sdk/access-program-linker.ts),
  [`src/sdk/access-runtime.ts`](../../src/sdk/access-runtime.ts), and
  [`src/sdk/access-provider-runtime.ts`](../../src/sdk/access-provider-runtime.ts)
- host-specific assembly through shared CLI/API/SDK boundaries in
  [`src/standalone.ts`](../../src/standalone.ts),
  [`src/api.ts`](../../src/api.ts), and
  [`src/sdk/runtime-layer.ts`](../../src/sdk/runtime-layer.ts)
- activated transport bindings for proxy and WireGuard-backed execution in
  [`src/sdk/access-transport-binding.ts`](../../src/sdk/access-transport-binding.ts)
  and
  [`src/sdk/access-allocation-plugin-runtime.ts`](../../src/sdk/access-allocation-plugin-runtime.ts)

What remains open outside this ADR's acceptance scope is follow-up work on top
of the implemented kernel seam, for example:

- adding more aggressive prelinked or cached specialization layers above the
  linker
- broadening transport realizers beyond the current proxy-capable execution
  backends
- running the full-corpus live suite when release evidence, parity, or canary
  confidence matters more than fast-regression turnaround

## Post-Implementation Validation

The implementation was re-validated on 2026-03-12 with both the focused E3
runtime benchmark and the live E9 fast-regression suite. The artifacts cited
below were generated on 2026-03-12 while validating the repository state under
test for those benchmark runs:

- [`docs/artifacts/e3-access-runtime-scorecard.json`](../artifacts/e3-access-runtime-scorecard.json)
  reported `status: "pass"` with:
  - `generatedAt = 2026-03-12T06:18:02.319Z`
  - `baselineAccess.p95Ms = 0.785`
  - `candidateAccess.p95Ms = 8.568`
  - `retryRecovery.p95Ms = 261.158`
  - all three metrics stayed inside the current budgets of `25`, `50`, and
    `300` milliseconds respectively
- [`docs/artifacts/e9-benchmark-suite-fast-regression-artifact.json`](../artifacts/e9-benchmark-suite-fast-regression-artifact.json)
  reported `status: "pass"` with:
  - `generatedAt = 2026-03-12T07:14:57.388Z`
  - `totalAttemptCount = 640`
  - `totalSweepCount = 5`
  - `httpSuccessRate = 0.896`
  - `browserSuccessRate = 0.859`
  - `httpBestThroughputPagesPerMinute = 1453.683`
  - `browserBestThroughputPagesPerMinute = 77.843`
  - `httpLocalFailureCount = 0`
  - `browserLocalFailureCount = 0`

The sampled live artifact does not surface direct evidence of local kernel or
runtime faults. Its observed failures cluster on external domain behavior
instead:

- `ebay.com` appeared in both the top HTTP and top browser failure-domain lists
- `zbozi.cz` appeared in the top browser failure-domain list
- smaller residual failures appeared on `datart.cz`, `lidl-shop.cz`, `mp.cz`,
  and `shein.com`
- the top browser failure category was `access-wall` (`33` attempts), followed
  by `browser-navigation-timeout` (`3` attempts)
- no recovered-browser allocations and zero local-failure counters
- skipped `scrapling` and `canary` phases in the sampled preset, so a
  full-corpus run remains the right release-evidence follow-up when needed

The benchmark follow-up therefore changes the implementation assessment in one
important way: the current ADR seam is not only structurally implemented, but
also validated under both focused runtime pressure and sampled live traffic.
That sampled live evidence still does not justify treating browser fallback as
production-ready, and it does not prove release readiness. Its benchmark-driven
follow-up remains concrete:

- review browser failure categories and top failing domains
- prioritize diagnostics for `ebay.com`, `zbozi.cz`, and `lidl-shop.cz`
- run parity and canary phases separately, or the full-corpus suite, when
  definitive release evidence is needed

## Context

The repository is introducing a new access architecture before the library is
published. Backward compatibility is explicitly not a constraint. The goal is
to choose the strongest long-term architecture, even if the refactor is large.

The library must satisfy two host modes without architectural drift:

1. Standalone host usage through the repository CLI and future packaged CLI.
2. Embedded host usage as an SDK for other TypeScript applications.

The architecture therefore must optimize for all of the following at once:

- maximal modularity
- maximal runtime performance
- zero hardcoded transport semantics in the core
- one semantic model for CLI and SDK
- correct lifecycle handling for expensive runtime resources
- a public API that downstream TypeScript consumers can use without importing
  internal orchestration machinery

## Pre-Implementation State And Pain Points

At decision time, the repository already contained valuable pieces that should
influence the target design, but that pre-implementation state was not yet a
suitable target architecture.

### Good Parts Worth Preserving

- module composition validation already exists in
  [`src/sdk/access-module-runtime.ts`](../../src/sdk/access-module-runtime.ts)
- broker and execution coordination are already separated in
  [`src/sdk/access-broker-runtime.ts`](../../src/sdk/access-broker-runtime.ts),
  [`src/sdk/access-execution-engine.ts`](../../src/sdk/access-execution-engine.ts),
  and [`src/sdk/access-execution-coordinator.ts`](../../src/sdk/access-execution-coordinator.ts)
- access health subjects are already hierarchical in
  [`src/sdk/access-health-policy-runtime.ts`](../../src/sdk/access-health-policy-runtime.ts)
- CLI and API already call into shared SDK operations from
  [`src/standalone.ts`](../../src/standalone.ts) and
  [`src/api.ts`](../../src/api.ts)

### Structural Problems

#### 1. The core is still provider-centric

The current system treats provider IDs as central semantic carriers:

- [`src/sdk/access-provider-ids.ts`](../../src/sdk/access-provider-ids.ts)
- [`src/sdk/access-policy-runtime.ts`](../../src/sdk/access-policy-runtime.ts)
- [`src/sdk/access-runtime.ts`](../../src/sdk/access-runtime.ts)

This conflates several concerns:

- capture mode
- browser posture
- default selection
- fallback targets
- identity preference

That is a weak architectural center.

#### 2. Selection is split across layers that are not actually independent

Provider selection happens separately from egress and identity selection:

- [`src/sdk/access-policy-runtime.ts`](../../src/sdk/access-policy-runtime.ts)
- [`src/sdk/access-profile-policy-runtime.ts`](../../src/sdk/access-profile-policy-runtime.ts)
- [`src/sdk/access-profile-selection-strategy-runtime.ts`](../../src/sdk/access-profile-selection-strategy-runtime.ts)

However, the implementation already reveals real cross-axis coupling. Identity
selection and browser posture depend on provider-specific semantics. This means
the decomposition is only partially truthful.

#### 3. Transport is still modeled too close to proxy semantics

The current execution path ultimately materializes proxy-shaped configuration:

- [`src/sdk/egress-route-config.ts`](../../src/sdk/egress-route-config.ts)
- [`src/sdk/access-provider-runtime.ts`](../../src/sdk/access-provider-runtime.ts)

This makes Tor fit naturally, but makes WireGuard a second-class citizen. The
current WireGuard plugin enriches route metadata in
[`src/sdk/access-allocation-plugin-runtime.ts`](../../src/sdk/access-allocation-plugin-runtime.ts),
but execution engines do not consume WireGuard-native semantics in a first-class
way.

#### 4. The public SDK surface leaks too much internal machinery

[`src/sdk/index.ts`](../../src/sdk/index.ts) currently exports a very large
surface area, including internals that should remain replaceable. That is a poor
fit for a future embeddable SDK.

#### 5. The hot path still does too much runtime orchestration

The current runtime still performs a meaningful amount of dynamic lookup and
selection during request execution. This is acceptable for a transitional
architecture, but not for the target system.

## Decision

We will adopt the following target architecture:

### One Authoring Model, Two Host Assemblers, One Internal Kernel

The final system will have three major layers:

1. A public authoring layer shared by CLI and SDK.
2. An internal linking layer that compiles authoring inputs into a canonical
   runtime representation.
3. A low-level execution kernel centered on resource lifecycle, not on provider
   IDs or profile IDs.

This decision intentionally separates:

- public authoring contracts
- internal optimization structures
- host-specific assembly behavior
- hot-path execution semantics

## Target Architecture

### A. Public Authoring Model

The public API for both CLI and SDK will be declarative.

It will describe:

- access intents
- module manifests
- presets
- policy inputs
- optional host configuration

It will not expose:

- broker registries
- runtime layers as primary user concepts
- execution kernel internals
- provider-specific semantics as the main mental model

The public model must compile into the same semantic inputs regardless of host:

- CLI flag parsing
- API JSON parsing
- SDK TypeScript builders

All three must become adapters into the same authoring contract.

### A1. Semantic Boundary Between CLI And SDK

This ADR makes a strict distinction between:

- authoring semantics
- assembly policy
- runtime execution

CLI and SDK may differ only in assembly policy, not in authoring semantics.

The linker must therefore accept one normalized authoring input shape. Host
adapters may transform user-facing inputs into that shape, but once the
normalized authoring input exists, host-specific behavior must stop affecting
meaning.

Allowed host differences:

- input acquisition
- preset lookup
- module discovery
- cache usage
- diagnostics formatting

Forbidden host differences after normalization:

- different default fallback semantics
- different transport compatibility rules
- different identity precedence rules
- different policy scoring inputs
- different recovery graphs

In other words, CLI discovery and preset loading are valid only if they resolve
fully into the same normalized authoring input that an SDK consumer could have
constructed explicitly.

### B. Canonical Access IR

All authoring inputs will compile into one canonical internal representation.

The IR is the only internal model that may express:

- network semantics
- identity semantics
- capture semantics
- compatibility constraints
- recovery transitions
- resource lifecycle contracts
- health dimensions

The IR must be:

- normalized
- host-agnostic
- provider-agnostic
- transport-native instead of proxy-native
- suitable for partial evaluation

### B1. Control Boundary Between IR, Linked Programs, Kernel, And Executors

This ADR defines the following control ownership rules:

- the authoring model may describe intent, manifests, presets, and host input
- the canonical IR owns static semantics:
  - topology
  - compatibility
  - recovery graph
  - resource classes
  - policy dimensions
  - health dimensions
- linked programs own prelinked executable structure derived from the IR
- the resource kernel owns runtime resource lifecycle only
- capture backends own capture execution only

The following are explicitly forbidden:

- the resource kernel inventing new fallback topology
- capture backends reinterpreting transport compatibility
- linked programs mutating the canonical recovery graph at runtime
- host adapters bypassing the canonical IR to inject hidden execution semantics

The kernel may decide only operational matters such as:

- whether a resource can currently be acquired
- whether a resource should be reused or released
- whether cancellation or shutdown interrupts an in-flight operation

It may not decide architectural semantics.

### C. Partial Evaluation And Linking

The repository will not rely on rich runtime plugin lookups on the hot path.

Instead, a linker will:

- validate module manifests
- resolve compatibility relations
- intern identifiers
- precompute static dispatch structures
- produce parameterized executable programs

The result is not a fat "compiled strategy" object that contains everything.
Instead, it is a parameterized execution program that keeps stable logic
prelinked and accepts dynamic runtime overlays such as:

- health
- lease availability
- credentials
- locality
- load

### C1. Link-Time Versus Execute-Time Invariant

Linking must freeze:

- the set of candidate programs
- compatibility topology
- fallback and recovery graph
- scoring dimensions
- resource class bindings
- interned identifiers and static dispatch tables

Execution may vary only over dynamic overlays such as:

- health state
- live lease availability
- credentials presence
- locality
- host load

Execution must not:

- create new compatibility edges
- create new fallback branches
- discover new modules
- reinterpret scoring dimensions

This invariant is required so that "no runtime registry-heavy orchestration on
the hot path" is testable and enforceable.

### D. Resource Kernel

The real architectural center will be a resource kernel.

The kernel owns:

- acquire
- bind
- reuse
- recover
- release

This is the correct center because the expensive and failure-prone parts of the
system are resource-lifecycle concerns:

- browser contexts
- browser pools
- proxy sessions
- Tor circuits
- WireGuard tunnels or bridges
- leased egress sessions
- leased identities

The kernel must operate on typed resource contracts, not on loosely shaped
route configuration bags.

### D1. Ownership, Cancellation, And Lifecycle

The architecture explicitly adopts `Engine` lifecycle ownership as a public host
concern.

- the linker creates an `Engine`
- the `Engine` owns linked programs and runtime resource managers
- the host owns the `Engine` lifetime
- the kernel owns resource acquire, reuse, cancellation, and release inside one
  engine

This implies the following rules:

- SDK usage is centered on long-lived `Engine` instances
- CLI usage may create one short-lived `Engine` per invocation unless an
  explicit daemon mode is introduced later
- resources may be shared within an `Engine`
- resources must not be shared across `Engine` instances unless a future ADR
  introduces an explicit external shared-runtime facility
- cancellation semantics must be defined at the `Engine` boundary
- shutdown must be explicit for SDK hosts and deterministic for CLI hosts

This decision avoids smuggling process-lifetime assumptions from CLI mode into
embedded SDK mode.

### E. Capture Backends

Capture backends such as HTTP, browser, and future managed execution are not
planners. They are executors.

Their job is to consume provisioned handles produced by the resource kernel.
They must not decide:

- fallback topology
- transport compatibility
- identity precedence
- host policy defaults

### F. Two Host Assemblers

The system will expose two assembly policies over the same public authoring
model and the same internal kernel.

#### CLI host assembler

The CLI host may provide:

- opinionated defaults
- preset loading
- optional manifest autodiscovery
- optional persisted link caches
- human-facing diagnostics and explainability

#### SDK host assembler

The SDK host must provide:

- explicit module injection
- deterministic in-process linking
- long-lived engine instances as the normal consumption model
- tree-shakeable imports
- zero magic side effects during execution

CLI and SDK are therefore not separate architectures. They are separate host
assemblers over one shared semantic system.

### G. Packaging And Entrypoints

The architecture requires explicit packaging discipline.

The project should evolve toward separate entrypoint categories:

- public SDK facade entrypoints
- CLI host entrypoints
- internal kernel/linker entrypoints
- transport and capture driver entrypoints

The public SDK facade must remain narrow and stable in shape even if the
internal kernel evolves aggressively. CLI entrypoints may depend on defaults,
discovery, diagnostics, and caches that are unacceptable in the SDK host.

This separation is required for:

- tree-shaking
- dependency hygiene
- optional transport stacks
- smaller downstream bundles
- avoiding accidental import of host-specific side effects

### G2. Public Extension Seam

The public SDK must support explicit downstream extension, but only at the
authoring and driver boundary.

Allowed downstream extension points:

- authoring new module manifests
- authoring new presets
- supplying explicit transport, identity, and capture drivers through the public
  composition API

Not allowed as public extension points:

- direct mutation of canonical IR
- direct participation in linker internals
- direct use of resource kernel internals
- custom host-only semantics that bypass authoring normalization

This keeps the SDK genuinely extensible without leaking internal optimization
structures into downstream TypeScript applications.

### G1. Link Cache Semantics

Persisted CLI link caches are an optimization only, never a semantic source of
truth.

Any cache artifact must be invalidated by at least:

- linker version
- manifest digest
- normalized authoring input digest
- enabled capability set
- runtime platform fingerprint

A cache hit must be observationally equivalent to a fresh link for the same
normalized authoring input. The SDK host does not require persisted cache
support as part of its public contract.

## Why This Decision Was Chosen

### It gives the strongest modularity boundary

Modularity belongs at assembly time, not at hot-path dispatch time.

Modules should be excellent at describing capabilities and contributing runtime
drivers, but the assembled engine should run with minimal runtime indirection.

### It gives the strongest performance profile

This architecture allows:

- one-time linking
- precomputed compatibility
- indexed dispatch instead of repeated string-heavy resolution
- reusable long-lived runtime instances
- better pooling locality
- less per-request orchestration

This ADR also makes the performance priority order explicit:

1. steady-state execution throughput and latency under reuse
2. correctness and determinism of resource reuse and cleanup
3. bounded memory retention of long-lived engines
4. acceptable link latency and cold-start behavior
5. optional CLI cache acceleration

The design is therefore intentionally optimized for warm and repeated execution
first. A slower link phase is acceptable if it buys a meaningfully better
steady-state engine, but a more complex design that regresses end-to-end warm
execution is not acceptable.

### It treats CLI and SDK as first-class from the start

This is the strongest reason for the chosen shape.

The same authoring model can serve:

- human operators using the CLI
- server applications embedding the SDK
- future API adapters

without semantic drift.

### It creates an explainability contract without exposing internals

The architecture allows the linker and runtime to emit a stable decision trace
artifact that explains:

- chosen access program
- rejected alternatives
- transport and identity rationale
- recovery transitions
- cache hit or miss status

CLI can render this trace for humans. SDK can inspect it through a read-only
typed contract. Neither host needs direct access to internal linker or kernel
structures.

### It makes Tor and WireGuard symmetrical

Neither Tor nor WireGuard should be special cases in the core.

They should both appear as transport/resource contributors whose semantics are
understood through manifests, IR, and typed resource contracts. This avoids
biasing the core toward proxy-only thinking.

### It allows strict public/private separation

The public SDK contract can remain small and declarative while the internal
kernel remains free to evolve aggressively.

That is the correct trade if backward compatibility is not currently required
but future embeddability is.

## Alternatives Considered

### Alternative 1: Keep the current shape and remove hardcoded builtins

This would improve the current code, but it would preserve the wrong center:

- provider-centric semantics
- split selection logic
- runtime-heavy orchestration
- proxy-shaped transport assumptions

This is not sufficient.

### Alternative 2: Generic plugin runtime with registries everywhere

This improves flexibility, but it is too runtime-oriented.

It would likely:

- keep too much lookup logic on the hot path
- encourage broad public exports of internals
- make SDK ergonomics noisier
- reduce the ability to specialize execution

This is more flexible than necessary at the wrong layer.

### Alternative 3: Compiled strategies as the primary internal unit

This was the strongest earlier candidate and is intentionally recorded here as a
rejected near-final option.

It is better than the current system, but it still risks:

- strategy explosion
- too much business-shaped data in one object
- poor separation between stable logic and dynamic overlays

The accepted design keeps the compile/link idea but prefers a canonical IR and
parameterized executable programs over a large strategy catalog.

## Benefits

The architecture is expected to provide the following concrete benefits:

- one semantic model for CLI and SDK
- strong separation between public API and internal optimization structures
- no provider-ID hardcoding in core semantics
- no transport hardcoding in capture backends
- first-class lifecycle management for expensive resources
- better warm reuse and locality
- simpler future support for new transports
- clearer package boundaries
- better testability at each stage:
  - authoring
  - linking
  - execution
  - recovery

## Tradeoffs

The decision intentionally accepts these costs:

- a larger up-front redesign
- more internal architecture than a simple plugin registry would require
- a non-trivial linker/compiler implementation
- a new internal IR that must be kept disciplined
- stricter package/entrypoint boundaries

These are acceptable because the repository has not yet published a stable API
and the maintainers prefer architectural quality over short-term delivery speed.

## Risks

The chosen direction introduces real risks that must be actively managed.

### 1. IR bloat

If the canonical IR becomes a dumping ground for every concern, the architecture
will recreate the same coupling under a new name.

### 2. Hidden host drift

CLI and SDK can still drift if their assemblers start applying different
semantics instead of merely different assembly policies.

### 3. Internal/public leakage

If the SDK starts exporting internal linker or kernel primitives as normal user
concepts, the public surface will calcify around implementation details.

### 4. Over-optimization around compile/link

The design must not chase theoretical dispatch performance while ignoring the
true dominant costs:

- browser startup
- transport provisioning
- session reuse
- cleanup correctness

### 5. Cold-start and memory regression

The architecture can fail even if warm execution improves, if it introduces:

- pathological link latency
- unacceptable CLI startup regression
- excessive retained memory in long-lived SDK engines
- cache invalidation cost larger than the saved link work

### 6. Resource contract over-generalization

A resource kernel can fail if it tries to erase meaningful differences between
resource classes. WireGuard, Tor, direct access, leased sessions, and managed
browser execution may require different lifecycle handling.

### 7. Package sprawl

If packaging is not designed carefully, the system could become harder to
consume despite being internally cleaner.

### 8. Explainability erosion

If the system optimizes only for internal performance and fails to preserve a
stable decision trace contract, operators and SDK consumers will lose the
ability to understand why a path was chosen without depending on internals.

## What To Watch Out For

The implementation must preserve the following guardrails:

- one public authoring model
- one canonical internal IR
- no provider IDs as core semantic keys
- no route-config bag as the transport center
- no duplicated semantics between CLI and SDK
- one normalized authoring input before linking
- canonical IR owns static topology and recovery semantics
- resource kernel owns runtime lifecycle only
- no runtime registry-heavy orchestration on the hot path
- no public export of internal kernel concepts unless explicitly intended
- no host-specific fallback semantics hidden below the authoring layer
- long-lived linked engine instances for SDK usage
- optional link caches for CLI usage only
- cache hits must be semantically equivalent to fresh links
- a stable decision trace must exist for both CLI and SDK hosts

## Blind Alleys We Intentionally Avoid

The accepted decision explicitly avoids these architectural dead ends:

### 1. "Just make modules injectable"

This would improve flexibility but keep the wrong runtime structure.

### 2. "Use provider IDs, but more cleanly"

Provider IDs are not the right architectural center. Cleaning them up would not
fix the semantic coupling.

### 3. "Everything is a plugin all the way down"

This sounds modular, but it pushes too much indirection onto the hot path and
usually leaks internal mechanisms into the public SDK.

### 4. "The CLI can have its own config semantics"

This guarantees eventual drift from the SDK.

### 5. "The SDK can expose internals and let consumers decide"

This maximizes short-term flexibility at the cost of long-term coherence and
replaceability.

### 6. "Treat WireGuard as proxy-like enough"

This would lock the architecture into a transport model that is accidentally
favorable to proxy-based paths and fundamentally weaker for future transports.

## Public API Consequences

The future public SDK should expose a narrow surface centered on:

- authoring contracts
- engine creation
- engine execution
- engine shutdown
- decision trace inspection
- typed result and error contracts
- explicit module/preset composition

It should not treat internal registries, brokers, or kernel primitives as
normal application-level concepts.

The SDK should primarily expose a long-lived `Engine` or equivalent runtime
handle built from authoring inputs and explicit module composition.

The CLI should become a host adapter over the same authoring contracts and the
same linked engine model, with its own assembly policy.

## Success Criteria

This decision should be considered successful only if all of the following are
true after implementation:

1. CLI and SDK compile to the same semantic authoring model.
2. The core contains no provider-ID-driven policy semantics.
3. Transport modules such as Tor and WireGuard can be added without modifying
   core execution semantics.
4. The hot path does not re-link or re-discover the world on each execution.
5. SDK consumers can build a long-lived engine once and execute many times.
6. Public exports no longer leak broad internal orchestration machinery.
7. Link-time and execute-time responsibilities are mechanically testable.
8. Warm end-to-end execution improves without pathological cold-start or memory
   regression.

## Follow-Up Work

Implementation produced follow-up design and implementation artifacts for:

- public SDK facade
- CLI host assembler
- canonical access IR
- linker and partial evaluator
- resource kernel
- package/entrypoint boundaries
- migration of current runtime-layer and selection logic

## References

- [`src/sdk/index.ts`](../../src/sdk/index.ts)
- [`src/sdk/access-provider-ids.ts`](../../src/sdk/access-provider-ids.ts)
- [`src/sdk/access-policy-runtime.ts`](../../src/sdk/access-policy-runtime.ts)
- [`src/sdk/access-profile-policy-runtime.ts`](../../src/sdk/access-profile-policy-runtime.ts)
- [`src/sdk/access-profile-selection-strategy-runtime.ts`](../../src/sdk/access-profile-selection-strategy-runtime.ts)
- [`src/sdk/access-provider-runtime.ts`](../../src/sdk/access-provider-runtime.ts)
- [`src/sdk/access-health-policy-runtime.ts`](../../src/sdk/access-health-policy-runtime.ts)
- [`src/standalone.ts`](../../src/standalone.ts)
- [`src/api.ts`](../../src/api.ts)
