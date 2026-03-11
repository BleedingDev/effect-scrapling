import { Effect, Layer, ServiceMap } from "effect";
import {
  EgressLeaseUnavailable,
  makeInMemoryEgressLeaseManager,
} from "@effect-scrapling/foundation-core/egress-lease-runtime";
import {
  IdentityLeaseUnavailable,
  makeInMemoryIdentityLeaseManager,
} from "@effect-scrapling/foundation-core/identity-lease-runtime";
import { PolicyViolation } from "@effect-scrapling/foundation-core/tagged-errors";
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
export {
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
import {
  type ResolvedEgressProfile,
  type ResolvedIdentityProfile,
} from "./access-profile-runtime.ts";
import { type ResolvedExecutionPlan } from "./access-runtime.ts";
import {
  type AccessEgressRouteConfig,
  parseProxyUrl,
  type ProxyEgressRouteKind,
} from "./egress-route-config.ts";
import { AccessResourceError, InvalidInputError } from "./errors.ts";

const DEFAULT_EGRESS_OWNER_ID = "sdk-access";
const DEFAULT_IDENTITY_OWNER_ID = "sdk-access";
const DEFAULT_EGRESS_TTL_MS = 30_000;
const DEFAULT_IDENTITY_TTL_MS = 30_000;
const DEFAULT_MAX_POOL_LEASES = 128;
const DEFAULT_MAX_ROUTE_LEASES = 64;
const DEFAULT_MAX_IDENTITY_LEASES = 64;
let nextEgressAllocationSequence = 0;
let nextIdentityAllocationSequence = 0;

export type ResolvedEgressLease = ResolvedExecutionPlan["egress"] & {
  readonly egressKey: string;
  readonly leaseId?: string | undefined;
  readonly release: Effect.Effect<void, never>;
};

export type ResolvedIdentityLease = ResolvedExecutionPlan["identity"] & {
  readonly identityKey: string;
  readonly leaseId?: string | undefined;
  readonly release: Effect.Effect<void, never>;
};

export type AcquiredEgressSession = ResolvedEgressLease;
export type AcquiredIdentitySession = ResolvedIdentityLease;

export type EgressBrokerAcquireInput = {
  readonly url: string;
  readonly plan: ResolvedExecutionPlan;
};

export type IdentityBrokerAcquireInput = {
  readonly url: string;
  readonly plan: ResolvedExecutionPlan;
};

type EgressLeaseManager = {
  readonly acquire: (input: unknown) => Effect.Effect<
    {
      readonly id: string;
      readonly egressKey: string;
    },
    PolicyViolation | EgressLeaseUnavailable
  >;
  readonly release: (leaseId: unknown) => Effect.Effect<unknown, PolicyViolation>;
};

type IdentityLeaseManager = {
  readonly acquire: (input: unknown) => Effect.Effect<
    {
      readonly id: string;
      readonly identityKey: string;
    },
    PolicyViolation | IdentityLeaseUnavailable
  >;
  readonly release: (leaseId: unknown) => Effect.Effect<unknown, PolicyViolation>;
};

export class EgressLeaseManagerService extends ServiceMap.Service<
  EgressLeaseManagerService,
  EgressLeaseManager
>()("@effect-scrapling/sdk/EgressLeaseManagerService") {}

export class IdentityLeaseManagerService extends ServiceMap.Service<
  IdentityLeaseManagerService,
  IdentityLeaseManager
>()("@effect-scrapling/sdk/IdentityLeaseManagerService") {}

export type EmptyPluginConfig = Readonly<Record<string, never>>;

export type LeasedEgressPluginConfig = {
  readonly ownerId?: string | undefined;
  readonly ttlMs?: number | undefined;
  readonly maxPoolLeases?: number | undefined;
  readonly maxRouteLeases?: number | undefined;
};

export type WireGuardEgressPluginConfig = {
  readonly endpoint?: string | undefined;
  readonly interfaceName?: string | undefined;
  readonly exitNodeId?: string | undefined;
  readonly egressKey?: string | undefined;
};

export type ProxyEgressPluginConfig = {
  readonly proxyUrl: string;
  readonly proxyHeaders?: Readonly<Record<string, string>> | undefined;
  readonly bypass?: string | undefined;
  readonly egressKey?: string | undefined;
};

export type LeasedIdentityPluginConfig = {
  readonly ownerId?: string | undefined;
  readonly ttlMs?: number | undefined;
  readonly maxActiveLeases?: number | undefined;
};

export type EgressAllocationPlugin<Config = EmptyPluginConfig> = {
  readonly id: string;
  readonly decodeConfig: (input: unknown) => Effect.Effect<Config, InvalidInputError>;
  readonly acquire: (
    input: EgressBrokerAcquireInput & {
      readonly profile: ResolvedEgressProfile;
      readonly config: Config;
    },
  ) => Effect.Effect<ResolvedEgressLease, InvalidInputError | AccessResourceError>;
};

export type IdentityAllocationPlugin<Config = EmptyPluginConfig> = {
  readonly id: string;
  readonly decodeConfig: (input: unknown) => Effect.Effect<Config, InvalidInputError>;
  readonly acquire: (
    input: IdentityBrokerAcquireInput & {
      readonly profile: ResolvedIdentityProfile;
      readonly config: Config;
    },
  ) => Effect.Effect<ResolvedIdentityLease, InvalidInputError | AccessResourceError>;
};

function invalidPlugin(message: string, details?: string) {
  return new InvalidInputError({
    message,
    ...(details === undefined ? {} : { details }),
  });
}

function mapLeaseError(
  error: EgressLeaseUnavailable | IdentityLeaseUnavailable | unknown,
  message: string,
) {
  if (error instanceof EgressLeaseUnavailable || error instanceof IdentityLeaseUnavailable) {
    return new AccessResourceError({
      message,
      details: error.message,
    });
  }

  if (error instanceof PolicyViolation) {
    return new AccessResourceError({
      message,
      details: error.message,
    });
  }

  return new AccessResourceError({
    message,
    details: String(error),
  });
}

function domainFromUrl(url: string): Effect.Effect<string, InvalidInputError> {
  return Effect.try({
    try: () => new URL(url).hostname,
    catch: () =>
      new InvalidInputError({
        message: "Invalid target URL",
        details: `Expected an absolute HTTP(S) URL, received "${url}".`,
      }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeObjectConfig(
  subject: "egress" | "identity",
  pluginId: string,
  input: unknown,
): Effect.Effect<Record<string, unknown>, InvalidInputError> {
  if (input === undefined) {
    return Effect.succeed({});
  }

  if (!isRecord(input)) {
    return Effect.fail(
      invalidPlugin(
        `Invalid ${subject} plugin config`,
        `Plugin "${pluginId}" expected an object config but received ${typeof input}.`,
      ),
    );
  }

  return Effect.succeed(input);
}

function ensureAllowedConfigKeys(
  subject: "egress" | "identity",
  pluginId: string,
  config: Record<string, unknown>,
  allowedKeys: ReadonlyArray<string>,
) {
  const unexpectedKey = Object.keys(config).find((key) => !allowedKeys.includes(key));
  if (unexpectedKey === undefined) {
    return Effect.succeed(config);
  }

  return Effect.fail(
    invalidPlugin(
      `Invalid ${subject} plugin config`,
      `Plugin "${pluginId}" does not accept config key "${unexpectedKey}".`,
    ),
  );
}

function decodeOptionalNonEmptyString(input: {
  readonly subject: "egress" | "identity";
  readonly pluginId: string;
  readonly config: Record<string, unknown>;
  readonly key: string;
}) {
  const value = input.config[input.key];
  if (value === undefined) {
    return Effect.succeed(undefined);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return Effect.succeed(value.trim());
  }

  return Effect.fail(
    invalidPlugin(
      `Invalid ${input.subject} plugin config`,
      `Plugin "${input.pluginId}" expects "${input.key}" to be a non-empty string.`,
    ),
  );
}

function decodeOptionalPositiveNumber(input: {
  readonly subject: "egress" | "identity";
  readonly pluginId: string;
  readonly config: Record<string, unknown>;
  readonly key: string;
}) {
  const value = input.config[input.key];
  if (value === undefined) {
    return Effect.succeed(undefined);
  }

  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return Effect.succeed(value);
  }

  return Effect.fail(
    invalidPlugin(
      `Invalid ${input.subject} plugin config`,
      `Plugin "${input.pluginId}" expects "${input.key}" to be a positive integer.`,
    ),
  );
}

function decodeOptionalStringRecord(input: {
  readonly subject: "egress" | "identity";
  readonly pluginId: string;
  readonly config: Record<string, unknown>;
  readonly key: string;
}) {
  const value = input.config[input.key];
  if (value === undefined) {
    return Effect.succeed(undefined);
  }

  if (!isRecord(value)) {
    return Effect.fail(
      invalidPlugin(
        `Invalid ${input.subject} plugin config`,
        `Plugin "${input.pluginId}" expects "${input.key}" to be an object of string headers.`,
      ),
    );
  }

  const decoded = Object.entries(value).reduce<Record<string, string> | undefined>(
    (current, entry) => {
      const [headerName, headerValue] = entry;
      if (typeof headerValue !== "string" || headerValue.trim().length === 0) {
        return undefined;
      }

      return {
        ...current,
        [headerName]: headerValue,
      };
    },
    {},
  );

  if (decoded === undefined || Object.keys(decoded).length !== Object.keys(value).length) {
    return Effect.fail(
      invalidPlugin(
        `Invalid ${input.subject} plugin config`,
        `Plugin "${input.pluginId}" expects "${input.key}" to be an object with non-empty string values.`,
      ),
    );
  }

  return Effect.succeed(decoded);
}

function decodeEmptyPluginConfig(input: {
  readonly subject: "egress" | "identity";
  readonly pluginId: string;
  readonly rawConfig: unknown;
}) {
  return Effect.gen(function* () {
    const config = yield* decodeObjectConfig(input.subject, input.pluginId, input.rawConfig);
    yield* ensureAllowedConfigKeys(input.subject, input.pluginId, config, []);
    return {} satisfies EmptyPluginConfig;
  });
}

function decodeLeasedEgressPluginConfig(
  pluginId: string,
  rawConfig: unknown,
): Effect.Effect<LeasedEgressPluginConfig, InvalidInputError> {
  return Effect.gen(function* () {
    const config = yield* decodeObjectConfig("egress", pluginId, rawConfig);
    yield* ensureAllowedConfigKeys("egress", pluginId, config, [
      "ownerId",
      "ttlMs",
      "maxPoolLeases",
      "maxRouteLeases",
    ]);

    return {
      ownerId: yield* decodeOptionalNonEmptyString({
        subject: "egress",
        pluginId,
        config,
        key: "ownerId",
      }),
      ttlMs: yield* decodeOptionalPositiveNumber({
        subject: "egress",
        pluginId,
        config,
        key: "ttlMs",
      }),
      maxPoolLeases: yield* decodeOptionalPositiveNumber({
        subject: "egress",
        pluginId,
        config,
        key: "maxPoolLeases",
      }),
      maxRouteLeases: yield* decodeOptionalPositiveNumber({
        subject: "egress",
        pluginId,
        config,
        key: "maxRouteLeases",
      }),
    } satisfies LeasedEgressPluginConfig;
  });
}

function decodeLeasedIdentityPluginConfig(
  pluginId: string,
  rawConfig: unknown,
): Effect.Effect<LeasedIdentityPluginConfig, InvalidInputError> {
  return Effect.gen(function* () {
    const config = yield* decodeObjectConfig("identity", pluginId, rawConfig);
    yield* ensureAllowedConfigKeys("identity", pluginId, config, [
      "ownerId",
      "ttlMs",
      "maxActiveLeases",
    ]);

    return {
      ownerId: yield* decodeOptionalNonEmptyString({
        subject: "identity",
        pluginId,
        config,
        key: "ownerId",
      }),
      ttlMs: yield* decodeOptionalPositiveNumber({
        subject: "identity",
        pluginId,
        config,
        key: "ttlMs",
      }),
      maxActiveLeases: yield* decodeOptionalPositiveNumber({
        subject: "identity",
        pluginId,
        config,
        key: "maxActiveLeases",
      }),
    } satisfies LeasedIdentityPluginConfig;
  });
}

function decodeWireGuardEgressPluginConfig(
  pluginId: string,
  rawConfig: unknown,
): Effect.Effect<WireGuardEgressPluginConfig, InvalidInputError> {
  return Effect.gen(function* () {
    const config = yield* decodeObjectConfig("egress", pluginId, rawConfig);
    yield* ensureAllowedConfigKeys("egress", pluginId, config, [
      "endpoint",
      "interfaceName",
      "exitNodeId",
      "egressKey",
    ]);

    return {
      endpoint: yield* decodeOptionalNonEmptyString({
        subject: "egress",
        pluginId,
        config,
        key: "endpoint",
      }),
      interfaceName: yield* decodeOptionalNonEmptyString({
        subject: "egress",
        pluginId,
        config,
        key: "interfaceName",
      }),
      exitNodeId: yield* decodeOptionalNonEmptyString({
        subject: "egress",
        pluginId,
        config,
        key: "exitNodeId",
      }),
      egressKey: yield* decodeOptionalNonEmptyString({
        subject: "egress",
        pluginId,
        config,
        key: "egressKey",
      }),
    } satisfies WireGuardEgressPluginConfig;
  });
}

function decodeProxyEgressPluginConfig(
  pluginId: string,
  rawConfig: unknown,
): Effect.Effect<ProxyEgressPluginConfig, InvalidInputError> {
  return Effect.gen(function* () {
    const config = yield* decodeObjectConfig("egress", pluginId, rawConfig);
    yield* ensureAllowedConfigKeys("egress", pluginId, config, [
      "proxyUrl",
      "proxyHeaders",
      "bypass",
      "egressKey",
    ]);

    const proxyUrl = yield* decodeOptionalNonEmptyString({
      subject: "egress",
      pluginId,
      config,
      key: "proxyUrl",
    });
    if (proxyUrl === undefined) {
      return yield* Effect.fail(
        invalidPlugin(
          "Invalid egress plugin config",
          `Plugin "${pluginId}" requires a non-empty "proxyUrl" value.`,
        ),
      );
    }
    try {
      parseProxyUrl(proxyUrl);
    } catch {
      return yield* Effect.fail(
        invalidPlugin(
          "Invalid egress plugin config",
          `Plugin "${pluginId}" requires "proxyUrl" to be an absolute URL.`,
        ),
      );
    }

    return {
      proxyUrl,
      proxyHeaders: yield* decodeOptionalStringRecord({
        subject: "egress",
        pluginId,
        config,
        key: "proxyHeaders",
      }),
      bypass: yield* decodeOptionalNonEmptyString({
        subject: "egress",
        pluginId,
        config,
        key: "bypass",
      }),
      egressKey: yield* decodeOptionalNonEmptyString({
        subject: "egress",
        pluginId,
        config,
        key: "egressKey",
      }),
    } satisfies ProxyEgressPluginConfig;
  });
}

function makeLeaseAllocationKey(baseKey: string, nextSequence: () => number) {
  return `${baseKey}-lease-${nextSequence()}`;
}

function nextEgressAllocationKey(baseKey: string) {
  return makeLeaseAllocationKey(baseKey, () => {
    nextEgressAllocationSequence += 1;
    return nextEgressAllocationSequence;
  });
}

function nextIdentityAllocationKey(baseKey: string) {
  return makeLeaseAllocationKey(baseKey, () => {
    nextIdentityAllocationSequence += 1;
    return nextIdentityAllocationSequence;
  });
}

function ensureAllocationMode(
  subject: "egress" | "identity",
  expectedMode: "static" | "leased",
  actualMode: "static" | "leased",
  pluginId: string,
) {
  if (actualMode === expectedMode) {
    return Effect.void;
  }

  return Effect.fail(
    invalidPlugin(
      `Invalid ${subject} plugin/profile combination`,
      `Plugin "${pluginId}" requires allocationMode="${expectedMode}" but the resolved profile uses "${actualMode}".`,
    ),
  );
}

export class EgressPluginRegistry extends ServiceMap.Service<
  EgressPluginRegistry,
  {
    readonly resolve: (
      pluginId: string,
    ) => Effect.Effect<EgressAllocationPlugin<any>, InvalidInputError>;
  }
>()("@effect-scrapling/sdk/EgressPluginRegistry") {}

export class IdentityPluginRegistry extends ServiceMap.Service<
  IdentityPluginRegistry,
  {
    readonly resolve: (
      pluginId: string,
    ) => Effect.Effect<IdentityAllocationPlugin<any>, InvalidInputError>;
  }
>()("@effect-scrapling/sdk/IdentityPluginRegistry") {}

export function makeStaticEgressPlugin(id: string = BUILTIN_DIRECT_EGRESS_PLUGIN_ID) {
  return {
    id,
    decodeConfig: (input) =>
      decodeEmptyPluginConfig({
        subject: "egress",
        pluginId: id,
        rawConfig: input,
      }),
    acquire: ({ profile }) =>
      Effect.gen(function* () {
        yield* ensureAllocationMode("egress", "static", profile.allocationMode, id);
        return {
          ...profile,
          egressKey: profile.routeKey,
          release: Effect.void,
        } satisfies ResolvedEgressLease;
      }),
  } satisfies EgressAllocationPlugin;
}

function mergeRouteConfig(
  baseRouteConfig: AccessEgressRouteConfig | undefined,
  nextRouteConfig: AccessEgressRouteConfig,
) {
  return {
    ...baseRouteConfig,
    ...nextRouteConfig,
  } satisfies AccessEgressRouteConfig;
}

export function makeWireGuardEgressPlugin(id: string = BUILTIN_WIREGUARD_EGRESS_PLUGIN_ID) {
  return {
    id,
    decodeConfig: (input) => decodeWireGuardEgressPluginConfig(id, input),
    acquire: ({ profile, config }) =>
      Effect.gen(function* () {
        yield* ensureAllocationMode("egress", "static", profile.allocationMode, id);
        return {
          ...profile,
          routeConfig: mergeRouteConfig(profile.routeConfig, {
            kind: "wireguard",
            ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
            ...(config.interfaceName === undefined ? {} : { interfaceName: config.interfaceName }),
            ...(config.exitNodeId === undefined ? {} : { exitNodeId: config.exitNodeId }),
          }),
          egressKey: config.egressKey ?? config.endpoint ?? profile.routeKey,
          release: Effect.void,
        } satisfies ResolvedEgressLease;
      }),
  } satisfies EgressAllocationPlugin<WireGuardEgressPluginConfig>;
}

export function makeProxyStaticEgressPlugin(input: {
  readonly id: string;
  readonly kind: ProxyEgressRouteKind;
}) {
  return {
    id: input.id,
    decodeConfig: (rawConfig) => decodeProxyEgressPluginConfig(input.id, rawConfig),
    acquire: ({ profile, config }) =>
      Effect.gen(function* () {
        yield* ensureAllocationMode("egress", "static", profile.allocationMode, input.id);
        return {
          ...profile,
          routeConfig: mergeRouteConfig(profile.routeConfig, {
            kind: input.kind,
            proxyUrl: config.proxyUrl,
            ...(config.proxyHeaders === undefined ? {} : { proxyHeaders: config.proxyHeaders }),
            ...(config.bypass === undefined ? {} : { bypass: config.bypass }),
          }),
          egressKey: config.egressKey ?? config.proxyUrl,
          release: Effect.void,
        } satisfies ResolvedEgressLease;
      }),
  } satisfies EgressAllocationPlugin<ProxyEgressPluginConfig>;
}

export function makeStaticIdentityPlugin(id: string = BUILTIN_DEFAULT_IDENTITY_PLUGIN_ID) {
  return {
    id,
    decodeConfig: (input) =>
      decodeEmptyPluginConfig({
        subject: "identity",
        pluginId: id,
        rawConfig: input,
      }),
    acquire: ({ profile }) =>
      Effect.gen(function* () {
        yield* ensureAllocationMode("identity", "static", profile.allocationMode, id);
        return {
          ...profile,
          identityKey: profile.profileId,
          release: Effect.void,
        } satisfies ResolvedIdentityLease;
      }),
  } satisfies IdentityAllocationPlugin;
}

export function makeLeaseBackedEgressPlugin(input: {
  readonly manager: EgressLeaseManager;
  readonly id?: string | undefined;
  readonly ownerId?: string | undefined;
  readonly ttlMs?: number | undefined;
  readonly maxPoolLeases?: number | undefined;
  readonly maxRouteLeases?: number | undefined;
}) {
  const pluginId = input.id ?? BUILTIN_LEASED_EGRESS_PLUGIN_ID;
  const ownerId = input.ownerId ?? DEFAULT_EGRESS_OWNER_ID;
  const ttlMs = input.ttlMs ?? DEFAULT_EGRESS_TTL_MS;
  const maxPoolLeases = input.maxPoolLeases ?? DEFAULT_MAX_POOL_LEASES;
  const maxRouteLeases = input.maxRouteLeases ?? DEFAULT_MAX_ROUTE_LEASES;

  return Effect.succeed({
    id: pluginId,
    decodeConfig: (input) => decodeLeasedEgressPluginConfig(pluginId, input),
    acquire: ({ profile, config }) =>
      Effect.gen(function* () {
        yield* ensureAllocationMode("egress", "leased", profile.allocationMode, pluginId);
        const allocationKey = nextEgressAllocationKey(profile.routeKey);
        const lease = yield* input.manager
          .acquire({
            ownerId: config.ownerId ?? ownerId,
            egressKey: allocationKey,
            poolId: profile.poolId,
            routePolicyId: profile.routePolicyId,
            ttlMs: config.ttlMs ?? ttlMs,
            maxPoolLeases: config.maxPoolLeases ?? maxPoolLeases,
            maxRouteLeases: config.maxRouteLeases ?? maxRouteLeases,
          })
          .pipe(
            Effect.mapError((error) =>
              mapLeaseError(
                error,
                `Failed to acquire egress lease for profile "${profile.profileId}"`,
              ),
            ),
          );

        return {
          ...profile,
          egressKey: lease.egressKey,
          leaseId: lease.id,
          release: input.manager.release(lease.id).pipe(Effect.ignore, Effect.orDie),
        } satisfies ResolvedEgressLease;
      }),
  } satisfies EgressAllocationPlugin<LeasedEgressPluginConfig>);
}

export function makeLeaseBackedIdentityPlugin(input: {
  readonly manager: IdentityLeaseManager;
  readonly id?: string | undefined;
  readonly ownerId?: string | undefined;
  readonly ttlMs?: number | undefined;
  readonly maxActiveLeases?: number | undefined;
}) {
  const pluginId = input.id ?? BUILTIN_LEASED_IDENTITY_PLUGIN_ID;
  const ownerId = input.ownerId ?? DEFAULT_IDENTITY_OWNER_ID;
  const ttlMs = input.ttlMs ?? DEFAULT_IDENTITY_TTL_MS;
  const maxActiveLeases = input.maxActiveLeases ?? DEFAULT_MAX_IDENTITY_LEASES;

  return Effect.succeed({
    id: pluginId,
    decodeConfig: (input) => decodeLeasedIdentityPluginConfig(pluginId, input),
    acquire: ({ profile, url, config }) =>
      Effect.gen(function* () {
        yield* ensureAllocationMode("identity", "leased", profile.allocationMode, pluginId);
        const allocationKey = nextIdentityAllocationKey(profile.profileId);
        const domain = yield* domainFromUrl(url);
        const lease = yield* input.manager
          .acquire({
            ownerId: config.ownerId ?? ownerId,
            tenantId: profile.tenantId,
            domain,
            identityKey: allocationKey,
            ttlMs: config.ttlMs ?? ttlMs,
            maxActiveLeases: config.maxActiveLeases ?? maxActiveLeases,
          })
          .pipe(
            Effect.mapError((error) =>
              mapLeaseError(
                error,
                `Failed to acquire identity lease for profile "${profile.profileId}"`,
              ),
            ),
          );

        return {
          ...profile,
          identityKey: lease.identityKey,
          leaseId: lease.id,
          release: input.manager.release(lease.id).pipe(Effect.ignore, Effect.orDie),
        } satisfies ResolvedIdentityLease;
      }),
  } satisfies IdentityAllocationPlugin<LeasedIdentityPluginConfig>);
}

export function makeStaticEgressPluginRegistry(input?: {
  readonly plugins?: Readonly<Record<string, EgressAllocationPlugin<any>>> | undefined;
}) {
  const plugins = input?.plugins ?? {};

  return {
    resolve: (pluginId: string) => {
      const plugin = plugins[pluginId];
      if (plugin === undefined) {
        return Effect.fail(
          invalidPlugin("Unknown egress plugin", `No egress plugin named "${pluginId}".`),
        );
      }

      return Effect.succeed(plugin);
    },
  } satisfies {
    readonly resolve: (
      pluginId: string,
    ) => Effect.Effect<EgressAllocationPlugin<any>, InvalidInputError>;
  };
}

export function makeStaticIdentityPluginRegistry(input?: {
  readonly plugins?: Readonly<Record<string, IdentityAllocationPlugin<any>>> | undefined;
}) {
  const plugins = input?.plugins ?? {};

  return {
    resolve: (pluginId: string) => {
      const plugin = plugins[pluginId];
      if (plugin === undefined) {
        return Effect.fail(
          invalidPlugin("Unknown identity plugin", `No identity plugin named "${pluginId}".`),
        );
      }

      return Effect.succeed(plugin);
    },
  } satisfies {
    readonly resolve: (
      pluginId: string,
    ) => Effect.Effect<IdentityAllocationPlugin<any>, InvalidInputError>;
  };
}

export function makeEgressPluginRegistryLiveLayer() {
  return Layer.effect(
    EgressPluginRegistry,
    Effect.gen(function* () {
      const manager = yield* EgressLeaseManagerService;
      const leasedPlugin = yield* makeLeaseBackedEgressPlugin({ manager });

      return makeStaticEgressPluginRegistry({
        plugins: {
          [BUILTIN_DIRECT_EGRESS_PLUGIN_ID]: makeStaticEgressPlugin(),
          [BUILTIN_WIREGUARD_EGRESS_PLUGIN_ID]: makeWireGuardEgressPlugin(),
          [BUILTIN_HTTP_CONNECT_EGRESS_PLUGIN_ID]: makeProxyStaticEgressPlugin({
            id: BUILTIN_HTTP_CONNECT_EGRESS_PLUGIN_ID,
            kind: "http-connect",
          }),
          [BUILTIN_SOCKS5_EGRESS_PLUGIN_ID]: makeProxyStaticEgressPlugin({
            id: BUILTIN_SOCKS5_EGRESS_PLUGIN_ID,
            kind: "socks5",
          }),
          [BUILTIN_TOR_EGRESS_PLUGIN_ID]: makeProxyStaticEgressPlugin({
            id: BUILTIN_TOR_EGRESS_PLUGIN_ID,
            kind: "tor",
          }),
          [BUILTIN_POOL_SERVER_EGRESS_PLUGIN_ID]: makeProxyStaticEgressPlugin({
            id: BUILTIN_POOL_SERVER_EGRESS_PLUGIN_ID,
            kind: "pool-server",
          }),
          [leasedPlugin.id]: leasedPlugin,
        },
      });
    }),
  );
}

export function makeIdentityPluginRegistryLiveLayer() {
  return Layer.effect(
    IdentityPluginRegistry,
    Effect.gen(function* () {
      const manager = yield* IdentityLeaseManagerService;
      const leasedPlugin = yield* makeLeaseBackedIdentityPlugin({ manager });

      return makeStaticIdentityPluginRegistry({
        plugins: {
          [BUILTIN_DEFAULT_IDENTITY_PLUGIN_ID]: makeStaticIdentityPlugin(
            BUILTIN_DEFAULT_IDENTITY_PLUGIN_ID,
          ),
          [BUILTIN_STEALTH_IDENTITY_PLUGIN_ID]: makeStaticIdentityPlugin(
            BUILTIN_STEALTH_IDENTITY_PLUGIN_ID,
          ),
          [leasedPlugin.id]: leasedPlugin,
        },
      });
    }),
  );
}

export const EgressLeaseManagerLive = Layer.effect(
  EgressLeaseManagerService,
  makeInMemoryEgressLeaseManager(),
);

export const IdentityLeaseManagerLive = Layer.effect(
  IdentityLeaseManagerService,
  makeInMemoryIdentityLeaseManager(),
);

export const EgressPluginRegistryLive = makeEgressPluginRegistryLiveLayer().pipe(
  Layer.provide(EgressLeaseManagerLive),
);
export const IdentityPluginRegistryLive = makeIdentityPluginRegistryLiveLayer().pipe(
  Layer.provide(IdentityLeaseManagerLive),
);

export function resetAccessAllocationPluginStateForTests(): Effect.Effect<void> {
  return Effect.sync(() => {
    nextEgressAllocationSequence = 0;
    nextIdentityAllocationSequence = 0;
  });
}
