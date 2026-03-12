import { Effect, Layer, Option, ServiceMap } from "effect";
import { type AccessHealthSnapshot } from "@effect-scrapling/foundation-core/access-health-runtime";
import {
  BuiltinAccessProviderDescriptors,
  type AccessProviderDescriptor,
  AccessProviderRegistry,
  makeAccessProviderRegistryLive,
} from "./access-provider-runtime.ts";
import {
  DEFAULT_BROWSER_PROVIDER_ID,
  DEFAULT_HTTP_PROVIDER_ID,
  DEFAULT_STEALTH_BROWSER_PROVIDER_ID,
} from "./access-provider-ids.ts";
import { resolveModeDefaultProviderId } from "./access-default-provider.ts";
export {
  DEFAULT_BROWSER_PROVIDER_ID,
  DEFAULT_HTTP_PROVIDER_ID,
  DEFAULT_STEALTH_BROWSER_PROVIDER_ID,
} from "./access-provider-ids.ts";
import { InvalidInputError } from "./errors.ts";
import {
  AccessSelectionHealthSignalsGateway,
  type AccessSelectionHealthSignals,
} from "./access-selection-health-runtime.ts";
import {
  AccessSelectionStrategy,
  AccessSelectionStrategyLive,
  makeHealthyFirstAccessSelectionStrategy,
  type AccessSelectionCandidate,
  type AccessSelectionStrategyDecision,
} from "./access-selection-strategy-runtime.ts";
import { makePreferredPathOverrideWarning } from "./access-health-warning-runtime.ts";
import { type AccessExecutionProfile, type AccessMode, type AccessProviderId } from "./schemas.ts";
import { SharedAccessHealthSignalsLive } from "./access-health-shared-runtime.ts";

export type AccessSelectionInput = {
  readonly url: string;
  readonly defaultProviderId: AccessProviderId;
  readonly defaultMode?: AccessMode | undefined;
  readonly allowUnregisteredDefaultProviderFallback?: boolean | undefined;
  readonly execution?: AccessExecutionProfile | undefined;
};

export type AccessSelectionDecision = {
  readonly providerId: AccessProviderId;
  readonly mode: AccessMode;
  readonly warnings: ReadonlyArray<string>;
};

