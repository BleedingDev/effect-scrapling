import { mock } from "bun:test";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  E8ArtifactExportEnvelopeSchema,
  runAccessPreviewOperation,
  runArtifactExportOperation,
  runCrawlCompileOperation,
  runRenderPreviewOperation,
  runWorkflowResumeOperation,
  runWorkflowRunOperation,
} from "effect-scrapling/e8";
import { resetAccessHealthGatewayForTests } from "../../src/sdk/access-health-gateway.ts";
import { resetBrowserPoolForTests } from "../../src/sdk/browser-pool.ts";

const E8ControlPlaneFailureSchema = Schema.Struct({
  message: Schema.String,
  details: Schema.optional(Schema.String),
});

function decodeFailure(error: unknown) {
  return Schema.decodeUnknownSync(E8ControlPlaneFailureSchema)(error);
}

function captureFailure<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.match({
      onSuccess: () => null,
      onFailure: decodeFailure,
    }),
  );
}

function makeTarget() {
  return {
    id: "target-e8-security-001",
    tenantId: "tenant-main",
    domain: "shop.example.com",
    kind: "productPage" as const,
    canonicalKey: "productPage/target-e8-security-001",
    seedUrls: ["https://shop.example.com/target-e8-security-001"],
    accessPolicyId: "policy-default",
    packId: "pack-shop-example-com",
    priority: 50,
  };
}

function makePack() {
  return {
    id: "pack-shop-example-com",
    tenantId: "tenant-main",
    domainPattern: "*.example.com",
    state: "shadow" as const,
    accessPolicyId: "policy-default",
    version: "2026.03.08",
  };
}

function makeAccessPolicy() {
  return {
    id: "policy-default",
    mode: "http" as const,
    render: "never" as const,
    perDomainConcurrency: 2,
    globalConcurrency: 8,
    timeoutMs: 30_000,
    maxRetries: 1,
  };
}

