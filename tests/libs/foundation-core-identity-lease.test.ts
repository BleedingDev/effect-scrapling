import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Option } from "effect";
import { makeInMemoryIdentityLeaseManager } from "../../libs/foundation/core/src/identity-lease-runtime.ts";

describe("foundation-core identity lease runtime", () => {
  it.effect(
    "prevents unbounded reuse inside the same tenant/domain scope and tracks lifecycle events",
    () =>
      Effect.gen(function* () {
        let currentTime = new Date("2026-03-06T10:30:00.000Z");
        const manager = yield* makeInMemoryIdentityLeaseManager(() => currentTime);
        const firstLease = yield* manager.acquire({
          ownerId: "target-product-001",
          tenantId: "tenant-main",
          domain: "example.com",
          identityKey: "identity-a",
          ttlMs: 1_000,
          maxActiveLeases: 2,
        });
        const secondLease = yield* manager.acquire({
          ownerId: "target-product-001",
          tenantId: "tenant-main",
          domain: "example.com",
          identityKey: "identity-b",
          ttlMs: 1_000,
          maxActiveLeases: 2,
        });

        const exhaustedMessage = yield* manager
          .acquire({
            ownerId: "target-product-001",
            tenantId: "tenant-main",
            domain: "example.com",
            identityKey: "identity-c",
            ttlMs: 1_000,
            maxActiveLeases: 2,
          })
          .pipe(
            Effect.match({
              onFailure: ({ message }) => message,
              onSuccess: () => "unexpected-success",
            }),
          );

        expect(exhaustedMessage).toContain("exhausted");

        const duplicateMessage = yield* manager
          .acquire({
            ownerId: "target-product-001",
            tenantId: "tenant-main",
            domain: "example.com",
            identityKey: "identity-a",
            ttlMs: 1_000,
            maxActiveLeases: 3,
          })
          .pipe(
            Effect.match({
              onFailure: ({ message }) => message,
              onSuccess: () => "unexpected-success",
            }),
          );

        expect(duplicateMessage).toContain("already leased");

        const renewed = yield* manager.renew({
          leaseId: firstLease.id,
          ttlMs: 2_000,
        });
        expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(firstLease.expiresAt));

        const released = yield* manager.release(secondLease.id);
        expect(Option.isSome(released)).toBe(true);

        currentTime = new Date("2026-03-06T10:30:03.500Z");
        const snapshotAfterExpiry = yield* manager.inspectScope({
          ownerId: "target-product-001",
          tenantId: "tenant-main",
          domain: "example.com",
        });

        expect(snapshotAfterExpiry.activeLeaseCount).toBe(0);
        expect(snapshotAfterExpiry.identityKeys).toEqual([]);

        const events = yield* manager.events();
        expect(events.map(({ kind }) => kind)).toEqual([
          "allocated",
          "allocated",
          "renewed",
          "released",
          "expired",
        ]);
      }),
  );

  it.effect("keeps identity lease budgets isolated across tenant and domain scopes", () =>
    Effect.gen(function* () {
      const manager = yield* makeInMemoryIdentityLeaseManager(
        () => new Date("2026-03-06T11:00:00.000Z"),
      );
      yield* manager.acquire({
        ownerId: "target-product-001",
        tenantId: "tenant-main",
        domain: "example.com",
        identityKey: "identity-a",
        ttlMs: 1_000,
        maxActiveLeases: 1,
      });
      const crossTenantLease = yield* manager.acquire({
        ownerId: "target-product-001",
        tenantId: "tenant-secondary",
        domain: "example.com",
        identityKey: "identity-a",
        ttlMs: 1_000,
        maxActiveLeases: 1,
      });
      const crossDomainLease = yield* manager.acquire({
        ownerId: "target-product-001",
        tenantId: "tenant-main",
        domain: "shop.example.com",
        identityKey: "identity-a",
        ttlMs: 1_000,
        maxActiveLeases: 1,
      });

      expect(crossTenantLease.identityKey).toBe("identity-a");
      expect(crossDomainLease.identityKey).toBe("identity-a");
    }),
  );

  it.effect("keeps scopes distinct when identifiers contain separator characters", () =>
    Effect.gen(function* () {
      const manager = yield* makeInMemoryIdentityLeaseManager(
        () => new Date("2026-03-06T11:15:00.000Z"),
      );
      const firstScopeLease = yield* manager.acquire({
        ownerId: "target|product-001",
        tenantId: "tenant-main",
        domain: "example.com",
        identityKey: "identity-a",
        ttlMs: 1_000,
        maxActiveLeases: 1,
      });
      const secondScopeLease = yield* manager.acquire({
        ownerId: "target",
        tenantId: "product-001|tenant-main",
        domain: "example.com",
        identityKey: "identity-a",
        ttlMs: 1_000,
        maxActiveLeases: 1,
      });

      expect(firstScopeLease.id).not.toBe(secondScopeLease.id);
      expect(firstScopeLease.ownerId).toBe("target|product-001");
      expect(secondScopeLease.ownerId).toBe("target");
    }),
  );

  it.effect("enforces scope budgets under parallel acquisition pressure", () =>
    Effect.gen(function* () {
      const manager = yield* makeInMemoryIdentityLeaseManager(
        () => new Date("2026-03-06T11:30:00.000Z"),
      );
      const outcomes = yield* Effect.forEach(
        ["identity-a", "identity-b", "identity-c"],
        (identityKey) =>
          manager
            .acquire({
              ownerId: "target-product-001",
              tenantId: "tenant-main",
              domain: "example.com",
              identityKey,
              ttlMs: 1_000,
              maxActiveLeases: 1,
            })
            .pipe(
              Effect.match({
                onFailure: () => "failed" as const,
                onSuccess: () => "succeeded" as const,
              }),
            ),
        { concurrency: "unbounded" },
      );
      const snapshot = yield* manager.inspectScope({
        ownerId: "target-product-001",
        tenantId: "tenant-main",
        domain: "example.com",
      });

      expect(outcomes.filter((outcome) => outcome === "succeeded")).toHaveLength(1);
      expect(snapshot.activeLeaseCount).toBe(1);
    }),
  );
});
