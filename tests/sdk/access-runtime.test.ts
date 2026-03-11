import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Layer } from "effect";
import {
  AccessModuleRegistry,
  makeStaticAccessModuleRegistry,
} from "../../src/sdk/access-module-runtime.ts";
import { AccessProgramLinkerLive } from "../../src/sdk/access-program-linker.ts";
import {
  type AccessProvider,
  type AccessProviderDescriptor,
  AccessProviderRegistry,
  makeAccessProviderRegistryLive,
  makeStaticAccessProviderRegistry,
} from "../../src/sdk/access-provider-runtime.ts";
import {
  AccessSelectionPolicyLive,
  AccessSelectionPolicy,
  makeStaticAccessSelectionPolicy,
  type AccessSelectionInput,
} from "../../src/sdk/access-policy-runtime.ts";
import { AccessHealthRuntimeLive } from "../../src/sdk/access-health-runtime-service.ts";
import {
  AccessProfileRegistryLive,
  DEFAULT_STEALTH_IDENTITY_PROFILE_ID,
} from "../../src/sdk/access-profile-runtime.ts";
import { AccessProfileSelectionPolicyLive } from "../../src/sdk/access-profile-policy-runtime.ts";
import { AccessProfileSelectionHealthSignalsGatewayLive } from "../../src/sdk/access-profile-selection-health-runtime.ts";
import { AccessProfileSelectionStrategyLive } from "../../src/sdk/access-profile-selection-strategy-runtime.ts";
import { type InvalidInputError } from "../../src/sdk/errors.ts";
import { AccessSelectionHealthSignalsGatewayLive } from "../../src/sdk/access-selection-health-runtime.ts";
import { AccessSelectionStrategyLive } from "../../src/sdk/access-selection-strategy-runtime.ts";
import {
  AccessExecutionRuntime,
  AccessExecutionRuntimeLive,
  DEFAULT_BROWSER_PROVIDER_ID,
  DEFAULT_HTTP_PROVIDER_ID,
  DEFAULT_STEALTH_BROWSER_PROVIDER_ID,
  materializeExecutionContext,
  toExecutionMetadata,
  type AccessExecutionInput,
  type ResolvedExecutionPlan,
} from "../../src/sdk/access-runtime.ts";

function makeDescriptorRegistry(descriptors: ReadonlyArray<AccessProviderDescriptor>) {
  const descriptorsById = Object.fromEntries(
    descriptors.map((descriptor) => [descriptor.id, descriptor] as const),
  ) as Readonly<Record<string, AccessProviderDescriptor>>;

  return {
    findDescriptor: (providerId: string) => Effect.succeed(descriptorsById[providerId]),
  };
}

function makeProviderRegistry(descriptors: ReadonlyArray<AccessProviderDescriptor>) {
  const providers = Object.fromEntries(
    descriptors.map((descriptor) => [
      descriptor.id,
      {
        id: descriptor.id,
        capabilities: descriptor.capabilities,
        execute: () =>
          Effect.die(
            new Error("Execution should not run during access-runtime selection-policy tests"),
          ),
      } satisfies AccessProvider,
    ]),
  ) as Readonly<Record<string, AccessProvider>>;

  return makeStaticAccessProviderRegistry(providers);
}

