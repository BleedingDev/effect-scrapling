import { Effect, Layer, ServiceMap } from "effect";
import { InvalidInputError } from "./errors.ts";
import {
  DEFAULT_BROWSER_WAIT_UNTIL,
  type AccessExecutionMetadata,
  type AccessExecutionProfile,
  type AccessProviderId,
  type BrowserExecutionOptions,
  type BrowserRuntimeProfileId,
  type BrowserWaitUntil,
} from "./schemas.ts";

export const DEFAULT_EGRESS_PROFILE_ID = "direct";
export const DEFAULT_IDENTITY_PROFILE_ID = "default";
export const DEFAULT_STEALTH_IDENTITY_PROFILE_ID = "stealth-default";
export const DEFAULT_PATCHRIGHT_BROWSER_RUNTIME_PROFILE_ID = "patchright-default";
export const DEFAULT_PATCHRIGHT_STEALTH_RUNTIME_PROFILE_ID = "patchright-stealth";
export const DEFAULT_HTTP_PROVIDER_ID = "http-basic";
export const DEFAULT_BROWSER_PROVIDER_ID = "browser-basic";
export const DEFAULT_STEALTH_BROWSER_PROVIDER_ID = "browser-stealth";

export type ResolvedEgressProfile = {
  readonly pluginId: string;
  readonly profileId: string;
  readonly routeKind: AccessExecutionMetadata["egressRouteKind"];
  readonly routeKey: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly warnings: ReadonlyArray<string>;
};

export type ResolvedIdentityProfile = {
  readonly pluginId: string;
  readonly profileId: string;
  readonly browserRuntimeProfileId: BrowserRuntimeProfileId;
  readonly httpUserAgent?: string | undefined;
  readonly browserUserAgent?: string | undefined;
  readonly locale?: string | undefined;
  readonly timezoneId?: string | undefined;
  readonly warnings: ReadonlyArray<string>;
};

export type ResolvedHttpExecution = {
  readonly userAgent?: string | undefined;
};

export type ResolvedBrowserExecution = {
  readonly runtimeProfileId: BrowserRuntimeProfileId;
  readonly waitUntil: BrowserWaitUntil;
  readonly timeoutMs: number;
  readonly userAgent?: string | undefined;
  readonly poolKey: string;
};

export type ResolvedExecutionPlan = {
  readonly providerId: AccessProviderId;
  readonly mode: AccessExecutionMetadata["mode"];
  readonly timeoutMs: number;
  readonly egress: ResolvedEgressProfile;
  readonly identity: ResolvedIdentityProfile;
  readonly http?: ResolvedHttpExecution | undefined;
  readonly browser?: ResolvedBrowserExecution | undefined;
  readonly warnings: ReadonlyArray<string>;
};

export type AccessExecutionInput = {
  readonly defaultTimeoutMs: number;
  readonly execution?: AccessExecutionProfile | undefined;
  readonly defaultProviderId: AccessProviderId;
};

type StaticEgressProfile = Omit<ResolvedEgressProfile, "profileId"> & {
  readonly profileId?: string;
};

type StaticIdentityProfile = Omit<ResolvedIdentityProfile, "profileId"> & {
  readonly profileId?: string;
};

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
    : DEFAULT_BROWSER_WAIT_UNTIL;
}

function resolveProviderId(input: AccessExecutionInput): AccessProviderId {
  if (input.execution?.providerId !== undefined) {
    return input.execution.providerId;
  }

  return input.defaultProviderId;
}

function resolveIdentityProfileId(input: AccessExecutionInput, providerId: AccessProviderId) {
  if (input.execution?.identityProfileId !== undefined) {
    return input.execution.identityProfileId;
  }

  return providerId === DEFAULT_STEALTH_BROWSER_PROVIDER_ID
    ? DEFAULT_STEALTH_IDENTITY_PROFILE_ID
    : DEFAULT_IDENTITY_PROFILE_ID;
}

