import { Effect, Layer } from "effect";
import {
  BUILTIN_DEFAULT_IDENTITY_PLUGIN_ID,
  BUILTIN_DIRECT_EGRESS_PLUGIN_ID,
  BUILTIN_HTTP_CONNECT_EGRESS_PLUGIN_ID,
  BUILTIN_POOL_SERVER_EGRESS_PLUGIN_ID,
  BUILTIN_SOCKS5_EGRESS_PLUGIN_ID,
  BUILTIN_STEALTH_IDENTITY_PLUGIN_ID,
  BUILTIN_TOR_EGRESS_PLUGIN_ID,
  BUILTIN_WIREGUARD_EGRESS_PLUGIN_ID,
  EgressLeaseManagerService,
  type EgressAllocationPlugin,
  IdentityLeaseManagerService,
  type IdentityAllocationPlugin,
  makeLeaseBackedEgressPlugin,
  makeLeaseBackedIdentityPlugin,
  makeProxyStaticEgressPlugin,
  makeStaticEgressPlugin,
  makeStaticIdentityPlugin,
  makeWireGuardEgressPlugin,
} from "./access-allocation-plugin-runtime.ts";
import {
  AccessModuleRegistry,
  makeStaticAccessModuleRegistry,
  type AccessRuntimeModule,
} from "./access-module-runtime.ts";
import {
  DEFAULT_BROWSER_PROVIDER_ID,
  DEFAULT_STEALTH_BROWSER_PROVIDER_ID,
} from "./access-provider-ids.ts";
import { makeBrowserAccessProvider, makeHttpAccessProvider } from "./access-provider-runtime.ts";
import {
  BrowserMediationRuntime,
  makeBrowserMediationService,
  type BrowserMediationService,
} from "./browser-mediation-runtime.ts";
import {
  DEFAULT_EGRESS_PROFILE_ID,
  DEFAULT_HTTP_CONNECT_EGRESS_PROFILE_ID,
  DEFAULT_IDENTITY_PROFILE_ID,
  DEFAULT_LEASED_EGRESS_PROFILE_ID,
  DEFAULT_LEASED_IDENTITY_PROFILE_ID,
  DEFAULT_LEASED_STEALTH_IDENTITY_PROFILE_ID,
  DEFAULT_POOL_SERVER_EGRESS_PROFILE_ID,
  DEFAULT_PATCHRIGHT_BROWSER_RUNTIME_PROFILE_ID,
  DEFAULT_PATCHRIGHT_STEALTH_RUNTIME_PROFILE_ID,
  DEFAULT_SOCKS5_EGRESS_PROFILE_ID,
  DEFAULT_STEALTH_IDENTITY_PROFILE_ID,
  DEFAULT_TOR_EGRESS_PROFILE_ID,
  DEFAULT_WIREGUARD_EGRESS_PROFILE_ID,
  type ResolvedEgressProfile,
  type ResolvedIdentityProfile,
} from "./access-profile-runtime.ts";

function createProxyProfile(input: {
  readonly pluginId: string;
  readonly profileId: string;
  readonly routeKind: string;
  readonly routeKey: string;
  readonly poolId: string;
  readonly routePolicyId: string;
}) {
  return {
    allocationMode: "static",
    pluginId: input.pluginId,
    profileId: input.profileId,
    poolId: input.poolId,
    routePolicyId: input.routePolicyId,
    routeKind: input.routeKind,
    routeKey: input.routeKey,
    routeConfig: {
      kind: input.routeKind,
    },
    requestHeaders: {},
    warnings: [],
    autoSelectionConstraint: {
      requiredPluginConfigKeys: ["proxyUrl"],
    },
  } satisfies ResolvedEgressProfile;
}

