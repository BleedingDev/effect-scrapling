import { Effect, Layer, ServiceMap } from "effect";
import {
  BUILTIN_DEFAULT_IDENTITY_PLUGIN_ID,
  BUILTIN_DIRECT_EGRESS_PLUGIN_ID,
  BUILTIN_HTTP_CONNECT_EGRESS_PLUGIN_ID,
  BUILTIN_LEASED_EGRESS_PLUGIN_ID,
  BUILTIN_LEASED_IDENTITY_PLUGIN_ID,
  BUILTIN_POOL_SERVER_EGRESS_PLUGIN_ID,
  BUILTIN_SOCKS5_EGRESS_PLUGIN_ID,
  BUILTIN_STEALTH_IDENTITY_PLUGIN_ID,
  BUILTIN_TOR_EGRESS_PLUGIN_ID,
  BUILTIN_WIREGUARD_EGRESS_PLUGIN_ID,
} from "./access-allocation-plugin-ids.ts";
import { parseProxyUrl, type AccessEgressRouteConfig } from "./egress-route-config.ts";
import { InvalidInputError } from "./errors.ts";
import {
  type AccessProfileSelector,
  type AccessExecutionMetadata,
  type AccessProviderId,
  type BrowserRuntimeProfileId,
} from "./schemas.ts";

export const DEFAULT_EGRESS_PROFILE_ID = "direct";
export const DEFAULT_LEASED_EGRESS_PROFILE_ID = "leased-direct";
export const DEFAULT_WIREGUARD_EGRESS_PROFILE_ID = "wireguard";
export const DEFAULT_HTTP_CONNECT_EGRESS_PROFILE_ID = "http-connect";
export const DEFAULT_SOCKS5_EGRESS_PROFILE_ID = "socks5";
export const DEFAULT_TOR_EGRESS_PROFILE_ID = "tor";
export const DEFAULT_POOL_SERVER_EGRESS_PROFILE_ID = "pool-server";
export const DEFAULT_IDENTITY_PROFILE_ID = "default";
export const DEFAULT_LEASED_IDENTITY_PROFILE_ID = "leased-default";
export const DEFAULT_STEALTH_IDENTITY_PROFILE_ID = "stealth-default";
export const DEFAULT_LEASED_STEALTH_IDENTITY_PROFILE_ID = "leased-stealth-default";
export const DEFAULT_PATCHRIGHT_BROWSER_RUNTIME_PROFILE_ID = "patchright-default";
export const DEFAULT_PATCHRIGHT_STEALTH_RUNTIME_PROFILE_ID = "patchright-stealth";

export type ResolvedEgressProfile = {
  readonly allocationMode: "static" | "leased";
  readonly pluginId: string;
  readonly pluginConfig?: unknown;
  readonly profileId: string;
  readonly poolId: string;
  readonly routePolicyId: string;
  readonly routeKind: AccessExecutionMetadata["egressRouteKind"];
  readonly routeKey: string;
  readonly routeConfig?: AccessEgressRouteConfig | undefined;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly warnings: ReadonlyArray<string>;
  readonly autoSelectionConstraint?:
    | {
        readonly requiredPluginConfigKeys?: ReadonlyArray<string> | undefined;
      }
    | undefined;
};

export type ResolvedIdentityProfile = {
  readonly allocationMode: "static" | "leased";
  readonly pluginId: string;
  readonly pluginConfig?: unknown;
  readonly profileId: string;
  readonly tenantId: string;
  readonly browserRuntimeProfileId: BrowserRuntimeProfileId;
  readonly httpUserAgent?: string | undefined;
  readonly browserUserAgent?: string | undefined;
  readonly locale?: string | undefined;
  readonly timezoneId?: string | undefined;
  readonly warnings: ReadonlyArray<string>;
};

export type AccessEgressProfileDescriptor = ResolvedEgressProfile;
export type AccessIdentityProfileDescriptor = ResolvedIdentityProfile;
export type ResolvedEgressProfileAutoSelectionEligibility = {
  readonly autoSelectable: boolean;
  readonly reason?: string | undefined;
};

function invalidProfile(message: string, details?: string) {
  return new InvalidInputError({
    message,
    ...(details === undefined ? {} : { details }),
  });
}

