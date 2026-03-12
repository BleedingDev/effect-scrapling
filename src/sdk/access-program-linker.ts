import { Effect, Layer, ServiceMap } from "effect";
import { AccessModuleRegistry } from "./access-module-runtime.ts";
import {
  AccessProfileRegistry,
  DEFAULT_PATCHRIGHT_BROWSER_RUNTIME_PROFILE_ID,
} from "./access-profile-runtime.ts";
import { AccessProfileSelectionPolicy } from "./access-profile-policy-runtime.ts";
import {
  type AccessProviderDescriptor,
  AccessProviderRegistry,
} from "./access-provider-runtime.ts";
import { AccessSelectionPolicy } from "./access-policy-runtime.ts";
import {
  buildCanonicalAccessIr,
  type AccessProgramDecisionTrace,
  type AccessProgramFallbackEdge,
  type AccessProgramSpecializationInput,
  type CanonicalAccessIr,
  type LinkedAccessProgram,
  type ParameterizedAccessProgram,
} from "./canonical-access-ir.ts";
import { InvalidInputError } from "./errors.ts";
import {
  type ResolvedBrowserFallbackExecution,
  type ResolvedBrowserExecution,
  type ResolvedExecutionPlan,
  type ResolvedHttpExecution,
} from "./access-execution-context.ts";
import { type BrowserExecutionOptions } from "./schemas.ts";

function invalidExecution(message: string, details?: string) {
  return new InvalidInputError({
    message,
    ...(details === undefined ? {} : { details }),
  });
}

function resolveBrowserProviderWaitUntil(
  provider: AccessProviderDescriptor,
  browserOptions?: BrowserExecutionOptions,
) {
  if (browserOptions?.waitUntil !== undefined) {
    return browserOptions.waitUntil;
  }

  return provider.capabilities.browserDefaults?.waitUntil ?? "domcontentloaded";
}

