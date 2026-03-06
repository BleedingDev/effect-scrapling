import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Fiber, Schema } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { planAccessExecution } from "../../libs/foundation/core/src/access-planner-runtime.ts";
import {
  tryAbortableAccess,
  withAccessTimeout,
} from "../../libs/foundation/core/src/access-timeout-runtime.ts";
import { AccessPolicySchema } from "../../libs/foundation/core/src/access-policy.ts";
import { captureHttpArtifacts } from "../../libs/foundation/core/src/http-access-runtime.ts";
import { RunPlanSchema } from "../../libs/foundation/core/src/run-state.ts";
import { PolicyViolation } from "../../libs/foundation/core/src/tagged-errors.ts";
import { SitePackSchema } from "../../libs/foundation/core/src/site-pack.ts";
import { TargetProfileSchema } from "../../libs/foundation/core/src/target-profile.ts";

const FIXED_DATE = "2026-03-06T10:30:00.000Z";

const target = Schema.decodeUnknownSync(TargetProfileSchema)({
  id: "target-product-001",
  tenantId: "tenant-main",
  domain: "example.com",
  kind: "productPage",
  canonicalKey: "catalog/product-001",
  seedUrls: ["https://example.com/products/001"],
  accessPolicyId: "policy-http",
  packId: "pack-example-com",
  priority: 10,
});

const pack = Schema.decodeUnknownSync(SitePackSchema)({
  id: "pack-example-com",
  domainPattern: "*.example.com",
  state: "shadow",
  accessPolicyId: "policy-http",
  version: "2026.03.06",
});

const httpPolicy = Schema.decodeUnknownSync(AccessPolicySchema)({
  id: "policy-http",
  mode: "http",
  perDomainConcurrency: 8,
  globalConcurrency: 64,
  timeoutMs: 100,
  maxRetries: 2,
  render: "never",
});

describe("foundation-core access timeout runtime", () => {
  it.effect("fails slow abortable operations with TimeoutError and aborts the signal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let aborted = false;
        const fiber = yield* tryAbortableAccess({
          policy: {
            timeoutMs: 100,
            timeoutMessage: "Access operation timed out.",
          },
          try: (signal) =>
            new Promise<string>(() => {
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                },
                { once: true },
              );
            }),
          catch: () =>
            new PolicyViolation({
              message: "unexpected",
            }),
        }).pipe(Effect.forkScoped);

        yield* Effect.yieldNow;
        yield* TestClock.adjust(100);

        const message = yield* Fiber.join(fiber).pipe(
          Effect.match({
            onFailure: ({ message }) => message,
            onSuccess: () => "unexpected-success",
          }),
        );

        expect(message).toBe("Access operation timed out.");
        expect(aborted).toBe(true);
      }),
    ),
  );

  it.effect("aborts in-flight operations when the running fiber is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let aborted = false;
        const fiber = yield* tryAbortableAccess({
          policy: {
            timeoutMs: 5_000,
            timeoutMessage: "Should not hit the timeout path.",
          },
          try: (signal) =>
            new Promise<string>(() => {
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                },
                { once: true },
              );
            }),
          catch: () =>
            new PolicyViolation({
              message: "unexpected",
            }),
        }).pipe(Effect.forkScoped);

        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        yield* Effect.yieldNow;

        expect(aborted).toBe(true);
      }),
    ),
  );

  it.effect("threads typed timeout failures into the real HTTP capture runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const decision = yield* planAccessExecution({
          target,
          pack,
          accessPolicy: httpPolicy,
          createdAt: FIXED_DATE,
        });
        const timeoutOnlyPlan = Schema.decodeUnknownSync(RunPlanSchema)({
          ...decision.plan,
          maxAttempts: 1,
        });
        let aborted = false;
        const fiber = yield* captureHttpArtifacts(
          timeoutOnlyPlan,
          async (_, init) =>
            new Promise<Response>(() => {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                },
                { once: true },
              );
            }),
          () => new Date(FIXED_DATE),
        ).pipe(Effect.forkScoped);

        yield* Effect.yieldNow;
        yield* TestClock.adjust(100);

        const message = yield* Fiber.join(fiber).pipe(
          Effect.match({
            onFailure: ({ message }) => message,
            onSuccess: () => "unexpected-success",
          }),
        );

        expect(message).toContain("HTTP access timed out");
        expect(aborted).toBe(true);
      }),
    ),
  );

  it.effect("rejects invalid timeout policies through shared schema contracts", () =>
    Effect.gen(function* () {
      const message = yield* withAccessTimeout(Effect.succeed("ok"), {
        timeoutMs: 10,
        timeoutMessage: "",
      }).pipe(
        Effect.match({
          onFailure: ({ message }) => message,
          onSuccess: () => "unexpected-success",
        }),
      );

      expect(message).toContain("Failed to decode access-timeout policy");
    }),
  );
});
