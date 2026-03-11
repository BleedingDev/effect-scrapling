import { describe, expect, it } from "@effect-native/bun-test";
import { Effect } from "effect";
import { makeInMemoryAccessHealthRuntime } from "../../libs/foundation/core/src/access-health-runtime.ts";

const policy = {
  failureThreshold: 2,
  recoveryThreshold: 2,
  quarantineMs: 1_000,
} as const;

const domainSubject = {
  kind: "domain",
  domain: "example.com",
} as const;

const providerSubject = {
  kind: "provider",
  providerId: "provider-http-main",
} as const;

const egressSubject = {
  kind: "egress",
  poolId: "pool-direct",
  routePolicyId: "route-direct",
  egressKey: "direct-primary",
} as const;

const egressProfileSubject = {
  kind: "egress-profile",
  poolId: "pool-direct",
  routePolicyId: "route-direct",
  profileId: "direct",
} as const;

const egressPluginSubject = {
  kind: "egress-plugin",
  poolId: "pool-direct",
  routePolicyId: "route-direct",
  pluginId: "builtin-direct-egress",
} as const;

const identitySubject = {
  kind: "identity",
  tenantId: "tenant-main",
  domain: "example.com",
  identityKey: "identity-a",
} as const;

const identityProfileSubject = {
  kind: "identity-profile",
  tenantId: "tenant-main",
  domain: "example.com",
  profileId: "default",
} as const;

const identityPluginSubject = {
  kind: "identity-plugin",
  tenantId: "tenant-main",
  domain: "example.com",
  pluginId: "builtin-default-identity",
} as const;

