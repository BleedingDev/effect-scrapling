# E1 Site Pack State Schema Runbook

## Purpose

Use this runbook when operators, SDK consumers, or downstream schema authors
need to validate or troubleshoot canonical `SitePack`, `PackState`, and
`PackLifecycleTransition` contracts in `@effect-scrapling/foundation-core`.

This contract exists to keep site pack lifecycle state, version rollout, and
domain ownership explicit before planners or runtime services decide which pack
version is eligible to serve traffic.

Policy baseline:
- Effect v4 only.
- No Effect v3 dependencies or compatibility shims.
- No manual tag inspection, manual instanceof, manual _tag inspection, or
  type-safety bypass shortcuts.

## Public Contract

Current exports:
- `PackStateSchema`
- `PackLifecycleTransitionSchema`
- `SitePack`
- `SitePackSchema`
- `CanonicalIdentifierSchema`

Supported pack states:
- `draft`
- `shadow`
- `active`
- `guarded`
- `quarantined`
- `retired`

Field expectations:
- `id` and `accessPolicyId` must be canonical identifiers: trimmed, non-empty,
  and whitespace-free.
- `domainPattern` must be lowercased, whitespace-free, and must not include a
  protocol. A leading `*.` wildcard is allowed.
- `version` must be trimmed, non-empty, and whitespace-free.
- `state` must decode through `PackStateSchema`.

Lifecycle transition expectations:
- Transition requests must decode through `PackLifecycleTransitionSchema`.
- `draft` cannot jump directly to `active`, `guarded`, or `quarantined`.
- `shadow` is the only promotion path into `active`.
- `shadow` cannot move directly into `guarded` or `quarantined`.
- `retired` is terminal. There is no supported path out of `retired`.
- Recovery states are explicit:
  - `guarded` may move to `shadow`, `active`, `quarantined`, or `retired`
  - `quarantined` may move to `shadow`, `active`, or `retired`

Supported lifecycle transition matrix:

| From | To |
| --- | --- |
| `draft` | `shadow`, `retired` |
| `shadow` | `active`, `retired` |
| `active` | `shadow`, `guarded`, `quarantined`, `retired` |
| `guarded` | `shadow`, `active`, `quarantined`, `retired` |
| `quarantined` | `shadow`, `active`, `retired` |
| `retired` | none |

## Command Usage

Run targeted verification from repository root:

```bash
bun test tests/libs/foundation-core.test.ts
bun test tests/guardrails/e1-site-pack-state.verify.test.ts
bun test tests/guardrails/e1-schema-runbooks.verify.test.ts
```

Run touched-project compilation checks:

```bash
bunx --bun tsc --noEmit -p libs/foundation/core/tsconfig.json
bunx --bun tsc --noEmit -p apps/api/tsconfig.json
bunx --bun tsc --noEmit -p apps/cli/tsconfig.json
```

Run the full repository gates before closure:

```bash
bun run check
bun run nx:show-projects
bun run nx:lint
bun run nx:typecheck
bun run nx:build
```

## Practical Example

```ts
import { Schema } from "effect";
import {
  PackLifecycleTransitionSchema,
  SitePackSchema,
} from "@effect-scrapling/foundation-core";

const sitePack = Schema.decodeUnknownSync(SitePackSchema)({
  id: "pack-example-com",
  domainPattern: "*.example.com",
  state: "shadow",
  accessPolicyId: "policy-default",
  version: "2026.03.06",
});

const promotion = Schema.decodeUnknownSync(PackLifecycleTransitionSchema)({
  from: "shadow",
  to: "active",
});
```

Expected behavior:
- `Schema.decodeUnknownSync(SitePackSchema)` succeeds only for canonical pack
  identity and state payloads
- transition decode succeeds only for supported lifecycle pairs
- encode returns a stable transport payload for CLI, SDK, and workflow use
- invalid lifecycle jumps fail at the contract boundary instead of reaching
  planner or runtime services

## Troubleshooting

### Domain pattern validation fails

Check whether `domainPattern` contains:
- uppercase characters
- `http://` or `https://`
- whitespace
- a path, query, or fragment

Use a lowercased host or wildcard host only, such as `example.com` or
`*.example.com`. Fix the upstream source instead of weakening the schema.

### Version validation fails

`version` must be non-empty after trimming and cannot contain whitespace. Keep
release identifiers compact, for example `2026.03.06` or `v2026-03-06`.

### Lifecycle transition validation fails

Check the requested `from -> to` pair against the supported matrix first.

Common invalid requests:
- `draft -> active`
- `draft -> guarded`
- `shadow -> quarantined`
- `quarantined -> draft`
- any `retired -> *` transition

Important lifecycle caveats from the validated implementation:
- initial rollout must pass through `shadow` before `active`
- `guarded` and `quarantined` are not aliases for `draft`; they preserve an
  existing deployed pack in a constrained recovery path
- retiring a pack is irreversible at the schema boundary

Do not bypass transition validation with ad hoc conditionals, manual
instanceof, or manual _tag checks. Decode through
`PackLifecycleTransitionSchema` and fix the upstream transition request.

### Consumer code branches on tags or classes directly

That is a policy violation. Operators and SDK consumers must not add manual
instanceof or manual _tag inspection to recover from schema failures.
Use schema decode results and typed Effect error handling instead.

## Rollout Guidance

1. Prepare
- confirm producers emit canonical `SitePack` payloads
- verify requested state moves against `PackLifecycleTransitionSchema`
- validate local examples with `bun test tests/guardrails/e1-site-pack-state.verify.test.ts`

2. Apply
- decode incoming pack payloads through `SitePackSchema`
- decode lifecycle changes through `PackLifecycleTransitionSchema`
- remove parallel ad hoc lifecycle validators or string-switch transition code

3. Verify
- run targeted tests
- run touched-project typechecks
- run `bun run check`

4. Promote
- move new packs `draft -> shadow` first, then `shadow -> active` only after
  verification is complete
- merge only when the site pack verify test and full gates are green

## Rollback Guidance

1. Revert the producer or operator change that introduced the invalid pack
   payload or unsupported lifecycle request.
2. If a rollout already moved a pack beyond the intended state, use only a
   supported reverse or recovery path:
- `active -> shadow` to withdraw from primary use without retiring
- `active -> guarded` for constrained serving
- `active -> quarantined` for hard isolation
- `guarded -> shadow` or `quarantined -> shadow` to recover through the shadow
  path
3. Re-run:

```bash
bun test tests/libs/foundation-core.test.ts
bun test tests/guardrails/e1-site-pack-state.verify.test.ts
bun test tests/guardrails/e1-schema-runbooks.verify.test.ts
bun run check
```

4. Keep lifecycle invariants intact; do not add fallback transitions, manual
   coercion, manual instanceof, or manual _tag parsing to force invalid
   state changes through.
5. Re-attempt rollout only after the payload source and requested lifecycle path
   are both compliant with the schema matrix.

## Operator Notes

- Treat site pack decode failures as contract bugs, not as candidates for silent
  coercion.
- Keep rollout orchestration explicit: `draft` is pre-release, `shadow` is the
  proving state, `active` is live, `guarded` and `quarantined` are constrained
  recovery states, and `retired` is terminal.
- Keep the public surface on `@effect-scrapling/foundation-core`.
- Effect v4 only remains mandatory for any future site pack schema extensions.
