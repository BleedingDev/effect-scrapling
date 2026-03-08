import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Match, Option, Schema } from "effect";
import { AccessPolicySchema } from "../../libs/foundation/core/src/access-policy.ts";
import { planAccessExecution } from "../../libs/foundation/core/src/access-planner-runtime.ts";
import {
  buildRedactedBrowserArtifactExports,
  BrowserCaptureBundleSchema,
} from "../../libs/foundation/core/src/browser-access-runtime.ts";
import { makeInMemoryCaptureBundleStore } from "../../libs/foundation/core/src/capture-store-runtime.ts";
import {
  buildRedactedHttpArtifactExports,
  captureHttpArtifacts,
} from "../../libs/foundation/core/src/http-access-runtime.ts";
import { SitePackSchema } from "../../libs/foundation/core/src/site-pack.ts";
import { REDACTED_SECRET_VALUE } from "../../libs/foundation/core/src/secret-sanitization.ts";
import { TargetProfileSchema } from "../../libs/foundation/core/src/target-profile.ts";

const CREATED_AT = "2026-03-09T05:00:00.000Z";

const target = Schema.decodeUnknownSync(TargetProfileSchema)({
  id: "target-e9-security-001",
  tenantId: "tenant-main",
  domain: "example.com",
  kind: "productPage",
  canonicalKey: "catalog/e9-security-001",
  seedUrls: ["https://example.com/products/security-001"],
  accessPolicyId: "policy-e9-http",
  packId: "pack-example-com",
  priority: 10,
});

const pack = Schema.decodeUnknownSync(SitePackSchema)({
  id: "pack-example-com",
  domainPattern: "*.example.com",
  state: "shadow",
  accessPolicyId: "policy-e9-http",
  version: "2026.03.09",
});

const accessPolicy = Schema.decodeUnknownSync(AccessPolicySchema)({
  id: "policy-e9-http",
  mode: "http",
  perDomainConcurrency: 4,
  globalConcurrency: 16,
  timeoutMs: 30_000,
  maxRetries: 1,
  render: "never",
});

