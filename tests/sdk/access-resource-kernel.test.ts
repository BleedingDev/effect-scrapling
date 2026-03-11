import { describe, expect, it } from "@effect-native/bun-test";
import { Effect } from "effect";
import { EgressBroker, IdentityBroker } from "../../src/sdk/access-broker-runtime.ts";
import {
  AccessResourceKernel,
  AccessResourceKernelLive,
} from "../../src/sdk/access-resource-kernel.ts";

describe("sdk access resource kernel", () => {
  it.effect(
    "provisions and releases bound access resources through one kernel-owned lifecycle",
    () => {
      let egressReleased = 0;
      let identityReleased = 0;

      return Effect.gen(function* () {
        const kernel = yield* AccessResourceKernel;
        const provisioned = yield* kernel.provision({
          url: "https://example.com/products/sku-1",
          intent: {
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
              routeKey: "direct",
              routeConfig: {
                kind: "direct",
              },
              requestHeaders: {},
              warnings: [],
            },
            identity: {
              allocationMode: "static",
              pluginId: "builtin-default-identity",
              profileId: "default",
              tenantId: "public",
              browserRuntimeProfileId: "patchright-default",
              httpUserAgent: "effect-scrapling/0.0.1",
              browserUserAgent: "Browser Agent",
              warnings: [],
            },
            http: {
              userAgent: "effect-scrapling/0.0.1",
            },
            warnings: [],
          },
        });

        expect(provisioned.context.providerId).toBe("http-basic");
        expect(provisioned.context.egress.egressKey).toBe("direct-lease");
        expect(provisioned.context.egress.transportBinding).toEqual({
          kind: "direct",
          routeKind: "direct",
          diagnostics: {
            routeKind: "direct",
            routeConfigKind: "direct",
          },
        });
        expect(provisioned.context.identity.identityKey).toBe("default-lease");

        yield* provisioned.release;

        expect(egressReleased).toBe(1);
        expect(identityReleased).toBe(1);
      }).pipe(
        Effect.provide(AccessResourceKernelLive),
        Effect.provideService(EgressBroker, {
          acquire: ({ plan }) =>
            Effect.succeed({
              ...plan.egress,
              egressKey: "direct-lease",
              transportBinding: {
                kind: "direct",
                routeKind: "direct",
                diagnostics: {
                  routeKind: "direct",
                  routeConfigKind: "direct",
                },
              },
              leaseId: "egress-lease-1",
              release: Effect.sync(() => {
                egressReleased += 1;
              }),
            }),
        }),
        Effect.provideService(IdentityBroker, {
          acquire: ({ plan }) =>
            Effect.succeed({
              ...plan.identity,
              identityKey: "default-lease",
              leaseId: "identity-lease-1",
              release: Effect.sync(() => {
                identityReleased += 1;
              }),
            }),
        }),
      );
    },
  );
});
