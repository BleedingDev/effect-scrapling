import { Effect, Layer } from "effect";
import {
  EgressLeaseManagerLive,
  EgressPluginRegistry,
  IdentityLeaseManagerLive,
  IdentityPluginRegistry,
  makeStaticEgressPluginRegistry,
  makeStaticIdentityPluginRegistry,
} from "./access-allocation-plugin-runtime.ts";
import { makeAccessModuleRegistryLiveLayer } from "./access-builtin-modules.ts";
import { AccessModuleComposition, AccessModuleRegistry } from "./access-module-runtime.ts";
import {
  AccessProviderRegistry,
  makeStaticAccessProviderRegistry,
} from "./access-provider-runtime.ts";
import { BrowserMediationRuntimeLive } from "./browser-mediation-runtime.ts";
import {
  AccessProfileRegistry,
  makeStaticAccessProfileRegistry,
} from "./access-profile-runtime.ts";

export const AccessModuleRegistryLive = makeAccessModuleRegistryLiveLayer().pipe(
  Layer.provide(
    Layer.mergeAll(EgressLeaseManagerLive, IdentityLeaseManagerLive, BrowserMediationRuntimeLive),
  ),
);

export const AccessModuleCompositionLive = Layer.effect(
  AccessModuleComposition,
  Effect.gen(function* () {
    const moduleRegistry = yield* AccessModuleRegistry;
    return yield* moduleRegistry.compose();
  }),
).pipe(Layer.provide(AccessModuleRegistryLive));

export const AccessProviderRegistryLive = Layer.effect(
  AccessProviderRegistry,
  Effect.gen(function* () {
    const composition = yield* AccessModuleComposition;
    return makeStaticAccessProviderRegistry(composition.providers);
  }),
).pipe(Layer.provide(AccessModuleCompositionLive));

export const AccessProfileRegistryLive = Layer.effect(
  AccessProfileRegistry,
  Effect.gen(function* () {
    const composition = yield* AccessModuleComposition;
    return makeStaticAccessProfileRegistry({
      egressProfiles: composition.egressProfiles,
      identityProfiles: composition.identityProfiles,
    });
  }),
).pipe(Layer.provide(AccessModuleCompositionLive));

export const EgressPluginRegistryLive = Layer.effect(
  EgressPluginRegistry,
  Effect.gen(function* () {
    const composition = yield* AccessModuleComposition;
    return makeStaticEgressPluginRegistry({
      plugins: composition.egressPlugins,
    });
  }),
).pipe(Layer.provide(AccessModuleCompositionLive));

export const IdentityPluginRegistryLive = Layer.effect(
  IdentityPluginRegistry,
  Effect.gen(function* () {
    const composition = yield* AccessModuleComposition;
    return makeStaticIdentityPluginRegistry({
      plugins: composition.identityPlugins,
    });
  }),
).pipe(Layer.provide(AccessModuleCompositionLive));
