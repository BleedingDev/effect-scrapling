import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Layer } from "effect";
import {
  makeStaticAccessProviderRegistry,
  type AccessProvider,
  type AccessProviderDescriptor,
  AccessProviderRegistry,
  AccessProviderRegistryLive,
} from "../../src/sdk/access-provider-runtime.ts";
import {
  AccessHealthRuntime,
  AccessHealthRuntimeLive,
} from "../../src/sdk/access-health-runtime-service.ts";
import {
  AccessSelectionHealthSignalsGateway,
  AccessSelectionHealthSignalsGatewayLive,
} from "../../src/sdk/access-selection-health-runtime.ts";
import {
  AccessSelectionStrategy,
  AccessSelectionStrategyLive,
} from "../../src/sdk/access-selection-strategy-runtime.ts";
import {
  AccessSelectionPolicy,
  AccessSelectionPolicyLive,
  DEFAULT_BROWSER_PROVIDER_ID,
  DEFAULT_HTTP_PROVIDER_ID,
  makeStaticAccessSelectionPolicy,
} from "../../src/sdk/access-policy-runtime.ts";

function makeDescriptorRegistry(descriptors: ReadonlyArray<AccessProviderDescriptor>) {
  const descriptorsById = Object.fromEntries(
    descriptors.map((descriptor) => [descriptor.id, descriptor] as const),
  ) as Readonly<Record<string, AccessProviderDescriptor>>;

  return {
    findDescriptor: (providerId: string) => Effect.succeed(descriptorsById[providerId]),
  };
}

function resolveSelection(
  input: Parameters<ReturnType<typeof makeStaticAccessSelectionPolicy>["resolveSelection"]>[0],
) {
  return Effect.gen(function* () {
    const policy = yield* AccessSelectionPolicy;
    return yield* policy.resolveSelection(input);
  }).pipe(
    Effect.provide(AccessSelectionPolicyLive),
    Effect.provide(AccessProviderRegistryLive),
    Effect.provide(AccessSelectionHealthSignalsGatewayLive),
    Effect.provideService(AccessSelectionStrategy, {
      selectCandidate: ({ candidates }) =>
        Effect.succeed({
          providerId: candidates[0]?.providerId ?? "http-basic",
          rationale: "preferred",
        }),
    }),
    Effect.provide(AccessHealthRuntimeLive),
  );
}

