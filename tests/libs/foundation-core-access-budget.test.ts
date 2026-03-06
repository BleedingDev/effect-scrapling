import { describe, expect, it } from "@effect-native/bun-test";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { makeInMemoryAccessBudgetManager } from "../../libs/foundation/core/src/access-budget-runtime.ts";
import { ConcurrencyBudgetSchema } from "../../libs/foundation/core/src/budget-lease-artifact.ts";

const budget = Schema.decodeUnknownSync(ConcurrencyBudgetSchema)({
  id: "budget-target-product-001",
  ownerId: "target-product-001",
  globalConcurrency: 2,
  maxPerDomain: 1,
});

describe("foundation-core access budget runtime", () => {
  it.effect("prevents overrun under stress and exposes utilization metrics", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* makeInMemoryAccessBudgetManager(
          () => new Date("2026-03-06T13:00:00.000Z"),
        );
        const releaseFirst = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const firstFiber = yield* manager
          .withPermit(budget, "example.com", Deferred.await(releaseFirst))
          .pipe(Effect.forkScoped);
        const secondFiber = yield* manager
          .withPermit(budget, "shop.example.com", Deferred.await(releaseSecond))
          .pipe(Effect.forkScoped);

        yield* Effect.yieldNow;

        const domainFailureMessage = yield* manager
          .withPermit(budget, "example.com", Effect.void)
          .pipe(
            Effect.match({
              onFailure: ({ message }) => message,
              onSuccess: () => "unexpected-success",
            }),
          );
        const globalFailureMessage = yield* manager
          .withPermit(budget, "cdn.example.com", Effect.void)
          .pipe(
            Effect.match({
              onFailure: ({ message }) => message,
              onSuccess: () => "unexpected-success",
            }),
          );

        expect(domainFailureMessage).toContain("denied access");
        expect(globalFailureMessage).toContain("denied access");

        const saturatedSnapshot = yield* manager.inspect(budget);
        expect(saturatedSnapshot.globalInUse).toBe(2);
        expect(saturatedSnapshot.domains).toEqual([
          {
            domain: "example.com",
            capacity: 1,
            available: 0,
            inUse: 1,
          },
          {
            domain: "shop.example.com",
            capacity: 1,
            available: 0,
            inUse: 1,
          },
        ]);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Fiber.join(firstFiber);
        yield* Fiber.join(secondFiber);

        const releasedSnapshot = yield* manager.inspect(budget);
        expect(releasedSnapshot.globalInUse).toBe(0);
        expect(releasedSnapshot.domains.every(({ inUse }) => inUse === 0)).toBe(true);

        const events = yield* manager.events();
        expect(events.map(({ kind }) => kind)).toEqual([
          "acquired",
          "acquired",
          "rejected",
          "rejected",
          "released",
          "released",
        ]);
      }),
    ),
  );
});
