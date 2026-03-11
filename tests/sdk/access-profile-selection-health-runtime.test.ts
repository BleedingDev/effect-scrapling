import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Layer } from "effect";
import { PolicyViolation } from "../../libs/foundation/core/src/tagged-errors.ts";
import {
  type AccessHealthSnapshot,
  type AccessHealthSubject,
} from "../../libs/foundation/core/src/access-health-runtime.ts";
import {
  AccessProfileSelectionHealthSignalsGateway,
  AccessProfileSelectionHealthSignalsGatewayLive,
  accessProfileSelectionEgressPluginKey,
  accessProfileSelectionIdentityPluginKey,
} from "../../src/sdk/access-profile-selection-health-runtime.ts";
import { AccessHealthRuntime } from "../../src/sdk/access-health-runtime-service.ts";
import { makeInMemoryAccessHealthRuntime } from "../../libs/foundation/core/src/access-health-runtime.ts";

const testPolicy = {
  failureThreshold: 1,
  recoveryThreshold: 1,
  quarantineMs: 60_000,
} as const;

const testAccessHealthRuntimeLayer = Layer.effect(
  AccessHealthRuntime,
  makeInMemoryAccessHealthRuntime(() => new Date("2026-03-11T06:00:00.000Z")),
);

const partialFailureAccessHealthRuntimeLayer = Layer.succeed(AccessHealthRuntime, {
  inspect: (subject: AccessHealthSubject) =>
    (subject.kind === "identity-profile" && subject.profileId === "broken") ||
    (subject.kind === "identity-plugin" && subject.pluginId === "broken-plugin")
      ? Effect.fail(
          new PolicyViolation({
            message: "broken-inspection",
          }),
        )
      : Effect.succeed({
          subject,
          successCount: 1,
          failureCount: 0,
          successStreak: 1,
          failureStreak: 0,
          score: 100,
          quarantinedUntil: null,
        } satisfies AccessHealthSnapshot),
  assertHealthy: () => Effect.die("not-used"),
  recordSuccess: () => Effect.die("not-used"),
  recordFailure: () => Effect.die("not-used"),
});

