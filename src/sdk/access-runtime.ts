import { Effect, Layer, ServiceMap } from "effect";
import { AccessProgramLinker } from "./access-program-linker.ts";
import {
  DEFAULT_BROWSER_PROVIDER_ID,
  DEFAULT_STEALTH_BROWSER_PROVIDER_ID,
} from "./access-provider-ids.ts";
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
import { type AccessProgramCommandKind, type CanonicalAccessIr } from "./canonical-access-ir.ts";
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

function shouldInferBrowserCommand(input: {
  readonly defaultProviderId: AccessProviderId;
  readonly ir: CanonicalAccessIr;
}) {
  const knownDefaultProvider = input.ir.providers.find(
    (provider) => provider.id === input.defaultProviderId,
  );
  if (knownDefaultProvider?.capabilities.mode === "browser") {
    return true;
  }

  if (
    input.defaultProviderId !== DEFAULT_BROWSER_PROVIDER_ID &&
    input.defaultProviderId !== DEFAULT_STEALTH_BROWSER_PROVIDER_ID
  ) {
    const hasBrowserProvider = input.ir.providers.some(
      (provider) => provider.capabilities.mode === "browser",
    );
    const hasHttpProvider = input.ir.providers.some(
      (provider) => provider.capabilities.mode === "http",
    );

    return hasBrowserProvider && !hasHttpProvider;
  }

  return input.ir.providers.some((provider) => provider.capabilities.mode === "browser");
}

function inferExecutionCommand(input: {
  readonly command?: AccessProgramCommandKind | undefined;
  readonly execution?: AccessExecutionProfile | undefined;
  readonly defaultProviderId: AccessProviderId;
  readonly ir: CanonicalAccessIr;
}): AccessProgramCommandKind {
  if (input.command !== undefined) {
    return input.command;
  }

  if (
    input.execution?.mode === "browser" ||
    input.execution?.browser !== undefined ||
    input.execution?.browserRuntimeProfileId !== undefined
  ) {
    return "render";
  }

  if (input.execution?.mode === "http" || input.execution?.http !== undefined) {
    return "access";
  }

  const explicitExecutionProvider = input.execution?.providerId;
  if (explicitExecutionProvider !== undefined) {
    const explicitProviderDescriptor = input.ir.providers.find(
      (provider) => provider.id === explicitExecutionProvider,
    );
    if (explicitProviderDescriptor?.capabilities.mode === "browser") {
      return "render";
    }
    if (explicitProviderDescriptor?.capabilities.mode === "http") {
      return "access";
    }
  }

  return shouldInferBrowserCommand({
    defaultProviderId: input.defaultProviderId,
    ir: input.ir,
  })
    ? "render"
    : "access";
}

export const AccessExecutionRuntimeLive = Layer.effect(
  AccessExecutionRuntime,
  Effect.gen(function* () {
    const linker = yield* AccessProgramLinker;
    const ir = yield* linker.inspectIr();

    return {
      resolve: (input) =>
        Effect.gen(function* () {
          const inferredCommand = inferExecutionCommand({
            command: input.command,
            execution: input.execution,
            defaultProviderId: input.defaultProviderId,
            ir,
          });

          const specialized = yield* linker.specialize({
            command: inferredCommand,
            url: input.url,
            defaultTimeoutMs: input.defaultTimeoutMs,
            defaultProviderId: input.defaultProviderId,
            execution: input.execution,
          });

          return specialized.intent;
        }),
    } satisfies AccessExecutionRuntime["Service"];
  }),
);
