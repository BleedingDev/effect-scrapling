import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Layer, Match, Schema } from "effect";
import { AccessPlanner, HttpAccess } from "../../libs/foundation/core/src/service-topology.ts";
import {
  AccessPlannerDecisionSchema,
  AccessPlannerLive,
  planAccessExecution,
} from "../../libs/foundation/core/src/access-planner-runtime.ts";
import { AccessPolicySchema } from "../../libs/foundation/core/src/access-policy.ts";
import {
  HttpAccessLive,
  HttpCaptureBundleSchema,
  captureHttpArtifacts,
} from "../../libs/foundation/core/src/http-access-runtime.ts";
import { RunPlanSchema } from "../../libs/foundation/core/src/run-state.ts";
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
  timeoutMs: 30_000,
  maxRetries: 2,
  render: "never",
});

describe("foundation-core access runtime", () => {
  it.effect("emits deterministic access plans with explicit budgets and rationale", () =>
    Effect.gen(function* () {
      const first = yield* planAccessExecution({
        target,
        pack,
        accessPolicy: httpPolicy,
        createdAt: FIXED_DATE,
      });
      const second = yield* planAccessExecution({
        target,
        pack,
        accessPolicy: httpPolicy,
        createdAt: FIXED_DATE,
      });

      expect(Schema.encodeSync(AccessPlannerDecisionSchema)(first)).toEqual(
        Schema.encodeSync(AccessPlannerDecisionSchema)(second),
      );
      expect(first.concurrencyBudget.maxPerDomain).toBe(8);
      expect(first.plan.steps[0]?.stage).toBe("capture");
      expect(first.plan.steps[0]?.requiresBrowser).toBe(false);
      expect(first.rationale.map(({ key }) => key)).toEqual([
        "mode",
        "rendering",
        "budget",
        "capture-path",
      ]);

      const planned = yield* Effect.gen(function* () {
        const planner = yield* AccessPlanner;
        return yield* planner.plan(target, pack, httpPolicy);
      }).pipe(Effect.provide(AccessPlannerLive(() => new Date(FIXED_DATE))));

      expect(Schema.encodeSync(RunPlanSchema)(planned)).toEqual(
        Schema.encodeSync(RunPlanSchema)(first.plan),
      );
    }),
  );

  it.effect(
    "rejects access-planner input when the target domain does not match the site pack",
    () =>
      Effect.gen(function* () {
        const error = yield* planAccessExecution({
          target: Schema.decodeUnknownSync(TargetProfileSchema)({
            ...Schema.encodeSync(TargetProfileSchema)(target),
            domain: "other-example.com",
          }),
          pack,
          accessPolicy: httpPolicy,
          createdAt: FIXED_DATE,
        }).pipe(Effect.flip);

        yield* Match.value(error).pipe(
          Match.tag("PolicyViolation", ({ message }) =>
            Effect.sync(() => {
              expect(message).toContain("does not match pack domain pattern");
            }),
          ),
          Match.exhaustive,
        );
      }),
  );

  it.effect("rejects access-planner input when pack or access-policy identifiers drift", () =>
    Effect.gen(function* () {
      const packFailureMessage = yield* planAccessExecution({
        target: Schema.decodeUnknownSync(TargetProfileSchema)({
          ...Schema.encodeSync(TargetProfileSchema)(target),
          packId: "pack-other",
        }),
        pack,
        accessPolicy: httpPolicy,
        createdAt: FIXED_DATE,
      }).pipe(
        Effect.match({
          onFailure: ({ message }) => message,
          onSuccess: () => "unexpected-success",
        }),
      );

      expect(packFailureMessage).not.toBe("unexpected-success");
      expect(packFailureMessage).toContain("packId must resolve");

      const policyFailureMessage = yield* planAccessExecution({
        target,
        pack: Schema.decodeUnknownSync(SitePackSchema)({
          ...Schema.encodeSync(SitePackSchema)(pack),
          accessPolicyId: "policy-other",
        }),
        accessPolicy: httpPolicy,
        createdAt: FIXED_DATE,
      }).pipe(
        Effect.match({
          onFailure: ({ message }) => message,
          onSuccess: () => "unexpected-success",
        }),
      );

      expect(policyFailureMessage).not.toBe("unexpected-success");
      expect(policyFailureMessage).toContain("must agree on accessPolicyId");
    }),
  );

  it.effect("rejects access-planner input when the seed URL host escapes the target domain", () =>
    Effect.gen(function* () {
      const hostFailureMessage = yield* planAccessExecution({
        target: Schema.decodeUnknownSync(TargetProfileSchema)({
          ...Schema.encodeSync(TargetProfileSchema)(target),
          seedUrls: ["https://evil.example.net/products/001"],
        }),
        pack,
        accessPolicy: httpPolicy,
        createdAt: FIXED_DATE,
      }).pipe(
        Effect.match({
          onFailure: ({ message }) => message,
          onSuccess: () => "unexpected-success",
        }),
      );

      expect(hostFailureMessage).not.toBe("unexpected-success");
      expect(hostFailureMessage).toContain("must stay within target domain");
    }),
  );

  it.effect(
    "keeps low-friction hybrid targets on the HTTP-first provider and records evidence",
    () =>
      Effect.gen(function* () {
        const hybridDecision = yield* planAccessExecution({
          target: Schema.decodeUnknownSync(TargetProfileSchema)({
            ...Schema.encodeSync(TargetProfileSchema)(target),
            kind: "blogPost",
          }),
          pack,
          accessPolicy: Schema.decodeUnknownSync(AccessPolicySchema)({
            ...Schema.encodeSync(AccessPolicySchema)(httpPolicy),
            mode: "hybrid",
            render: "onDemand",
          }),
          createdAt: FIXED_DATE,
        });

        expect(hybridDecision.plan.steps[0]?.requiresBrowser).toBe(false);
        expect(hybridDecision.plan.steps[0]?.artifactKind).toBe("html");
        expect(hybridDecision.rationale.find(({ key }) => key === "mode")?.message).toBe(
          "Access mode resolved to hybrid.",
        );
        expect(
          hybridDecision.rationale.find(({ key }) => key === "capture-path")?.message,
        ).toContain("selected http provider");
        expect(
          hybridDecision.rationale.find(({ key }) => key === "capture-path")?.message,
        ).toContain("HTTP-first path for blogPost targets");
      }),
  );

  it.effect('escalates hybrid targets with `render: "always"` to the browser provider', () =>
    Effect.gen(function* () {
      const hybridDecision = yield* planAccessExecution({
        target,
        pack,
        accessPolicy: Schema.decodeUnknownSync(AccessPolicySchema)({
          ...Schema.encodeSync(AccessPolicySchema)(httpPolicy),
          mode: "hybrid",
          render: "always",
        }),
        createdAt: FIXED_DATE,
      });

      expect(hybridDecision.plan.steps[0]?.requiresBrowser).toBe(true);
      expect(hybridDecision.plan.steps[0]?.artifactKind).toBe("renderedDom");
      expect(hybridDecision.rationale.find(({ key }) => key === "capture-path")?.message).toContain(
        'render: "always"',
      );
    }),
  );

  it.effect("escalates high-friction hybrid targets to the browser provider", () =>
    Effect.gen(function* () {
      const hybridDecision = yield* planAccessExecution({
        target: Schema.decodeUnknownSync(TargetProfileSchema)({
          ...Schema.encodeSync(TargetProfileSchema)(target),
          kind: "searchResult",
        }),
        pack,
        accessPolicy: Schema.decodeUnknownSync(AccessPolicySchema)({
          ...Schema.encodeSync(AccessPolicySchema)(httpPolicy),
          mode: "hybrid",
          render: "onDemand",
        }),
        createdAt: FIXED_DATE,
      });

      expect(hybridDecision.plan.steps[0]?.requiresBrowser).toBe(true);
      expect(hybridDecision.plan.steps[0]?.artifactKind).toBe("renderedDom");
      expect(hybridDecision.rationale.find(({ key }) => key === "capture-path")?.message).toContain(
        "selected browser provider",
      );
      expect(hybridDecision.rationale.find(({ key }) => key === "capture-path")?.message).toContain(
        "high-friction searchResult targets",
      );
    }),
  );

  it.effect(
    "escalates hybrid targets after repeated access failures and records policy evidence",
    () =>
      Effect.gen(function* () {
        const hybridDecision = yield* planAccessExecution({
          target,
          pack,
          accessPolicy: Schema.decodeUnknownSync(AccessPolicySchema)({
            ...Schema.encodeSync(AccessPolicySchema)(httpPolicy),
            mode: "hybrid",
            render: "onDemand",
          }),
          createdAt: FIXED_DATE,
          failureContext: {
            recentFailureCount: 2,
            lastFailureCode: "provider_unavailable",
          },
        });

        expect(hybridDecision.plan.steps[0]?.requiresBrowser).toBe(true);
        expect(hybridDecision.plan.steps[0]?.artifactKind).toBe("renderedDom");
        expect(
          hybridDecision.rationale.find(({ key }) => key === "capture-path")?.message,
        ).toContain("provider_unavailable");
        expect(
          hybridDecision.rationale.find(({ key }) => key === "capture-path")?.message,
        ).toContain("2 recent access failure");
      }),
  );

  it.effect("captures normalized request and response artifacts over HTTP", () =>
    Effect.gen(function* () {
      const decision = yield* planAccessExecution({
        target,
        pack,
        accessPolicy: httpPolicy,
        createdAt: FIXED_DATE,
      });
      let perfIndex = 0;
      const perfMarks = [100, 112.5];
      const fetchImpl = async () =>
        new Response("<html><body><h1>Example Product</h1></body></html>", {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "x-request-id": "req-001",
          },
        });
      const bundle = yield* captureHttpArtifacts(
        decision.plan,
        fetchImpl,
        () => new Date(FIXED_DATE),
        () => perfMarks[perfIndex++] ?? 112.5,
      );

      expect(
        Schema.encodeSync(HttpCaptureBundleSchema)(bundle).artifacts.map(({ kind }) => kind),
      ).toEqual(["requestMetadata", "responseMetadata", "html", "timings"]);
      expect(bundle.payloads[0]?.body).toContain('"method": "GET"');
      expect(bundle.payloads[1]?.body).toContain('"status": 200');
      expect(bundle.payloads[2]?.body).toContain("<h1>Example Product</h1>");
      expect(bundle.payloads[3]?.body).toContain('"durationMs": 12.5');

      const capturedArtifacts = yield* Effect.gen(function* () {
        const httpAccess = yield* HttpAccess;
        return yield* httpAccess.capture(decision.plan);
      }).pipe(
        Effect.provide(
          HttpAccessLive(
            fetchImpl,
            () => new Date(FIXED_DATE),
            () => 10,
          ),
        ),
      );

      expect(capturedArtifacts).toHaveLength(4);
      expect(capturedArtifacts[0]?.locator.namespace).toBe("captures/target-product-001");
    }),
  );

  it.effect("rejects browser-required plans for HTTP access", () =>
    Effect.gen(function* () {
      const browserPlan = Schema.decodeUnknownSync(RunPlanSchema)({
        ...(yield* planAccessExecution({
          target,
          pack,
          accessPolicy: Schema.decodeUnknownSync(AccessPolicySchema)({
            ...Schema.encodeSync(AccessPolicySchema)(httpPolicy),
            mode: "browser",
            render: "always",
          }),
          createdAt: FIXED_DATE,
        })).plan,
      });
      const failureMessage = yield* Effect.gen(function* () {
        const httpAccess = yield* HttpAccess;
        return yield* httpAccess.capture(browserPlan);
      }).pipe(
        Effect.provide(
          Layer.succeed(HttpAccess)(
            HttpAccess.of({
              capture: (plan) =>
                captureHttpArtifacts(plan, fetch, () => new Date(FIXED_DATE)).pipe(
                  Effect.map(({ artifacts }) => artifacts),
                ),
            }),
          ),
        ),
        Effect.match({
          onFailure: ({ message }) => message,
          onSuccess: () => "unexpected-success",
        }),
      );

      expect(failureMessage).not.toBe("unexpected-success");
      expect(failureMessage).toContain("requires browser resources");
    }),
  );

  it.effect(
    "maps fetch failures to ProviderUnavailable and rejects plans without capture steps",
    () =>
      Effect.gen(function* () {
        const decision = yield* planAccessExecution({
          target,
          pack,
          accessPolicy: httpPolicy,
          createdAt: FIXED_DATE,
        });
        const providerFailureMessage = yield* captureHttpArtifacts(
          decision.plan,
          async () => Promise.reject(new Error("network down")),
          () => new Date(FIXED_DATE),
        ).pipe(
          Effect.match({
            onFailure: ({ message }) => message,
            onSuccess: () => "unexpected-success",
          }),
        );

        expect(providerFailureMessage).not.toBe("unexpected-success");
        expect(providerFailureMessage).toContain("network down");

        const bodyReadFailureMessage = yield* captureHttpArtifacts(
          decision.plan,
          async () =>
            Object.assign(new Response("<html></html>", { status: 200 }), {
              text: async () => Promise.reject(new Error("body read failed")),
            }),
          () => new Date(FIXED_DATE),
        ).pipe(
          Effect.match({
            onFailure: ({ message }) => message,
            onSuccess: () => "unexpected-success",
          }),
        );

        expect(bodyReadFailureMessage).not.toBe("unexpected-success");
        expect(bodyReadFailureMessage).toContain("body read failed");

        const noCapturePlan = Schema.decodeUnknownSync(RunPlanSchema)({
          ...decision.plan,
          steps: [
            {
              id: "step-extract",
              stage: "extract",
              requiresBrowser: false,
            },
            {
              id: "step-snapshot",
              stage: "snapshot",
              requiresBrowser: false,
            },
          ],
        });
        const missingCaptureMessage = yield* captureHttpArtifacts(
          noCapturePlan,
          fetch,
          () => new Date(FIXED_DATE),
        ).pipe(
          Effect.match({
            onFailure: ({ message }) => message,
            onSuccess: () => "unexpected-success",
          }),
        );

        expect(missingCaptureMessage).not.toBe("unexpected-success");
        expect(missingCaptureMessage).toContain("requires a capture step");
      }),
  );
});