describe("E9 security review verification", () => {
  it.effect(
    "sanitizes secret-bearing HTTP metadata and defaults exports to redacted payloads",
    () =>
      Effect.gen(function* () {
        const planned = yield* planAccessExecution({
          target,
          pack,
          accessPolicy,
          createdAt: CREATED_AT,
        });

        const bundle = yield* captureHttpArtifacts(
          planned.plan,
          async (input: string | URL | Request) => {
            const response = new Response(
              `
                <html>
                  <head>
                    <title>E9 token=title-secret Bearer title-bearer</title>
                    <meta content="csrf=meta-secret" />
                  </head>
                  <body>
                    <main>token=body-secret password=body-password</main>
                    <input type="hidden" value="hidden-secret" />
                    <a href="https://user:secret@example.com/checkout?session=checkout-secret#frag">Checkout</a>
                    <form action="/confirm?csrf=form-secret#frag"></form>
                  </body>
                </html>
              `,
              {
                status: 200,
                headers: {
                  "content-type": "text/html; charset=utf-8",
                  "set-cookie": "session=server-secret",
                },
              },
            );
            Object.defineProperty(response, "url", {
              value: "https://user:secret@example.com/private?token=response-secret#frag",
              configurable: true,
            });
            void input;
            return response;
          },
          () => new Date("2026-03-09T05:01:00.000Z"),
          () => 42,
          undefined,
          {
            accept: "text/html",
            authorization: "Bearer request-secret",
            cookie: "session=request-cookie",
            "x-api-key": "request-api-key",
          },
        );

        const exports = buildRedactedHttpArtifactExports(bundle).exports;
        const requestExport = exports.find(({ kind }) => kind === "requestMetadata");
        const responseExport = exports.find(({ kind }) => kind === "responseMetadata");
        const htmlExport = exports.find(({ kind }) => kind === "html");

        expect(requestExport?.sourceVisibility).toBe("redacted");
        expect(responseExport?.sourceVisibility).toBe("redacted");
        expect(htmlExport?.sourceVisibility).toBe("raw");

        const requestBody = requestExport?.body ?? "";
        const responseBody = responseExport?.body ?? "";
        const htmlBody = htmlExport?.body ?? "";

        expect(requestBody).toContain(`"value": "${REDACTED_SECRET_VALUE}"`);
        expect(requestBody).toContain(`"url": "https://example.com/products/security-001"`);
        expect(responseBody).toContain(
          `"url": "https://example.com/private?token=${encodeURIComponent(REDACTED_SECRET_VALUE)}"`,
        );
        expect(responseBody).toContain(`"value": "${REDACTED_SECRET_VALUE}"`);

        expect(htmlBody).toContain(`token=${REDACTED_SECRET_VALUE}`);
        expect(htmlBody).toContain(`password=${REDACTED_SECRET_VALUE}`);
        expect(htmlBody).toContain(
          `https://example.com/checkout?session=${encodeURIComponent(REDACTED_SECRET_VALUE)}`,
        );
        expect(htmlBody).toContain(`/confirm?csrf=${encodeURIComponent(REDACTED_SECRET_VALUE)}`);
        expect(htmlBody).toContain(`"hiddenFieldCount": 2`);

        for (const leakedSecret of [
          "request-secret",
          "request-cookie",
          "request-api-key",
          "server-secret",
          "response-secret",
          "title-secret",
          "title-bearer",
          "body-secret",
          "body-password",
          "hidden-secret",
          "meta-secret",
          "checkout-secret",
          "form-secret",
        ]) {
          expect(`${requestBody}${responseBody}${htmlBody}`).not.toContain(leakedSecret);
        }
      }),
  );

  it("re-sanitizes browser exports and strips raw screenshot payloads from redacted output", () => {
    const bundle = Schema.decodeUnknownSync(BrowserCaptureBundleSchema)({
      capturedAt: "2026-03-09T05:02:00.000Z",
      artifacts: [
        {
          id: "artifact-rendered-dom-001",
          runId: "plan-e9-security-001",
          artifactId: "artifact-rendered-dom-001",
          kind: "renderedDom",
          visibility: "raw",
          locator: {
            namespace: "captures/raw/target-e9-security-001",
            key: "plan-e9-security-001/rendered-dom.html",
          },
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          sizeBytes: 300,
          mediaType: "text/html",
          storedAt: "2026-03-09T05:02:00.000Z",
        },
        {
          id: "artifact-screenshot-001",
          runId: "plan-e9-security-001",
          artifactId: "artifact-screenshot-001",
          kind: "screenshot",
          visibility: "raw",
          locator: {
            namespace: "captures/raw/target-e9-security-001",
            key: "plan-e9-security-001/screenshot.png",
          },
          sha256: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          sizeBytes: 128,
          mediaType: "image/png",
          storedAt: "2026-03-09T05:02:00.000Z",
        },
        {
          id: "artifact-network-summary-001",
          runId: "plan-e9-security-001",
          artifactId: "artifact-network-summary-001",
          kind: "networkSummary",
          visibility: "redacted",
          locator: {
            namespace: "captures/redacted/target-e9-security-001",
            key: "plan-e9-security-001/network-summary.json",
          },
          sha256: "bcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcde",
          sizeBytes: 256,
          mediaType: "application/json",
          storedAt: "2026-03-09T05:02:00.000Z",
        },
      ],
      payloads: [
        {
          locator: {
            namespace: "captures/raw/target-e9-security-001",
            key: "plan-e9-security-001/rendered-dom.html",
          },
          mediaType: "text/html",
          encoding: "utf8",
          body: `<html><head><title>Browser token=dom-secret</title></head><body><main>password=dom-password</main><a href="https://user:secret@example.com/report?api_key=net-secret#frag">Report</a></body></html>`,
        },
        {
          locator: {
            namespace: "captures/raw/target-e9-security-001",
            key: "plan-e9-security-001/screenshot.png",
          },
          mediaType: "image/png",
          encoding: "base64",
          body: "cmF3LXNjcmVlbnNob3Qtc2VjcmV0",
        },
        {
          locator: {
            namespace: "captures/redacted/target-e9-security-001",
            key: "plan-e9-security-001/network-summary.json",
          },
          mediaType: "application/json",
          encoding: "utf8",
          body: JSON.stringify({
            navigation: [
              {
                url: "https://user:secret@example.com/report?token=network-secret#frag",
                type: "navigation",
                startTimeMs: 0,
                durationMs: 10,
                transferSize: 100,
                encodedBodySize: 80,
                decodedBodySize: 120,
                responseStatus: 200,
              },
            ],
            resources: [],
          }),
        },
      ],
    });

    const exportBundle = buildRedactedBrowserArtifactExports(bundle);
    const renderedDom = exportBundle.exports.find(({ kind }) => kind === "renderedDom")?.body ?? "";
    const screenshot = exportBundle.exports.find(({ kind }) => kind === "screenshot")?.body ?? "";
    const networkSummary =
      exportBundle.exports.find(({ kind }) => kind === "networkSummary")?.body ?? "";

    expect(renderedDom).toContain(`token=${REDACTED_SECRET_VALUE}`);
    expect(renderedDom).toContain(`password=${REDACTED_SECRET_VALUE}`);
    expect(renderedDom).toContain(
      `https://example.com/report?api_key=${encodeURIComponent(REDACTED_SECRET_VALUE)}`,
    );
    expect(screenshot).toContain("Binary screenshot payload omitted from redacted export.");
    expect(screenshot).not.toContain("cmF3LXNjcmVlbnNob3Qtc2VjcmV0");
    expect(networkSummary).toContain(
      `https://example.com/report?token=${encodeURIComponent(REDACTED_SECRET_VALUE)}`,
    );

    for (const leakedSecret of [
      "dom-secret",
      "dom-password",
      "net-secret",
      "network-secret",
      "cmF3LXNjcmVlbnNob3Qtc2VjcmV0",
    ]) {
      expect(`${renderedDom}${screenshot}${networkSummary}`).not.toContain(leakedSecret);
    }
  });

  it.effect("rejects raw and redacted namespace drift at the capture-store boundary", () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryCaptureBundleStore();
      const failure = yield* store
        .persistBundle("run-e9-security-001", {
          capturedAt: "2026-03-09T05:03:00.000Z",
          artifacts: [
            {
              id: "artifact-html-001",
              runId: "run-e9-security-001",
              artifactId: "artifact-html-001",
              kind: "html",
              visibility: "raw",
              locator: {
                namespace: "captures/redacted/target-e9-security-001",
                key: "run-e9-security-001/body.html",
              },
              sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              sizeBytes: 16,
              mediaType: "text/html",
              storedAt: "2026-03-09T05:03:00.000Z",
            },
          ],
          payloads: [
            {
              locator: {
                namespace: "captures/redacted/target-e9-security-001",
                key: "run-e9-security-001/body.html",
              },
              mediaType: "text/html",
              body: "<html>bad</html>",
            },
          ],
        })
        .pipe(Effect.flip);

      yield* Match.value(failure).pipe(
        Match.tag("PolicyViolation", ({ message }) =>
          Effect.sync(() => {
            expect(message).toContain("separate storage namespaces");
          }),
        ),
        Match.exhaustive,
      );

      const missing = yield* store.readBundle("run-e9-security-missing");
      expect(Option.isNone(missing)).toBe(true);
    }),
  );
});