const builtinEgressProfiles = Object.freeze({
  [DEFAULT_EGRESS_PROFILE_ID]: {
    allocationMode: "static",
    pluginId: BUILTIN_DIRECT_EGRESS_PLUGIN_ID,
    profileId: DEFAULT_EGRESS_PROFILE_ID,
    poolId: "direct-pool",
    routePolicyId: "direct-route",
    routeKind: "direct" as const,
    routeKey: "direct",
    routeConfig: {
      kind: "direct",
    },
    requestHeaders: {},
    warnings: [],
  },
  [DEFAULT_LEASED_EGRESS_PROFILE_ID]: {
    allocationMode: "leased",
    pluginId: BUILTIN_LEASED_EGRESS_PLUGIN_ID,
    profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
    poolId: "leased-direct-pool",
    routePolicyId: "leased-direct-route",
    routeKind: "direct" as const,
    routeKey: "leased-direct",
    routeConfig: {
      kind: "direct",
    },
    requestHeaders: {},
    warnings: [],
  },
  [DEFAULT_WIREGUARD_EGRESS_PROFILE_ID]: {
    allocationMode: "static",
    pluginId: BUILTIN_WIREGUARD_EGRESS_PLUGIN_ID,
    profileId: DEFAULT_WIREGUARD_EGRESS_PROFILE_ID,
    poolId: "wireguard-pool",
    routePolicyId: "wireguard-route",
    routeKind: "wireguard" as const,
    routeKey: "wireguard",
    routeConfig: {
      kind: "wireguard",
    },
    requestHeaders: {},
    warnings: [],
  },
  [DEFAULT_HTTP_CONNECT_EGRESS_PROFILE_ID]: {
    allocationMode: "static",
    pluginId: BUILTIN_HTTP_CONNECT_EGRESS_PLUGIN_ID,
    profileId: DEFAULT_HTTP_CONNECT_EGRESS_PROFILE_ID,
    poolId: "http-connect-pool",
    routePolicyId: "http-connect-route",
    routeKind: "http-connect" as const,
    routeKey: "http-connect",
    routeConfig: {
      kind: "http-connect",
    },
    requestHeaders: {},
    warnings: [],
    autoSelectionConstraint: {
      requiredPluginConfigKeys: ["proxyUrl"],
    },
  },
  [DEFAULT_SOCKS5_EGRESS_PROFILE_ID]: {
    allocationMode: "static",
    pluginId: BUILTIN_SOCKS5_EGRESS_PLUGIN_ID,
    profileId: DEFAULT_SOCKS5_EGRESS_PROFILE_ID,
    poolId: "socks5-pool",
    routePolicyId: "socks5-route",
    routeKind: "socks5" as const,
    routeKey: "socks5",
    routeConfig: {
      kind: "socks5",
    },
    requestHeaders: {},
    warnings: [],
    autoSelectionConstraint: {
      requiredPluginConfigKeys: ["proxyUrl"],
    },
  },
  [DEFAULT_TOR_EGRESS_PROFILE_ID]: {
    allocationMode: "static",
    pluginId: BUILTIN_TOR_EGRESS_PLUGIN_ID,
    profileId: DEFAULT_TOR_EGRESS_PROFILE_ID,
    poolId: "tor-pool",
    routePolicyId: "tor-route",
    routeKind: "tor" as const,
    routeKey: "tor",
    routeConfig: {
      kind: "tor",
    },
    requestHeaders: {},
    warnings: [],
    autoSelectionConstraint: {
      requiredPluginConfigKeys: ["proxyUrl"],
    },
  },
  [DEFAULT_POOL_SERVER_EGRESS_PROFILE_ID]: {
    allocationMode: "static",
    pluginId: BUILTIN_POOL_SERVER_EGRESS_PLUGIN_ID,
    profileId: DEFAULT_POOL_SERVER_EGRESS_PROFILE_ID,
    poolId: "pool-server-pool",
    routePolicyId: "pool-server-route",
    routeKind: "pool-server" as const,
    routeKey: "pool-server",
    routeConfig: {
      kind: "pool-server",
    },
    requestHeaders: {},
    warnings: [],
    autoSelectionConstraint: {
      requiredPluginConfigKeys: ["proxyUrl"],
    },
  },
} satisfies Readonly<Record<string, ResolvedEgressProfile>>);

