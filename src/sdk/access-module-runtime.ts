import { Effect, ServiceMap } from "effect";
import { InvalidInputError } from "./errors.ts";
import {
  type EgressAllocationPlugin,
  type IdentityAllocationPlugin,
} from "./access-allocation-plugin-runtime.ts";
import {
  type ResolvedEgressProfile,
  type ResolvedIdentityProfile,
} from "./access-profile-runtime.ts";
import { type AccessProvider, type AccessProviderDescriptor } from "./access-provider-runtime.ts";
import { type AccessProviderId } from "./schemas.ts";

export type AccessRuntimeModule = {
  readonly id: string;
  readonly providers?: Readonly<Record<AccessProviderId, AccessProvider>> | undefined;
  readonly egressPlugins?: Readonly<Record<string, EgressAllocationPlugin<unknown>>> | undefined;
  readonly identityPlugins?:
    | Readonly<Record<string, IdentityAllocationPlugin<unknown>>>
    | undefined;
  readonly egressProfiles?: Readonly<Record<string, ResolvedEgressProfile>> | undefined;
  readonly identityProfiles?: Readonly<Record<string, ResolvedIdentityProfile>> | undefined;
};

export function defineAccessRuntimeModule(module: AccessRuntimeModule): AccessRuntimeModule {
  return module;
}

export type AccessRuntimeModuleComposition = {
  readonly modules: ReadonlyArray<AccessRuntimeModule>;
  readonly providers: Readonly<Record<AccessProviderId, AccessProvider>>;
  readonly providerDescriptors: Readonly<Record<AccessProviderId, AccessProviderDescriptor>>;
  readonly egressPlugins: Readonly<Record<string, EgressAllocationPlugin<unknown>>>;
  readonly identityPlugins: Readonly<Record<string, IdentityAllocationPlugin<unknown>>>;
  readonly egressProfiles: Readonly<Record<string, ResolvedEgressProfile>>;
  readonly identityProfiles: Readonly<Record<string, ResolvedIdentityProfile>>;
};

export class AccessModuleComposition extends ServiceMap.Service<
  AccessModuleComposition,
  AccessRuntimeModuleComposition
>()("@effect-scrapling/sdk/AccessModuleComposition") {}

function invalidModule(message: string, details?: string) {
  return new InvalidInputError({
    message,
    ...(details === undefined ? {} : { details }),
  });
}

function validateModuleId(moduleId: string) {
  const normalized = moduleId.trim();
  if (normalized.length === 0) {
    return Effect.fail(
      invalidModule(
        "Invalid access runtime module",
        "Access runtime module ids must be non-empty.",
      ),
    );
  }

  return Effect.succeed(normalized);
}

function mergeContributionRecord<Value>(input: {
  readonly contributionName:
    | "provider"
    | "egress plugin"
    | "identity plugin"
    | "egress profile"
    | "identity profile";
  readonly modules: ReadonlyArray<AccessRuntimeModule>;
  readonly readRecord: (module: AccessRuntimeModule) => Readonly<Record<string, Value>> | undefined;
  readonly readEmbeddedId: (value: Value) => string;
}) {
  return Effect.gen(function* () {
    const merged = new Map<string, { readonly value: Value; readonly moduleId: string }>();

    for (const candidate of input.modules) {
      const moduleId = yield* validateModuleId(candidate.id);
      const record = input.readRecord(candidate);
      if (record === undefined) {
        continue;
      }

      for (const [key, value] of Object.entries(record)) {
        const embeddedId = input.readEmbeddedId(value).trim();
        if (embeddedId.length === 0) {
          return yield* Effect.fail(
            invalidModule(
              `Invalid ${input.contributionName} id`,
              `Access runtime module "${moduleId}" registered ${input.contributionName} "${key}" with an empty embedded id.`,
            ),
          );
        }

        if (embeddedId !== key) {
          return yield* Effect.fail(
            invalidModule(
              `Mismatched ${input.contributionName} id`,
              `Access runtime module "${moduleId}" registered ${input.contributionName} map key "${key}" but the contributed value reports id "${embeddedId}".`,
            ),
          );
        }

        const existing = merged.get(key);
        if (existing !== undefined) {
          return yield* Effect.fail(
            invalidModule(
              `Duplicate ${input.contributionName} id`,
              `Access runtime module "${moduleId}" tried to register ${input.contributionName} "${key}" which is already provided by module "${existing.moduleId}".`,
            ),
          );
        }

        merged.set(key, { value, moduleId });
      }
    }

    return Object.freeze(
      Object.fromEntries([...merged.entries()].map(([key, entry]) => [key, entry.value])),
    ) as Readonly<Record<string, Value>>;
  });
}

