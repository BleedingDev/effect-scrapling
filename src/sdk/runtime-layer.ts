import { Effect, Layer, Scope, ServiceMap } from "effect";
import {
  EgressBroker,
  EgressBrokerLive,
  IdentityBroker,
  IdentityBrokerLive,
} from "./access-broker-runtime.ts";
import { AccessSelectionPolicy, AccessSelectionPolicyLive } from "./access-policy-runtime.ts";
import {
  AccessSelectionHealthSignalsGateway,
  AccessSelectionHealthSignalsGatewayLive,
} from "./access-selection-health-runtime.ts";
import {
  AccessSelectionStrategy,
  AccessSelectionStrategyLive,
} from "./access-selection-strategy-runtime.ts";
import {
  AccessHealthPolicyRegistry,
  AccessHealthPolicyRegistryLive,
  AccessHealthSubjectStrategy,
  AccessHealthSubjectStrategyLive,
} from "./access-health-policy-runtime.ts";
import { AccessHealthRuntime } from "./access-health-runtime-service.ts";
import {
  EgressLeaseManagerLive,
  EgressLeaseManagerService,
  EgressPluginRegistry,
  IdentityLeaseManagerLive,
  IdentityLeaseManagerService,
  IdentityPluginRegistry,
  makeStaticEgressPluginRegistry,
  makeStaticIdentityPluginRegistry,
} from "./access-allocation-plugin-runtime.ts";
import { AccessModuleComposition, AccessModuleRegistry } from "./access-module-runtime.ts";
import { makeAccessModuleRegistryLiveLayer } from "./access-builtin-modules.ts";
import {
  AccessExecutionCoordinator,
  AccessExecutionCoordinatorLive,
} from "./access-execution-coordinator.ts";
import { AccessExecutionEngine, AccessExecutionEngineLive } from "./access-execution-engine.ts";
import { AccessProgramLinker, AccessProgramLinkerLive } from "./access-program-linker.ts";
import { AccessHealthGateway, AccessHealthGatewayLive } from "./access-health-gateway.ts";
import {
  AccessProviderRegistry,
  makeStaticAccessProviderRegistry,
} from "./access-provider-runtime.ts";
import { AccessResourceKernel, AccessResourceKernelLive } from "./access-resource-kernel.ts";
import {
  AccessProfileRegistry,
  makeStaticAccessProfileRegistry,
} from "./access-profile-runtime.ts";
import {
  AccessProfileSelectionStrategy,
  AccessProfileSelectionStrategyLive,
} from "./access-profile-selection-strategy-runtime.ts";
import {
  AccessProfileSelectionHealthSignalsGateway,
  AccessProfileSelectionHealthSignalsGatewayLive,
} from "./access-profile-selection-health-runtime.ts";
import {
  AccessProfileSelectionPolicy,
  AccessProfileSelectionPolicyLive,
} from "./access-profile-policy-runtime.ts";
import { AccessExecutionRuntime, AccessExecutionRuntimeLive } from "./access-runtime.ts";
import { BrowserRuntime, BrowserRuntimeLive } from "./browser-pool.ts";
import {
  BrowserMediationRuntime,
  BrowserMediationRuntimeLive,
} from "./browser-mediation-runtime.ts";
import { FetchService, FetchServiceLive } from "./fetch-service.ts";
import { SharedAccessHealthSignalsLive } from "./access-health-shared-runtime.ts";

export type SdkRuntimeServices =
  | BrowserRuntime
  | BrowserMediationRuntime
  | AccessProfileRegistry
  | AccessProfileSelectionStrategy
  | AccessProfileSelectionHealthSignalsGateway
  | AccessProfileSelectionPolicy
  | AccessSelectionPolicy
  | AccessSelectionHealthSignalsGateway
  | AccessSelectionStrategy
  | AccessHealthPolicyRegistry
  | AccessHealthSubjectStrategy
  | AccessHealthRuntime
  | AccessProviderRegistry
  | AccessModuleComposition
  | AccessModuleRegistry
  | AccessExecutionRuntime
  | EgressLeaseManagerService
  | EgressPluginRegistry
  | IdentityLeaseManagerService
  | IdentityPluginRegistry
  | EgressBroker
  | IdentityBroker
  | AccessHealthGateway
  | AccessProgramLinker
  | AccessExecutionEngine
  | AccessExecutionCoordinator
  | AccessResourceKernel;

