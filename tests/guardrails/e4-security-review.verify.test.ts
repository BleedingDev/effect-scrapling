import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Logger, Schema } from "effect";
import {
  planAccessExecution,
  type AccessPlannerDecision,
} from "../../libs/foundation/core/src/access-planner-runtime.ts";
import { AccessPolicySchema } from "../../libs/foundation/core/src/access-policy.ts";
import {
  buildRedactedBrowserArtifactExports,
  BrowserCaptureBundleSchema,
} from "../../libs/foundation/core/src/browser-access-runtime.ts";
import { SitePackSchema } from "../../libs/foundation/core/src/site-pack.ts";
import { TargetProfileSchema } from "../../libs/foundation/core/src/target-profile.ts";
import { runE4CapabilitySlice } from "../../examples/e4-capability-slice.ts";

const plannerCreatedAt = "2026-03-07T10:00:00.000Z";
const target = Schema.decodeUnknownSync(TargetProfileSchema)({
  id: "target-browser-search-001",
  tenantId: "tenant-main",
  domain: "example.com",
  kind: "searchResult",
  canonicalKey: "search/effect",
  seedUrls: ["https://example.com/search?q=effect"],
  accessPolicyId: "policy-browser-hybrid",
  packId: "pack-example-com",
  priority: 20,
});
const pack = Schema.decodeUnknownSync(SitePackSchema)({
  id: "pack-example-com",
  domainPattern: "*.example.com",
  state: "shadow",
  accessPolicyId: "policy-browser-hybrid",
  version: "2026.03.07",
});
const hybridPolicy = Schema.decodeUnknownSync(AccessPolicySchema)({
  id: "policy-browser-hybrid",
  mode: "hybrid",
  perDomainConcurrency: 2,
  globalConcurrency: 4,
  timeoutMs: 20_000,
  maxRetries: 1,
  render: "onDemand",
});

function createPlan(targetKind: "blogPost" | "searchResult", failureCount = 0) {
  return planAccessExecution({
    target: Schema.decodeUnknownSync(TargetProfileSchema)({
      ...Schema.encodeSync(TargetProfileSchema)(target),
      kind: targetKind,
    }),
    pack,
    accessPolicy: hybridPolicy,
    createdAt: plannerCreatedAt,
    ...(failureCount === 0
      ? {}
      : {
          failureContext: {
            recentFailureCount: failureCount,
            lastFailureCode: "provider_unavailable",
          },
        }),
  });
}

function capturePathMessage(decision: AccessPlannerDecision) {
  return decision.rationale.find(({ key }) => key === "capture-path")?.message;
}

describe("E4 security review verification", () => {
  it.effect("keeps browser usage selective and evidence-driven at the planner boundary", () =>
    Effect.gen(function* () {
      const lowFrictionDecision = yield* createPlan("blogPost");
      const highFrictionDecision = yield* createPlan("searchResult");
      const failureEscalationDecision = yield* createPlan("blogPost", 2);

      expect(lowFrictionDecision.plan.steps[0]?.requiresBrowser).toBe(false);
      expect(lowFrictionDecision.plan.steps[0]?.artifactKind).toBe("html");
      expect(capturePathMessage(lowFrictionDecision)).toContain("selected http provider");

      expect(highFrictionDecision.plan.steps[0]?.requiresBrowser).toBe(true);
      expect(highFrictionDecision.plan.steps[0]?.artifactKind).toBe("renderedDom");
      expect(capturePathMessage(highFrictionDecision)).toContain(
        "high-friction searchResult targets",
      );

      expect(failureEscalationDecision.plan.steps[0]?.requiresBrowser).toBe(true);
      expect(capturePathMessage(failureEscalationDecision)).toContain("provider_unavailable");
      expect(capturePathMessage(failureEscalationDecision)).toContain("2 recent access failure");
    }),
  );

  it("re-sanitizes secret-bearing DOM titles and relative export targets", () => {
    const bundle = Schema.decodeUnknownSync(BrowserCaptureBundleSchema)({
      capturedAt: "2026-03-07T10:01:00.000Z",
      artifacts: [
        {
          id: "artifact-rendered-dom-001",
          runId: "plan-browser-security-review-001",
          artifactId: "artifact-rendered-dom-001",
          kind: "renderedDom",
          visibility: "raw",
          locator: {
            namespace: "captures/target-browser-search-001",
            key: "plan-browser-security-review-001/rendered-dom.html",
          },
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          sizeBytes: 256,
          mediaType: "text/html",
          storedAt: "2026-03-07T10:01:00.000Z",
        },
      ],
      payloads: [
        {
          locator: {
            namespace: "captures/target-browser-search-001",
            key: "plan-browser-security-review-001/rendered-dom.html",
          },
          mediaType: "text/html",
          encoding: "utf8",
          body: `<html><head><title>Security Review token=title-secret Bearer title-secret</title></head><body><main>token=body-secret</main><a href="/checkout?session=checkout-secret#payment">checkout</a><form action="?csrf=form-secret#frag"></form></body></html>`,
        },
      ],
    });
    const exportBundle = buildRedactedBrowserArtifactExports(bundle);
    const renderedDomExport = JSON.parse(exportBundle.exports[0]?.body ?? "{}");

    expect(renderedDomExport).toEqual({
      title: "Security Review token=[REDACTED] Bearer [REDACTED]",
      textPreview: "token=[REDACTED]",
      linkTargets: ["/checkout?session=%5BREDACTED%5D", "?csrf=%5BREDACTED%5D"],
      hiddenFieldCount: 0,
    });
    expect(exportBundle.exports[0]?.body).not.toContain("title-secret");
    expect(exportBundle.exports[0]?.body).not.toContain("body-secret");
    expect(exportBundle.exports[0]?.body).not.toContain("checkout-secret");
    expect(exportBundle.exports[0]?.body).not.toContain("form-secret");
  });

  it.effect(
    "emits sanitized E4 capability evidence with allowed policy decisions and zero leaks",
    () =>
      Effect.gen(function* () {
        const evidence = yield* runE4CapabilitySlice().pipe(
          Effect.provideService(Logger.CurrentLoggers, new Set<Logger.Logger<unknown, unknown>>()),
        );
        const encodedBodies = evidence.redactedExports.exports.map(({ body }) => body);

        expect(evidence.plannerDecision.plan.steps[0]?.requiresBrowser).toBe(true);
        expect(
          evidence.policyDecisions.every(
            ({ outcome, policy }) =>
              outcome === "allowed" &&
              (policy === "sessionIsolation" || policy === "originRestriction"),
          ),
        ).toBe(true);
        expect(evidence.leakSnapshot.openBrowsers).toBe(0);
        expect(evidence.leakSnapshot.openContexts).toBe(0);
        expect(evidence.leakSnapshot.openPages).toBe(0);
        expect(evidence.leakAlarms).toEqual([]);

        for (const body of encodedBodies) {
          expect(body).not.toContain("browser-secret");
          expect(body).not.toContain("super-secret");
        }
      }),
  );
});