function makeAccessExecutionRuntimeLayer(
  providerRegistryLayer = makeAccessProviderRegistryLive(),
  selectionPolicyLayer: Layer.Layer<
    AccessSelectionPolicy,
    never,
    never
  > = AccessSelectionPolicyLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        providerRegistryLayer,
        AccessSelectionStrategyLive,
        AccessSelectionHealthSignalsGatewayLive.pipe(Layer.provide(AccessHealthRuntimeLive)),
      ),
    ),
  ),
) {
  return AccessExecutionRuntimeLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          AccessModuleRegistry,
          makeStaticAccessModuleRegistry({
            modules: [],
          }),
        ),
        AccessProgramLinkerLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                AccessModuleRegistry,
                makeStaticAccessModuleRegistry({
                  modules: [],
                }),
              ),
              providerRegistryLayer,
              selectionPolicyLayer,
              AccessProfileSelectionPolicyLive.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    AccessProfileRegistryLive,
                    AccessProfileSelectionStrategyLive,
                    AccessProfileSelectionHealthSignalsGatewayLive.pipe(
                      Layer.provide(AccessHealthRuntimeLive),
                    ),
                  ),
                ),
              ),
              AccessProfileRegistryLive,
            ),
          ),
        ),
        providerRegistryLayer,
        selectionPolicyLayer,
        AccessProfileSelectionPolicyLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              AccessProfileRegistryLive,
              AccessProfileSelectionStrategyLive,
              AccessProfileSelectionHealthSignalsGatewayLive.pipe(
                Layer.provide(AccessHealthRuntimeLive),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function resolveExecution(
  input: AccessExecutionInput,
): Effect.Effect<ResolvedExecutionPlan, InvalidInputError, never> {
  return Effect.gen(function* () {
    const runtime = yield* AccessExecutionRuntime;
    return yield* runtime.resolve(input);
  }).pipe(
    Effect.provide(makeAccessExecutionRuntimeLayer()),
    Effect.provide(AccessHealthRuntimeLive),
  ) as Effect.Effect<ResolvedExecutionPlan, InvalidInputError, never>;
}

function resolveExecutionWithSelectionPolicy(
  input: AccessExecutionInput,
  policy: {
    readonly resolveSelection: (input: AccessSelectionInput) => Effect.Effect<
      {
        readonly providerId: string;
        readonly mode: "http" | "browser";
        readonly warnings: ReadonlyArray<string>;
      },
      InvalidInputError
    >;
  },
  providerRegistry?: ReturnType<typeof makeStaticAccessProviderRegistry>,
) {
  const providerRegistryLayer =
    providerRegistry === undefined
      ? makeAccessProviderRegistryLive()
      : Layer.succeed(AccessProviderRegistry, providerRegistry);
  const selectionPolicyLayer = Layer.succeed(AccessSelectionPolicy, policy);

  return Effect.gen(function* () {
    const runtime = yield* AccessExecutionRuntime;
    return yield* runtime.resolve(input);
  }).pipe(
    Effect.provide(makeAccessExecutionRuntimeLayer(providerRegistryLayer, selectionPolicyLayer)),
    Effect.provide(AccessHealthRuntimeLive),
  ) as Effect.Effect<ResolvedExecutionPlan, InvalidInputError, never>;
}

describe("sdk access runtime", () => {
  it.effect("elevates browser mode into the browser provider lane and preserves overrides", () =>
    Effect.gen(function* () {
      const plan = yield* resolveExecution({
        url: "https://example.com/browser-preview",
        defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
        defaultTimeoutMs: 600,
        execution: {
          mode: "browser",
          browser: {
            waitUntil: "load",
            timeoutMs: 450,
            userAgent: "Browser Agent",
          },
        },
      });

      expect(plan.providerId).toBe(DEFAULT_BROWSER_PROVIDER_ID);
      expect(plan.mode).toBe("browser");
      expect(plan.timeoutMs).toBe(450);
      expect(plan.browser).toEqual(
        expect.objectContaining({
          runtimeProfileId: "patchright-default",
          waitUntil: "load",
          timeoutMs: 450,
          userAgent: "Browser Agent",
        }),
      );
      expect(plan.egress.profileId).toBe("direct");
      expect(plan.identity.profileId).toBe("default");
    }),
  );

  it.effect("adds browser fallback by default for unresolved HTTP preview flows", () =>
    Effect.gen(function* () {
      const plan = yield* resolveExecution({
        url: "https://example.com/default-http-preview",
        defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
        defaultTimeoutMs: 600,
      });

      expect(plan.providerId).toBe(DEFAULT_HTTP_PROVIDER_ID);
      expect(plan.mode).toBe("http");
      const browserFallback = plan.fallback?.browserOnAccessWall;
      expect(browserFallback).toEqual(
        expect.objectContaining({
          providerId: DEFAULT_BROWSER_PROVIDER_ID,
          mode: "browser",
        }),
      );
      expect(browserFallback?.browser).toEqual(
        expect.objectContaining({
          runtimeProfileId: "patchright-default",
          waitUntil: "domcontentloaded",
          timeoutMs: 600,
        }),
      );
    }),
  );

  it.effect(
    "keeps explicitly pinned HTTP executions on the HTTP lane unless fallback is enabled",
    () =>
      Effect.gen(function* () {
        const pinnedPlan = yield* resolveExecution({
          url: "https://example.com/pinned-http-preview",
          defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
          defaultTimeoutMs: 600,
          execution: {
            mode: "http",
          },
        });
        const optInPlan = yield* resolveExecution({
          url: "https://example.com/pinned-http-preview",
          defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
          defaultTimeoutMs: 600,
          execution: {
            mode: "http",
            fallback: {
              browserOnAccessWall: true,
            },
          },
        });

        expect(pinnedPlan.mode).toBe("http");
        expect(pinnedPlan.fallback).toBeUndefined();
        expect(optInPlan.fallback?.browserOnAccessWall).toEqual(
          expect.objectContaining({
            providerId: DEFAULT_BROWSER_PROVIDER_ID,
            mode: "browser",
          }),
        );
      }),
  );

  it.effect("rejects contradictory mode and provider combinations", () =>
    Effect.gen(function* () {
      const error = yield* resolveExecution({
        url: "https://example.com/provider-mismatch",
        defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
        defaultTimeoutMs: 600,
        execution: {
          mode: "browser",
          providerId: DEFAULT_HTTP_PROVIDER_ID,
        },
      }).pipe(
        Effect.match({
          onFailure: (invalidInputError) => invalidInputError,
          onSuccess: () => undefined,
        }),
      );

      expect(error?._tag).toBe("InvalidInputError");
      expect(error?.message).toBe("Execution mode does not match provider");
      expect(error?.details).toContain(`provider "${DEFAULT_HTTP_PROVIDER_ID}"`);
    }),
  );

  it.effect("fails for unknown egress and identity profiles", () =>
    Effect.gen(function* () {
      const unknownEgress = yield* resolveExecution({
        url: "https://example.com/egress-profile",
        defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
        defaultTimeoutMs: 600,
        execution: {
          egress: {
            profileId: "missing-egress",
          },
        },
      }).pipe(
        Effect.match({
          onFailure: (invalidInputError) => invalidInputError,
          onSuccess: () => undefined,
        }),
      );
      const unknownIdentity = yield* resolveExecution({
        url: "https://example.com/identity-profile",
        defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
        defaultTimeoutMs: 600,
        execution: {
          identity: {
            profileId: "missing-identity",
          },
        },
      }).pipe(
        Effect.match({
          onFailure: (invalidInputError) => invalidInputError,
          onSuccess: () => undefined,
        }),
      );

      expect(unknownEgress?.message).toBe("Unknown egress profile");
      expect(unknownIdentity?.message).toBe("Unknown identity profile");
    }),
  );

  it.effect("defaults stealth browser provider to stealth identity and domcontentloaded", () =>
    Effect.gen(function* () {
      const plan = yield* resolveExecution({
        url: "https://example.com/stealth-preview",
        defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
        defaultTimeoutMs: 1_500,
        execution: {
          providerId: DEFAULT_STEALTH_BROWSER_PROVIDER_ID,
        },
      });

      expect(plan.providerId).toBe(DEFAULT_STEALTH_BROWSER_PROVIDER_ID);
      expect(plan.mode).toBe("browser");
      expect(plan.identity.profileId).toBe(DEFAULT_STEALTH_IDENTITY_PROFILE_ID);
      expect(plan.browser).toEqual(
        expect.objectContaining({
          runtimeProfileId: "patchright-stealth",
          waitUntil: "domcontentloaded",
        }),
      );
      expect(plan.browser?.timeoutMs ?? plan.timeoutMs).toBe(1_500);

      const context = materializeExecutionContext({
        intent: plan,
        egress: {
          ...plan.egress,
          egressKey: "stealth-egress",
          release: Effect.void,
        },
        identity: {
          ...plan.identity,
          identityKey: "stealth-identity",
          release: Effect.void,
        },
      });

      expect(toExecutionMetadata(context)).toEqual({
        providerId: DEFAULT_STEALTH_BROWSER_PROVIDER_ID,
        mode: "browser",
        egressProfileId: "direct",
        egressPluginId: "builtin-direct-egress",
        egressRouteKind: "direct",
        egressRouteKey: "direct",
        egressPoolId: "direct-pool",
        egressRoutePolicyId: "direct-route",
        egressKey: "stealth-egress",
        identityProfileId: DEFAULT_STEALTH_IDENTITY_PROFILE_ID,
        identityPluginId: "builtin-stealth-identity",
        identityTenantId: "public",
        identityKey: "stealth-identity",
        browserRuntimeProfileId: "patchright-stealth",
        browserPoolKey: "browser-stealth::patchright-stealth::stealth-egress::stealth-identity",
      });
    }),
  );

  it.effect("infers browser mode from browser execution options", () =>
    Effect.gen(function* () {
      const plan = yield* resolveExecution({
        url: "https://example.com/browser-inferred",
        defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
        defaultTimeoutMs: 900,
        execution: {
          browser: {
            waitUntil: "commit",
          },
        },
      });

      expect(plan.providerId).toBe(DEFAULT_BROWSER_PROVIDER_ID);
      expect(plan.mode).toBe("browser");
      expect(plan.browser?.waitUntil).toBe("commit");
    }),
  );

  it.effect("requires explicit mode for custom providers", () =>
    Effect.gen(function* () {
      const failure = yield* resolveExecution({
        url: "https://example.com/custom-provider",
        defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
        defaultTimeoutMs: 900,
        execution: {
          providerId: "managed-unblocker",
        },
      }).pipe(
        Effect.match({
          onFailure: (invalidInputError) => invalidInputError,
          onSuccess: () => undefined,
        }),
      );

      expect(failure?._tag).toBe("InvalidInputError");
      expect(failure?.message).toBe("Unknown access provider");
    }),
  );

  it.effect("rejects browser mode when HTTP execution options are also supplied", () =>
    Effect.gen(function* () {
      const failure = yield* resolveExecution({
        url: "https://example.com/mixed-mode-browser",
        defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
        defaultTimeoutMs: 900,
        execution: {
          mode: "browser",
          http: {
            userAgent: "HTTP Agent",
          },
        },
      }).pipe(
        Effect.match({
          onFailure: (invalidInputError) => invalidInputError,
          onSuccess: () => undefined,
        }),
      );

      expect(failure?._tag).toBe("InvalidInputError");
      expect(failure?.message).toBe("Execution mode/options mismatch");
    }),
  );

  it.effect("rejects HTTP mode when browser execution options are also supplied", () =>
    Effect.gen(function* () {
      const failure = yield* resolveExecution({
        url: "https://example.com/mixed-mode-http",
        defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
        defaultTimeoutMs: 900,
        execution: {
          mode: "http",
          browser: {
            waitUntil: "commit",
          },
        },
      }).pipe(
        Effect.match({
          onFailure: (invalidInputError) => invalidInputError,
          onSuccess: () => undefined,
        }),
      );

      expect(failure?._tag).toBe("InvalidInputError");
      expect(failure?.message).toBe("Execution mode/options mismatch");
    }),
  );

  it.effect("accepts custom providers when execution mode is explicit", () =>
    Effect.gen(function* () {
      const customPolicy = makeStaticAccessSelectionPolicy({
        providerRegistry: makeDescriptorRegistry([
          {
            id: "managed-unblocker",
            capabilities: {
              mode: "browser",
              rendersDom: true,
            },
          },
          {
            id: DEFAULT_HTTP_PROVIDER_ID,
            capabilities: {
              mode: "http",
              rendersDom: false,
            },
          },
        ]),
      });
      const providerRegistry = makeProviderRegistry([
        {
          id: "managed-unblocker",
          capabilities: {
            mode: "browser",
            rendersDom: true,
          },
        },
        {
          id: DEFAULT_HTTP_PROVIDER_ID,
          capabilities: {
            mode: "http",
            rendersDom: false,
          },
        },
      ]);
      const plan = yield* resolveExecutionWithSelectionPolicy(
        {
          url: "https://example.com/custom-provider",
          defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
          defaultTimeoutMs: 900,
          execution: {
            mode: "browser",
            providerId: "managed-unblocker",
          },
        },
        customPolicy,
        providerRegistry,
      );

      expect(plan.providerId).toBe("managed-unblocker");
      expect(plan.mode).toBe("browser");
    }),
  );

  it.effect("preserves custom default providers when the explicit mode selects their lane", () =>
    Effect.gen(function* () {
      const customPolicy = makeStaticAccessSelectionPolicy({
        providerRegistry: makeDescriptorRegistry([
          {
            id: "managed-unblocker-browser",
            capabilities: {
              mode: "browser",
              rendersDom: true,
            },
          },
          {
            id: "managed-unblocker-http",
            capabilities: {
              mode: "http",
              rendersDom: false,
            },
          },
          {
            id: DEFAULT_BROWSER_PROVIDER_ID,
            capabilities: {
              mode: "browser",
              rendersDom: true,
            },
          },
          {
            id: DEFAULT_HTTP_PROVIDER_ID,
            capabilities: {
              mode: "http",
              rendersDom: false,
            },
          },
        ]),
      });
      const providerRegistry = makeProviderRegistry([
        {
          id: "managed-unblocker-browser",
          capabilities: {
            mode: "browser",
            rendersDom: true,
          },
        },
        {
          id: "managed-unblocker-http",
          capabilities: {
            mode: "http",
            rendersDom: false,
          },
        },
        {
          id: DEFAULT_BROWSER_PROVIDER_ID,
          capabilities: {
            mode: "browser",
            rendersDom: true,
          },
        },
        {
          id: DEFAULT_HTTP_PROVIDER_ID,
          capabilities: {
            mode: "http",
            rendersDom: false,
          },
        },
      ]);
      const browserPlan = yield* resolveExecutionWithSelectionPolicy(
        {
          url: "https://example.com/custom-default-browser",
          defaultProviderId: "managed-unblocker-browser",
          defaultTimeoutMs: 900,
          execution: {
            mode: "browser",
          },
        },
        customPolicy,
        providerRegistry,
      );
      const httpPlan = yield* resolveExecutionWithSelectionPolicy(
        {
          url: "https://example.com/custom-default-http",
          defaultProviderId: "managed-unblocker-http",
          defaultTimeoutMs: 900,
          execution: {
            mode: "http",
          },
        },
        customPolicy,
        providerRegistry,
      );

      expect(browserPlan.providerId).toBe("managed-unblocker-browser");
      expect(browserPlan.mode).toBe("browser");
      expect(httpPlan.providerId).toBe("managed-unblocker-http");
      expect(httpPlan.mode).toBe("http");
    }),
  );

  it.effect("fails malformed target URLs with a typed invalid-input error", () =>
    Effect.gen(function* () {
      const error = yield* resolveExecution({
        url: "not-a-valid-url",
        defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
        defaultTimeoutMs: 900,
      }).pipe(
        Effect.match({
          onFailure: (invalidInputError) => invalidInputError,
          onSuccess: () => undefined,
        }),
      );

      expect(error?._tag).toBe("InvalidInputError");
      expect(error?.message).toBe("Invalid target URL");
    }),
  );

  it.effect("rejects non-http target URLs with the same typed invalid-input error", () =>
    Effect.gen(function* () {
      const error = yield* resolveExecution({
        url: "ftp://example.com/file.txt",
        defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
        defaultTimeoutMs: 900,
      }).pipe(
        Effect.match({
          onFailure: (invalidInputError) => invalidInputError,
          onSuccess: () => undefined,
        }),
      );

      expect(error?._tag).toBe("InvalidInputError");
      expect(error?.message).toBe("Invalid target URL");
    }),
  );

  it.effect("defaults HTTP provider lane with direct egress and default identity", () =>
    Effect.gen(function* () {
      const plan = yield* resolveExecution({
        url: "https://example.com/http-preview",
        defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
        defaultTimeoutMs: 500,
      });

      expect(plan.providerId).toBe(DEFAULT_HTTP_PROVIDER_ID);
      expect(plan.mode).toBe("http");
      expect(plan.timeoutMs).toBe(500);
      expect(plan.http).toEqual({
        userAgent: "effect-scrapling/0.0.1",
      });
      expect(plan.egress.profileId).toBe("direct");
      expect(plan.identity.profileId).toBe("default");
    }),
  );

  it.effect("uses the injected selection policy instead of builtin lane selection", () =>
    Effect.gen(function* () {
      const plan = yield* resolveExecutionWithSelectionPolicy(
        {
          url: "https://example.com/custom-policy",
          defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
          defaultTimeoutMs: 900,
          execution: {
            browser: {
              waitUntil: "commit",
            },
          },
        },
        {
          resolveSelection: () =>
            Effect.succeed({
              providerId: "managed-unblocker-browser",
              mode: "browser",
              warnings: ["selection-policy-warning"],
            }),
        },
        makeProviderRegistry([
          {
            id: "managed-unblocker-browser",
            capabilities: {
              mode: "browser",
              rendersDom: true,
            },
          },
          {
            id: DEFAULT_HTTP_PROVIDER_ID,
            capabilities: {
              mode: "http",
              rendersDom: false,
            },
          },
        ]),
      );

      expect(plan.providerId).toBe("managed-unblocker-browser");
      expect(plan.mode).toBe("browser");
      expect(plan.warnings).toContain("selection-policy-warning");
    }),
  );

  it.effect(
    "rejects impossible provider and mode pairs returned by selection policy overrides",
    () =>
      Effect.gen(function* () {
        const error = yield* resolveExecutionWithSelectionPolicy(
          {
            url: "https://example.com/invalid-selection-policy",
            defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
            defaultTimeoutMs: 900,
          },
          {
            resolveSelection: () =>
              Effect.succeed({
                providerId: DEFAULT_HTTP_PROVIDER_ID,
                mode: "browser",
                warnings: [],
              }),
          },
        ).pipe(
          Effect.match({
            onFailure: (invalidInputError) => invalidInputError,
            onSuccess: () => undefined,
          }),
        );

        expect(error?._tag).toBe("InvalidInputError");
        expect(error?.message).toBe("Selection policy returned an incompatible provider");
        expect(error?.details).toContain(
          `Provider "${DEFAULT_HTTP_PROVIDER_ID}" serves mode "http"`,
        );
      }),
  );
});
