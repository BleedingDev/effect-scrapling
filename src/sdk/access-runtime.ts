import { Effect, Layer, ServiceMap } from "effect";
import { AccessProgramLinker } from "./access-program-linker.ts";
import { AccessProfileSelectionPolicy } from "./access-profile-policy-runtime.ts";
import {
  DEFAULT_PATCHRIGHT_BROWSER_RUNTIME_PROFILE_ID,
  DEFAULT_PATCHRIGHT_STEALTH_RUNTIME_PROFILE_ID,
} from "./access-profile-runtime.ts";
import { AccessProviderRegistry } from "./access-provider-runtime.ts";
import { AccessSelectionPolicy } from "./access-policy-runtime.ts";
import {
  DEFAULT_BROWSER_PROVIDER_ID,
  DEFAULT_HTTP_PROVIDER_ID,
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
import {
  type AccessExecutionProfile,
  type AccessProviderId,
  type BrowserExecutionOptions,
} from "./schemas.ts";

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

function invalidExecution(message: string, details?: string) {
  return new InvalidInputError({
    message,
    ...(details === undefined ? {} : { details }),
  });
}

function resolveBrowserProviderWaitUntil(
  providerId: AccessProviderId,
  browserOptions?: BrowserExecutionOptions,
) {
  if (browserOptions?.waitUntil !== undefined) {
    return browserOptions.waitUntil;
  }

  return providerId === DEFAULT_STEALTH_BROWSER_PROVIDER_ID
    ? "domcontentloaded"
    : "domcontentloaded";
}

function resolveTargetDomain(url: string): Effect.Effect<string, InvalidInputError> {
  return Effect.try({
    try: () => {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("unsupported-protocol");
      }

      if (parsed.hostname.length === 0) {
        throw new Error("missing-hostname");
      }

      return parsed.hostname.toLowerCase();
    },
    catch: () =>
      invalidExecution(
        "Invalid target URL",
        `Expected an absolute HTTP(S) URL, received "${url}".`,
      ),
  });
}

function shouldEnableBrowserFallbackByDefault(execution: AccessExecutionInput["execution"]) {
  return (
    execution?.mode === undefined &&
    execution?.providerId === undefined &&
    execution?.http === undefined
  );
}

function httpExecutionFromIdentity(
  execution: AccessExecutionInput["execution"],
  identity: { readonly httpUserAgent?: string | undefined },
): ResolvedHttpExecution | undefined {
  const userAgent = execution?.http?.userAgent ?? identity.httpUserAgent;
  return userAgent === undefined ? undefined : { userAgent };
}

function browserExecutionFromIdentity(input: {
  readonly providerId: AccessProviderId;
  readonly defaultTimeoutMs: number;
  readonly execution?: AccessExecutionInput["execution"];
  readonly identity: {
    readonly browserRuntimeProfileId?: string | undefined;
    readonly browserUserAgent?: string | undefined;
  };
}): ResolvedBrowserExecution {
  const browserOptions = input.execution?.browser;
  const browserTimeoutMs = browserOptions?.timeoutMs ?? input.defaultTimeoutMs;
  const browserUserAgent = browserOptions?.userAgent ?? input.identity.browserUserAgent;

  return {
    runtimeProfileId:
      input.execution?.browserRuntimeProfileId ??
      input.identity.browserRuntimeProfileId ??
      (input.providerId === DEFAULT_STEALTH_BROWSER_PROVIDER_ID
        ? DEFAULT_PATCHRIGHT_STEALTH_RUNTIME_PROFILE_ID
        : DEFAULT_PATCHRIGHT_BROWSER_RUNTIME_PROFILE_ID),
    waitUntil: resolveBrowserProviderWaitUntil(input.providerId, browserOptions),
    timeoutMs: browserTimeoutMs,
    ...(browserUserAgent === undefined ? {} : { userAgent: browserUserAgent }),
  };
}