function makeBrowserPoolKey(input: {
  readonly providerId: AccessProviderId;
  readonly runtimeProfileId: BrowserRuntimeProfileId;
  readonly egressRouteKey: string;
  readonly identityProfileId: string;
}) {
  return [
    input.providerId,
    input.runtimeProfileId,
    input.egressRouteKey,
    input.identityProfileId,
  ].join("::");
}

export function toExecutionMetadata(plan: ResolvedExecutionPlan): AccessExecutionMetadata {
  return {
    providerId: plan.providerId,
    mode: plan.mode,
    egressProfileId: plan.egress.profileId,
    egressPluginId: plan.egress.pluginId,
    egressRouteKind: plan.egress.routeKind,
    egressRouteKey: plan.egress.routeKey,
    identityProfileId: plan.identity.profileId,
    identityPluginId: plan.identity.pluginId,
    ...(plan.browser === undefined
      ? {}
      : { browserRuntimeProfileId: plan.browser.runtimeProfileId }),
  };
}

export class EgressProfileRegistry extends ServiceMap.Service<
  EgressProfileRegistry,
  {
    readonly resolve: (
      profileId: string | undefined,
    ) => Effect.Effect<ResolvedEgressProfile, InvalidInputError>;
  }
>()("@effect-scrapling/sdk/EgressProfileRegistry") {}

export class IdentityProfileRegistry extends ServiceMap.Service<
  IdentityProfileRegistry,
  {
    readonly resolve: (
      profileId: string | undefined,
    ) => Effect.Effect<ResolvedIdentityProfile, InvalidInputError>;
  }
>()("@effect-scrapling/sdk/IdentityProfileRegistry") {}

export class AccessExecutionRuntime extends ServiceMap.Service<
  AccessExecutionRuntime,
  {
    readonly resolve: (
      input: AccessExecutionInput,
    ) => Effect.Effect<ResolvedExecutionPlan, InvalidInputError>;
  }
>()("@effect-scrapling/sdk/AccessExecutionRuntime") {}

export function makeStaticEgressProfileRegistry(
  profiles: Readonly<Record<string, StaticEgressProfile>>,
): {
  readonly resolve: (
    profileId: string | undefined,
  ) => Effect.Effect<ResolvedEgressProfile, InvalidInputError>;
} {
  return {
    resolve: (profileId) =>
      Effect.gen(function* () {
        const resolvedProfileId = profileId ?? DEFAULT_EGRESS_PROFILE_ID;
        const profile = profiles[resolvedProfileId];
        if (profile === undefined) {
          return yield* Effect.fail(
            invalidExecution(
              "Unknown egress profile",
              `No egress profile named ${resolvedProfileId}.`,
            ),
          );
        }

        return {
          ...profile,
          profileId: profile.profileId ?? resolvedProfileId,
        };
      }),
  };
}

export function makeStaticIdentityProfileRegistry(
  profiles: Readonly<Record<string, StaticIdentityProfile>>,
): {
  readonly resolve: (
    profileId: string | undefined,
  ) => Effect.Effect<ResolvedIdentityProfile, InvalidInputError>;
} {
  return {
    resolve: (profileId) =>
      Effect.gen(function* () {
        const resolvedProfileId = profileId ?? DEFAULT_IDENTITY_PROFILE_ID;
        const profile = profiles[resolvedProfileId];
        if (profile === undefined) {
          return yield* Effect.fail(
            invalidExecution(
              "Unknown identity profile",
              `No identity profile named ${resolvedProfileId}.`,
            ),
          );
        }

        return {
          ...profile,
          profileId: profile.profileId ?? resolvedProfileId,
        };
      }),
  };
}

const defaultEgressProfiles = Object.freeze({
  [DEFAULT_EGRESS_PROFILE_ID]: {
    pluginId: "builtin-direct-egress",
    routeKind: "direct" as const,
    routeKey: "direct",
    requestHeaders: {},
    warnings: [],
  },
});