describe("foundation-core access health runtime", () => {
  it.effect("quarantines unhealthy access paths and emits typed policy events", () =>
    Effect.gen(function* () {
      let currentTime = new Date("2026-03-06T14:00:00.000Z");
      const runtime = yield* makeInMemoryAccessHealthRuntime(() => currentTime);

      yield* runtime.recordFailure(domainSubject, policy, "timeout");
      const quarantinedSnapshot = yield* runtime.recordFailure(domainSubject, policy, "timeout");
      expect(quarantinedSnapshot.failureStreak).toBe(2);
      expect(quarantinedSnapshot.quarantinedUntil).not.toBeNull();

      const quarantineMessage = yield* runtime.assertHealthy(domainSubject).pipe(
        Effect.match({
          onFailure: ({ message }) => message,
          onSuccess: () => "unexpected-success",
        }),
      );
      expect(quarantineMessage).toContain("quarantined");

      currentTime = new Date("2026-03-06T14:00:02.500Z");
      yield* runtime.recordSuccess(domainSubject, policy);
      const restoredSnapshot = yield* runtime.recordSuccess(domainSubject, policy);
      expect(restoredSnapshot.quarantinedUntil).toBeNull();
      expect(restoredSnapshot.successStreak).toBe(2);
      expect(restoredSnapshot.score).toBeGreaterThan(0);

      yield* runtime.recordFailure(providerSubject, policy, "proxy-reset");
      const egressSnapshot = yield* runtime.recordSuccess(egressSubject, policy);
      expect(egressSnapshot.successCount).toBe(1);
      const egressProfileSnapshot = yield* runtime.recordSuccess(egressProfileSubject, policy);
      expect(egressProfileSnapshot.successCount).toBe(1);
      const egressPluginSnapshot = yield* runtime.recordSuccess(egressPluginSubject, policy);
      expect(egressPluginSnapshot.successCount).toBe(1);
      const identitySnapshot = yield* runtime.recordSuccess(identitySubject, policy);
      expect(identitySnapshot.successCount).toBe(1);
      const identityProfileSnapshot = yield* runtime.recordSuccess(identityProfileSubject, policy);
      expect(identityProfileSnapshot.successCount).toBe(1);
      const identityPluginSnapshot = yield* runtime.recordSuccess(identityPluginSubject, policy);
      expect(identityPluginSnapshot.successCount).toBe(1);

      const events = yield* runtime.events();
      expect(events.map(({ kind }) => kind)).toEqual([
        "failure",
        "failure",
        "quarantined",
        "success",
        "success",
        "restored",
        "failure",
        "success",
        "success",
        "success",
        "success",
        "success",
        "success",
      ]);
    }),
  );

  it.effect("does not emit restored for subjects that were never quarantined", () =>
    Effect.gen(function* () {
      const runtime = yield* makeInMemoryAccessHealthRuntime(
        () => new Date("2026-03-06T14:30:00.000Z"),
      );
      yield* runtime.recordSuccess(providerSubject, policy);
      yield* runtime.recordSuccess(providerSubject, policy);

      const events = yield* runtime.events();
      expect(events.map(({ kind }) => kind)).toEqual(["success", "success"]);
    }),
  );

  it.effect(
    "keeps identity health subjects distinct when identifiers contain separator characters",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeInMemoryAccessHealthRuntime(
          () => new Date("2026-03-06T14:45:00.000Z"),
        );
        const firstSubject = {
          kind: "identity",
          tenantId: "tenant|main",
          domain: "example.com",
          identityKey: "identity-a",
        } as const;
        const secondSubject = {
          kind: "identity",
          tenantId: "tenant",
          domain: "example.com",
          identityKey: "main|identity-a",
        } as const;

        const firstSnapshot = yield* runtime.recordSuccess(firstSubject, policy);
        const secondSnapshot = yield* runtime.recordSuccess(secondSubject, policy);

        expect(firstSnapshot.subject).toEqual(firstSubject);
        expect(secondSnapshot.subject).toEqual(secondSubject);
        expect(firstSnapshot.successCount).toBe(1);
        expect(secondSnapshot.successCount).toBe(1);
      }),
  );

  it.effect("keeps egress health subjects distinct across route identities", () =>
    Effect.gen(function* () {
      const runtime = yield* makeInMemoryAccessHealthRuntime(
        () => new Date("2026-03-06T15:00:00.000Z"),
      );
      const firstSubject = {
        kind: "egress",
        poolId: "pool-main",
        routePolicyId: "route-a",
        egressKey: "gateway-a",
      } as const;
      const secondSubject = {
        kind: "egress",
        poolId: "pool-main",
        routePolicyId: "route-a|gateway",
        egressKey: "a",
      } as const;

      const firstSnapshot = yield* runtime.recordSuccess(firstSubject, policy);
      const secondSnapshot = yield* runtime.recordSuccess(secondSubject, policy);

      expect(firstSnapshot.subject).toEqual(firstSubject);
      expect(secondSnapshot.subject).toEqual(secondSubject);
      expect(firstSnapshot.successCount).toBe(1);
      expect(secondSnapshot.successCount).toBe(1);
    }),
  );

  it.effect("quarantines egress subjects once and keeps route identities isolated", () =>
    Effect.gen(function* () {
      let currentTime = new Date("2026-03-06T15:15:00.000Z");
      const runtime = yield* makeInMemoryAccessHealthRuntime(() => currentTime);
      const firstSubject = {
        kind: "egress",
        poolId: "pool-main",
        routePolicyId: "route-direct",
        egressKey: "gateway-a",
      } as const;
      const secondSubject = {
        kind: "egress",
        poolId: "pool-main",
        routePolicyId: "route-direct",
        egressKey: "gateway-b",
      } as const;

      yield* runtime.recordFailure(firstSubject, policy, "proxy-reset");
      const quarantinedSnapshot = yield* runtime.recordFailure(firstSubject, policy, "proxy-reset");
      const initialQuarantinedUntil = quarantinedSnapshot.quarantinedUntil;

      expect(initialQuarantinedUntil).not.toBeNull();

      currentTime = new Date("2026-03-06T15:15:00.500Z");
      const repeatedFailureSnapshot = yield* runtime.recordFailure(
        firstSubject,
        policy,
        "proxy-reset",
      );
      expect(repeatedFailureSnapshot.quarantinedUntil).toBe(initialQuarantinedUntil);

      const healthySecondSnapshot = yield* runtime.assertHealthy(secondSubject);
      expect(healthySecondSnapshot.subject).toEqual(secondSubject);
      expect(healthySecondSnapshot.failureCount).toBe(0);

      const events = yield* runtime.events();
      expect(
        events.filter(
          ({ kind, subject }) =>
            kind === "quarantined" &&
            subject.kind === "egress" &&
            subject.egressKey === firstSubject.egressKey,
        ),
      ).toHaveLength(1);
    }),
  );

  it.effect("re-emits quarantined when a subject becomes unhealthy again after expiry", () =>
    Effect.gen(function* () {
      let currentTime = new Date("2026-03-06T15:30:00.000Z");
      const runtime = yield* makeInMemoryAccessHealthRuntime(() => currentTime);

      yield* runtime.recordFailure(egressSubject, policy, "proxy-reset");
      yield* runtime.recordFailure(egressSubject, policy, "proxy-reset");

      currentTime = new Date("2026-03-06T15:30:02.500Z");
      yield* runtime.recordFailure(egressSubject, policy, "proxy-reset");

      const events = yield* runtime.events();
      expect(
        events.filter(
          ({ kind, subject }) =>
            kind === "quarantined" &&
            subject.kind === "egress" &&
            subject.egressKey === egressSubject.egressKey,
        ),
      ).toHaveLength(2);
    }),
  );

  it.effect("keeps profile-level health subjects distinct across profile identifiers", () =>
    Effect.gen(function* () {
      const runtime = yield* makeInMemoryAccessHealthRuntime(
        () => new Date("2026-03-06T16:00:00.000Z"),
      );
      const firstEgressProfileSubject = {
        kind: "egress-profile",
        poolId: "pool-main",
        routePolicyId: "route-direct",
        profileId: "gateway-a",
      } as const;
      const secondEgressProfileSubject = {
        kind: "egress-profile",
        poolId: "pool-main",
        routePolicyId: "route-direct|gateway",
        profileId: "a",
      } as const;
      const firstIdentityProfileSubject = {
        kind: "identity-profile",
        tenantId: "tenant|main",
        domain: "example.com",
        profileId: "identity-a",
      } as const;
      const secondIdentityProfileSubject = {
        kind: "identity-profile",
        tenantId: "tenant",
        domain: "example.com",
        profileId: "main|identity-a",
      } as const;

      const firstEgressSnapshot = yield* runtime.recordSuccess(firstEgressProfileSubject, policy);
      const secondEgressSnapshot = yield* runtime.recordSuccess(secondEgressProfileSubject, policy);
      const firstIdentitySnapshot = yield* runtime.recordSuccess(
        firstIdentityProfileSubject,
        policy,
      );
      const secondIdentitySnapshot = yield* runtime.recordSuccess(
        secondIdentityProfileSubject,
        policy,
      );

      expect(firstEgressSnapshot.subject).toEqual(firstEgressProfileSubject);
      expect(secondEgressSnapshot.subject).toEqual(secondEgressProfileSubject);
      expect(firstIdentitySnapshot.subject).toEqual(firstIdentityProfileSubject);
      expect(secondIdentitySnapshot.subject).toEqual(secondIdentityProfileSubject);
    }),
  );

  it.effect("keeps plugin-level health subjects distinct across plugin identifiers", () =>
    Effect.gen(function* () {
      const runtime = yield* makeInMemoryAccessHealthRuntime(
        () => new Date("2026-03-06T16:15:00.000Z"),
      );
      const firstEgressPluginSubject = {
        kind: "egress-plugin",
        poolId: "pool-main",
        routePolicyId: "route-direct",
        pluginId: "plugin-a",
      } as const;
      const secondEgressPluginSubject = {
        kind: "egress-plugin",
        poolId: "pool-main",
        routePolicyId: "route-direct|plugin",
        pluginId: "a",
      } as const;
      const firstIdentityPluginSubject = {
        kind: "identity-plugin",
        tenantId: "tenant|main",
        domain: "example.com",
        pluginId: "plugin-a",
      } as const;
      const secondIdentityPluginSubject = {
        kind: "identity-plugin",
        tenantId: "tenant",
        domain: "example.com",
        pluginId: "main|plugin-a",
      } as const;

      const firstEgressSnapshot = yield* runtime.recordSuccess(firstEgressPluginSubject, policy);
      const secondEgressSnapshot = yield* runtime.recordSuccess(secondEgressPluginSubject, policy);
      const firstIdentitySnapshot = yield* runtime.recordSuccess(
        firstIdentityPluginSubject,
        policy,
      );
      const secondIdentitySnapshot = yield* runtime.recordSuccess(
        secondIdentityPluginSubject,
        policy,
      );

      expect(firstEgressSnapshot.subject).toEqual(firstEgressPluginSubject);
      expect(secondEgressSnapshot.subject).toEqual(secondEgressPluginSubject);
      expect(firstIdentitySnapshot.subject).toEqual(firstIdentityPluginSubject);
      expect(secondIdentitySnapshot.subject).toEqual(secondIdentityPluginSubject);
    }),
  );
});
