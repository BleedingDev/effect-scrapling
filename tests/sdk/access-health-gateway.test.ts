import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Layer } from "effect";
import {
  AccessHealthGateway,
  makeSharedAccessHealthGatewayLiveLayer,
  makeAccessHealthGatewayLiveLayer,
  type AccessHealthContext,
} from "../../src/sdk/access-health-gateway.ts";
import {
  AccessHealthPolicyRegistry,
  AccessHealthSubjectStrategy,
} from "../../src/sdk/access-health-policy-runtime.ts";
import { AccessHealthRuntimeLive } from "../../src/sdk/access-health-runtime-service.ts";
import { AccessQuarantinedError, NetworkError } from "../../src/sdk/errors.ts";

const healthContext: AccessHealthContext = {
  url: "https://example.com/products/sku-1",
  context: {
    targetUrl: "https://example.com/products/sku-1",
    targetDomain: "example.com",
    providerId: "http-basic",
    mode: "http",
    timeoutMs: 500,
    egress: {
      allocationMode: "static",
      pluginId: "builtin-direct-egress",
      profileId: "direct",
      poolId: "direct-pool",
      routePolicyId: "direct-route",
      routeKind: "direct",
      routeKey: "planned-direct-route",
      requestHeaders: {},
      warnings: [],
      egressKey: "leased-direct-egress",
      release: Effect.void,
    },
    identity: {
      allocationMode: "static",
      pluginId: "builtin-default-identity",
      profileId: "planned-default-identity",
      tenantId: "public",
      browserRuntimeProfileId: "patchright-default",
      httpUserAgent: "effect-scrapling/0.0.1",
      browserUserAgent: "browser-agent",
      locale: undefined,
      timezoneId: undefined,
      warnings: [],
      identityKey: "leased-default-identity",
      release: Effect.void,
    },
    http: {
      userAgent: "effect-scrapling/0.0.1",
    },
    warnings: [],
  },
};

describe("sdk access health gateway", () => {
  it.effect("persists health state within one provided gateway instance", () =>
    Effect.gen(function* () {
      const gateway = yield* AccessHealthGateway;
      const failure = new NetworkError({
        message: "Access failed for https://example.com/products/sku-1",
      });

      yield* gateway.recordFailure(healthContext, failure);
      yield* gateway.recordFailure(healthContext, failure);

      const quarantined = yield* gateway.assertHealthy(healthContext).pipe(
        Effect.match({
          onSuccess: () => undefined,
          onFailure: (error) => error,
        }),
      );

      expect(quarantined).toBeInstanceOf(AccessQuarantinedError);
    }).pipe(Effect.provide(makeSharedAccessHealthGatewayLiveLayer())),
  );

  it.effect(
    "shares quarantine across leases that reuse the same profile and isolates different profiles",
    () =>
      Effect.gen(function* () {
        const gateway = yield* AccessHealthGateway;
        const isolatedContext: AccessHealthContext = {
          ...healthContext,
          context: {
            ...healthContext.context,
            egress: {
              ...healthContext.context.egress,
              egressKey: "leased-direct-egress-b",
              release: Effect.void,
            },
            identity: {
              ...healthContext.context.identity,
              identityKey: "leased-default-identity-b",
              release: Effect.void,
            },
          },
        };
        const differentProfileContext: AccessHealthContext = {
          ...healthContext,
          context: {
            ...healthContext.context,
            egress: {
              ...healthContext.context.egress,
              pluginId: "builtin-leased-egress",
              profileId: "leased-direct",
              poolId: "leased-direct-pool",
              routePolicyId: "leased-direct-route",
              routeKey: "leased-direct",
              egressKey: "leased-direct-egress-c",
              release: Effect.void,
            },
            identity: {
              ...healthContext.context.identity,
              pluginId: "builtin-leased-identity",
              profileId: "leased-default",
              identityKey: "leased-default-identity-c",
              release: Effect.void,
            },
          },
        };
        const failure = new NetworkError({
          message: "Access failed for https://example.com/products/sku-1",
        });

        yield* gateway.recordFailure(healthContext, failure);
        yield* gateway.recordFailure(healthContext, failure);

        const originalLease = yield* gateway.assertHealthy(healthContext).pipe(
          Effect.match({
            onSuccess: () => undefined,
            onFailure: (error) => error,
          }),
        );
        const isolatedLease = yield* gateway.assertHealthy(isolatedContext).pipe(
          Effect.match({
            onSuccess: () => undefined,
            onFailure: (error) => error,
          }),
        );
        const differentProfileLease = yield* gateway.assertHealthy(differentProfileContext).pipe(
          Effect.match({
            onSuccess: () => "healthy",
            onFailure: (error) => error,
          }),
        );

        expect(originalLease).toBeInstanceOf(AccessQuarantinedError);
        expect(isolatedLease).toBeInstanceOf(AccessQuarantinedError);
        expect(differentProfileLease).toBe("healthy");
      }).pipe(Effect.provide(makeSharedAccessHealthGatewayLiveLayer())),
  );

  it.effect("supports injected health policy and subject strategy plugins", () =>
    Effect.gen(function* () {
      const gateway = yield* AccessHealthGateway;
      const failure = new NetworkError({
        message: "Access failed for https://example.com/products/sku-1",
      });

      yield* gateway.recordFailure(healthContext, failure);

      const providerQuarantined = yield* gateway.assertHealthy(healthContext).pipe(
        Effect.match({
          onSuccess: () => undefined,
          onFailure: (error) => error,
        }),
      );

      expect(providerQuarantined).toBeInstanceOf(AccessQuarantinedError);
      expect(providerQuarantined?.details).toContain("provider");
    }).pipe(
      Effect.provide(
        makeAccessHealthGatewayLiveLayer().pipe(
          Layer.provide(
            Layer.mergeAll(
              AccessHealthRuntimeLive,
              Layer.succeed(AccessHealthPolicyRegistry, {
                policyFor: (subject) =>
                  subject.kind === "provider"
                    ? {
                        failureThreshold: 1,
                        recoveryThreshold: 1,
                        quarantineMs: 60_000,
                      }
                    : {
                        failureThreshold: 10,
                        recoveryThreshold: 2,
                        quarantineMs: 60_000,
                      },
              }),
              Layer.succeed(AccessHealthSubjectStrategy, {
                subjectsFor: (context) => [
                  {
                    kind: "provider",
                    providerId: context.context.providerId,
                  },
                ],
              }),
            ),
          ),
        ),
      ),
    ),
  );
});