export type SdkEnvironmentServices = SdkRuntimeServices | FetchService;
export type WithoutSdkRuntime<R> = Exclude<R, SdkRuntimeServices>;
export type WithoutSdkEnvironment<R> = Exclude<R, SdkEnvironmentServices>;
export type SdkRuntimeHandle = {
  readonly provideRuntime: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, WithoutSdkRuntime<R>>;
  readonly provideEnvironment: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, WithoutSdkEnvironment<R>>;
};

const SharedHealthSelectionServicesLive = Layer.mergeAll(
  SharedAccessHealthSignalsLive,
  AccessHealthPolicyRegistryLive,
  AccessHealthSubjectStrategyLive,
);

const ProvidedAccessModuleRegistryLive = makeAccessModuleRegistryLiveLayer().pipe(
  Layer.provide(
    Layer.mergeAll(EgressLeaseManagerLive, IdentityLeaseManagerLive, BrowserMediationRuntimeLive),
  ),
);

const ProvidedAccessModuleCompositionLive = Layer.effect(
  AccessModuleComposition,
  Effect.gen(function* () {
    const moduleRegistry = yield* AccessModuleRegistry;
    return yield* moduleRegistry.compose();
  }),
).pipe(Layer.provide(ProvidedAccessModuleRegistryLive));

const AccessProviderRegistryFromModulesLive = Layer.effect(
  AccessProviderRegistry,
  Effect.gen(function* () {
    const composition = yield* AccessModuleComposition;
    return makeStaticAccessProviderRegistry(composition.providers);
  }),
);

const AccessProfileRegistryFromModulesLive = Layer.effect(
  AccessProfileRegistry,
  Effect.gen(function* () {
    const composition = yield* AccessModuleComposition;
    return makeStaticAccessProfileRegistry({
      egressProfiles: composition.egressProfiles,
      identityProfiles: composition.identityProfiles,
    });
  }),
);

const EgressPluginRegistryFromModulesLive = Layer.effect(
  EgressPluginRegistry,
  Effect.gen(function* () {
    const composition = yield* AccessModuleComposition;
    return makeStaticEgressPluginRegistry({
      plugins: composition.egressPlugins,
    });
  }),
);

const IdentityPluginRegistryFromModulesLive = Layer.effect(
  IdentityPluginRegistry,
  Effect.gen(function* () {
    const composition = yield* AccessModuleComposition;
    return makeStaticIdentityPluginRegistry({
      plugins: composition.identityPlugins,
    });
  }),
);

const ProvidedAccessProviderRegistryLive = AccessProviderRegistryFromModulesLive.pipe(
  Layer.provide(ProvidedAccessModuleCompositionLive),
);

const ProvidedAccessProfileRegistryLive = AccessProfileRegistryFromModulesLive.pipe(
  Layer.provide(ProvidedAccessModuleCompositionLive),
);

const ProvidedAccessSelectionPolicyLive = AccessSelectionPolicyLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      SharedHealthSelectionServicesLive,
      ProvidedAccessProviderRegistryLive,
      AccessSelectionStrategyLive,
    ),
  ),
);

const ProvidedAccessProfileSelectionPolicyLive = AccessProfileSelectionPolicyLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProvidedAccessProfileRegistryLive,
      AccessProfileSelectionStrategyLive,
      SharedHealthSelectionServicesLive,
    ),
  ),
);

const ProvidedAccessHealthGatewayLive = AccessHealthGatewayLive.pipe(
  Layer.provide(SharedHealthSelectionServicesLive),
);

const ProvidedEgressPluginRegistryLive = EgressPluginRegistryFromModulesLive.pipe(
  Layer.provide(ProvidedAccessModuleCompositionLive),
);

const ProvidedIdentityPluginRegistryLive = IdentityPluginRegistryFromModulesLive.pipe(
  Layer.provide(ProvidedAccessModuleCompositionLive),
);

const ProvidedEgressBrokerLive = EgressBrokerLive.pipe(
  Layer.provide(ProvidedEgressPluginRegistryLive),
);

const ProvidedIdentityBrokerLive = IdentityBrokerLive.pipe(
  Layer.provide(ProvidedIdentityPluginRegistryLive),
);

