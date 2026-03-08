# E8 Shared Command Core

## Purpose

Operate the shared E8 command-handler layer that backs the public workspace
doctor/config commands and keeps the CLI and SDK on one deterministic Effect
surface.

## Public Surface

CLI:

```sh
effect-scrapling doctor
effect-scrapling workspace doctor
effect-scrapling workspace config show
```

SDK:

```ts
import { executeWorkspaceCommand } from "effect-scrapling/e8";
```

Focused checks:

```sh
bun test tests/sdk/e8-command-core-verify.test.ts
bun run check:e8-workspace-operations
```

## Practical Use

Run the shared core directly through the public SDK:

```ts
import { Effect } from "effect";
import { executeWorkspaceCommand } from "effect-scrapling/e8";

const doctor = await Effect.runPromise(executeWorkspaceCommand("doctor"));
const config = await Effect.runPromise(executeWorkspaceCommand("config-show"));
```

CLI parity replay:

```sh
effect-scrapling workspace doctor
effect-scrapling workspace config show
```

## Troubleshooting

### Unknown workspace command

The boundary rejects unsupported subcommands as `InvalidInputError`. Fix the
invocation instead of adding a fallback alias with divergent behavior.

### SDK and CLI envelopes drift

Run:

```sh
bun test tests/sdk/e8-command-core-verify.test.ts
bun run check:e8-workspace-operations
```

If either fails, fix the shared handler path first. Do not patch only one
surface.

## Rollback

1. Revert the offending changes in `src/e8-command-core.ts`,
   `src/standalone.ts`, or `src/e8.ts`.
2. Re-run the focused checks above.
3. Re-run `bun run check` before re-promoting the change.
