import { describe, expect, it } from "@effect-native/bun-test";
import { Effect } from "effect";
import {
  composeAccessRuntimeModules,
  makeStaticAccessModuleRegistry,
} from "../../src/sdk/access-module-runtime.ts";
import {
  makeStaticEgressPlugin,
  makeStaticIdentityPlugin,
} from "../../src/sdk/access-allocation-plugin-runtime.ts";
import { makeAccessCoreRuntimeModule } from "../../src/sdk/access-builtin-modules.ts";
import {
  DEFAULT_LEASED_EGRESS_PROFILE_ID,
  DEFAULT_LEASED_IDENTITY_PROFILE_ID,
  DEFAULT_LEASED_STEALTH_IDENTITY_PROFILE_ID,
} from "../../src/sdk/access-profile-runtime.ts";

describe("sdk access module runtime", () => {
  it("rejects mismatched contribution keys and embedded ids", async () => {
    const failure = await Effect.runPromise(
      composeAccessRuntimeModules([
        {
          id: "managed-module",
          providers: {
            "managed-provider-key": {
              id: "different-provider-id",
              capabilities: {
                mode: "browser",
                rendersDom: true,
              },
              execute: () =>
                Effect.die(
                  new Error("Execution should not run during module composition validation"),
                ),
            },
          },
        },
      ]).pipe(
        Effect.match({
          onSuccess: () => undefined,
          onFailure: (error) => error,
        }),
      ),
    );

    expect(failure?._tag).toBe("InvalidInputError");
    expect(failure?.message).toBe("Mismatched provider id");
  });

  it("rejects profiles that reference plugins no module provides", async () => {
    const failure = await Effect.runPromise(
      composeAccessRuntimeModules([
        {
          id: "managed-module",
          egressProfiles: {
            "managed-egress": {
              allocationMode: "static",
              pluginId: "missing-egress-plugin",
              profileId: "managed-egress",
              poolId: "managed-pool",
              routePolicyId: "managed-policy",
              routeKind: "managed-direct",
              routeKey: "managed-egress",
              routeConfig: {
                kind: "managed-direct",
              },
              requestHeaders: {},
              warnings: [],
            },
          },
        },
      ]).pipe(
        Effect.match({
          onSuccess: () => undefined,
          onFailure: (error) => error,
        }),
      ),
    );

    expect(failure?._tag).toBe("InvalidInputError");
    expect(failure?.message).toBe("Unknown egress plugin reference");
  });

  it("composes a valid module graph into one static registry snapshot", async () => {
    const registry = makeStaticAccessModuleRegistry({
      modules: [
        {
          id: "managed-module",
          egressPlugins: {
            "managed-egress-plugin": makeStaticEgressPlugin("managed-egress-plugin"),
          },
          identityPlugins: {
            "managed-identity-plugin": makeStaticIdentityPlugin("managed-identity-plugin"),
          },
          egressProfiles: {
            "managed-egress": {
              allocationMode: "static",
              pluginId: "managed-egress-plugin",
              profileId: "managed-egress",
              poolId: "managed-pool",
              routePolicyId: "managed-policy",
              routeKind: "managed-direct",
              routeKey: "managed-egress",
              routeConfig: {
                kind: "managed-direct",
              },
              requestHeaders: {},
              warnings: [],
            },
          },
          identityProfiles: {
            "managed-identity": {
              allocationMode: "static",
              pluginId: "managed-identity-plugin",
              profileId: "managed-identity",
              tenantId: "managed-tenant",
              browserRuntimeProfileId: "patchright-default",
              browserUserAgent: "managed-browser-agent",
              locale: undefined,
              timezoneId: undefined,
              warnings: [],
            },
          },
        },
      ],
    });

    const composition = await Effect.runPromise(registry.compose());

    expect(Object.keys(composition.egressPlugins)).toEqual(["managed-egress-plugin"]);
    expect(Object.keys(composition.identityProfiles)).toEqual(["managed-identity"]);
  });

  it("emits default leased profiles against injected leased plugin ids", async () => {
    const customLeasedEgressPluginId = "custom-leased-egress";
    const customLeasedIdentityPluginId = "custom-leased-identity";
    const registry = makeStaticAccessModuleRegistry({
      modules: [
        makeAccessCoreRuntimeModule({
          leasedEgressPluginId: customLeasedEgressPluginId,
          leasedEgressPlugin: makeStaticEgressPlugin(customLeasedEgressPluginId),
          leasedIdentityPluginId: customLeasedIdentityPluginId,
          leasedIdentityPlugin: makeStaticIdentityPlugin(customLeasedIdentityPluginId),
        }),
      ],
    });

    const composition = await Effect.runPromise(registry.compose());

    expect(composition.egressProfiles[DEFAULT_LEASED_EGRESS_PROFILE_ID]?.pluginId).toBe(
      customLeasedEgressPluginId,
    );
    expect(composition.identityProfiles[DEFAULT_LEASED_IDENTITY_PROFILE_ID]?.pluginId).toBe(
      customLeasedIdentityPluginId,
    );
    expect(composition.identityProfiles[DEFAULT_LEASED_STEALTH_IDENTITY_PROFILE_ID]?.pluginId).toBe(
      customLeasedIdentityPluginId,
    );
  });
});