function createIdentityProfile(input: {
  readonly profileId: string;
  readonly pluginId: string;
  readonly browserRuntimeProfileId: string;
  readonly httpUserAgent?: string | undefined;
  readonly browserUserAgent?: string | undefined;
}) {
  return {
    allocationMode: input.profileId.startsWith("leased-") ? "leased" : "static",
    pluginId: input.pluginId,
    profileId: input.profileId,
    tenantId: "public",
    browserRuntimeProfileId: input.browserRuntimeProfileId,
    ...(input.httpUserAgent === undefined ? {} : { httpUserAgent: input.httpUserAgent }),
    ...(input.browserUserAgent === undefined ? {} : { browserUserAgent: input.browserUserAgent }),
    locale: undefined,
    timezoneId: undefined,
    warnings: [],
  } satisfies ResolvedIdentityProfile;
}

export const AccessCoreRuntimeModuleId = "builtin-access-core";
export const HttpConnectAccessRuntimeModuleId = "builtin-http-connect-access";
export const Socks5AccessRuntimeModuleId = "builtin-socks5-access";
export const PoolServerAccessRuntimeModuleId = "builtin-pool-server-access";
export const WireGuardAccessRuntimeModuleId = "builtin-wireguard-access";
export const TorAccessRuntimeModuleId = "builtin-tor-access";

export function makeAccessCoreRuntimeModule(input: {
  readonly leasedEgressPluginId: string;
  readonly leasedEgressPlugin: EgressAllocationPlugin<unknown>;
  readonly leasedIdentityPluginId: string;
  readonly leasedIdentityPlugin: IdentityAllocationPlugin<unknown>;
  readonly mediationRuntime?: BrowserMediationService | undefined;
}) {
  const mediationRuntime = input.mediationRuntime;
  return {
    id: AccessCoreRuntimeModuleId,
    providers: {
      "http-basic": makeHttpAccessProvider("http-basic"),
      "http-impersonated": makeHttpAccessProvider("http-impersonated"),
      [DEFAULT_BROWSER_PROVIDER_ID]: makeBrowserAccessProvider(
        DEFAULT_BROWSER_PROVIDER_ID,
        mediationRuntime ?? makeBrowserMediationService(),
      ),
      [DEFAULT_STEALTH_BROWSER_PROVIDER_ID]: makeBrowserAccessProvider(
        DEFAULT_STEALTH_BROWSER_PROVIDER_ID,
        mediationRuntime ?? makeBrowserMediationService(),
      ),
    },
    egressPlugins: {
      [BUILTIN_DIRECT_EGRESS_PLUGIN_ID]: makeStaticEgressPlugin(),
      [input.leasedEgressPluginId]: input.leasedEgressPlugin,
    },
    identityPlugins: {
      [BUILTIN_DEFAULT_IDENTITY_PLUGIN_ID]: makeStaticIdentityPlugin(
        BUILTIN_DEFAULT_IDENTITY_PLUGIN_ID,
      ),
      [BUILTIN_STEALTH_IDENTITY_PLUGIN_ID]: makeStaticIdentityPlugin(
        BUILTIN_STEALTH_IDENTITY_PLUGIN_ID,
      ),
      [input.leasedIdentityPluginId]: input.leasedIdentityPlugin,
    },
    egressProfiles: {
      [DEFAULT_EGRESS_PROFILE_ID]: {
        allocationMode: "static",
        pluginId: BUILTIN_DIRECT_EGRESS_PLUGIN_ID,
        profileId: DEFAULT_EGRESS_PROFILE_ID,
        poolId: "direct-pool",
        routePolicyId: "direct-route",
        routeKind: "direct",
        routeKey: "direct",
        routeConfig: {
          kind: "direct",
        },
        requestHeaders: {},
        warnings: [],
      },
      [DEFAULT_LEASED_EGRESS_PROFILE_ID]: {
        allocationMode: "leased",
        pluginId: input.leasedEgressPluginId,
        profileId: DEFAULT_LEASED_EGRESS_PROFILE_ID,
        poolId: "leased-direct-pool",
        routePolicyId: "leased-direct-route",
        routeKind: "direct",
        routeKey: "leased-direct",
        routeConfig: {
          kind: "direct",
        },
        requestHeaders: {},
        warnings: [],
      },
    },
    identityProfiles: {
      [DEFAULT_IDENTITY_PROFILE_ID]: createIdentityProfile({
        profileId: DEFAULT_IDENTITY_PROFILE_ID,
        pluginId: BUILTIN_DEFAULT_IDENTITY_PLUGIN_ID,
        browserRuntimeProfileId: DEFAULT_PATCHRIGHT_BROWSER_RUNTIME_PROFILE_ID,
        httpUserAgent: "effect-scrapling/0.0.1",
        browserUserAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      }),
      [DEFAULT_LEASED_IDENTITY_PROFILE_ID]: createIdentityProfile({
        profileId: DEFAULT_LEASED_IDENTITY_PROFILE_ID,
        pluginId: input.leasedIdentityPluginId,
        browserRuntimeProfileId: DEFAULT_PATCHRIGHT_BROWSER_RUNTIME_PROFILE_ID,
        httpUserAgent: "effect-scrapling/0.0.1",
        browserUserAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      }),
      [DEFAULT_STEALTH_IDENTITY_PROFILE_ID]: createIdentityProfile({
        profileId: DEFAULT_STEALTH_IDENTITY_PROFILE_ID,
        pluginId: BUILTIN_STEALTH_IDENTITY_PLUGIN_ID,
        browserRuntimeProfileId: DEFAULT_PATCHRIGHT_STEALTH_RUNTIME_PROFILE_ID,
        browserUserAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      }),
      [DEFAULT_LEASED_STEALTH_IDENTITY_PROFILE_ID]: createIdentityProfile({
        profileId: DEFAULT_LEASED_STEALTH_IDENTITY_PROFILE_ID,
        pluginId: input.leasedIdentityPluginId,
        browserRuntimeProfileId: DEFAULT_PATCHRIGHT_STEALTH_RUNTIME_PROFILE_ID,
        browserUserAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      }),
    },
  } satisfies AccessRuntimeModule;
}