const defaultIdentityProfiles = Object.freeze({
  [DEFAULT_IDENTITY_PROFILE_ID]: {
    pluginId: "builtin-default-identity",
    browserRuntimeProfileId:
      DEFAULT_PATCHRIGHT_BROWSER_RUNTIME_PROFILE_ID satisfies BrowserRuntimeProfileId,
    httpUserAgent: "effect-scrapling/0.0.1",
    browserUserAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    warnings: [],
  },
  [DEFAULT_STEALTH_IDENTITY_PROFILE_ID]: {
    pluginId: "builtin-stealth-identity",
    browserRuntimeProfileId:
      DEFAULT_PATCHRIGHT_STEALTH_RUNTIME_PROFILE_ID satisfies BrowserRuntimeProfileId,
    browserUserAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    warnings: [],
  },
});

export const EgressProfileRegistryLive = Layer.succeed(
  EgressProfileRegistry,
  makeStaticEgressProfileRegistry(defaultEgressProfiles),
);

export const IdentityProfileRegistryLive = Layer.succeed(
  IdentityProfileRegistry,
  makeStaticIdentityProfileRegistry(defaultIdentityProfiles),
);

export const AccessExecutionRuntimeLive = Layer.effect(
  AccessExecutionRuntime,
  Effect.gen(function* () {
    const egressProfiles = yield* EgressProfileRegistry;
    const identityProfiles = yield* IdentityProfileRegistry;

    return {
      resolve: (input: AccessExecutionInput) =>
        Effect.gen(function* () {
          const providerId = resolveProviderId(input);
          const egress = yield* egressProfiles.resolve(input.execution?.egressProfileId);
          const identity = yield* identityProfiles.resolve(
            resolveIdentityProfileId(input, providerId),
          );
          const warnings = [...egress.warnings, ...identity.warnings];

          if (providerId === "http-basic" || providerId === "http-impersonated") {
            const userAgent = input.execution?.http?.userAgent ?? identity.httpUserAgent;

            return {
              providerId,
              mode: "http" as const,
              timeoutMs: input.defaultTimeoutMs,
              egress,
              identity,
              ...(userAgent === undefined ? {} : { http: { userAgent } }),
              warnings,
            } satisfies ResolvedExecutionPlan;
          }

          const browserOptions = input.execution?.browser;
          const runtimeProfileId =
            input.execution?.browserRuntimeProfileId ??
            identity.browserRuntimeProfileId ??
            (providerId === DEFAULT_STEALTH_BROWSER_PROVIDER_ID
              ? DEFAULT_PATCHRIGHT_STEALTH_RUNTIME_PROFILE_ID
              : DEFAULT_PATCHRIGHT_BROWSER_RUNTIME_PROFILE_ID);
          const browserTimeoutMs = browserOptions?.timeoutMs ?? input.defaultTimeoutMs;
          const browserUserAgent = browserOptions?.userAgent ?? identity.browserUserAgent;

          return {
            providerId,
            mode: "browser" as const,
            timeoutMs: browserTimeoutMs,
            egress,
            identity,
            browser: {
              runtimeProfileId,
              waitUntil: resolveBrowserProviderWaitUntil(providerId, browserOptions),
              timeoutMs: browserTimeoutMs,
              ...(browserUserAgent === undefined ? {} : { userAgent: browserUserAgent }),
              poolKey: makeBrowserPoolKey({
                providerId,
                runtimeProfileId,
                egressRouteKey: egress.routeKey,
                identityProfileId: identity.profileId,
              }),
            },
            warnings,
          } satisfies ResolvedExecutionPlan;
        }),
    };
  }).pipe(Effect.provide(Layer.mergeAll(EgressProfileRegistryLive, IdentityProfileRegistryLive))),
);

export const resolveProvidedAccessExecutionRuntime = Effect.gen(function* () {
  return yield* AccessExecutionRuntime;
}).pipe(Effect.provide(AccessExecutionRuntimeLive));