const ProvidedAccessExecutionEngineLive = AccessExecutionEngineLive.pipe(
  Layer.provide(ProvidedAccessProviderRegistryLive),
);

const ProvidedAccessProgramLinkerLive = AccessProgramLinkerLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProvidedAccessModuleRegistryLive,
      ProvidedAccessProviderRegistryLive,
      ProvidedAccessProfileRegistryLive,
      ProvidedAccessProfileSelectionPolicyLive,
      ProvidedAccessSelectionPolicyLive,
    ),
  ),
);

const ProvidedAccessExecutionRuntimeLive = AccessExecutionRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProvidedAccessProgramLinkerLive,
      ProvidedAccessProviderRegistryLive,
      ProvidedAccessSelectionPolicyLive,
      ProvidedAccessProfileSelectionPolicyLive,
    ),
  ),
);

const ProvidedAccessResourceKernelLive = AccessResourceKernelLive.pipe(
  Layer.provide(Layer.mergeAll(ProvidedEgressBrokerLive, ProvidedIdentityBrokerLive)),
);

const ProvidedAccessExecutionCoordinatorLive = AccessExecutionCoordinatorLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProvidedAccessResourceKernelLive,
      ProvidedAccessHealthGatewayLive,
      ProvidedAccessExecutionEngineLive,
    ),
  ),
);

export const SdkRuntimeDependenciesLive = Layer.mergeAll(
  ProvidedAccessModuleRegistryLive,
  ProvidedAccessModuleCompositionLive,
  ProvidedAccessProfileRegistryLive,
  AccessProfileSelectionStrategyLive,
  ProvidedAccessProfileSelectionPolicyLive,
  SharedHealthSelectionServicesLive,
  ProvidedAccessProviderRegistryLive,
  BrowserRuntimeLive,
  BrowserMediationRuntimeLive,
  ProvidedAccessProgramLinkerLive,
  AccessSelectionStrategyLive,
  ProvidedAccessSelectionPolicyLive,
  EgressLeaseManagerLive,
  ProvidedEgressPluginRegistryLive,
  IdentityLeaseManagerLive,
  ProvidedIdentityPluginRegistryLive,
);

export const SdkRuntimeDerivedLive = Layer.mergeAll(
  ProvidedAccessExecutionRuntimeLive,
  ProvidedAccessProviderRegistryLive,
  ProvidedEgressBrokerLive,
  ProvidedIdentityBrokerLive,
  ProvidedAccessHealthGatewayLive,
  ProvidedAccessProgramLinkerLive,
  ProvidedAccessExecutionEngineLive,
  ProvidedAccessResourceKernelLive,
  ProvidedAccessExecutionCoordinatorLive,
);

export const SdkRuntimeLive = Layer.mergeAll(SdkRuntimeDependenciesLive, SdkRuntimeDerivedLive);

export const SdkEnvironmentLive = Layer.mergeAll(SdkRuntimeLive, FetchServiceLive);

function contextServiceLayer<I, S, R>(
  tag: ServiceMap.Key<I, S>,
  context: ServiceMap.ServiceMap<R | I>,
) {
  return Layer.succeed(tag, ServiceMap.get(context, tag));
}

function singleServiceContext<I, S>(tag: ServiceMap.Key<I, S>, service: S) {
  return ServiceMap.make(tag, service);
}

function overrideServiceContext<I, S, R>(
  tag: ServiceMap.Key<I, S>,
  overrides: ServiceMap.ServiceMap<R>,
) {
  return ServiceMap.getOrUndefined(overrides, tag);
}