export function composeAccessRuntimeModules(
  modules: ReadonlyArray<AccessRuntimeModule>,
): Effect.Effect<AccessRuntimeModuleComposition, InvalidInputError> {
  return Effect.gen(function* () {
    const normalizedModules = new Array<AccessRuntimeModule>();
    for (const module of modules) {
      const moduleId = yield* validateModuleId(module.id);
      normalizedModules.push({
        ...module,
        id: moduleId,
      } satisfies AccessRuntimeModule);
    }

    const providers = (yield* mergeContributionRecord<AccessProvider>({
      contributionName: "provider",
      modules: normalizedModules,
      readRecord: (module) => module.providers,
      readEmbeddedId: (provider) => provider.id,
    })) as Readonly<Record<AccessProviderId, AccessProvider>>;
    const providerDescriptors = Object.freeze(
      Object.fromEntries(
        Object.values(providers).map((provider) => [
          provider.id,
          {
            id: provider.id,
            capabilities: provider.capabilities,
          } satisfies AccessProviderDescriptor,
        ]),
      ),
    ) as Readonly<Record<AccessProviderId, AccessProviderDescriptor>>;
    const egressPlugins = yield* mergeContributionRecord<EgressAllocationPlugin<unknown>>({
      contributionName: "egress plugin",
      modules: normalizedModules,
      readRecord: (module) => module.egressPlugins,
      readEmbeddedId: (plugin) => plugin.id,
    });
    const identityPlugins = yield* mergeContributionRecord<IdentityAllocationPlugin<unknown>>({
      contributionName: "identity plugin",
      modules: normalizedModules,
      readRecord: (module) => module.identityPlugins,
      readEmbeddedId: (plugin) => plugin.id,
    });
    const egressProfiles = yield* mergeContributionRecord<ResolvedEgressProfile>({
      contributionName: "egress profile",
      modules: normalizedModules,
      readRecord: (module) => module.egressProfiles,
      readEmbeddedId: (profile) => profile.profileId,
    });
    const identityProfiles = yield* mergeContributionRecord<ResolvedIdentityProfile>({
      contributionName: "identity profile",
      modules: normalizedModules,
      readRecord: (module) => module.identityProfiles,
      readEmbeddedId: (profile) => profile.profileId,
    });

    const unresolvedEgressPlugin = Object.values(egressProfiles).find(
      (profile) => egressPlugins[profile.pluginId] === undefined,
    );
    if (unresolvedEgressPlugin !== undefined) {
      return yield* Effect.fail(
        invalidModule(
          "Unknown egress plugin reference",
          `Egress profile "${unresolvedEgressPlugin.profileId}" references plugin "${unresolvedEgressPlugin.pluginId}" but no module provides it.`,
        ),
      );
    }

    const unresolvedIdentityPlugin = Object.values(identityProfiles).find(
      (profile) => identityPlugins[profile.pluginId] === undefined,
    );
    if (unresolvedIdentityPlugin !== undefined) {
      return yield* Effect.fail(
        invalidModule(
          "Unknown identity plugin reference",
          `Identity profile "${unresolvedIdentityPlugin.profileId}" references plugin "${unresolvedIdentityPlugin.pluginId}" but no module provides it.`,
        ),
      );
    }

    return {
      modules: Object.freeze([...normalizedModules]),
      providers,
      providerDescriptors,
      egressPlugins,
      identityPlugins,
      egressProfiles,
      identityProfiles,
    } satisfies AccessRuntimeModuleComposition;
  });
}

export function makeStaticAccessModuleRegistry(input: {
  readonly modules: ReadonlyArray<AccessRuntimeModule>;
}) {
  return {
    listModules: () => Effect.succeed(input.modules),
    compose: () => composeAccessRuntimeModules(input.modules),
  } satisfies {
    readonly listModules: () => Effect.Effect<ReadonlyArray<AccessRuntimeModule>, never>;
    readonly compose: () => Effect.Effect<AccessRuntimeModuleComposition, InvalidInputError>;
  };
}

export class AccessModuleRegistry extends ServiceMap.Service<
  AccessModuleRegistry,
  {
    readonly listModules: () => Effect.Effect<ReadonlyArray<AccessRuntimeModule>, never>;
    readonly compose: () => Effect.Effect<AccessRuntimeModuleComposition, InvalidInputError>;
  }
>()("@effect-scrapling/sdk/AccessModuleRegistry") {}
