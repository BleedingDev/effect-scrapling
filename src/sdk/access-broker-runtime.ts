import { Effect, Layer, ServiceMap } from "effect";
import {
  EgressPluginRegistry,
  EgressPluginRegistryLive,
  IdentityPluginRegistry,
  IdentityPluginRegistryLive,
  resetAccessAllocationPluginStateForTests,
  type AcquiredEgressSession,
  type AcquiredIdentitySession,
  type EgressBrokerAcquireInput,
  type IdentityBrokerAcquireInput,
  type ResolvedEgressLease,
  type ResolvedIdentityLease,
} from "./access-allocation-plugin-runtime.ts";
import { AccessResourceError, InvalidInputError } from "./errors.ts";

export function makeEgressBroker(pluginRegistry: {
  readonly resolve: (
    pluginId: string,
  ) => Effect.Effect<
    import("./access-allocation-plugin-runtime.ts").EgressAllocationPlugin,
    InvalidInputError
  >;
}) {
  return {
    acquire: (input: EgressBrokerAcquireInput) =>
      Effect.gen(function* () {
        const plugin = yield* pluginRegistry.resolve(input.plan.egress.pluginId);
        const config = yield* plugin.decodeConfig(input.plan.egress.pluginConfig);
        return yield* plugin.acquire({
          ...input,
          profile: input.plan.egress,
          config,
        });
      }),
  } satisfies {
    readonly acquire: (
      input: EgressBrokerAcquireInput,
    ) => Effect.Effect<ResolvedEgressLease, InvalidInputError | AccessResourceError>;
  };
}

export function makeIdentityBroker(pluginRegistry: {
  readonly resolve: (
    pluginId: string,
  ) => Effect.Effect<
    import("./access-allocation-plugin-runtime.ts").IdentityAllocationPlugin,
    InvalidInputError
  >;
}) {
  return {
    acquire: (input: IdentityBrokerAcquireInput) =>
      Effect.gen(function* () {
        const plugin = yield* pluginRegistry.resolve(input.plan.identity.pluginId);
        const config = yield* plugin.decodeConfig(input.plan.identity.pluginConfig);
        return yield* plugin.acquire({
          ...input,
          profile: input.plan.identity,
          config,
        });
      }),
  } satisfies {
    readonly acquire: (
      input: IdentityBrokerAcquireInput,
    ) => Effect.Effect<ResolvedIdentityLease, InvalidInputError | AccessResourceError>;
  };
}

export class EgressBroker extends ServiceMap.Service<
  EgressBroker,
  {
    readonly acquire: (
      input: EgressBrokerAcquireInput,
    ) => Effect.Effect<ResolvedEgressLease, InvalidInputError | AccessResourceError>;
  }
>()("@effect-scrapling/sdk/EgressBroker") {}

export class IdentityBroker extends ServiceMap.Service<
  IdentityBroker,
  {
    readonly acquire: (
      input: IdentityBrokerAcquireInput,
    ) => Effect.Effect<ResolvedIdentityLease, InvalidInputError | AccessResourceError>;
  }
>()("@effect-scrapling/sdk/IdentityBroker") {}

export const EgressBrokerLive = Layer.effect(
  EgressBroker,
  Effect.gen(function* () {
    const pluginRegistry = yield* EgressPluginRegistry;
    return makeEgressBroker(pluginRegistry);
  }),
);

export const IdentityBrokerLive = Layer.effect(
  IdentityBroker,
  Effect.gen(function* () {
    const pluginRegistry = yield* IdentityPluginRegistry;
    return makeIdentityBroker(pluginRegistry);
  }),
);

export const EgressBrokerEnvironmentLive = EgressBrokerLive.pipe(
  Layer.provide(EgressPluginRegistryLive),
);

export const IdentityBrokerEnvironmentLive = IdentityBrokerLive.pipe(
  Layer.provide(IdentityPluginRegistryLive),
);

export function resetAccessBrokerStateForTests(): Effect.Effect<void> {
  return resetAccessAllocationPluginStateForTests();
}

export type {
  AcquiredEgressSession,
  AcquiredIdentitySession,
  EgressBrokerAcquireInput,
  IdentityBrokerAcquireInput,
  ResolvedEgressLease,
  ResolvedIdentityLease,
} from "./access-allocation-plugin-runtime.ts";