describe("sdk access policy runtime", () => {
  it.effect("elevates browser execution hints into the browser lane", () =>
    Effect.gen(function* () {
      const selection = yield* resolveSelection({
        url: "https://example.com/browser-lane",
        defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
        execution: {
          browser: {
            waitUntil: "commit",
          },
        },
      });

      expect(selection.providerId).toBe(DEFAULT_BROWSER_PROVIDER_ID);
      expect(selection.mode).toBe("browser");
      expect(selection.warnings).toEqual([]);
    }),
  );

  it.effect("rejects contradictory provider and mode combinations", () =>
    Effect.gen(function* () {
      const failure = yield* resolveSelection({
        url: "https://example.com/mismatch",
        defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
        execution: {
          mode: "browser",
          providerId: DEFAULT_HTTP_PROVIDER_ID,
        },
      }).pipe(
        Effect.match({
          onSuccess: () => undefined,
          onFailure: (error) => error,
        }),
      );

      expect(failure?._tag).toBe("InvalidInputError");
      expect(failure?.message).toBe("Execution mode does not match provider");
    }),
  );

  it.effect("rejects unknown custom providers", () =>
    Effect.gen(function* () {
      const failure = yield* resolveSelection({
        url: "https://example.com/custom-provider",
        defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
        execution: {
          providerId: "managed-unblocker",
        },
      }).pipe(
        Effect.match({
          onSuccess: () => undefined,
          onFailure: (error) => error,
        }),
      );

      expect(failure?._tag).toBe("InvalidInputError");
      expect(failure?.message).toBe("Unknown access provider");
    }),
  );

  it.effect("accepts custom providers when the provider registry knows their lane", () =>
    Effect.gen(function* () {
      const selection = yield* Effect.succeed(
        makeStaticAccessSelectionPolicy({
          providerRegistry: makeDescriptorRegistry([
            {
              id: "managed-unblocker",
              capabilities: {
                mode: "browser",
                rendersDom: true,
              },
            },
          ]),
        }),
      ).pipe(
        Effect.flatMap((policy) =>
          policy.resolveSelection({
            url: "https://example.com/custom-provider-known",
            defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
            execution: {
              mode: "browser",
              providerId: "managed-unblocker",
            },
          }),
        ),
      );

      expect(selection.providerId).toBe("managed-unblocker");
      expect(selection.mode).toBe("browser");
    }),
  );

  it.effect(
    "derives lane defaults from the live provider registry when builtin ids are absent",
    () =>
      Effect.gen(function* () {
        const selection = yield* Effect.gen(function* () {
          const policy = yield* AccessSelectionPolicy;
          return yield* policy.resolveSelection({
            url: "https://example.com/live-custom-default-browser",
            defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
            allowUnregisteredDefaultProviderFallback: true,
            execution: {
              mode: "browser",
            },
          });
        }).pipe(
          Effect.provide(AccessSelectionPolicyLive),
          Effect.provide(
            Layer.succeed(
              AccessProviderRegistry,
              makeStaticAccessProviderRegistry({
                "managed-browser": {
                  id: "managed-browser",
                  capabilities: {
                    mode: "browser",
                    rendersDom: true,
                  },
                  execute: () =>
                    Effect.die(new Error("Execution should not run during selection-policy tests")),
                } satisfies AccessProvider,
                "managed-http": {
                  id: "managed-http",
                  capabilities: {
                    mode: "http",
                    rendersDom: false,
                  },
                  execute: () =>
                    Effect.die(new Error("Execution should not run during selection-policy tests")),
                } satisfies AccessProvider,
              }),
            ),
          ),
          Effect.provide(AccessSelectionHealthSignalsGatewayLive),
          Effect.provideService(AccessSelectionStrategy, {
            selectCandidate: ({ candidates }) =>
              Effect.succeed({
                providerId: candidates[0]?.providerId ?? "managed-http",
                rationale: "preferred",
              }),
          }),
          Effect.provide(AccessHealthRuntimeLive),
        );

        expect(selection.providerId).toBe("managed-browser");
        expect(selection.mode).toBe("browser");
      }),
  );

  it.effect(
    "reuses the live HTTP lane default for implicit-mode requests when builtin ids are absent",
    () =>
      Effect.gen(function* () {
        const selection = yield* Effect.gen(function* () {
          const policy = yield* AccessSelectionPolicy;
          return yield* policy.resolveSelection({
            url: "https://example.com/live-custom-default-http",
            defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
            allowUnregisteredDefaultProviderFallback: true,
          });
        }).pipe(
          Effect.provide(AccessSelectionPolicyLive),
          Effect.provide(
            Layer.succeed(
              AccessProviderRegistry,
              makeStaticAccessProviderRegistry({
                "managed-browser": {
                  id: "managed-browser",
                  capabilities: {
                    mode: "browser",
                    rendersDom: true,
                  },
                  execute: () =>
                    Effect.die(new Error("Execution should not run during selection-policy tests")),
                } satisfies AccessProvider,
                "managed-http": {
                  id: "managed-http",
                  capabilities: {
                    mode: "http",
                    rendersDom: false,
                  },
                  execute: () =>
                    Effect.die(new Error("Execution should not run during selection-policy tests")),
                } satisfies AccessProvider,
              }),
            ),
          ),
          Effect.provide(AccessSelectionHealthSignalsGatewayLive),
          Effect.provide(AccessSelectionStrategyLive),
          Effect.provide(AccessHealthRuntimeLive),
        );

        expect(selection.providerId).toBe("managed-http");
        expect(selection.mode).toBe("http");
      }),
  );

  it.effect(
    "falls back away from quarantined default providers when a healthy lane default exists",
    () =>
      Effect.gen(function* () {
        const selection = yield* Effect.succeed(
          makeStaticAccessSelectionPolicy({
            providerRegistry: makeDescriptorRegistry([
              {
                id: "managed-browser",
                capabilities: {
                  mode: "browser",
                  rendersDom: true,
                },
              },
              {
                id: DEFAULT_BROWSER_PROVIDER_ID,
                capabilities: {
                  mode: "browser",
                  rendersDom: true,
                },
              },
            ]),
            healthSignals: {
              inspect: ({ url, providerIds }) =>
                Effect.succeed({
                  domain: {
                    subject: {
                      kind: "domain",
                      domain: new URL(url).hostname.toLowerCase(),
                    },
                    successCount: 0,
                    failureCount: 0,
                    successStreak: 0,
                    failureStreak: 0,
                    score: 100,
                    quarantinedUntil: null,
                  },
                  providers: Object.fromEntries(
                    providerIds.map((providerId) => [
                      providerId,
                      {
                        subject: {
                          kind: "provider",
                          providerId,
                        },
                        successCount: 0,
                        failureCount: providerId === "managed-browser" ? 3 : 0,
                        successStreak: 0,
                        failureStreak: providerId === "managed-browser" ? 3 : 0,
                        score: providerId === "managed-browser" ? 0 : 100,
                        quarantinedUntil:
                          providerId === "managed-browser" ? "2099-01-01T00:00:00.000Z" : null,
                      },
                    ]),
                  ),
                }),
            },
          }),
        ).pipe(
          Effect.flatMap((policy) =>
            policy.resolveSelection({
              url: "https://example.com/browser-health-fallback",
              defaultProviderId: "managed-browser",
              execution: {
                mode: "browser",
              },
            }),
          ),
        );

        expect(selection.providerId).toBe(DEFAULT_BROWSER_PROVIDER_ID);
        expect(selection.warnings).toContain(
          'Selection policy chose provider "browser-basic" instead of preferred "managed-browser"; access health signals rate the preferred provider as less healthy.',
        );
      }),
  );

  it.effect("can reroute using shared access health runtime feedback", () =>
    Effect.gen(function* () {
      const runtime = yield* AccessHealthRuntime;
      const healthSignals = yield* AccessSelectionHealthSignalsGateway;
      const policy = makeStaticAccessSelectionPolicy({
        providerRegistry: makeDescriptorRegistry([
          {
            id: "managed-browser",
            capabilities: {
              mode: "browser",
              rendersDom: true,
            },
          },
          {
            id: DEFAULT_BROWSER_PROVIDER_ID,
            capabilities: {
              mode: "browser",
              rendersDom: true,
            },
          },
        ]),
        healthSignals: {
          inspect: ({ url, providerIds }) =>
            healthSignals.inspect({
              url,
              providerIds,
            }),
        },
      });

      yield* runtime.recordFailure(
        {
          kind: "provider",
          providerId: "managed-browser",
        },
        {
          failureThreshold: 1,
          recoveryThreshold: 1,
          quarantineMs: 60_000,
        },
        "provider_unavailable",
      );

      const selection = yield* policy.resolveSelection({
        url: "https://example.com/shared-runtime-feedback",
        defaultProviderId: "managed-browser",
        execution: {
          mode: "browser",
        },
      });

      expect(selection.providerId).toBe(DEFAULT_BROWSER_PROVIDER_ID);
      expect(selection.warnings).toContain(
        'Selection policy chose provider "browser-basic" instead of preferred "managed-browser"; access health signals rate the preferred provider as less healthy.',
      );
    }).pipe(
      Effect.provide(AccessSelectionHealthSignalsGatewayLive),
      Effect.provide(AccessHealthRuntimeLive),
    ),
  );

  it.effect("supports injected selection strategy plugins", () =>
    Effect.gen(function* () {
      const selection = yield* Effect.succeed(
        makeStaticAccessSelectionPolicy({
          providerRegistry: makeDescriptorRegistry([
            {
              id: "managed-browser",
              capabilities: {
                mode: "browser",
                rendersDom: true,
              },
            },
            {
              id: DEFAULT_BROWSER_PROVIDER_ID,
              capabilities: {
                mode: "browser",
                rendersDom: true,
              },
            },
          ]),
          selectionStrategy: {
            selectCandidate: () =>
              Effect.succeed({
                providerId: DEFAULT_BROWSER_PROVIDER_ID,
                rationale: "custom",
              }),
          },
          healthSignals: {
            inspect: ({ url, providerIds }) =>
              Effect.succeed({
                domain: {
                  subject: {
                    kind: "domain",
                    domain: new URL(url).hostname.toLowerCase(),
                  },
                  successCount: 0,
                  failureCount: 0,
                  successStreak: 0,
                  failureStreak: 0,
                  score: 100,
                  quarantinedUntil: null,
                },
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
                    },
                  ]),
                ),
              }),
          },
        }),
      ).pipe(
        Effect.flatMap((policy) =>
          policy.resolveSelection({
            url: "https://example.com/strategy-override",
            defaultProviderId: "managed-browser",
            execution: {
              mode: "browser",
            },
          }),
        ),
      );

      expect(selection.providerId).toBe(DEFAULT_BROWSER_PROVIDER_ID);
      expect(selection.warnings).toEqual([]);
    }),
  );

  it.effect("does not attribute custom strategy reroutes to access health signals", () =>
    Effect.gen(function* () {
      const selection = yield* Effect.succeed(
        makeStaticAccessSelectionPolicy({
          providerRegistry: makeDescriptorRegistry([
            {
              id: "managed-browser",
              capabilities: {
                mode: "browser",
                rendersDom: true,
              },
            },
            {
              id: DEFAULT_BROWSER_PROVIDER_ID,
              capabilities: {
                mode: "browser",
                rendersDom: true,
              },
            },
          ]),
          selectionStrategy: {
            selectCandidate: () =>
              Effect.succeed({
                providerId: DEFAULT_BROWSER_PROVIDER_ID,
                rationale: "custom",
              }),
          },
          healthSignals: {
            inspect: ({ url, providerIds }) =>
              Effect.succeed({
                domain: {
                  subject: {
                    kind: "domain",
                    domain: new URL(url).hostname.toLowerCase(),
                  },
                  successCount: 0,
                  failureCount: 0,
                  successStreak: 0,
                  failureStreak: 0,
                  score: 100,
                  quarantinedUntil: null,
                },
                providers: Object.fromEntries(
                  providerIds.map((providerId) => [
                    providerId,
                    {
                      subject: {
                        kind: "provider",
                        providerId,
                      },
                      successCount: providerId === DEFAULT_BROWSER_PROVIDER_ID ? 3 : 0,
                      failureCount: providerId === DEFAULT_BROWSER_PROVIDER_ID ? 0 : 2,
                      successStreak: providerId === DEFAULT_BROWSER_PROVIDER_ID ? 3 : 0,
                      failureStreak: providerId === DEFAULT_BROWSER_PROVIDER_ID ? 0 : 2,
                      score: providerId === DEFAULT_BROWSER_PROVIDER_ID ? 100 : 10,
                      quarantinedUntil: null,
                    },
                  ]),
                ),
              }),
          },
        }),
      ).pipe(
        Effect.flatMap((policy) =>
          policy.resolveSelection({
            url: "https://example.com/custom-strategy-health-wording",
            defaultProviderId: "managed-browser",
            execution: {
              mode: "browser",
            },
          }),
        ),
      );

      expect(selection.providerId).toBe(DEFAULT_BROWSER_PROVIDER_ID);
      expect(selection.warnings).toEqual([]);
    }),
  );

  it.effect("does not trust a custom strategy that misreports health-signals rationale", () =>
    Effect.gen(function* () {
      const selection = yield* Effect.succeed(
        makeStaticAccessSelectionPolicy({
          providerRegistry: makeDescriptorRegistry([
            {
              id: "managed-browser",
              capabilities: {
                mode: "browser",
                rendersDom: true,
              },
            },
            {
              id: DEFAULT_BROWSER_PROVIDER_ID,
              capabilities: {
                mode: "browser",
                rendersDom: true,
              },
            },
          ]),
          selectionStrategy: {
            selectCandidate: () =>
              Effect.succeed({
                providerId: DEFAULT_BROWSER_PROVIDER_ID,
                rationale: "health-signals",
              }),
          },
          healthSignals: {
            inspect: ({ url, providerIds }) =>
              Effect.succeed({
                domain: {
                  subject: {
                    kind: "domain",
                    domain: new URL(url).hostname.toLowerCase(),
                  },
                  successCount: 0,
                  failureCount: 0,
                  successStreak: 0,
                  failureStreak: 0,
                  score: 100,
                  quarantinedUntil: null,
                },
                providers: Object.fromEntries(
                  providerIds.map((providerId) => [
                    providerId,
                    {
                      subject: {
                        kind: "provider",
                        providerId,
                      },
                      successCount: 1,
                      failureCount: 1,
                      successStreak: 1,
                      failureStreak: 0,
                      score: 50,
                      quarantinedUntil: null,
                    },
                  ]),
                ),
              }),
          },
        }),
      ).pipe(
        Effect.flatMap((policy) =>
          policy.resolveSelection({
            url: "https://example.com/misreported-rationale",
            defaultProviderId: "managed-browser",
            execution: {
              mode: "browser",
            },
          }),
        ),
      );

      expect(selection.providerId).toBe(DEFAULT_BROWSER_PROVIDER_ID);
      expect(selection.warnings).toEqual([]);
    }),
  );

  it.effect(
    "reuses the live lane default when an explicit mode request carries an unknown default provider",
    () =>
      Effect.gen(function* () {
        const selection = yield* resolveSelection({
          url: "https://example.com/unknown-default-provider",
          defaultProviderId: "missing-http-provider",
          allowUnregisteredDefaultProviderFallback: true,
          execution: {
            mode: "http",
          },
        });

        expect(selection.providerId).toBe(DEFAULT_HTTP_PROVIDER_ID);
        expect(selection.mode).toBe("http");
        expect(selection.warnings).toEqual([]);
      }),
  );

  it.effect("rejects strategy outputs outside the computed candidate set", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.succeed(
        makeStaticAccessSelectionPolicy({
          providerRegistry: makeDescriptorRegistry([
            {
              id: "managed-browser",
              capabilities: {
                mode: "browser",
                rendersDom: true,
              },
            },
            {
              id: DEFAULT_BROWSER_PROVIDER_ID,
              capabilities: {
                mode: "browser",
                rendersDom: true,
              },
            },
          ]),
          selectionStrategy: {
            selectCandidate: () =>
              Effect.succeed({
                providerId: "not-a-candidate",
                rationale: "custom",
              }),
          },
          healthSignals: {
            inspect: ({ url, providerIds }) =>
              Effect.succeed({
                domain: {
                  subject: {
                    kind: "domain",
                    domain: new URL(url).hostname.toLowerCase(),
                  },
                  successCount: 0,
                  failureCount: 0,
                  successStreak: 0,
                  failureStreak: 0,
                  score: 100,
                  quarantinedUntil: null,
                },
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
                    },
                  ]),
                ),
              }),
          },
        }),
      ).pipe(
        Effect.flatMap((policy) =>
          policy.resolveSelection({
            url: "https://example.com/invalid-strategy-provider",
            defaultProviderId: "managed-browser",
            execution: {
              mode: "browser",
            },
          }),
        ),
        Effect.match({
          onSuccess: () => undefined,
          onFailure: (error) => error,
        }),
      );

      expect(failure?._tag).toBe("InvalidInputError");
      expect(failure?.message).toBe("Selection strategy returned an invalid provider");
      expect(failure?.details).toContain("not-a-candidate");
    }),
  );

  it.effect("rejects provider ids with whitespace instead of leaking health-runtime failures", () =>
    Effect.gen(function* () {
      const failure = yield* resolveSelection({
        url: "https://example.com/invalid-provider-id",
        defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
        execution: {
          mode: "http",
          providerId: "bad id",
        },
      }).pipe(
        Effect.match({
          onSuccess: () => undefined,
          onFailure: (error) => error,
        }),
      );

      expect(failure?._tag).toBe("InvalidInputError");
      expect(failure?.message).toBe("Invalid provider id");
    }),
  );
});
