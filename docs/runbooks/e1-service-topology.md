# E1 Service Topology Runbook

## Purpose

Use this runbook when operators, SDK consumers, or runtime authors need to
validate or troubleshoot the canonical E1 service topology in
`@effect-scrapling/foundation-core`.

This topology keeps core module boundaries expressed as `Schema + Service tag +
Layer + Effect` instead of ad hoc singleton helpers.

Policy baseline:
- Effect v4 only.
- No Effect v3 dependencies or compatibility shims.
- No `Context.Tag` business-logic tags.
- No manual `instanceof`, manual `_tag`, or type-safety bypass shortcuts.

## Public Contract

Current exports:
- `TargetRegistry`
- `PackRegistry`
- `AccessPlanner`
- `HttpAccess`
- `BrowserAccess`
- `CaptureStore`
- `Extractor`
- `SnapshotStore`
- `DiffEngine`
- `QualityGate`
- `ReflectionEngine`
- `WorkflowRunner`
- `ArtifactExporter`

Topology expectations from the current implementation:
- tags use `ServiceMap.Service`
- consumers resolve services through `Layer.succeed`, `Layer.effect`, or
  `Layer.mergeAll`
- no core service requires direct singleton imports to function
- cross-service payloads stay on shared schema contracts

## Command Usage

Run targeted verification from repository root:

```bash
bun test tests/libs/foundation-core-workflow.test.ts
bun run example:e1-capability-slice
```

Run touched-project compilation checks:

```bash
bunx --bun tsc --noEmit -p libs/foundation/core/tsconfig.json
bunx --bun tsc --noEmit -p apps/api/tsconfig.json
bunx --bun tsc --noEmit -p apps/cli/tsconfig.json
```

Run the full repository gates before closure:

```bash
bun run lint
bun run check
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

## Practical Example

```ts
import { Effect, Layer, Option } from "effect";
import {
  AccessPlanner,
  PackRegistry,
  TargetRegistry,
} from "@effect-scrapling/foundation-core";

const live = Layer.mergeAll(
  Layer.succeed(TargetRegistry)(
    TargetRegistry.of({
      getById: () => Effect.succeed(Option.none()),
    }),
  ),
  Layer.succeed(PackRegistry)(
    PackRegistry.of({
      getByDomain: () => Effect.succeed(Option.none()),
      getById: () => Effect.succeed(Option.none()),
    }),
  ),
  Layer.succeed(AccessPlanner)(
    AccessPlanner.of({
      plan: () => Effect.fail(new Error("Provide a real planner implementation")),
    }),
  ),
);
```

Expected behavior:
- services resolve from layers, not from hidden module state
- public service contracts keep typed payload and error surfaces explicit
- tests can swap individual services without patching global state

## Troubleshooting

### A service works only when imported directly

That is a topology regression. Move the dependency behind a service tag and
provide it through a layer. Do not hide runtime state in module globals.

### Layers become deeply nested and requirements are hard to read

Flatten composition with `Layer.mergeAll` or use `Layer.provideMerge` for
incremental composition. Avoid long, opaque provide chains.

### Generic errors or untyped payloads leak between services

Fix the service contract, not the caller. Cross-service surfaces must use
shared schemas and typed error families from foundation-core.

### Tests mutate services imperatively

That is a smell. Prefer replacing services through layers in the test context so
the dependency graph stays explicit and reproducible.

## Rollout Guidance

1. Prepare
- identify every consumer of the topology services
- verify that service boundaries use public schemas and typed errors
- validate the current graph with `bun test tests/libs/foundation-core-workflow.test.ts`

2. Apply
- wire services through `ServiceMap.Service` tags and layers
- remove singleton imports and ambient mutable state from the affected path

3. Verify
- run targeted tests
- run `bun run example:e1-capability-slice`
- run `bun run check`

4. Promote
- merge only when topology tests, capability slice, and full gates are green

## Rollback Guidance

1. Revert the change that introduced singleton coupling, hidden state, or
   untyped boundaries.
2. Re-run:

```bash
bun test tests/libs/foundation-core-workflow.test.ts
bun run example:e1-capability-slice
bun run check
```

3. Keep the service tags intact; do not patch regressions with direct imports or
   local mutable caches.
4. Re-attempt rollout only after the layer graph is explicit and green again.

## Operator Notes

- The topology is intentionally bigger than the current execution slice so later
  epics can plug in without changing the boundary pattern.
- Keep service contracts public and layer-provided.
- Effect v4 only remains mandatory for future service additions.