const builtinIdentityProfiles = Object.freeze({
  [DEFAULT_IDENTITY_PROFILE_ID]: {
    allocationMode: "static",
    pluginId: BUILTIN_DEFAULT_IDENTITY_PLUGIN_ID,
    profileId: DEFAULT_IDENTITY_PROFILE_ID,
    tenantId: "public",
    browserRuntimeProfileId:
      DEFAULT_PATCHRIGHT_BROWSER_RUNTIME_PROFILE_ID satisfies BrowserRuntimeProfileId,
    httpUserAgent: "effect-scrapling/0.0.1",
    browserUserAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    locale: undefined,
    timezoneId: undefined,
    warnings: [],
  },
  [DEFAULT_LEASED_IDENTITY_PROFILE_ID]: {
    allocationMode: "leased",
    pluginId: BUILTIN_LEASED_IDENTITY_PLUGIN_ID,
    profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
    tenantId: "public",
    browserRuntimeProfileId:
      DEFAULT_PATCHRIGHT_BROWSER_RUNTIME_PROFILE_ID satisfies BrowserRuntimeProfileId,
    httpUserAgent: "effect-scrapling/0.0.1",
    browserUserAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    locale: undefined,
    timezoneId: undefined,
    warnings: [],
  },
  [DEFAULT_STEALTH_IDENTITY_PROFILE_ID]: {
    allocationMode: "static",
    pluginId: BUILTIN_STEALTH_IDENTITY_PLUGIN_ID,
    profileId: DEFAULT_STEALTH_IDENTITY_PROFILE_ID,
    tenantId: "public",
    browserRuntimeProfileId:
      DEFAULT_PATCHRIGHT_STEALTH_RUNTIME_PROFILE_ID satisfies BrowserRuntimeProfileId,
    httpUserAgent: undefined,
    browserUserAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    locale: undefined,
    timezoneId: undefined,
    warnings: [],
  },
  [DEFAULT_LEASED_STEALTH_IDENTITY_PROFILE_ID]: {
    allocationMode: "leased",
    pluginId: BUILTIN_LEASED_IDENTITY_PLUGIN_ID,
    profileId: DEFAULT_LEASED_STEALTH_IDENTITY_PROFILE_ID,
    tenantId: "public",
    browserRuntimeProfileId:
      DEFAULT_PATCHRIGHT_STEALTH_RUNTIME_PROFILE_ID satisfies BrowserRuntimeProfileId,
    httpUserAgent: undefined,
    browserUserAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    locale: undefined,
    timezoneId: undefined,
    warnings: [],
  },
} satisfies Readonly<Record<string, ResolvedIdentityProfile>>);

export function defaultIdentityProfileIdForProvider(providerId: AccessProviderId) {
  return providerId === "browser-stealth"
    ? DEFAULT_STEALTH_IDENTITY_PROFILE_ID
    : DEFAULT_IDENTITY_PROFILE_ID;
}

export class AccessProfileRegistry extends ServiceMap.Service<
  AccessProfileRegistry,
  {
    readonly findEgressProfile: (
      profileId: string,
    ) => Effect.Effect<ResolvedEgressProfile | undefined, never>;
    readonly findIdentityProfile: (
      profileId: string,
    ) => Effect.Effect<ResolvedIdentityProfile | undefined, never>;
    readonly listEgressProfiles: () => Effect.Effect<ReadonlyArray<ResolvedEgressProfile>, never>;
    readonly listIdentityProfiles: () => Effect.Effect<
      ReadonlyArray<ResolvedIdentityProfile>,
      never
    >;
    readonly resolveEgressProfile: (
      selector?: AccessProfileSelector | undefined,
    ) => Effect.Effect<ResolvedEgressProfile, InvalidInputError>;
    readonly resolveIdentityProfile: (input: {
      readonly selector?: AccessProfileSelector | undefined;
      readonly providerId: AccessProviderId;
    }) => Effect.Effect<ResolvedIdentityProfile, InvalidInputError>;
  }
>()("@effect-scrapling/sdk/AccessProfileRegistry") {}

function applySelectorConfigOverride<Profile extends { readonly pluginConfig?: unknown }>(
  profile: Profile,
  selector?: AccessProfileSelector | undefined,
): Profile {
  return selector?.pluginConfig === undefined
    ? profile
    : ({
        ...profile,
        pluginConfig: selector.pluginConfig,
      } satisfies Profile);
}

function readProxyRouteConfigValue(profile: ResolvedEgressProfile) {
  const routeConfig = profile.routeConfig;
  if (routeConfig === undefined) {
    return undefined;
  }

  return typeof routeConfig.proxyUrl === "string" && routeConfig.proxyUrl.trim().length > 0
    ? routeConfig.proxyUrl.trim()
    : undefined;
}

function readProxyPluginConfigValue(profile: ResolvedEgressProfile) {
  const pluginConfig = profile.pluginConfig;
  if (typeof pluginConfig !== "object" || pluginConfig === null || Array.isArray(pluginConfig)) {
    return undefined;
  }

  const proxyUrl = (pluginConfig as Record<string, unknown>).proxyUrl;
  return typeof proxyUrl === "string" && proxyUrl.trim().length > 0 ? proxyUrl.trim() : undefined;
}

function isUsableAbsoluteProxyUrl(proxyUrl: string | undefined) {
  if (proxyUrl === undefined) {
    return false;
  }

  try {
    parseProxyUrl(proxyUrl);
    return true;
  } catch {
    return false;
  }
}

