import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Option } from "effect";
import { makeInMemoryEgressLeaseManager } from "../../libs/foundation/core/src/egress-lease-runtime.ts";

describe("foundation-core egress lease runtime", () => {
  it.effect("enforces pool and route budgets while emitting lease telemetry", () =>
    Effect.gen(function* () {
      let currentTime = new Date("2026-03-06T12:00:00.000Z");
      const manager = yield* makeInMemoryEgressLeaseManager(() => currentTime);
      const first = yield* manager.acquire({
        ownerId: "target-product-001",
        egressKey: "proxy-a",
        poolId: "pool-main",
        routePolicyId: "route-primary",
        ttlMs: 1_000,
        maxPoolLeases: 2,
        maxRouteLeases: 1,
      });
      const poolLease = yield* manager.acquire({
        ownerId: "target-product-001",
        egressKey: "proxy-b",
        poolId: "pool-main",
        routePolicyId: "route-secondary",
        ttlMs: 1_000,
        maxPoolLeases: 2,
        maxRouteLeases: 1,
      });

      const routeFailureMessage = yield* manager
        .acquire({
          ownerId: "target-product-001",
          egressKey: "proxy-c",
          poolId: "pool-main",
          routePolicyId: "route-secondary",
          ttlMs: 1_000,
          maxPoolLeases: 3,
          maxRouteLeases: 1,
        })
        .pipe(
          Effect.match({
            onFailure: ({ message }) => message,
            onSuccess: () => "unexpected-success",
          }),
        );

      expect(routeFailureMessage).toContain("Route policy");

      const poolFailureMessage = yield* manager
        .acquire({
          ownerId: "target-product-001",
          egressKey: "proxy-d",
          poolId: "pool-main",
          routePolicyId: "route-tertiary",
          ttlMs: 1_000,
          maxPoolLeases: 2,
          maxRouteLeases: 2,
        })
        .pipe(
          Effect.match({
            onFailure: ({ message }) => message,
            onSuccess: () => "unexpected-success",
          }),
        );

      expect(poolFailureMessage).toContain("Egress pool");

      const renewed = yield* manager.renew({
        leaseId: first.id,
        ttlMs: 2_000,
      });
      expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));

      const released = yield* manager.release(poolLease.id);
      expect(Option.isSome(released)).toBe(true);

      currentTime = new Date("2026-03-06T12:00:03.500Z");
      const snapshot = yield* manager.inspectScope({
        ownerId: "target-product-001",
        poolId: "pool-main",
        routePolicyId: "route-primary",
      });

      expect(snapshot.activePoolLeaseCount).toBe(0);
      expect(snapshot.activeRouteLeaseCount).toBe(0);

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

  it.effect("keeps pool and route caps intact under concurrent allocation pressure", () =>
    Effect.gen(function* () {
      const manager = yield* makeInMemoryEgressLeaseManager(
        () => new Date("2026-03-06T12:30:00.000Z"),
      );
      const outcomes = yield* Effect.forEach(
        ["proxy-a", "proxy-b", "proxy-c"],
        (egressKey) =>
          manager
            .acquire({
              ownerId: "target-product-001",
              egressKey,
              poolId: "pool-main",
              routePolicyId: "route-primary",
              ttlMs: 1_000,
              maxPoolLeases: 1,
              maxRouteLeases: 1,
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
        poolId: "pool-main",
        routePolicyId: "route-primary",
      });

      expect(outcomes.filter((outcome) => outcome === "succeeded")).toHaveLength(1);
      expect(snapshot.activePoolLeaseCount).toBe(1);
      expect(snapshot.activeRouteLeaseCount).toBe(1);
    }),
  );
});