function dedupeWarnings(...inputs: ReadonlyArray<ReadonlyArray<string>>) {
  return [...new Set(inputs.flatMap((warnings) => warnings))];
}

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
    const providerRegistry = yield* AccessProviderRegistry;
    const selectionPolicy = yield* AccessSelectionPolicy;
    const profileSelectionPolicy = yield* AccessProfileSelectionPolicy;
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
          const program = ir.programs.find((candidate) => candidate.command === inferredCommand);
          if (program === undefined) {
            return yield* Effect.fail(
              invalidExecution(
                "Unknown access program",
                `No linked access program is registered for command "${inferredCommand}".`,
              ),
            );
          }

          const resolveIntent = ({
            defaultProviderId,
            execution,
          }: {
            readonly defaultProviderId: AccessProviderId;
            readonly execution: AccessExecutionInput["execution"];
          }) =>
            Effect.gen(function* () {
              const selection = yield* selectionPolicy.resolveSelection({
                url: input.url,
                defaultProviderId,
                execution,
              });
              const providerId = selection.providerId;
              const mode = selection.mode;
              const providerDescriptor = yield* providerRegistry.findDescriptor(providerId);
              if (providerDescriptor === undefined) {
                return yield* Effect.fail(
                  invalidExecution(
                    "Unknown access provider",
                    `No access provider named "${providerId}" is registered.`,
                  ),
                );
              }
              if (providerDescriptor.capabilities.mode !== mode) {
                return yield* Effect.fail(
                  invalidExecution(
                    "Selection policy returned an incompatible provider",
                    `Provider "${providerId}" serves mode "${providerDescriptor.capabilities.mode}", not "${mode}".`,
                  ),
                );
              }

              const candidateProviderIds =
                mode === "http"
                  ? program.candidateProviderIdsByMode.http
                  : program.candidateProviderIdsByMode.browser;
              if (!candidateProviderIds.includes(providerId)) {
                return yield* Effect.fail(
                  invalidExecution(
                    "Selection escaped linked program topology",
                    `Linked program "${program.programId}" does not admit provider "${providerId}" for mode "${mode}".`,
                  ),
                );
              }

              const profiles = yield* profileSelectionPolicy.resolveProfiles({
                url: input.url,
                providerId,
                execution,
              });
              const targetDomain = yield* resolveTargetDomain(input.url);
              const warnings = dedupeWarnings(
                selection.warnings,
                profiles.egress.warnings,
                profiles.identity.warnings,
              );

              return {
                targetUrl: input.url,
                targetDomain,
                providerId,
                mode,
                timeoutMs:
                  mode === "browser"
                    ? (execution?.browser?.timeoutMs ?? input.defaultTimeoutMs)
                    : input.defaultTimeoutMs,
                egress: profiles.egress,
                identity: profiles.identity,
                ...(mode === "http"
                  ? (() => {
                      const http = httpExecutionFromIdentity(execution, profiles.identity);
                      return http === undefined ? {} : { http };
                    })()
                  : {
                      browser: browserExecutionFromIdentity({
                        providerId,
                        defaultTimeoutMs: input.defaultTimeoutMs,
                        execution,
                        identity: profiles.identity,
                      }),
                    }),
                warnings,
              } satisfies ResolvedExecutionPlan;
            });

          const explicitDefaultProvider = yield* providerRegistry.findDescriptor(
            input.defaultProviderId,
          );
          const effectiveDefaultProviderId =
            explicitDefaultProvider !== undefined
              ? input.defaultProviderId
              : input.defaultProviderId === DEFAULT_HTTP_PROVIDER_ID ||
                  input.defaultProviderId === DEFAULT_BROWSER_PROVIDER_ID ||
                  input.defaultProviderId === DEFAULT_STEALTH_BROWSER_PROVIDER_ID
                ? program.defaultProviderId
                : input.defaultProviderId;

          const baseIntent = yield* resolveIntent({
            defaultProviderId: effectiveDefaultProviderId,
            execution: input.execution,
          });

          const browserFallbackEdge = program.fallbackEdges.find(
            (edge) => edge.kind === "browser-on-access-wall",
          );
          const browserFallbackEnabled =
            input.execution?.fallback?.browserOnAccessWall ??
            shouldEnableBrowserFallbackByDefault(input.execution);

          if (
            baseIntent.mode !== "http" ||
            !browserFallbackEnabled ||
            browserFallbackEdge === undefined
          ) {
            return baseIntent;
          }

          const explicitFallbackProviderId = input.execution?.providerId;
          const explicitFallbackDescriptor =
            explicitFallbackProviderId === undefined
              ? undefined
              : yield* providerRegistry.findDescriptor(explicitFallbackProviderId);
          const fallbackExecution = {
            ...input.execution,
            mode: "browser" as const,
            http: undefined,
            ...(explicitFallbackDescriptor?.capabilities.mode === "browser"
              ? {}
              : { providerId: undefined }),
          };
          const fallbackIntent = yield* resolveIntent({
            defaultProviderId: browserFallbackEdge.defaultTargetProviderId,
            execution: fallbackExecution,
          });
          const fallbackBrowser =
            fallbackIntent.mode === "browser" && "browser" in fallbackIntent
              ? fallbackIntent.browser
              : undefined;
          if (fallbackIntent.mode !== "browser" || fallbackBrowser === undefined) {
            return yield* Effect.fail(
              invalidExecution(
                "Browser fallback resolved an incompatible provider",
                `Fallback edge "${browserFallbackEdge.edgeId}" must materialize browser execution settings.`,
              ),
            );
          }

          return {
            ...baseIntent,
            fallback: {
              browserOnAccessWall: {
                targetUrl: fallbackIntent.targetUrl,
                targetDomain: fallbackIntent.targetDomain,
                providerId: fallbackIntent.providerId,
                mode: "browser",
                timeoutMs: fallbackIntent.timeoutMs,
                egress: fallbackIntent.egress,
                identity: fallbackIntent.identity,
                browser: fallbackBrowser,
                warnings: dedupeWarnings(fallbackIntent.warnings, baseIntent.warnings),
              } satisfies ResolvedBrowserFallbackExecution,
            },
          } satisfies ResolvedExecutionPlan;
        }),
    } satisfies AccessExecutionRuntime["Service"];
  }),
);
