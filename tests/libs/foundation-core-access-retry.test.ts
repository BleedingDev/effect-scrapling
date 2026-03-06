import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { planAccessExecution } from "../../libs/foundation/core/src/access-planner-runtime.ts";
import {
  executeWithAccessRetry,
  isRetryableAccessFailure,
} from "../../libs/foundation/core/src/access-retry-runtime.ts";
import { AccessPolicySchema } from "../../libs/foundation/core/src/access-policy.ts";
import { captureHttpArtifacts } from "../../libs/foundation/core/src/http-access-runtime.ts";
import {
  PolicyViolation,
  ProviderUnavailable,
} from "../../libs/foundation/core/src/tagged-errors.ts";
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
  timeoutMs: 1_000,
  maxRetries: 2,
  render: "never",
});

describe("foundation-core access retry runtime", () => {
  it.effect("retries retryable failures with a bounded exponential policy", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const decisions: number[] = [];
      const result = yield* executeWithAccessRetry({
        policy: {
          id: "retry-demo",
          maxAttempts: 4,
          baseDelayMs: 100,
          maxDelayMs: 400,
          backoffFactor: 2,
        },
        effect: () => {
          attempts += 1;
          return attempts < 3
            ? Effect.fail(new ProviderUnavailable({ message: `network down ${attempts}` }))
            : Effect.succeed("ok");
        },
        shouldRetry: isRetryableAccessFailure,
        onDecision: (decision) =>
          Effect.sync(() => {
            decisions.push(decision.delayMs);
          }),
        delay: () => Effect.void,
      });

      expect(result.value).toBe("ok");
      expect(result.report.attempts).toBe(3);
      expect(result.report.exhaustedBudget).toBe(false);
      expect(decisions).toEqual([100, 200]);
      expect(attempts).toBe(3);
    }),
  );

  it.effect("does not retry non-retryable policy violations", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const message = yield* executeWithAccessRetry({
        policy: {
          id: "retry-demo",
          maxAttempts: 4,
          baseDelayMs: 100,
          maxDelayMs: 400,
          backoffFactor: 2,
        },
        effect: () => {
          attempts += 1;
          return Effect.fail(
            new PolicyViolation({
              message: "policy drift",
            }),
          );
        },
        shouldRetry: isRetryableAccessFailure,
        delay: () => Effect.void,
      }).pipe(
        Effect.match({
          onFailure: ({ message }) => message,
          onSuccess: () => "unexpected-success",
        }),
      );

      expect(message).toBe("policy drift");
      expect(attempts).toBe(1);
    }),
  );

  it.effect("retries transient HTTP capture failures without exceeding the attempt budget", () =>
    Effect.gen(function* () {
      const decision = yield* planAccessExecution({
        target,
        pack,
        accessPolicy: httpPolicy,
        createdAt: FIXED_DATE,
      });
      let attempts = 0;
      const bundle = yield* captureHttpArtifacts(
        decision.plan,
        async () => {
          attempts += 1;
          if (attempts === 1) {
            return Promise.reject(new Error("transient upstream"));
          }

          return new Response("<html><body>ok</body></html>", {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          });
        },
        () => new Date(FIXED_DATE),
      );

      expect(bundle.artifacts).toHaveLength(4);
      expect(attempts).toBe(2);
    }),
  );
});