export const HttpConnectAccessRuntimeModule = {
  id: HttpConnectAccessRuntimeModuleId,
  egressPlugins: {
    [BUILTIN_HTTP_CONNECT_EGRESS_PLUGIN_ID]: makeProxyStaticEgressPlugin({
      id: BUILTIN_HTTP_CONNECT_EGRESS_PLUGIN_ID,
      kind: "http-connect",
    }),
  },
  egressProfiles: {
    [DEFAULT_HTTP_CONNECT_EGRESS_PROFILE_ID]: createProxyProfile({
      pluginId: BUILTIN_HTTP_CONNECT_EGRESS_PLUGIN_ID,
      profileId: DEFAULT_HTTP_CONNECT_EGRESS_PROFILE_ID,
      routeKind: "http-connect",
      routeKey: "http-connect",
      poolId: "http-connect-pool",
      routePolicyId: "http-connect-route",
    }),
  },
} satisfies AccessRuntimeModule;

export const Socks5AccessRuntimeModule = {
  id: Socks5AccessRuntimeModuleId,
  egressPlugins: {
    [BUILTIN_SOCKS5_EGRESS_PLUGIN_ID]: makeProxyStaticEgressPlugin({
      id: BUILTIN_SOCKS5_EGRESS_PLUGIN_ID,
      kind: "socks5",
    }),
  },
  egressProfiles: {
    [DEFAULT_SOCKS5_EGRESS_PROFILE_ID]: createProxyProfile({
      pluginId: BUILTIN_SOCKS5_EGRESS_PLUGIN_ID,
      profileId: DEFAULT_SOCKS5_EGRESS_PROFILE_ID,
      routeKind: "socks5",
      routeKey: "socks5",
      poolId: "socks5-pool",
      routePolicyId: "socks5-route",
    }),
  },
} satisfies AccessRuntimeModule;

