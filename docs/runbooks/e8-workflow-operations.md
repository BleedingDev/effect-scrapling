# E8 Workflow Operations

## Purpose

Operate crawl compilation, workflow run, workflow resume, and workflow inspect
through one typed E8 control-plane surface.

## Public Surface

CLI:

```sh
effect-scrapling crawl compile --input '<json>'
effect-scrapling workflow run --input '<json>'
effect-scrapling workflow resume --input '<json>'
effect-scrapling workflow inspect --input '<json>'
```

SDK:

```ts
import {
  runCrawlCompileOperation,
  runWorkflowRunOperation,
  runWorkflowResumeOperation,
  runWorkflowInspectOperation,
} from "effect-scrapling/e8";
```

Focused checks:

```sh
bun test tests/sdk/e8-workflow-verify.test.ts tests/sdk/e8-control-plane.test.ts
bun run check:e8-workspace-operations
```

## Practical Use

Compile a crawl plan and inspect the resulting run:

```sh
effect-scrapling crawl compile --input '{ "createdAt": "2026-03-09T16:10:00.000Z", "entries": [...] }'
effect-scrapling workflow run --input '{ "compiledPlan": {...}, "pack": {...} }'
effect-scrapling workflow inspect --input '{ "compiledPlan": {...}, "checkpoint": {...}, "pack": {...} }'
```

## Troubleshooting

### Resume or inspect rejects the checkpoint

The checkpoint must align with the compiled plan, resume token, step sequence,
and pack identity. Rebuild the workflow input from the original compiled plan.

### Run identifiers drift across operations

That is a bug. Re-run the focused workflow checks and inspect the checkpoint
construction path in `src/e8-control-plane.ts`.

## Rollback

1. Revert the workflow-surface changes in `src/e8-control-plane.ts`.
2. Re-run the focused workflow checks.
3. Re-run `bun run check` before restoring the earlier release path.