function hostnameFromSelectionUrl(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function snapshotIsQuarantined(snapshot: AccessHealthSnapshot) {
  return snapshot.quarantinedUntil !== null && Date.parse(snapshot.quarantinedUntil) > Date.now();
}

function preferredProviderIsLessHealthy(input: {
  readonly preferredProviderId: AccessProviderId;
  readonly selectedProviderId: AccessProviderId;
  readonly healthSignals: AccessSelectionHealthSignals;
}) {
  if (input.preferredProviderId === input.selectedProviderId) {
    return false;
  }

  const preferredSnapshot = input.healthSignals.providers[input.preferredProviderId];
  const selectedSnapshot = input.healthSignals.providers[input.selectedProviderId];

  if (
    preferredSnapshot !== undefined &&
    selectedSnapshot !== undefined &&
    snapshotIsQuarantined(preferredSnapshot) !== snapshotIsQuarantined(selectedSnapshot)
  ) {
    return snapshotIsQuarantined(preferredSnapshot) && !snapshotIsQuarantined(selectedSnapshot);
  }

  return (preferredSnapshot?.score ?? 100) < (selectedSnapshot?.score ?? 100);
}

function uniqueProviderIds(providerIds: ReadonlyArray<AccessProviderId>) {
  return [...new Set(providerIds)];
}

function candidateProviders(input: {
  readonly targetMode: AccessMode;
  readonly defaultProviderId: AccessProviderId;
  readonly defaultHttpProviderId: AccessProviderId;
  readonly defaultBrowserProviderId: AccessProviderId;
  readonly providerModes: Readonly<Partial<Record<AccessProviderId, AccessMode>>>;
}) {
  if (input.targetMode === "http") {
    return uniqueProviderIds(
      [
        ...(input.providerModes[input.defaultProviderId] !== "browser"
          ? [input.defaultProviderId]
          : []),
        input.defaultHttpProviderId,
      ].filter((providerId) => input.providerModes[providerId] === "http"),
    );
  }

  return uniqueProviderIds(
    [
      ...(input.providerModes[input.defaultProviderId] !== "http" ? [input.defaultProviderId] : []),
      input.defaultBrowserProviderId,
    ].filter((providerId) => input.providerModes[providerId] === "browser"),
  );
}

function withHealthWarnings(input: {
  readonly url: string;
  readonly selectedProviderId: AccessProviderId;
  readonly preferredProviderId: AccessProviderId;
  readonly healthSignals: AccessSelectionHealthSignals;
  readonly selectionRationale: AccessSelectionStrategyDecision["rationale"];
}) {
  const warnings = new Array<string>();

  if (snapshotIsQuarantined(input.healthSignals.domain)) {
    const hostname = hostnameFromSelectionUrl(input.url);
    warnings.push(
      hostname === undefined
        ? "Selection target domain is currently quarantined in access health state."
        : `Domain "${hostname}" is currently quarantined in access health state.`,
    );
  }

  const selectedProviderSnapshot = input.healthSignals.providers[input.selectedProviderId];
  if (selectedProviderSnapshot && snapshotIsQuarantined(selectedProviderSnapshot)) {
    warnings.push(
      `Provider "${input.selectedProviderId}" is currently quarantined in access health state.`,
    );
  }

  if (
    input.selectedProviderId !== input.preferredProviderId &&
    input.selectionRationale === "health-signals" &&
    preferredProviderIsLessHealthy({
      preferredProviderId: input.preferredProviderId,
      selectedProviderId: input.selectedProviderId,
      healthSignals: input.healthSignals,
    })
  ) {
    warnings.push(
      makePreferredPathOverrideWarning({
        kind: "provider",
        selectedId: input.selectedProviderId,
        preferredId: input.preferredProviderId,
      }),
    );
  }

  return warnings;
}

function invalidExecution(message: string, details?: string) {
  return new InvalidInputError({
    message,
    ...(details === undefined ? {} : { details }),
  });
}

function validateProviderId(
  providerId: AccessProviderId,
): Effect.Effect<AccessProviderId, InvalidInputError> {
  return /\s/gu.test(providerId)
    ? Effect.fail(
        invalidExecution(
          "Invalid provider id",
          `Provider "${providerId}" must be a canonical identifier without whitespace.`,
        ),
      )
    : Effect.succeed(providerId);
}

function inferRequestedMode(
  execution?: AccessExecutionProfile | undefined,
): Effect.Effect<AccessMode | undefined, InvalidInputError> {
  return Effect.gen(function* () {
    const usesBrowserOptions =
      execution?.browser !== undefined || execution?.browserRuntimeProfileId !== undefined;
    const usesHttpOptions = execution?.http !== undefined;
    const explicitMode = execution?.mode;
    if (explicitMode !== undefined) {
      if (explicitMode === "browser" && usesHttpOptions) {
        return yield* Effect.fail(
          invalidExecution(
            "Execution mode/options mismatch",
            'Mode "browser" cannot be combined with HTTP execution options.',
          ),
        );
      }

      if (explicitMode === "http" && usesBrowserOptions) {
        return yield* Effect.fail(
          invalidExecution(
            "Execution mode/options mismatch",
            'Mode "http" cannot be combined with browser execution options.',
          ),
        );
      }

      return explicitMode;
    }

    if (usesBrowserOptions && usesHttpOptions) {
      return yield* Effect.fail(
        invalidExecution(
          "Execution mode is ambiguous",
          "Specify execution.mode when mixing browser and HTTP execution options.",
        ),
      );
    }

    if (usesBrowserOptions) {
      return "browser";
    }

    if (usesHttpOptions) {
      return "http";
    }

    return undefined;
  });
}

export function makeStaticAccessSelectionPolicy(input?: {
  readonly providerRegistry?:
    | {
        readonly findDescriptor: (
          providerId: AccessProviderId,
        ) => Effect.Effect<AccessProviderDescriptor | undefined>;
      }
    | undefined;
  readonly defaultHttpProviderId?: AccessProviderId | undefined;
  readonly defaultBrowserProviderId?: AccessProviderId | undefined;
  readonly healthSignals?:
    | {
        readonly inspect: (
          input: AccessSelectionInput & {
            readonly providerIds: ReadonlyArray<AccessProviderId>;
          },
        ) => Effect.Effect<AccessSelectionHealthSignals, never, never>;
      }
    | undefined;
  readonly selectionStrategy?:
    | {
        readonly selectCandidate: (input: {
          readonly url: string;
          readonly mode: AccessMode;
          readonly preferredProviderId: AccessProviderId;
          readonly candidates: ReadonlyArray<AccessSelectionCandidate>;
          readonly healthSignals: AccessSelectionHealthSignals;
        }) => Effect.Effect<AccessSelectionStrategyDecision, never>;
      }
    | undefined;
}) {
  const builtinDescriptorsById = Object.fromEntries(
    BuiltinAccessProviderDescriptors.map((descriptor) => [descriptor.id, descriptor] as const),
  ) as Readonly<Record<AccessProviderId, AccessProviderDescriptor>>;
  const providerRegistry =
    input?.providerRegistry ??
    ({
      findDescriptor: (providerId) => Effect.succeed(builtinDescriptorsById[providerId]),
    } satisfies {
      readonly findDescriptor: (
        providerId: AccessProviderId,
      ) => Effect.Effect<AccessProviderDescriptor | undefined>;
    });
  const defaultHttpProviderId = input?.defaultHttpProviderId ?? DEFAULT_HTTP_PROVIDER_ID;
  const defaultBrowserProviderId = input?.defaultBrowserProviderId ?? DEFAULT_BROWSER_PROVIDER_ID;
  const healthSignals =
    input?.healthSignals ??
    ({
      inspect: ({ url, providerIds }) =>
        Effect.succeed({
          domain: {
            subject: {
              kind: "domain",
              domain: hostnameFromSelectionUrl(url) ?? "invalid-selection-target.local",
            },
            successCount: 0,
            failureCount: 0,
            successStreak: 0,
            failureStreak: 0,
            score: 100,
            quarantinedUntil: null,
          } satisfies AccessHealthSnapshot,
          providers: Object.fromEntries(
            providerIds.map((providerId) => [
              providerId,
              {
                subject: {
                  kind: "provider",
                  providerId,
                },
                successCount: 0,
                failureCount: 0,
                successStreak: 0,
                failureStreak: 0,
                score: 100,
                quarantinedUntil: null,
              } satisfies AccessHealthSnapshot,
            ]),
          ),
        }),
    } satisfies {
      readonly inspect: (
        input: AccessSelectionInput & {
          readonly providerIds: ReadonlyArray<AccessProviderId>;
        },
      ) => Effect.Effect<AccessSelectionHealthSignals, never, never>;
    });
  const selectionStrategy = input?.selectionStrategy ?? makeHealthyFirstAccessSelectionStrategy();

  return {
    resolveSelection: (input: AccessSelectionInput) =>
      Effect.gen(function* () {
        const requestedMode = yield* inferRequestedMode(input.execution);
        const requestedProviderId = input.execution?.providerId;
        const targetMode = requestedMode ?? input.defaultMode ?? "http";
        yield* validateProviderId(input.defaultProviderId);
        if (requestedProviderId !== undefined) {
          yield* validateProviderId(requestedProviderId);
        }

        const providerMode = (providerId: AccessProviderId) =>
          providerRegistry
            .findDescriptor(providerId)
            .pipe(Effect.map((descriptor) => descriptor?.capabilities.mode));

        const ensureKnownProvider = (providerId: AccessProviderId) =>
          providerRegistry
            .findDescriptor(providerId)
            .pipe(
              Effect.flatMap((descriptor) =>
                descriptor === undefined
                  ? Effect.fail(
                      invalidExecution(
                        "Unknown access provider",
                        `No access provider named "${providerId}" is registered.`,
                      ),
                    )
                  : Effect.succeed(descriptor),
              ),
            );

        const resolveProviderModes = (providerIds: ReadonlyArray<AccessProviderId>) =>
          Effect.all(
            providerIds.map((providerId) =>
              providerMode(providerId).pipe(Effect.map((mode) => [providerId, mode] as const)),
            ),
          ).pipe(
            Effect.map(
              (entries) =>
                Object.fromEntries(entries) as Readonly<
                  Partial<Record<AccessProviderId, AccessMode>>
                >,
            ),
          );

        const resolveProviderId = (): Effect.Effect<AccessProviderId, InvalidInputError> => {
          if (requestedProviderId !== undefined) {
            return Effect.gen(function* () {
              const requestedProvider = yield* ensureKnownProvider(requestedProviderId);
              const requestedProviderMode = requestedProvider.capabilities.mode;
              if (targetMode !== requestedProviderMode) {
                return yield* Effect.fail(
                  invalidExecution(
                    "Execution mode does not match provider",
                    `Mode "${targetMode}" cannot be served by provider "${requestedProviderId}".`,
                  ),
                );
              }

              return requestedProviderId;
            });
          }

          return Effect.gen(function* () {
            const configuredProvider = yield* providerRegistry.findDescriptor(
              input.defaultProviderId,
            );
            if (
              configuredProvider === undefined &&
              input.allowUnregisteredDefaultProviderFallback !== true
            ) {
              return yield* Effect.fail(
                invalidExecution(
                  "Unknown access provider",
                  `No access provider named "${input.defaultProviderId}" is registered.`,
                ),
              );
            }
            const providerModes = yield* resolveProviderModes([
              input.defaultProviderId,
              defaultHttpProviderId,
              defaultBrowserProviderId,
            ]);
            const candidates = candidateProviders({
              targetMode,
              defaultProviderId: input.defaultProviderId,
              defaultHttpProviderId,
              defaultBrowserProviderId,
              providerModes,
            });
            const fallbackProviderId =
              targetMode === "http" ? defaultHttpProviderId : defaultBrowserProviderId;
            const resolvedProviderId = candidates[0] ?? fallbackProviderId;
            yield* ensureKnownProvider(resolvedProviderId);
            return resolvedProviderId;
          });
        };

        const preferredProviderId = yield* resolveProviderId();
        const preferredProvider = yield* ensureKnownProvider(preferredProviderId);
        const mode = targetMode;
        if (preferredProvider.capabilities.mode !== mode) {
          return yield* Effect.fail(
            invalidExecution(
              "Selected provider does not match execution mode",
              `Provider "${preferredProviderId}" serves mode "${preferredProvider.capabilities.mode}", not "${mode}".`,
            ),
          );
        }

        if (requestedProviderId !== undefined) {
          const explicitWarnings = yield* healthSignals
            .inspect({
              ...input,
              providerIds: [preferredProviderId],
            })
            .pipe(
              Effect.map((resolvedHealthSignals) =>
                withHealthWarnings({
                  url: input.url,
                  selectedProviderId: preferredProviderId,
                  preferredProviderId,
                  healthSignals: resolvedHealthSignals,
                  selectionRationale: "preferred",
                }),
              ),
            );

          return {
            providerId: preferredProviderId,
            mode,
            warnings: explicitWarnings,
          } satisfies AccessSelectionDecision;
        }

        const providerModes = yield* resolveProviderModes([
          input.defaultProviderId,
          defaultHttpProviderId,
          defaultBrowserProviderId,
        ]);
        const candidates = candidateProviders({
          targetMode: mode,
          defaultProviderId: input.defaultProviderId,
          defaultHttpProviderId,
          defaultBrowserProviderId,
          providerModes,
        });
        yield* Effect.forEach(candidates, ensureKnownProvider, { discard: true });
        const resolvedHealthSignals = yield* healthSignals.inspect({
          ...input,
          providerIds: candidates,
        });
        const selectionDecision = yield* selectionStrategy.selectCandidate({
          url: input.url,
          mode,
          preferredProviderId,
          candidates: candidates.map((candidate, inputOrder) => ({
            providerId: candidate,
            mode,
            inputOrder,
            preferred: candidate === preferredProviderId,
          })),
          healthSignals: resolvedHealthSignals,
        });
        const healthyCandidate = selectionDecision.providerId;
        if (!candidates.includes(healthyCandidate)) {
          return yield* Effect.fail(
            invalidExecution(
              "Selection strategy returned an invalid provider",
              `Strategy selected "${healthyCandidate}" which is not one of the computed candidates: ${candidates.join(", ")}.`,
            ),
          );
        }
        const validatedCandidate = yield* ensureKnownProvider(healthyCandidate);
        if (validatedCandidate.capabilities.mode !== mode) {
          return yield* Effect.fail(
            invalidExecution(
              "Selection strategy returned a provider in the wrong lane",
              `Strategy selected "${healthyCandidate}" for mode "${mode}" but the provider serves "${validatedCandidate.capabilities.mode}".`,
            ),
          );
        }

        return {
          providerId: healthyCandidate,
          mode,
          warnings: withHealthWarnings({
            url: input.url,
            selectedProviderId: healthyCandidate,
            preferredProviderId,
            healthSignals: resolvedHealthSignals,
            selectionRationale: selectionDecision.rationale,
          }),
        } satisfies AccessSelectionDecision;
      }),
  } satisfies {
    readonly resolveSelection: (
      input: AccessSelectionInput,
    ) => Effect.Effect<AccessSelectionDecision, InvalidInputError>;
  };
}

export class AccessSelectionPolicy extends ServiceMap.Service<
  AccessSelectionPolicy,
  {
    readonly resolveSelection: (
      input: AccessSelectionInput,
    ) => Effect.Effect<AccessSelectionDecision, InvalidInputError>;
  }
>()("@effect-scrapling/sdk/AccessSelectionPolicy") {}

export const AccessSelectionPolicyLive = Layer.succeed(AccessSelectionPolicy, {
  resolveSelection: (input: AccessSelectionInput) =>
    Effect.gen(function* () {
      const healthSignalsGateway = Option.getOrUndefined(
        yield* Effect.serviceOption(AccessSelectionHealthSignalsGateway),
      );
      const providerRegistry = Option.getOrUndefined(
        yield* Effect.serviceOption(AccessProviderRegistry),
      );
      const selectionStrategy = Option.getOrUndefined(
        yield* Effect.serviceOption(AccessSelectionStrategy),
      );
      const liveDefaults =
        providerRegistry === undefined
          ? {}
          : yield* providerRegistry.listDescriptors().pipe(
              Effect.map((descriptors) => {
                const providerIdsByMode = {
                  http: descriptors
                    .filter((descriptor) => descriptor.capabilities.mode === "http")
                    .map((descriptor) => descriptor.id),
                  browser: descriptors
                    .filter((descriptor) => descriptor.capabilities.mode === "browser")
                    .map((descriptor) => descriptor.id),
                } as const;
                providerIdsByMode.http.sort();
                providerIdsByMode.browser.sort();

                return {
                  ...(providerIdsByMode.http.length === 0
                    ? {}
                    : {
                        defaultHttpProviderId: resolveModeDefaultProviderId({
                          mode: "http",
                          providers: descriptors,
                        }),
                      }),
                  ...(providerIdsByMode.browser.length === 0
                    ? {}
                    : {
                        defaultBrowserProviderId: resolveModeDefaultProviderId({
                          mode: "browser",
                          providers: descriptors,
                        }),
                      }),
                };
              }),
            );

      return yield* makeStaticAccessSelectionPolicy({
        ...(providerRegistry === undefined ? {} : { providerRegistry }),
        ...liveDefaults,
        ...(healthSignalsGateway === undefined
          ? {}
          : {
              healthSignals: {
                inspect: ({ url, providerIds }) =>
                  healthSignalsGateway.inspect({
                    url,
                    providerIds,
                  }),
              },
            }),
        ...(selectionStrategy === undefined ? {} : { selectionStrategy }),
      }).resolveSelection(input);
    }),
});

const SharedAccessProviderRegistryLive = makeAccessProviderRegistryLive();

export const AccessSelectionPolicyEnvironmentLive = Layer.mergeAll(
  SharedAccessProviderRegistryLive,
  SharedAccessHealthSignalsLive,
  AccessSelectionStrategyLive,
  AccessSelectionPolicyLive,
);