describe("sdk access profile selection health runtime", () => {
  it.effect("inspects profile-level egress and identity health snapshots", () =>
    Effect.gen(function* () {
      const runtime = yield* AccessHealthRuntime;
      yield* runtime.recordFailure(
        {
          kind: "egress-profile",
          poolId: "direct-pool",
          routePolicyId: "direct-route",
          profileId: "direct",
        },
        testPolicy,
        "proxy-reset",
      );
      yield* runtime.recordFailure(
        {
          kind: "identity-profile",
          tenantId: "public",
          domain: "example.com",
          profileId: "default",
        },
        testPolicy,
        "identity-poisoned",
      );

      const gateway = yield* AccessProfileSelectionHealthSignalsGateway;
      const signals = yield* gateway.inspect({
        url: "https://example.com/products/sku-1",
        egressProfiles: [
          {
            allocationMode: "static",
            pluginId: "builtin-direct-egress",
            pluginConfig: undefined,
            profileId: "direct",
            poolId: "direct-pool",
            routePolicyId: "direct-route",
            routeKind: "direct",
            routeKey: "direct",
            requestHeaders: {},
            warnings: [],
          },
        ],
        identityProfiles: [
          {
            allocationMode: "static",
            pluginId: "builtin-default-identity",
            pluginConfig: undefined,
            profileId: "default",
            tenantId: "public",
            browserRuntimeProfileId: "patchright-default",
            httpUserAgent: "effect-scrapling/0.0.1",
            browserUserAgent: "ua",
            locale: undefined,
            timezoneId: undefined,
            warnings: [],
          },
        ],
      });

      expect(signals.egressProfiles.direct?.failureCount).toBe(1);
      expect(
        signals.egressPlugins[
          accessProfileSelectionEgressPluginKey({
            poolId: "direct-pool",
            routePolicyId: "direct-route",
            pluginId: "builtin-direct-egress",
          })
        ]?.successCount,
      ).toBe(0);
      expect(signals.identityProfiles.default?.failureCount).toBe(1);
      expect(
        signals.identityPlugins[
          accessProfileSelectionIdentityPluginKey({
            tenantId: "public",
            pluginId: "builtin-default-identity",
          })
        ]?.successCount,
      ).toBe(0);
      expect(signals.egressProfiles.direct?.quarantinedUntil).not.toBeNull();
      expect(signals.identityProfiles.default?.quarantinedUntil).not.toBeNull();
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          testAccessHealthRuntimeLayer,
          AccessProfileSelectionHealthSignalsGatewayLive.pipe(
            Layer.provide(testAccessHealthRuntimeLayer),
          ),
        ),
      ),
    ),
  );

  it.effect("keeps successful snapshots when one profile inspection fails", () =>
    Effect.gen(function* () {
      const gateway = yield* AccessProfileSelectionHealthSignalsGateway;
      const signals = yield* gateway.inspect({
        url: "https://example.com/products/sku-2",
        egressProfiles: [
          {
            allocationMode: "static",
            pluginId: "builtin-direct-egress",
            pluginConfig: undefined,
            profileId: "direct",
            poolId: "direct-pool",
            routePolicyId: "direct-route",
            routeKind: "direct",
            routeKey: "direct",
            requestHeaders: {},
            warnings: [],
          },
        ],
        identityProfiles: [
          {
            allocationMode: "static",
            pluginId: "builtin-default-identity",
            pluginConfig: undefined,
            profileId: "default",
            tenantId: "public",
            browserRuntimeProfileId: "patchright-default",
            httpUserAgent: "effect-scrapling/0.0.1",
            browserUserAgent: "ua",
            locale: undefined,
            timezoneId: undefined,
            warnings: [],
          },
          {
            allocationMode: "static",
            pluginId: "broken-plugin",
            pluginConfig: undefined,
            profileId: "broken",
            tenantId: "public",
            browserRuntimeProfileId: "patchright-default",
            httpUserAgent: "effect-scrapling/0.0.1",
            browserUserAgent: "ua",
            locale: undefined,
            timezoneId: undefined,
            warnings: [],
          },
        ],
      });

      expect(signals.egressProfiles.direct?.successCount).toBe(1);
      expect(
        signals.egressPlugins[
          accessProfileSelectionEgressPluginKey({
            poolId: "direct-pool",
            routePolicyId: "direct-route",
            pluginId: "builtin-direct-egress",
          })
        ]?.successCount,
      ).toBe(1);
      expect(signals.identityProfiles.default?.successCount).toBe(1);
      expect(
        signals.identityPlugins[
          accessProfileSelectionIdentityPluginKey({
            tenantId: "public",
            pluginId: "builtin-default-identity",
          })
        ]?.successCount,
      ).toBe(1);
      expect(signals.identityProfiles.broken).toBeUndefined();
      expect(
        signals.identityPlugins[
          accessProfileSelectionIdentityPluginKey({
            tenantId: "public",
            pluginId: "broken-plugin",
          })
        ],
      ).toBeUndefined();
      expect(signals.degraded).toBe(true);
      expect(signals.identityWarnings).toContain(
        "Some identity profile or plugin health signals were unavailable; static profile preference may be used for affected entries.",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          partialFailureAccessHealthRuntimeLayer,
          AccessProfileSelectionHealthSignalsGatewayLive.pipe(
            Layer.provide(partialFailureAccessHealthRuntimeLayer),
          ),
        ),
      ),
    ),
  );

  it.effect("deduplicates plugin inspections across profiles that share one plugin", () => {
    let egressPluginInspections = 0;
    let identityPluginInspections = 0;
    const runtimeLayer = Layer.succeed(AccessHealthRuntime, {
      inspect: (subject: AccessHealthSubject) => {
        if (subject.kind === "egress-plugin") {
          egressPluginInspections += 1;
        }
        if (subject.kind === "identity-plugin") {
          identityPluginInspections += 1;
        }

        return Effect.succeed({
          subject,
          successCount: 1,
          failureCount: 0,
          successStreak: 1,
          failureStreak: 0,
          score: 100,
          quarantinedUntil: null,
        } satisfies AccessHealthSnapshot);
      },
      assertHealthy: () => Effect.die("not-used"),
      recordSuccess: () => Effect.die("not-used"),
      recordFailure: () => Effect.die("not-used"),
    });

    return Effect.gen(function* () {
      const gateway = yield* AccessProfileSelectionHealthSignalsGateway;
      const signals = yield* gateway.inspect({
        url: "https://example.com/products/sku-3",
        egressProfiles: [
          {
            allocationMode: "static",
            pluginId: "shared-egress-plugin",
            pluginConfig: undefined,
            profileId: "direct-a",
            poolId: "direct-pool",
            routePolicyId: "direct-route",
            routeKind: "direct",
            routeKey: "direct-a",
            requestHeaders: {},
            warnings: [],
          },
          {
            allocationMode: "static",
            pluginId: "shared-egress-plugin",
            pluginConfig: undefined,
            profileId: "direct-b",
            poolId: "direct-pool",
            routePolicyId: "direct-route",
            routeKind: "direct",
            routeKey: "direct-b",
            requestHeaders: {},
            warnings: [],
          },
        ],
        identityProfiles: [
          {
            allocationMode: "static",
            pluginId: "shared-identity-plugin",
            pluginConfig: undefined,
            profileId: "identity-a",
            tenantId: "public",
            browserRuntimeProfileId: "patchright-default",
            httpUserAgent: "ua",
            browserUserAgent: "ua",
            locale: undefined,
            timezoneId: undefined,
            warnings: [],
          },
          {
            allocationMode: "static",
            pluginId: "shared-identity-plugin",
            pluginConfig: undefined,
            profileId: "identity-b",
            tenantId: "public",
            browserRuntimeProfileId: "patchright-default",
            httpUserAgent: "ua",
            browserUserAgent: "ua",
            locale: undefined,
            timezoneId: undefined,
            warnings: [],
          },
        ],
      });

      expect(
        signals.egressPlugins[
          accessProfileSelectionEgressPluginKey({
            poolId: "direct-pool",
            routePolicyId: "direct-route",
            pluginId: "shared-egress-plugin",
          })
        ]?.successCount,
      ).toBe(1);
      expect(
        signals.identityPlugins[
          accessProfileSelectionIdentityPluginKey({
            tenantId: "public",
            pluginId: "shared-identity-plugin",
          })
        ]?.successCount,
      ).toBe(1);
      expect(egressPluginInspections).toBe(1);
      expect(identityPluginInspections).toBe(1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          runtimeLayer,
          AccessProfileSelectionHealthSignalsGatewayLive.pipe(Layer.provide(runtimeLayer)),
        ),
      ),
    );
  });
});