const rebuildDerivedRuntimeServices = <ROverrides>(
  context: ServiceMap.ServiceMap<SdkRuntimeServices | ROverrides>,
  overrides: ServiceMap.ServiceMap<ROverrides>,
) =>
  Effect.gen(function* () {
    const overriddenSelectionHealthSignals = overrideServiceContext(
      AccessSelectionHealthSignalsGateway,
      overrides,
    );
    const resolvedSelectionHealthSignals =
      overriddenSelectionHealthSignals === undefined
        ? yield* Layer.build(
            AccessSelectionHealthSignalsGatewayLive.pipe(
              Layer.provide(contextServiceLayer(AccessHealthRuntime, context)),
            ),
          )
        : singleServiceContext(
            AccessSelectionHealthSignalsGateway,
            overriddenSelectionHealthSignals,
          );
    const overriddenAccessProviderRegistry = overrideServiceContext(
      AccessProviderRegistry,
      overrides,
    );
    const overriddenAccessModuleRegistry = overrideServiceContext(AccessModuleRegistry, overrides);
    const overriddenAccessProfileRegistry = overrideServiceContext(
      AccessProfileRegistry,
      overrides,
    );
    const overriddenEgressLeaseManager = overrideServiceContext(
      EgressLeaseManagerService,
      overrides,
    );
    const overriddenIdentityLeaseManager = overrideServiceContext(
      IdentityLeaseManagerService,
      overrides,
    );
    const overriddenBrowserMediationRuntime = overrideServiceContext(
      BrowserMediationRuntime,
      overrides,
    );
    const resolvedAccessModuleRegistry =
      overriddenAccessModuleRegistry === undefined
        ? overriddenEgressLeaseManager === undefined &&
          overriddenIdentityLeaseManager === undefined &&
          overriddenBrowserMediationRuntime === undefined
          ? singleServiceContext(
              AccessModuleRegistry,
              ServiceMap.get(context, AccessModuleRegistry),
            )
          : yield* Layer.build(
              makeAccessModuleRegistryLiveLayer().pipe(
                Layer.provide(
                  Layer.mergeAll(
                    contextServiceLayer(EgressLeaseManagerService, context),
                    contextServiceLayer(IdentityLeaseManagerService, context),
                    contextServiceLayer(BrowserMediationRuntime, context),
                  ),
                ),
              ),
            )
        : singleServiceContext(AccessModuleRegistry, overriddenAccessModuleRegistry);
    const resolvedAccessModuleComposition = yield* Layer.build(
      Layer.effect(
        AccessModuleComposition,
        Effect.gen(function* () {
          const moduleRegistry = yield* AccessModuleRegistry;
          return yield* moduleRegistry.compose();
        }),
      ).pipe(
        Layer.provide(contextServiceLayer(AccessModuleRegistry, resolvedAccessModuleRegistry)),
      ),
    );
    const resolvedAccessProviderRegistry =
      overriddenAccessProviderRegistry === undefined
        ? yield* Layer.build(
            AccessProviderRegistryFromModulesLive.pipe(
              Layer.provide(
                contextServiceLayer(AccessModuleComposition, resolvedAccessModuleComposition),
              ),
            ),
          )
        : singleServiceContext(AccessProviderRegistry, overriddenAccessProviderRegistry);
    const providerRegistryContext = ServiceMap.merge(context, resolvedAccessProviderRegistry);
    const resolvedAccessProfileRegistry =
      overriddenAccessProfileRegistry === undefined
        ? yield* Layer.build(
            AccessProfileRegistryFromModulesLive.pipe(
              Layer.provide(
                contextServiceLayer(AccessModuleComposition, resolvedAccessModuleComposition),
              ),
            ),
          )
        : singleServiceContext(AccessProfileRegistry, overriddenAccessProfileRegistry);
    const profileRegistryContext = ServiceMap.merge(context, resolvedAccessProfileRegistry);
    const overriddenEgressPluginRegistry = overrideServiceContext(EgressPluginRegistry, overrides);
    const resolvedEgressPluginRegistry =
      overriddenEgressPluginRegistry === undefined
        ? yield* Layer.build(
            EgressPluginRegistryFromModulesLive.pipe(
              Layer.provide(
                contextServiceLayer(AccessModuleComposition, resolvedAccessModuleComposition),
              ),
            ),
          )
        : singleServiceContext(EgressPluginRegistry, overriddenEgressPluginRegistry);
    const overriddenIdentityPluginRegistry = overrideServiceContext(
      IdentityPluginRegistry,
      overrides,
    );
    const resolvedIdentityPluginRegistry =
      overriddenIdentityPluginRegistry === undefined
        ? yield* Layer.build(
            IdentityPluginRegistryFromModulesLive.pipe(
              Layer.provide(
                contextServiceLayer(AccessModuleComposition, resolvedAccessModuleComposition),
              ),
            ),
          )
        : singleServiceContext(IdentityPluginRegistry, overriddenIdentityPluginRegistry);
    const overriddenSelectionStrategy = overrideServiceContext(AccessSelectionStrategy, overrides);
    const resolvedSelectionStrategy =
      overriddenSelectionStrategy === undefined
        ? yield* Layer.build(AccessSelectionStrategyLive)
        : singleServiceContext(AccessSelectionStrategy, overriddenSelectionStrategy);
    const overriddenSelectionPolicy = overrideServiceContext(AccessSelectionPolicy, overrides);
    const resolvedSelectionPolicy =
      overriddenSelectionPolicy === undefined
        ? yield* Layer.build(
            AccessSelectionPolicyLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  contextServiceLayer(
                    AccessSelectionHealthSignalsGateway,
                    resolvedSelectionHealthSignals,
                  ),
                  contextServiceLayer(AccessProviderRegistry, providerRegistryContext),
                  contextServiceLayer(AccessSelectionStrategy, resolvedSelectionStrategy),
                ),
              ),
            ),
          )
        : singleServiceContext(AccessSelectionPolicy, overriddenSelectionPolicy);
    const overriddenAccessHealthGateway = overrideServiceContext(AccessHealthGateway, overrides);
    const resolvedAccessHealthGateway =
      overriddenAccessHealthGateway === undefined
        ? yield* Layer.build(
            AccessHealthGatewayLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  contextServiceLayer(AccessHealthRuntime, context),
                  contextServiceLayer(AccessHealthPolicyRegistry, context),
                  contextServiceLayer(AccessHealthSubjectStrategy, context),
                ),
              ),
            ),
          )
        : singleServiceContext(AccessHealthGateway, overriddenAccessHealthGateway);
    const overriddenEgressBroker = overrideServiceContext(EgressBroker, overrides);
    const resolvedEgressBroker =
      overriddenEgressBroker === undefined
        ? yield* Layer.build(
            EgressBrokerLive.pipe(
              Layer.provide(
                contextServiceLayer(EgressPluginRegistry, resolvedEgressPluginRegistry),
              ),
            ),
          )
        : singleServiceContext(EgressBroker, overriddenEgressBroker);
    const overriddenIdentityBroker = overrideServiceContext(IdentityBroker, overrides);
    const resolvedIdentityBroker =
      overriddenIdentityBroker === undefined
        ? yield* Layer.build(
            IdentityBrokerLive.pipe(
              Layer.provide(
                contextServiceLayer(IdentityPluginRegistry, resolvedIdentityPluginRegistry),
              ),
            ),
          )
        : singleServiceContext(IdentityBroker, overriddenIdentityBroker);
    const overriddenAccessExecutionRuntime = overrideServiceContext(
      AccessExecutionRuntime,
      overrides,
    );
    const overriddenAccessProgramLinker = overrideServiceContext(AccessProgramLinker, overrides);
    const overriddenAccessProfileSelectionStrategy = overrideServiceContext(
      AccessProfileSelectionStrategy,
      overrides,
    );
    const resolvedAccessProfileSelectionStrategy =
      overriddenAccessProfileSelectionStrategy === undefined
        ? yield* Layer.build(AccessProfileSelectionStrategyLive)
        : singleServiceContext(
            AccessProfileSelectionStrategy,
            overriddenAccessProfileSelectionStrategy,
          );
    const overriddenAccessProfileSelectionHealthSignals = overrideServiceContext(
      AccessProfileSelectionHealthSignalsGateway,
      overrides,
    );
    const resolvedAccessProfileSelectionHealthSignals =
      overriddenAccessProfileSelectionHealthSignals === undefined
        ? yield* Layer.build(
            AccessProfileSelectionHealthSignalsGatewayLive.pipe(
              Layer.provide(contextServiceLayer(AccessHealthRuntime, context)),
            ),
          )
        : singleServiceContext(
            AccessProfileSelectionHealthSignalsGateway,
            overriddenAccessProfileSelectionHealthSignals,
          );
    const overriddenAccessProfileSelectionPolicy = overrideServiceContext(
      AccessProfileSelectionPolicy,
      overrides,
    );
    const resolvedAccessProfileSelectionPolicy =
      overriddenAccessProfileSelectionPolicy === undefined
        ? yield* Layer.build(
            AccessProfileSelectionPolicyLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  contextServiceLayer(
                    AccessProfileSelectionStrategy,
                    resolvedAccessProfileSelectionStrategy,
                  ),
                  contextServiceLayer(
                    AccessProfileSelectionHealthSignalsGateway,
                    resolvedAccessProfileSelectionHealthSignals,
                  ),
                  contextServiceLayer(AccessProfileRegistry, profileRegistryContext),
                ),
              ),
            ),
          )
        : singleServiceContext(
            AccessProfileSelectionPolicy,
            overriddenAccessProfileSelectionPolicy,
          );
    const resolvedAccessProgramLinker =
      overriddenAccessProgramLinker === undefined
        ? yield* Layer.build(
            AccessProgramLinkerLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  contextServiceLayer(AccessModuleRegistry, resolvedAccessModuleRegistry),
                  contextServiceLayer(AccessProviderRegistry, providerRegistryContext),
                  contextServiceLayer(AccessProfileRegistry, profileRegistryContext),
                  contextServiceLayer(
                    AccessProfileSelectionPolicy,
                    resolvedAccessProfileSelectionPolicy,
                  ),
                  contextServiceLayer(AccessSelectionPolicy, resolvedSelectionPolicy),
                ),
              ),
            ),
          )
        : singleServiceContext(AccessProgramLinker, overriddenAccessProgramLinker);
    const resolvedAccessExecutionRuntime =
      overriddenAccessExecutionRuntime === undefined
        ? yield* Layer.build(
            AccessExecutionRuntimeLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  contextServiceLayer(AccessProgramLinker, resolvedAccessProgramLinker),
                  contextServiceLayer(AccessProviderRegistry, providerRegistryContext),
                  contextServiceLayer(AccessSelectionPolicy, resolvedSelectionPolicy),
                  contextServiceLayer(
                    AccessProfileSelectionPolicy,
                    resolvedAccessProfileSelectionPolicy,
                  ),
                ),
              ),
            ),
          )
        : singleServiceContext(AccessExecutionRuntime, overriddenAccessExecutionRuntime);
    const overriddenAccessExecutionEngine = overrideServiceContext(
      AccessExecutionEngine,
      overrides,
    );
    const resolvedAccessExecutionEngine =
      overriddenAccessExecutionEngine === undefined
        ? yield* Layer.build(
            AccessExecutionEngineLive.pipe(
              Layer.provide(contextServiceLayer(AccessProviderRegistry, providerRegistryContext)),
            ),
          )
        : singleServiceContext(AccessExecutionEngine, overriddenAccessExecutionEngine);
    const overriddenAccessExecutionCoordinator = overrideServiceContext(
      AccessExecutionCoordinator,
      overrides,
    );
    const overriddenAccessResourceKernel = overrideServiceContext(AccessResourceKernel, overrides);
    const resolvedAccessResourceKernel =
      overriddenAccessResourceKernel === undefined
        ? yield* Layer.build(
            AccessResourceKernelLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  contextServiceLayer(EgressBroker, resolvedEgressBroker),
                  contextServiceLayer(IdentityBroker, resolvedIdentityBroker),
                ),
              ),
            ),
          )
        : singleServiceContext(AccessResourceKernel, overriddenAccessResourceKernel);
    const resolvedAccessExecutionCoordinator =
      overriddenAccessExecutionCoordinator === undefined
        ? yield* Layer.build(
            AccessExecutionCoordinatorLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  contextServiceLayer(AccessResourceKernel, resolvedAccessResourceKernel),
                  contextServiceLayer(AccessHealthGateway, resolvedAccessHealthGateway),
                  contextServiceLayer(AccessExecutionEngine, resolvedAccessExecutionEngine),
                ),
              ),
            ),
          )
        : singleServiceContext(AccessExecutionCoordinator, overriddenAccessExecutionCoordinator);

    return ServiceMap.mergeAll(
      resolvedSelectionHealthSignals,
      resolvedSelectionStrategy,
      resolvedSelectionPolicy,
      resolvedAccessHealthGateway,
      resolvedAccessModuleRegistry,
      resolvedAccessModuleComposition,
      resolvedAccessProfileRegistry,
      resolvedAccessProviderRegistry,
      resolvedEgressPluginRegistry,
      resolvedEgressBroker,
      resolvedIdentityPluginRegistry,
      resolvedIdentityBroker,
      resolvedAccessProfileSelectionStrategy,
      resolvedAccessProfileSelectionHealthSignals,
      resolvedAccessProfileSelectionPolicy,
      resolvedAccessProgramLinker,
      resolvedAccessExecutionRuntime,
      resolvedAccessExecutionEngine,
      resolvedAccessResourceKernel,
      resolvedAccessExecutionCoordinator,
    );
  });