export const PoolServerAccessRuntimeModule = {
  id: PoolServerAccessRuntimeModuleId,
  egressPlugins: {
    [BUILTIN_POOL_SERVER_EGRESS_PLUGIN_ID]: makeProxyStaticEgressPlugin({
      id: BUILTIN_POOL_SERVER_EGRESS_PLUGIN_ID,
      kind: "pool-server",
    }),
  },
  egressProfiles: {
    [DEFAULT_POOL_SERVER_EGRESS_PROFILE_ID]: createProxyProfile({
      pluginId: BUILTIN_POOL_SERVER_EGRESS_PLUGIN_ID,
      profileId: DEFAULT_POOL_SERVER_EGRESS_PROFILE_ID,
      routeKind: "pool-server",
      routeKey: "pool-server",
      poolId: "pool-server-pool",
      routePolicyId: "pool-server-route",
    }),
  },
} satisfies AccessRuntimeModule;

export const WireGuardAccessRuntimeModule = {
  id: WireGuardAccessRuntimeModuleId,
  egressPlugins: {
    [BUILTIN_WIREGUARD_EGRESS_PLUGIN_ID]: makeWireGuardEgressPlugin(),
  },
  egressProfiles: {
    [DEFAULT_WIREGUARD_EGRESS_PROFILE_ID]: {
      allocationMode: "static",
      pluginId: BUILTIN_WIREGUARD_EGRESS_PLUGIN_ID,
      profileId: DEFAULT_WIREGUARD_EGRESS_PROFILE_ID,
      poolId: "wireguard-pool",
      routePolicyId: "wireguard-route",
      routeKind: "wireguard",
      routeKey: "wireguard",
      routeConfig: {
        kind: "wireguard",
      },
      requestHeaders: {},
      warnings: [],
      autoSelectionConstraint: {
        requiredPluginConfigKeys: ["proxyUrl"],
      },
    },
  },
} satisfies AccessRuntimeModule;

export const TorAccessRuntimeModule = {
  id: TorAccessRuntimeModuleId,
  egressPlugins: {
    [BUILTIN_TOR_EGRESS_PLUGIN_ID]: makeProxyStaticEgressPlugin({
      id: BUILTIN_TOR_EGRESS_PLUGIN_ID,
      kind: "tor",
    }),
  },
  egressProfiles: {
    [DEFAULT_TOR_EGRESS_PROFILE_ID]: createProxyProfile({
      pluginId: BUILTIN_TOR_EGRESS_PLUGIN_ID,
      profileId: DEFAULT_TOR_EGRESS_PROFILE_ID,
      routeKind: "tor",
      routeKey: "tor",
      poolId: "tor-pool",
      routePolicyId: "tor-route",
    }),
  },
} satisfies AccessRuntimeModule;

export function makeBuiltinAccessRuntimeModules(input: {
  readonly egressLeaseManager: Parameters<typeof makeLeaseBackedEgressPlugin>[0]["manager"];
  readonly identityLeaseManager: Parameters<typeof makeLeaseBackedIdentityPlugin>[0]["manager"];
}) {
  return Effect.gen(function* () {
    const leasedEgressPlugin = yield* makeLeaseBackedEgressPlugin({
      manager: input.egressLeaseManager,
    });
    const leasedIdentityPlugin = yield* makeLeaseBackedIdentityPlugin({
      manager: input.identityLeaseManager,
    });
    const mediationRuntime = yield* BrowserMediationRuntime;

    return [
      makeAccessCoreRuntimeModule({
        leasedEgressPluginId: leasedEgressPlugin.id,
        leasedEgressPlugin,
        leasedIdentityPluginId: leasedIdentityPlugin.id,
        leasedIdentityPlugin,
        mediationRuntime,
      }),
      HttpConnectAccessRuntimeModule,
      Socks5AccessRuntimeModule,
      PoolServerAccessRuntimeModule,
      WireGuardAccessRuntimeModule,
      TorAccessRuntimeModule,
    ] as const;
  });
}

export function makeAccessModuleRegistryLiveLayer() {
  return Layer.effect(
    AccessModuleRegistry,
    Effect.gen(function* () {
      const egressLeaseManager = yield* EgressLeaseManagerService;
      const identityLeaseManager = yield* IdentityLeaseManagerService;
      const modules = yield* makeBuiltinAccessRuntimeModules({
        egressLeaseManager,
        identityLeaseManager,
      });

      return makeStaticAccessModuleRegistry({
        modules,
      });
    }),
  );
}
