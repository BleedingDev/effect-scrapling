import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Layer, Match, Schema } from "effect";
import { AccessPlanner, HttpAccess } from "../../libs/foundation/core/src/service-topology.ts";
import { AccessRetryReportSchema } from "../../libs/foundation/core/src/access-retry-runtime.ts";
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
import { PolicyViolation } from "../../libs/foundation/core/src/tagged-errors.ts";
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

  it.effect("keeps browser and managed policies on browser-backed capture", () =>
    Effect.gen(function* () {
      const cases = [
        {
          mode: "browser",
          render: "always",
          evidence: "Browser mode requires browser-backed capture.",
        },
        {
          mode: "managed",
          render: "onDemand",
          evidence: "Managed mode delegates capture to a browser-capable provider.",
        },
      ] as const;

      for (const testCase of cases) {
        const decision = yield* planAccessExecution({
          target,
          pack,
          accessPolicy: Schema.decodeUnknownSync(AccessPolicySchema)({
            ...Schema.encodeSync(AccessPolicySchema)(httpPolicy),
            mode: testCase.mode,
            render: testCase.render,
          }),
          createdAt: FIXED_DATE,
        });

        expect(decision.plan.steps[0]?.requiresBrowser).toBe(true);
        expect(decision.plan.steps[0]?.artifactKind).toBe("renderedDom");
        expect(decision.rationale.find(({ key }) => key === "capture-path")?.message).toContain(
          testCase.evidence,
        );
      }
    }),
  );

  it.effect("escalates all high-friction hybrid targets to the browser provider", () =>
    Effect.gen(function* () {
      const highFrictionKinds = ["productListing", "searchResult", "socialPost"] as const;

      for (const kind of highFrictionKinds) {
        const hybridDecision = yield* planAccessExecution({
          target: Schema.decodeUnknownSync(TargetProfileSchema)({
            ...Schema.encodeSync(TargetProfileSchema)(target),
            kind,
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
        expect(
          hybridDecision.rationale.find(({ key }) => key === "capture-path")?.message,
        ).toContain("selected browser provider");
        expect(
          hybridDecision.rationale.find(({ key }) => key === "capture-path")?.message,
        ).toContain(`high-friction ${kind} targets`);
      }
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

  it.effect("escalates hybrid targets for every browser-worthy failure code", () =>
    Effect.gen(function* () {
      const escalationCodes = ["timeout", "provider_unavailable", "render_crash"] as const;

      for (const lastFailureCode of escalationCodes) {
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
          failureContext: {
            recentFailureCount: 1,
            lastFailureCode,
          },
        });

        expect(hybridDecision.plan.steps[0]?.requiresBrowser).toBe(true);
        expect(
          hybridDecision.rationale.find(({ key }) => key === "capture-path")?.message,
        ).toContain(lastFailureCode);
      }
    }),
  );

  it.effect("ignores lastFailureCode when there are no recent failures to escalate", () =>
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
        failureContext: {
          recentFailureCount: 0,
          lastFailureCode: "render_crash",
        },
      });

      expect(hybridDecision.plan.steps[0]?.requiresBrowser).toBe(false);
      expect(hybridDecision.plan.steps[0]?.artifactKind).toBe("html");
      expect(hybridDecision.rationale.find(({ key }) => key === "capture-path")?.message).toContain(
        "selected http provider",
      );
      expect(
        hybridDecision.rationale.find(({ key }) => key === "capture-path")?.message,
      ).not.toContain("render_crash");
    }),
  );

  it.effect(
    "falls back to unspecified-access-failure when repeated failures omit a lastFailureCode",
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
          failureContext: {
            recentFailureCount: 2,
          },
        });

        expect(hybridDecision.plan.steps[0]?.requiresBrowser).toBe(true);
        expect(
          hybridDecision.rationale.find(({ key }) => key === "capture-path")?.message,
        ).toContain("unspecified-access-failure");
      }),
  );

  it.effect("combines high-friction and failure escalation evidence in a single rationale", () =>
    Effect.gen(function* () {
      const hybridDecision = yield* planAccessExecution({
        target: Schema.decodeUnknownSync(TargetProfileSchema)({
          ...Schema.encodeSync(TargetProfileSchema)(target),
          kind: "socialPost",
        }),
        pack,
        accessPolicy: Schema.decodeUnknownSync(AccessPolicySchema)({
          ...Schema.encodeSync(AccessPolicySchema)(httpPolicy),
          mode: "hybrid",
          render: "onDemand",
        }),
        createdAt: FIXED_DATE,
        failureContext: {
          recentFailureCount: 1,
          lastFailureCode: "timeout",
        },
      });

      expect(hybridDecision.plan.steps[0]?.requiresBrowser).toBe(true);
      expect(hybridDecision.rationale.find(({ key }) => key === "capture-path")?.message).toContain(
        "high-friction socialPost targets after 1 recent access failure(s), latest timeout",
      );
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

  it.effect(
    "sanitizes secret-bearing request and response headers before persisting metadata",
    () =>
      Effect.gen(function* () {
        const decision = yield* planAccessExecution({
          target,
          pack,
          accessPolicy: httpPolicy,
          createdAt: FIXED_DATE,
        });
        const requestHeaders = {
          accept: "text/html,application/xhtml+xml",
          authorization: "Bearer request-secret",
          cookie: "session=request-cookie-secret",
          "x-api-key": "request-api-key-secret",
          "x-request-id": "req-outbound-001",
        } as const;
        let outboundHeaders: HeadersInit | undefined;
        const bundle = yield* captureHttpArtifacts(
          decision.plan,
          async (_input, init) => {
            outboundHeaders = init?.headers;

            return new Response("<html><body>sanitized</body></html>", {
              status: 200,
              headers: {
                authorization: "Bearer response-secret",
                "content-type": "text/html; charset=utf-8",
                "set-cookie": "session=response-cookie-secret; HttpOnly",
                "x-auth-token": "response-auth-token-secret",
                "x-request-id": "req-keep-me",
              },
            });
          },
          () => new Date(FIXED_DATE),
          () => 50,
          undefined,
          requestHeaders,
        );

        expect(outboundHeaders).toEqual(requestHeaders);

        const requestMetadata = JSON.parse(
          bundle.payloads.find(({ locator }) => locator.key.endsWith("request-metadata.json"))
            ?.body ?? "{}",
        );
        const responseMetadata = JSON.parse(
          bundle.payloads.find(({ locator }) => locator.key.endsWith("response-metadata.json"))
            ?.body ?? "{}",
        );
        const redactedBodies = bundle.payloads
          .filter(({ locator }) => !locator.key.endsWith("body.html"))
          .map(({ body }) => body)
          .join("\n");

        expect(requestMetadata.headers).toEqual([
          { name: "accept", value: "text/html,application/xhtml+xml" },
          { name: "authorization", value: "[REDACTED]" },
          { name: "cookie", value: "[REDACTED]" },
          { name: "x-api-key", value: "[REDACTED]" },
          { name: "x-request-id", value: "req-outbound-001" },
        ]);
        expect(responseMetadata.headers).toEqual([
          { name: "authorization", value: "[REDACTED]" },
          { name: "content-type", value: "text/html; charset=utf-8" },
          { name: "set-cookie", value: "[REDACTED]" },
          { name: "x-auth-token", value: "[REDACTED]" },
          { name: "x-request-id", value: "req-keep-me" },
        ]);
        expect(redactedBodies).toContain("[REDACTED]");
        expect(redactedBodies).not.toContain("request-secret");
        expect(redactedBodies).not.toContain("request-cookie-secret");
        expect(redactedBodies).not.toContain("request-api-key-secret");
        expect(redactedBodies).not.toContain("response-secret");
        expect(redactedBodies).not.toContain("response-cookie-secret");
        expect(redactedBodies).not.toContain("response-auth-token-secret");
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

  it.effect("retries transient body-read failures through a fresh HTTP capture attempt", () =>
    Effect.gen(function* () {
      const decision = yield* planAccessExecution({
        target,
        pack,
        accessPolicy: httpPolicy,
        createdAt: FIXED_DATE,
      });
      const decisions: string[] = [];
      let attempts = 0;

      const bundle = yield* captureHttpArtifacts(
        decision.plan,
        async () => {
          attempts += 1;

          if (attempts === 1) {
            return Object.assign(new Response("<html></html>", { status: 200 }), {
              text: async () => Promise.reject(new Error("body read failed")),
            });
          }

          return new Response("<html><body>recovered body</body></html>", {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          });
        },
        () => new Date(FIXED_DATE),
        undefined,
        (decision) =>
          Effect.sync(() => {
            decisions.push(decision.reason);
          }),
      );

      expect(attempts).toBe(2);
      expect(decisions).toEqual(["body read failed"]);
      expect(bundle.artifacts).toHaveLength(4);
      expect(
        bundle.payloads.find(({ locator }) => locator.key === `${decision.plan.id}/body.html`)
          ?.body,
      ).toContain("recovered body");
    }),
  );

  it.effect("does not retry non-retryable body-read failures", () =>
    Effect.gen(function* () {
      const decision = yield* planAccessExecution({
        target,
        pack,
        accessPolicy: httpPolicy,
        createdAt: FIXED_DATE,
      });
      const decisions: string[] = [];
      const exhaustedEvents: unknown[] = [];
      let attempts = 0;

      const failureMessage = yield* captureHttpArtifacts(
        decision.plan,
        async () => {
          attempts += 1;

          return Object.assign(new Response("<html></html>", { status: 200 }), {
            text: async () =>
              Promise.reject(
                new PolicyViolation({
                  message: "body policy violation",
                }),
              ),
          });
        },
        () => new Date(FIXED_DATE),
        undefined,
        (decision) =>
          Effect.sync(() => {
            decisions.push(decision.reason);
          }),
        undefined,
        (input) =>
          Effect.sync(() => {
            exhaustedEvents.push({
              error: {
                name: input.error.name,
                message: input.error.message,
              },
              report: Schema.encodeSync(AccessRetryReportSchema)(input.report),
            });
          }),
      ).pipe(
        Effect.match({
          onFailure: ({ message }) => message,
          onSuccess: () => "unexpected-success",
        }),
      );

      expect(failureMessage).not.toBe("unexpected-success");
      expect(failureMessage).toContain("body policy violation");
      expect(attempts).toBe(1);
      expect(decisions).toEqual([]);
      expect(exhaustedEvents).toEqual([]);
    }),
  );

  it.effect("surfaces retry exhaustion evidence separately from the terminal failure", () =>
    Effect.gen(function* () {
      const decision = yield* planAccessExecution({
        target,
        pack,
        accessPolicy: Schema.decodeUnknownSync(AccessPolicySchema)({
          ...Schema.encodeSync(AccessPolicySchema)(httpPolicy),
          maxRetries: 1,
        }),
        createdAt: FIXED_DATE,
      });
      const exhaustedEvents: unknown[] = [];
      const failureMessage = yield* captureHttpArtifacts(
        decision.plan,
        async () => Promise.reject(new Error("persistent upstream")),
        () => new Date(FIXED_DATE),
        undefined,
        () => Effect.void,
        undefined,
        (input) =>
          Effect.sync(() => {
            exhaustedEvents.push({
              error: {
                name: input.error.name,
                message: input.error.message,
              },
              report: Schema.encodeSync(AccessRetryReportSchema)(input.report),
            });
          }),
      ).pipe(
        Effect.match({
          onFailure: ({ message }) => message,
          onSuccess: () => "unexpected-success",
        }),
      );

      expect(failureMessage).toBe("persistent upstream");
      expect(exhaustedEvents).toEqual([
        {
          error: {
            name: "ProviderUnavailable",
            message: "persistent upstream",
          },
          report: {
            attempts: 2,
            exhaustedBudget: true,
            decisions: [
              {
                attempt: 1,
                nextAttempt: 2,
                delayMs: 250,
                reason: "persistent upstream",
              },
            ],
          },
        },
      ]);
    }),
  );
});