function buildSdkRuntimeContext<ROut, E, RIn>(overrides?: Layer.Layer<ROut, E, RIn>) {
  if (overrides === undefined) {
    return Layer.build(Layer.fresh(SdkRuntimeLive));
  }

  return Effect.gen(function* () {
    const defaults = yield* Layer.build(Layer.fresh(SdkRuntimeLive));
    const overrideContext = yield* Layer.build(Layer.fresh(overrides)).pipe(
      Effect.provide(defaults),
    );
    const seededContext = ServiceMap.merge(defaults, overrideContext);
    const rebuiltDerived = yield* rebuildDerivedRuntimeServices(seededContext, overrideContext);
    return ServiceMap.merge(ServiceMap.merge(seededContext, rebuiltDerived), overrideContext);
  });
}

function buildSdkEnvironmentContext<ROut, E, RIn>(overrides?: Layer.Layer<ROut, E, RIn>) {
  return Effect.gen(function* () {
    const runtimeContext = yield* buildSdkRuntimeContext(overrides);
    const fetchService = ServiceMap.getOrUndefined(runtimeContext, FetchService);
    if (fetchService !== undefined) {
      return runtimeContext;
    }

    const fetchServiceContext = yield* Layer.build(Layer.fresh(FetchServiceLive));
    return ServiceMap.merge(runtimeContext, fetchServiceContext);
  });
}