describe("E8 security review verification", () => {
  it.effect(
    "rejects unsafe preview URLs before the public E8 control plane performs network I/O",
    () =>
      Effect.gen(function* () {
        yield* resetAccessHealthGatewayForTests();
        let fetchCallCount = 0;
        const fetchClient = async (input: string | URL | Request) => {
          fetchCallCount += 1;
          const response = new Response("<html><body>unexpected</body></html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
          Object.defineProperty(response, "url", {
            value: new Request(input).url,
            configurable: true,
          });
          return response;
        };

        const credentialedFailure = yield* captureFailure(
          runAccessPreviewOperation(
            { url: "https://user:secret@example.com/private" },
            fetchClient,
          ),
        );
        const loopbackFailure = yield* captureFailure(
          runAccessPreviewOperation({ url: "https://127.0.0.1/private" }, fetchClient),
        );

        expect(fetchCallCount).toBe(0);
        expect(credentialedFailure).toEqual({
          message: "URL failed security policy",
          details: "credentialed URLs are not allowed",
        });
        expect(loopbackFailure).toEqual({
          message: "URL failed security policy",
          details: 'host "127.0.0.1" resolves to a private or reserved IPv4 range',
        });
      }),
  );

  it.effect(
    "rejects forged workflow checkpoints whose lineage no longer matches the compiled plan",
    () =>
      Effect.gen(function* () {
        yield* resetAccessHealthGatewayForTests();
        const compiled = yield* runCrawlCompileOperation({
          createdAt: "2026-03-09T13:00:00.000Z",
          entries: [
            {
              target: makeTarget(),
              pack: makePack(),
              accessPolicy: makeAccessPolicy(),
            },
          ],
        });
        const workflowRun = yield* runWorkflowRunOperation({
          compiledPlan: compiled.data.compiled,
          pack: makePack(),
        });
        const forgedFailure = yield* captureFailure(
          runWorkflowResumeOperation({
            compiledPlan: compiled.data.compiled,
            checkpoint: {
              ...workflowRun.data.checkpoint,
              resumeToken: "resume-attacker-999",
            },
            pack: makePack(),
          }),
        );

        expect(forgedFailure).toEqual({
          message: "Invalid workflow resume payload.",
          details: "Checkpoint state must align with the compiled workflow plan.",
        });
      }),
  );

  it.effect("sanitizes rendered link targets before they leave the public E8 preview surface", () =>
    Effect.gen(function* () {
      yield* resetAccessHealthGatewayForTests();
      yield* resetBrowserPoolForTests();
      mock.module("patchright", () => ({
        chromium: {
          launch: async () => ({
            newContext: async () => ({
              newPage: async () => ({
                route: async () => {},
                goto: async () => ({
                  status: () => 200,
                  allHeaders: async () => ({ "content-type": "text/html; charset=utf-8" }),
                }),
                waitForLoadState: async () => {},
                content: async () => `
                  <html>
                    <head><title>E8 Security Preview</title></head>
                    <body>
                      <a href="/checkout?step=payment#frag">Checkout</a>
                      <a href="https://user:secret@example.com/admin#frag">Admin</a>
                      <a href="https://example.com/account?token=super-secret">Token</a>
                      <a href="http://127.0.0.1/internal">Loopback</a>
                      <a href="javascript:alert('x')">Ignore</a>
                      <a href="mailto:ops@example.com">Mail</a>
                      <a href="https://example.com/admin">Dedup</a>
                    </body>
                  </html>
                `,
                screenshot: async () => Buffer.from("render"),
                evaluate: async () => ({
                  requestCount: 1,
                  responseCount: 1,
                  failedRequestCount: 0,
                }),
                url: () => "https://example.com/reports/view",
                close: async () => {},
              }),
              close: async () => {},
            }),
            close: async () => {},
          }),
        },
      }));

      try {
        const result = yield* runRenderPreviewOperation({
          url: "https://example.com/reports/view",
          execution: {
            providerId: "browser-basic",
            browser: {
              waitUntil: "networkidle",
              timeoutMs: 300,
            },
          },
        });
        const renderedDom = result.data.artifacts[1];

        expect(renderedDom.kind).toBe("renderedDom");
        expect(renderedDom.linkTargets).toEqual([
          "https://example.com/checkout?step=payment",
          "https://example.com/account?token=%5BREDACTED%5D",
          "https://example.com/admin",
        ]);
      } finally {
        yield* resetBrowserPoolForTests();
        mock.restore();
      }
    }),
  );

  it.effect(
    "sanitizes absolute benchmark export paths before they leave the public E8 artifact surface",
    () =>
      Effect.gen(function* () {
        yield* resetAccessHealthGatewayForTests();
        const baselineExport = yield* runArtifactExportOperation();
        const baselineArtifact = Schema.decodeUnknownSync(E8ArtifactExportEnvelopeSchema)(
          baselineExport,
        ).data.artifact;
        const exported = yield* runArtifactExportOperation({
          exportId: "export-e8-security-review",
          generatedAt: "2026-03-09T12:30:00.000Z",
          bundle: {
            ...baselineArtifact.bundle,
            performanceBudget: {
              ...baselineArtifact.bundle.performanceBudget,
              comparison: {
                ...baselineArtifact.bundle.performanceBudget.comparison,
                baselinePath: "/private/tmp/e8-secret-baseline.json",
              },
            },
          },
        });
        const artifact = Schema.decodeUnknownSync(E8ArtifactExportEnvelopeSchema)(exported).data
          .artifact;

        expect(artifact.metadata.sanitizedPathCount).toBe(1);
        expect(artifact.metadata.sanitizedPaths).toEqual(["e8-secret-baseline.json"]);
        expect(artifact.bundle.performanceBudget.comparison.baselinePath).toBe(
          "e8-secret-baseline.json",
        );
        expect(
          artifact.metadata.manifest.every(
            ({ artifactPath }) => !artifactPath.startsWith("/") && !artifactPath.includes("\\"),
          ),
        ).toBe(true);
      }),
  );
});