function shouldEnableBrowserFallbackByDefault(
  execution: AccessProgramSpecializationInput["execution"],
) {
  return (
    execution?.mode === undefined &&
    execution?.providerId === undefined &&
    execution?.http === undefined
  );
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

function makeFallbackEdges(browserProviders: ReadonlyArray<AccessProviderDescriptor>) {
  if (browserProviders.length === 0) {
    return [] as const;
  }

  return [
    {
      edgeId: "browser-on-access-wall",
      kind: "browser-on-access-wall",
      fromMode: "http",
      toMode: "browser",
    } satisfies AccessProgramFallbackEdge,
  ] as const;
}

function buildPrograms(input: {
  readonly providers: ReadonlyArray<AccessProviderDescriptor>;
  readonly providerIdsByMode: Readonly<{
    readonly http: ReadonlyArray<string>;
    readonly browser: ReadonlyArray<string>;
  }>;
  readonly egressProfileIds: ReadonlyArray<string>;
  readonly identityProfileIds: ReadonlyArray<string>;
}) {
  const shared = {
    candidateProviderIdsByMode: input.providerIdsByMode,
    egressProfileIds: input.egressProfileIds,
    identityProfileIds: input.identityProfileIds,
    scoringDimensions: [
      "selection-health",
      "profile-health",
      "lease-availability",
      "host-load",
    ] as const,
  };
  const fallbackEdges = makeFallbackEdges(
    input.providers.filter((provider) => provider.capabilities.mode === "browser"),
  );

  return [
    {
      programId: "access-preview",
      command: "access",
      defaultMode: "http",
      fallbackEdges,
      ...shared,
    },
    {
      programId: "render-preview",
      command: "render",
      defaultMode: "browser",
      fallbackEdges: [] as const,
      ...shared,
    },
    {
      programId: "extract-run",
      command: "extract",
      defaultMode: "http",
      fallbackEdges,
      ...shared,
    },
  ] satisfies ReadonlyArray<ParameterizedAccessProgram>;
}

function httpExecutionFromIdentity(
  execution: AccessProgramSpecializationInput["execution"],
  identity: { readonly httpUserAgent?: string | undefined },
): ResolvedHttpExecution | undefined {
  const userAgent = execution?.http?.userAgent ?? identity.httpUserAgent;
  return userAgent === undefined ? undefined : { userAgent };
}

function browserExecutionFromIdentity(input: {
  readonly provider: AccessProviderDescriptor;
  readonly defaultTimeoutMs: number;
  readonly execution?: AccessProgramSpecializationInput["execution"];
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
      input.provider.capabilities.browserDefaults?.runtimeProfileId ??
      DEFAULT_PATCHRIGHT_BROWSER_RUNTIME_PROFILE_ID,
    waitUntil: resolveBrowserProviderWaitUntil(input.provider, browserOptions),
    timeoutMs: browserTimeoutMs,
    ...(browserUserAgent === undefined ? {} : { userAgent: browserUserAgent }),
  };
}

function dedupeWarnings(...inputs: ReadonlyArray<ReadonlyArray<string>>) {
  return [...new Set(inputs.flatMap((warnings) => warnings))];
}

export class AccessProgramLinker extends ServiceMap.Service<
  AccessProgramLinker,
  {
    readonly inspectIr: () => Effect.Effect<CanonicalAccessIr, never>;
    readonly listPrograms: () => Effect.Effect<ReadonlyArray<LinkedAccessProgram>, never>;
    readonly specialize: (input: AccessProgramSpecializationInput) => Effect.Effect<
      {
        readonly ir: CanonicalAccessIr;
        readonly program: ParameterizedAccessProgram;
        readonly intent: ResolvedExecutionPlan;
        readonly trace: AccessProgramDecisionTrace;
      },
      InvalidInputError
    >;
  }
>()("@effect-scrapling/sdk/AccessProgramLinker") {}

export const AccessProgramLinkerLive = Layer.effect(
  AccessProgramLinker,
  Effect.gen(function* () {
    const moduleRegistry = yield* AccessModuleRegistry;
    const providerRegistry = yield* AccessProviderRegistry;
    const profileRegistry = yield* AccessProfileRegistry;
    const selectionPolicy = yield* AccessSelectionPolicy;
    const profileSelectionPolicy = yield* AccessProfileSelectionPolicy;
    const modules = yield* moduleRegistry.listModules();
    const providers = yield* providerRegistry.listDescriptors();
    const egressProfiles = yield* profileRegistry.listEgressProfiles();
    const identityProfiles = yield* profileRegistry.listIdentityProfiles();
    const providerIdsByMode = {
      http: providers
        .filter((provider) => provider.capabilities.mode === "http")
        .map((provider) => provider.id)
        .sort(),
      browser: providers
        .filter((provider) => provider.capabilities.mode === "browser")
        .map((provider) => provider.id)
        .sort(),
    } as const;
    const programs = buildPrograms({
      providers,
      providerIdsByMode,
      egressProfileIds: egressProfiles.map((profile) => profile.profileId).sort(),
      identityProfileIds: identityProfiles.map((profile) => profile.profileId).sort(),
    });
    const canonicalIr = buildCanonicalAccessIr({
      modules,
      providers,
      egressProfiles,
      identityProfiles,
      programs,
    });

    const linkedPrograms = canonicalIr.programs.map((program) => ({
      ir: canonicalIr,
      program,
    })) satisfies ReadonlyArray<LinkedAccessProgram>;

    return {
      inspectIr: () => Effect.succeed(canonicalIr),
      listPrograms: () => Effect.succeed(linkedPrograms),
      specialize: (input) =>
        Effect.gen(function* () {
          const program = canonicalIr.programs.find(
            (candidate) => candidate.command === input.command,
          );
          if (program === undefined) {
            return yield* Effect.fail(
              invalidExecution(
                "Unknown access program",
                `No linked access program is registered for command "${input.command}".`,
              ),
            );
          }
          const resolveIntent = ({
            defaultProviderId,
            defaultMode,
            execution,
          }: {
            readonly defaultProviderId: string;
            readonly defaultMode: "http" | "browser";
            readonly execution: AccessProgramSpecializationInput["execution"];
          }) =>
            Effect.gen(function* () {
              const selection = yield* selectionPolicy.resolveSelection({
                url: input.url,
                defaultProviderId,
                defaultMode,
                allowUnregisteredDefaultProviderFallback:
                  input.allowUnregisteredDefaultProviderFallback,
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
                intent: {
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
                          provider: providerDescriptor,
                          defaultTimeoutMs: input.defaultTimeoutMs,
                          execution,
                          identity: profiles.identity,
                        }),
                      }),
                  warnings,
                } satisfies ResolvedExecutionPlan,
                trace: {
                  selectedProviderId: providerId,
                  selectedMode: mode,
                  candidateProviderIds,
                  rejectedProviderIds: candidateProviderIds.filter(
                    (candidate) => candidate !== providerId,
                  ),
                },
              } as const;
            });

          const baseResolution = yield* resolveIntent({
            defaultProviderId: input.defaultProviderId,
            defaultMode: program.defaultMode,
            execution: input.execution,
          });
          const baseIntent = baseResolution.intent;

          const browserFallbackEdge = program.fallbackEdges.find(
            (edge) => edge.kind === "browser-on-access-wall",
          );
          const browserFallbackEnabled =
            input.execution?.fallback?.browserOnAccessWall ??
            shouldEnableBrowserFallbackByDefault(input.execution);
          const fallbackIntent: ResolvedExecutionPlan["fallback"] | undefined =
            baseIntent.mode === "http" &&
            browserFallbackEnabled &&
            browserFallbackEdge !== undefined
              ? {
                  browserOnAccessWall: yield* Effect.gen(function* () {
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
                    const fallbackResolution = yield* resolveIntent({
                      defaultProviderId: input.defaultProviderId,
                      defaultMode: browserFallbackEdge.toMode,
                      execution: fallbackExecution,
                    });
                    if (fallbackResolution.intent.mode !== "browser") {
                      return yield* Effect.fail(
                        invalidExecution(
                          "Browser fallback resolved an incompatible provider",
                          `Fallback edge "${browserFallbackEdge.edgeId}" resolved mode "${fallbackResolution.intent.mode}" instead of "browser".`,
                        ),
                      );
                    }
                    const fallbackBrowser =
                      "browser" in fallbackResolution.intent
                        ? fallbackResolution.intent.browser
                        : undefined;
                    if (fallbackBrowser === undefined) {
                      return yield* Effect.fail(
                        invalidExecution(
                          "Browser fallback did not materialize browser execution settings",
                          `Fallback edge "${browserFallbackEdge.edgeId}" produced provider "${fallbackResolution.intent.providerId}" without browser launch settings.`,
                        ),
                      );
                    }

                    const fallbackBrowserIntent: ResolvedBrowserFallbackExecution = {
                      targetUrl: fallbackResolution.intent.targetUrl,
                      targetDomain: fallbackResolution.intent.targetDomain,
                      providerId: fallbackResolution.intent.providerId,
                      mode: "browser",
                      timeoutMs: fallbackResolution.intent.timeoutMs,
                      egress: fallbackResolution.intent.egress,
                      identity: fallbackResolution.intent.identity,
                      browser: fallbackBrowser,
                      warnings: dedupeWarnings(
                        fallbackResolution.intent.warnings,
                        baseIntent.warnings,
                      ),
                    };

                    return fallbackBrowserIntent;
                  }),
                }
              : undefined;

          return {
            ir: canonicalIr,
            program,
            intent:
              fallbackIntent === undefined
                ? baseIntent
                : ({
                    ...baseIntent,
                    fallback: fallbackIntent,
                  } satisfies ResolvedExecutionPlan),
            trace: {
              programId: program.programId,
              command: program.command,
              selectedProviderId: baseResolution.trace.selectedProviderId,
              selectedMode: baseResolution.trace.selectedMode,
              candidateProviderIds: baseResolution.trace.candidateProviderIds,
              rejectedProviderIds: baseResolution.trace.rejectedProviderIds,
              appliedFallbackEdgeIds:
                fallbackIntent === undefined ? [] : [browserFallbackEdge!.edgeId],
              scoringDimensions: [...program.scoringDimensions],
            } satisfies AccessProgramDecisionTrace,
          };
        }),
    } satisfies AccessProgramLinker["Service"];
  }),
);
