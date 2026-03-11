import { Effect, Layer, ServiceMap } from "effect";
import {
  DEFAULT_BROWSER_PROVIDER_ID,
  DEFAULT_HTTP_PROVIDER_ID,
  DEFAULT_STEALTH_BROWSER_PROVIDER_ID,
} from "./access-provider-ids.ts";
import { AccessProgramLinker } from "./access-program-linker.ts";
export {
  DEFAULT_BROWSER_PROVIDER_ID,
  DEFAULT_HTTP_PROVIDER_ID,
  DEFAULT_STEALTH_BROWSER_PROVIDER_ID,
} from "./access-provider-ids.ts";
import {
  makeBrowserPoolKey,
  materializeExecutionContext,
  toExecutionMetadata,
  type AccessExecutionContext,
  type ResolvedBrowserFallbackExecution,
  type ResolvedBrowserExecution,
  type ResolvedExecutionIntent,
  type ResolvedExecutionPlan,
  type ResolvedHttpExecution,
} from "./access-execution-context.ts";
import { type AccessProgramCommandKind } from "./canonical-access-ir.ts";
import { InvalidInputError } from "./errors.ts";
import { type AccessExecutionProfile, type AccessProviderId } from "./schemas.ts";

export type AccessExecutionInput = {
  readonly command?: AccessProgramCommandKind | undefined;
  readonly url: string;
  readonly defaultTimeoutMs: number;
  readonly execution?: AccessExecutionProfile | undefined;
  readonly defaultProviderId: AccessProviderId;
};

export { toExecutionMetadata } from "./access-execution-metadata.ts";
export {
  makeBrowserPoolKey,
  materializeExecutionContext,
  type AccessExecutionContext,
  type ResolvedBrowserFallbackExecution,
  type ResolvedBrowserExecution,
  type ResolvedExecutionIntent,
  type ResolvedExecutionPlan,
  type ResolvedHttpExecution,
} from "./access-execution-context.ts";

export class AccessExecutionRuntime extends ServiceMap.Service<
  AccessExecutionRuntime,
  {
    readonly resolve: (
      input: AccessExecutionInput,
    ) => Effect.Effect<ResolvedExecutionPlan, InvalidInputError>;
  }
>()("@effect-scrapling/sdk/AccessExecutionRuntime") {}

export const AccessExecutionRuntimeLive = Layer.effect(
  AccessExecutionRuntime,
  Effect.gen(function* () {
    const linker = yield* AccessProgramLinker;

    return {
      resolve: (input) =>
        linker
          .specialize({
            command:
              input.command ??
              (input.defaultProviderId === DEFAULT_BROWSER_PROVIDER_ID ? "render" : "access"),
            url: input.url,
            defaultTimeoutMs: input.defaultTimeoutMs,
            defaultProviderId: input.defaultProviderId,
            execution: input.execution,
          })
          .pipe(Effect.map(({ intent }) => intent)),
    } satisfies AccessExecutionRuntime["Service"];
  }),
);
