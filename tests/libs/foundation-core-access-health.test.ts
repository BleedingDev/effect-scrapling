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

const identitySubject = {
  kind: "identity",
  tenantId: "tenant-main",
  domain: "example.com",
  identityKey: "identity-a",
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
      const identitySnapshot = yield* runtime.recordSuccess(identitySubject, policy);
      expect(identitySnapshot.successCount).toBe(1);

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
});