export function describeResolvedEgressProfileAutoSelectionEligibility(
  profile: ResolvedEgressProfile,
): ResolvedEgressProfileAutoSelectionEligibility {
  const requiredPluginConfigKeys = profile.autoSelectionConstraint?.requiredPluginConfigKeys ?? [];
  if (requiredPluginConfigKeys.length === 0) {
    return {
      autoSelectable: true,
    };
  }

  const configuredPluginConfigValues = Object.fromEntries(
    requiredPluginConfigKeys.map((key) => [
      key,
      key === "proxyUrl"
        ? (readProxyRouteConfigValue(profile) ?? readProxyPluginConfigValue(profile))
        : undefined,
    ]),
  ) as Readonly<Record<string, string | undefined>>;
  const missingRequiredKey = requiredPluginConfigKeys.find((key) => {
    if (key === "proxyUrl") {
      return !isUsableAbsoluteProxyUrl(configuredPluginConfigValues[key]);
    }

    const pluginConfig = profile.pluginConfig;
    if (typeof pluginConfig !== "object" || pluginConfig === null || Array.isArray(pluginConfig)) {
      return true;
    }

    const value = (pluginConfig as Record<string, unknown>)[key];
    return typeof value !== "string" || value.trim().length === 0;
  });
  if (missingRequiredKey === undefined) {
    return {
      autoSelectable: true,
    };
  }

  return {
    autoSelectable: false,
    reason: `Egress profile "${profile.profileId}" requires explicit plugin config "${missingRequiredKey}" before it can be used.`,
  };
}

function ensureResolvedEgressProfileUsable(profile: ResolvedEgressProfile) {
  const eligibility = describeResolvedEgressProfileAutoSelectionEligibility(profile);
  if (eligibility.autoSelectable) {
    return Effect.succeed(profile);
  }

  return Effect.fail(invalidProfile("Invalid egress profile configuration", eligibility.reason));
}

export function makeStaticAccessProfileRegistry(input?: {
  readonly egressProfiles?: Readonly<Record<string, ResolvedEgressProfile>> | undefined;
  readonly identityProfiles?: Readonly<Record<string, ResolvedIdentityProfile>> | undefined;
}) {
  const egressProfiles: Readonly<Record<string, ResolvedEgressProfile>> =
    input?.egressProfiles ?? builtinEgressProfiles;
  const identityProfiles: Readonly<Record<string, ResolvedIdentityProfile>> =
    input?.identityProfiles ?? builtinIdentityProfiles;

  return {
    findEgressProfile: (profileId: string) => Effect.succeed(egressProfiles[profileId]),
    findIdentityProfile: (profileId: string) => Effect.succeed(identityProfiles[profileId]),
    listEgressProfiles: () => Effect.succeed(Object.values(egressProfiles)),
    listIdentityProfiles: () => Effect.succeed(Object.values(identityProfiles)),
    resolveEgressProfile: (selector?: AccessProfileSelector | undefined) => {
      const resolvedProfileId = selector?.profileId ?? DEFAULT_EGRESS_PROFILE_ID;
      const profile = egressProfiles[resolvedProfileId];
      if (profile === undefined) {
        return Effect.fail(
          invalidProfile("Unknown egress profile", `No egress profile named ${resolvedProfileId}.`),
        );
      }

      return Effect.succeed(applySelectorConfigOverride(profile, selector)).pipe(
        Effect.flatMap(ensureResolvedEgressProfileUsable),
      );
    },
    resolveIdentityProfile: ({
      selector,
      providerId,
    }: {
      readonly selector?: AccessProfileSelector | undefined;
      readonly providerId: AccessProviderId;
    }) => {
      const resolvedProfileId =
        selector?.profileId ?? defaultIdentityProfileIdForProvider(providerId);
      const profile = identityProfiles[resolvedProfileId];
      if (profile === undefined) {
        return Effect.fail(
          invalidProfile(
            "Unknown identity profile",
            `No identity profile named ${resolvedProfileId}.`,
          ),
        );
      }

      return Effect.succeed(applySelectorConfigOverride(profile, selector));
    },
  } satisfies {
    readonly findEgressProfile: (
      profileId: string,
    ) => Effect.Effect<ResolvedEgressProfile | undefined, never>;
    readonly findIdentityProfile: (
      profileId: string,
    ) => Effect.Effect<ResolvedIdentityProfile | undefined, never>;
    readonly listEgressProfiles: () => Effect.Effect<ReadonlyArray<ResolvedEgressProfile>, never>;
    readonly listIdentityProfiles: () => Effect.Effect<
      ReadonlyArray<ResolvedIdentityProfile>,
      never
    >;
    readonly resolveEgressProfile: (
      selector?: AccessProfileSelector | undefined,
    ) => Effect.Effect<ResolvedEgressProfile, InvalidInputError>;
    readonly resolveIdentityProfile: (input: {
      readonly selector?: AccessProfileSelector | undefined;
      readonly providerId: AccessProviderId;
    }) => Effect.Effect<ResolvedIdentityProfile, InvalidInputError>;
  };
}

export const AccessProfileRegistryLive = Layer.succeed(
  AccessProfileRegistry,
  makeStaticAccessProfileRegistry(),
);