export function makeSdkRuntimeHandle<ROut, E, RIn>(
  overrides?: Layer.Layer<ROut, E, RIn>,
): Effect.Effect<SdkRuntimeHandle, never, Scope.Scope> {
  return Effect.gen(function* () {
    const runtimeContext = yield* buildSdkRuntimeContext(overrides);
    const environmentContext = yield* buildSdkEnvironmentContextFromRuntime(runtimeContext);

    return {
      provideRuntime: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provide(runtimeContext)) as Effect.Effect<A, E, WithoutSdkRuntime<R>>,
      provideEnvironment: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provide(environmentContext)) as Effect.Effect<
          A,
          E,
          WithoutSdkEnvironment<R>
        >,
    } satisfies SdkRuntimeHandle;
  }) as Effect.Effect<SdkRuntimeHandle, never, Scope.Scope>;
}

function buildSdkEnvironmentContextFromRuntime<R>(runtimeContext: ServiceMap.ServiceMap<R>) {
  return Effect.gen(function* () {
    const fetchService = ServiceMap.getOrUndefined(runtimeContext, FetchService);
    if (fetchService !== undefined) {
      return runtimeContext;
    }

    const fetchServiceContext = yield* Layer.build(Layer.fresh(FetchServiceLive));
    return ServiceMap.merge(runtimeContext, fetchServiceContext);
  });
}

export function provideSdkRuntime<A, E, R, ROut, E2, RIn>(
  effect: Effect.Effect<A, E, R>,
  overrides?: Layer.Layer<ROut, E2, RIn>,
): Effect.Effect<A, E, WithoutSdkRuntime<R>> {
  return Effect.scoped(
    Effect.gen(function* () {
      const runtimeContext = yield* buildSdkRuntimeContext(overrides);
      return yield* effect.pipe(Effect.provide(runtimeContext));
    }),
  ) as Effect.Effect<A, E, WithoutSdkRuntime<R>>;
}

export function provideSdkEnvironment<A, E, R, ROut, E2, RIn>(
  effect: Effect.Effect<A, E, R>,
  overrides?: Layer.Layer<ROut, E2, RIn>,
): Effect.Effect<A, E, WithoutSdkEnvironment<R>> {
  return Effect.scoped(
    Effect.gen(function* () {
      const environmentContext = yield* buildSdkEnvironmentContext(overrides);
      return yield* effect.pipe(Effect.provide(environmentContext));
    }),
  ) as Effect.Effect<A, E, WithoutSdkEnvironment<R>>;
}
