import { describe, expect, it } from "@effect-native/bun-test";
import { mock } from "bun:test";
import { Effect, Schema } from "effect";
import { runIncumbentComparison } from "@effect-scrapling/foundation-core/incumbent-comparison-runtime";
import {
  PackCreateEnvelopeSchema,
  PackInspectEnvelopeSchema,
  PackPromoteEnvelopeSchema,
  PackValidateEnvelopeSchema,
  QualityCompareEnvelopeSchema,
  QualityVerifyEnvelopeSchema,
  SnapshotDiffEnvelopeSchema,
  TargetImportEnvelopeSchema,
  TargetListEnvelopeSchema,
  WorkflowInspectEnvelopeSchema,
  WorkflowResumeEnvelopeSchema,
  WorkflowRunEnvelopeSchema,
  runAccessPreviewOperation,
  runCrawlCompileOperation,
  runExtractRunOperation,
  runPackCreateOperation,
  runPackInspectOperation,
  runPackPromoteOperation,
  runPackValidateOperation,
  runQualityCompareOperation,
  runQualityVerifyOperation,
  runRenderPreviewOperation,
  runSnapshotDiffOperation,
  runTargetImportOperation,
  runTargetListOperation,
  runWorkflowInspectOperation,
  runWorkflowResumeOperation,
  runWorkflowRunOperation,
} from "effect-scrapling/e8";
import { resetAccessHealthGatewayForTests } from "../../src/sdk/access-health-gateway.ts";
import { executeCli } from "../../src/standalone.ts";
import { resetBrowserPoolForTests } from "../../src/sdk/browser-pool.ts";
import { InvalidInputError } from "../../src/sdk/errors.ts";
import { type ExtractRunResponse } from "../../src/sdk/schemas.ts";
import { runDefaultBaselineCorpus } from "../../scripts/benchmarks/e7-baseline-corpus.ts";
import { stripVolatileAccessTelemetry } from "./test-envelope-normalizers.ts";

function makeTarget(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly domain: string;
  readonly kind: "productPage" | "productListing";
  readonly priority: number;
}) {
  return {
    id: input.id,
    tenantId: input.tenantId,
    domain: input.domain,
    kind: input.kind,
    canonicalKey: `${input.kind}/${input.id}`,
    seedUrls: [`https://${input.domain}/${input.id}`],
    accessPolicyId: "policy-default",
    packId: "pack-shop-example-com",
    priority: input.priority,
  };
}

function makePackDefinition(state: "draft" | "shadow" | "active") {
  return {
    pack: {
      id: "pack-shop-example-com",
      tenantId: "tenant-main",
      domainPattern: "*.example.com",
      state,
      accessPolicyId: "policy-default",
      version: state === "active" ? "2026.03.09" : "2026.03.08",
    },
    selectors: [
      {
        field: "title",
        candidates: [
          {
            path: `title/${state}`,
            selector: state === "active" ? "h1.active" : "h1.shadow",
          },
        ],
        fallbackPolicy: {
          maxFallbackCount: 0,
          fallbackConfidenceImpact: 0,
          maxConfidenceImpact: 0,
        },
      },
    ],
    assertions: {
      requiredFields: [{ field: "title" }],
      businessInvariants: [],
    },
    policy: {
      targetKinds: ["productPage"],
      mode: "http",
      render: "never",
    },
    metadata: {
      tenantId: "tenant-main",
      owners: ["team-catalog"],
      labels: [],
    },
  };
}

function normalizeExtractRunResponse(response: ExtractRunResponse): ExtractRunResponse {
  return stripVolatileAccessTelemetry(response);
}

function makeAccessPolicy() {
  return {
    id: "policy-default",
    mode: "http",
    render: "never",
    perDomainConcurrency: 2,
    globalConcurrency: 8,
    timeoutMs: 30_000,
    maxRetries: 1,
  };
}

function makeSnapshot(input: {
  readonly id: string;
  readonly targetId: string;
  readonly title: string;
  readonly price: number;
}) {
  return {
    id: input.id,
    targetId: input.targetId,
    observations: [
      {
        field: "title",
        normalizedValue: input.title,
        confidence: 0.98,
        evidenceRefs: [`artifact-${input.id}`],
      },
      {
        field: "price",
        normalizedValue: {
          amount: input.price,
          currency: "CZK",
        },
        confidence: 0.95,
        evidenceRefs: [`artifact-${input.id}`],
      },
    ],
    qualityScore: 0.96,
    createdAt: "2026-03-09T10:00:00.000Z",
  };
}

function mockHtmlFetch(body: string) {
  return async (input: string | URL | Request) => {
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    Object.defineProperty(response, "url", {
      value: new Request(input).url,
      configurable: true,
    });
    return response;
  };
}

describe("E8 control plane", () => {
  it.effect("keeps target import and list deterministic across SDK and CLI", () =>
    Effect.gen(function* () {
      yield* resetAccessHealthGatewayForTests();
      const targets = [
        makeTarget({
          id: "target-shop-002",
          tenantId: "tenant-main",
          domain: "shop.example.com",
          kind: "productPage",
          priority: 20,
        }),
        makeTarget({
          id: "target-blog-001",
          tenantId: "tenant-alt",
          domain: "blog.example.com",
          kind: "productListing",
          priority: 10,
        }),
      ];

      const sdkImport = yield* runTargetImportOperation({ targets });
      const cliImport = yield* Effect.promise(() =>
        executeCli(["target", "import", "--input", JSON.stringify({ targets })]),
      );
      const sdkList = yield* runTargetListOperation({
        targets,
        filters: { tenantId: "tenant-main" },
      });
      const cliList = yield* Effect.promise(() =>
        executeCli([
          "target",
          "list",
          "--input",
          JSON.stringify({
            targets,
            filters: { tenantId: "tenant-main" },
          }),
        ]),
      );

      expect(Schema.decodeUnknownSync(TargetImportEnvelopeSchema)(sdkImport)).toEqual(
        Schema.decodeUnknownSync(TargetImportEnvelopeSchema)(JSON.parse(cliImport.output)),
      );
      expect(Schema.decodeUnknownSync(TargetListEnvelopeSchema)(sdkList)).toEqual(
        Schema.decodeUnknownSync(TargetListEnvelopeSchema)(JSON.parse(cliList.output)),
      );
      expect(sdkImport.data.targets.map(({ id }) => id)).toEqual([
        "target-blog-001",
        "target-shop-002",
      ]);
      expect(sdkList.data.targets.map(({ id }) => id)).toEqual(["target-shop-002"]);

      const invalidDomainExit = yield* Effect.flip(
        runTargetListOperation({
          targets,
          filters: { domain: "https://shop.example.com" },
        }),
      );
      const invalidTenantCli = yield* Effect.promise(() =>
        executeCli([
          "target",
          "list",
          "--input",
          JSON.stringify({
            targets,
            filters: { tenantId: "tenant main" },
          }),
        ]),
      );

      expect(invalidDomainExit).toBeInstanceOf(InvalidInputError);
      expect(invalidTenantCli.exitCode).toBe(2);
      expect(JSON.parse(invalidTenantCli.output)).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });
    }),
  );

  it.effect("rejects empty target imports across SDK and CLI", () =>
    Effect.gen(function* () {
      yield* resetAccessHealthGatewayForTests();
      const sdkExit = yield* Effect.flip(runTargetImportOperation({ targets: [] }));
      const cliResult = yield* Effect.promise(() =>
        executeCli(["target", "import", "--input", JSON.stringify({ targets: [] })]),
      );
      const cliError = JSON.parse(cliResult.output);

      expect(sdkExit).toBeInstanceOf(InvalidInputError);
      expect(sdkExit.message).toContain("Invalid target import payload.");
      expect(cliResult.exitCode).toBe(2);
      expect(cliError).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });
      expect(String(cliError.message)).toContain("Invalid target import payload.");
    }),
  );

  it.effect("keeps target ordering deterministic for mixed-case identifiers", () =>
    Effect.gen(function* () {
      yield* resetAccessHealthGatewayForTests();
      const targets = [
        makeTarget({
          id: "target-zed",
          tenantId: "tenant-main",
          domain: "shop.example.com",
          kind: "productPage",
          priority: 20,
        }),
        makeTarget({
          id: "Target-alpha",
          tenantId: "tenant-main",
          domain: "shop.example.com",
          kind: "productPage",
          priority: 10,
        }),
      ];

      const imported = yield* runTargetImportOperation({ targets });

      expect(imported.data.targets.map(({ id }) => id)).toEqual(["Target-alpha", "target-zed"]);
    }),
  );

  it.effect("exposes pack create inspect validate and promote through the shared E8 surface", () =>
    Effect.gen(function* () {
      yield* resetAccessHealthGatewayForTests();
      const shadowDefinition = makePackDefinition("shadow");
      const activeDefinition = makePackDefinition("active");
      const packValidateInput = {
        pack: shadowDefinition.pack,
        snapshotDiff: {
          id: "diff-pack-shadow",
          baselineSnapshotId: "snapshot-baseline-pack",
          candidateSnapshotId: "snapshot-candidate-pack",
          metrics: {
            fieldRecallDelta: 0.02,
            falsePositiveDelta: 0.01,
            driftDelta: 0.03,
            latencyDeltaMs: 30,
            memoryDelta: 4,
          },
          createdAt: "2026-03-09T11:00:00.000Z",
        },
        checks: {
          replayDeterminism: true,
          workflowResume: true,
          canary: true,
          chaos: true,
          securityRedaction: true,
          soakStability: true,
        },
        createdAt: "2026-03-09T11:30:00.000Z",
      };
      const packPromoteInput = {
        catalog: [
          {
            definition: activeDefinition,
            recordedAt: "2026-03-08T08:00:00.000Z",
            recordedBy: "curator-main",
          },
          {
            definition: shadowDefinition,
            recordedAt: "2026-03-09T08:00:00.000Z",
            recordedBy: "curator-main",
          },
        ],
        subjectPackId: shadowDefinition.pack.id,
        subjectPackVersion: shadowDefinition.pack.version,
        decision: {
          id: "decision-pack-activate",
          packId: shadowDefinition.pack.id,
          sourceVersion: shadowDefinition.pack.version,
          triggerVerdictId: "verdict-pack-shadow",
          createdAt: "2026-03-09T12:00:00.000Z",
          fromState: "shadow",
          toState: "active",
          action: "active",
        },
        changedBy: "curator-main",
        rationale: "shadow pack passed the validation ladder",
        occurredAt: "2026-03-09T12:30:00.000Z",
        nextVersion: "2026.03.10",
      };

      const created = yield* runPackCreateOperation({ definition: shadowDefinition });
      const inspected = yield* runPackInspectOperation({ definition: shadowDefinition });
      const validated = yield* runPackValidateOperation(packValidateInput);
      const promoted = yield* runPackPromoteOperation(packPromoteInput);
      const cliCreated = yield* Effect.promise(() =>
        executeCli(["pack", "create", "--input", JSON.stringify({ definition: shadowDefinition })]),
      );
      const cliInspected = yield* Effect.promise(() =>
        executeCli([
          "pack",
          "inspect",
          "--input",
          JSON.stringify({ definition: shadowDefinition }),
        ]),
      );
      const cliValidated = yield* Effect.promise(() =>
        executeCli(["pack", "validate", "--input", JSON.stringify(packValidateInput)]),
      );
      const cliPromoted = yield* Effect.promise(() =>
        executeCli(["pack", "promote", "--input", JSON.stringify(packPromoteInput)]),
      );

      expect(
        Schema.decodeUnknownSync(PackCreateEnvelopeSchema)(created).data.definition.pack.id,
      ).toBe("pack-shop-example-com");
      expect(Schema.decodeUnknownSync(PackCreateEnvelopeSchema)(created)).toEqual(
        Schema.decodeUnknownSync(PackCreateEnvelopeSchema)(JSON.parse(cliCreated.output)),
      );
      expect(
        Schema.decodeUnknownSync(PackInspectEnvelopeSchema)(inspected).data.summary
          .selectorFieldCount,
      ).toBe(1);
      expect(Schema.decodeUnknownSync(PackInspectEnvelopeSchema)(inspected)).toEqual(
        Schema.decodeUnknownSync(PackInspectEnvelopeSchema)(JSON.parse(cliInspected.output)),
      );
      expect(
        Schema.decodeUnknownSync(PackValidateEnvelopeSchema)(validated).data.verdict.qualityVerdict
          .action,
      ).toBe("active");
      expect(Schema.decodeUnknownSync(PackValidateEnvelopeSchema)(validated)).toEqual(
        Schema.decodeUnknownSync(PackValidateEnvelopeSchema)(JSON.parse(cliValidated.output)),
      );
      expect(
        Schema.decodeUnknownSync(PackPromoteEnvelopeSchema)(promoted).data.result.activeArtifact
          ?.definition.pack.version,
      ).toBe("2026.03.10");
      expect(Schema.decodeUnknownSync(PackPromoteEnvelopeSchema)(promoted)).toEqual(
        Schema.decodeUnknownSync(PackPromoteEnvelopeSchema)(JSON.parse(cliPromoted.output)),
      );
    }),
  );

  it.effect("exports access preview and render preview through the public E8 SDK surface", () =>
    Effect.gen(function* () {
      yield* resetAccessHealthGatewayForTests();
      yield* resetBrowserPoolForTests();
      const access = yield* runAccessPreviewOperation(
        { url: "https://example.com/e8-preview" },
        mockHtmlFetch(
          "<html><head><title>Effect Scrapling</title></head><body>Preview</body></html>",
        ),
      );

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
                content: async () =>
                  "<html><body><main>Rendered browser preview</main></body></html>",
                screenshot: async () => Buffer.from("render"),
                evaluate: async () => ({
                  requestCount: 1,
                  responseCount: 1,
                  failedRequestCount: 0,
                }),
                url: () => "https://example.com/e8-preview",
                close: async () => {},
              }),
              close: async () => {},
            }),
            close: async () => {},
          }),
        },
      }));

      try {
        const render = yield* runRenderPreviewOperation({
          url: "https://example.com/e8-preview",
          execution: {
            browser: {
              waitUntil: "networkidle",
              timeoutMs: 300,
            },
          },
        });

        expect(access.command).toBe("access preview");
        expect(access.data.finalUrl).toBe("https://example.com/e8-preview");
        expect(render.command).toBe("render preview");
        expect(render.data.artifacts.some(({ kind }) => kind === "renderedDom")).toBe(true);
      } finally {
        yield* resetBrowserPoolForTests();
        mock.restore();
      }
    }),
  );

  it.effect("keeps crawl compile and workflow run resume inspect stable across SDK and CLI", () =>
    Effect.gen(function* () {
      yield* resetAccessHealthGatewayForTests();
      const compileInput = {
        createdAt: "2026-03-09T13:00:00.000Z",
        entries: [
          {
            target: makeTarget({
              id: "target-workflow-001",
              tenantId: "tenant-main",
              domain: "shop.example.com",
              kind: "productPage",
              priority: 50,
            }),
            pack: makePackDefinition("shadow").pack,
            accessPolicy: makeAccessPolicy(),
          },
        ],
      };
      const compiled = yield* runCrawlCompileOperation(compileInput);
      const workflowRun = yield* runWorkflowRunOperation({
        compiledPlan: compiled.data.compiled,
        pack: makePackDefinition("shadow").pack,
      });
      const workflowResume = yield* runWorkflowResumeOperation({
        compiledPlan: compiled.data.compiled,
        checkpoint: workflowRun.data.checkpoint,
        pack: makePackDefinition("shadow").pack,
      });
      const workflowInspect = yield* runWorkflowInspectOperation({
        compiledPlan: compiled.data.compiled,
        checkpoint: workflowRun.data.checkpoint,
        pack: makePackDefinition("shadow").pack,
      });
      const cliWorkflowRun = yield* Effect.promise(() =>
        executeCli([
          "workflow",
          "run",
          "--input",
          JSON.stringify({
            compiledPlan: compiled.data.compiled,
            pack: makePackDefinition("shadow").pack,
          }),
        ]),
      );
      const cliWorkflowResume = yield* Effect.promise(() =>
        executeCli([
          "workflow",
          "resume",
          "--input",
          JSON.stringify({
            compiledPlan: compiled.data.compiled,
            checkpoint: workflowRun.data.checkpoint,
            pack: makePackDefinition("shadow").pack,
          }),
        ]),
      );
      const cliWorkflowInspect = yield* Effect.promise(() =>
        executeCli([
          "workflow",
          "inspect",
          "--input",
          JSON.stringify({
            compiledPlan: compiled.data.compiled,
            checkpoint: workflowRun.data.checkpoint,
            pack: makePackDefinition("shadow").pack,
          }),
        ]),
      );

      expect(workflowRun.data.checkpoint.runId).toBe(compiled.data.compiled.plan.id);
      expect(workflowResume.data.checkpoint.runId).toBe(compiled.data.compiled.plan.id);
      expect(workflowInspect.data.inspection.runId).toBe(compiled.data.compiled.plan.id);
      expect(workflowResume.data.checkpoint.storedAt).not.toBe(
        workflowRun.data.checkpoint.storedAt,
      );
      expect(Schema.decodeUnknownSync(WorkflowRunEnvelopeSchema)(workflowRun)).toEqual(
        Schema.decodeUnknownSync(WorkflowRunEnvelopeSchema)(JSON.parse(cliWorkflowRun.output)),
      );
      expect(
        Schema.decodeUnknownSync(WorkflowResumeEnvelopeSchema)(workflowResume).data.inspection
          .runId,
      ).toBe(compiled.data.compiled.plan.id);
      expect(Schema.decodeUnknownSync(WorkflowResumeEnvelopeSchema)(workflowResume)).toEqual(
        Schema.decodeUnknownSync(WorkflowResumeEnvelopeSchema)(
          JSON.parse(cliWorkflowResume.output),
        ),
      );
      expect(
        Schema.decodeUnknownSync(WorkflowInspectEnvelopeSchema)(workflowInspect).data.inspection
          .runId,
      ).toBe(compiled.data.compiled.plan.id);
      expect(Schema.decodeUnknownSync(WorkflowInspectEnvelopeSchema)(workflowInspect)).toEqual(
        Schema.decodeUnknownSync(WorkflowInspectEnvelopeSchema)(
          JSON.parse(cliWorkflowInspect.output),
        ),
      );

      const workflowMismatchExit = yield* Effect.flip(
        runWorkflowResumeOperation({
          compiledPlan: compiled.data.compiled,
          checkpoint: workflowRun.data.checkpoint,
          pack: {
            ...makePackDefinition("shadow").pack,
            id: "pack-shop-other-example-com",
          },
        }),
      );
      const workflowMismatchCli = yield* Effect.promise(() =>
        executeCli([
          "workflow",
          "resume",
          "--input",
          JSON.stringify({
            compiledPlan: compiled.data.compiled,
            checkpoint: workflowRun.data.checkpoint,
            pack: {
              ...makePackDefinition("shadow").pack,
              id: "pack-shop-other-example-com",
            },
          }),
        ]),
      );

      expect(workflowMismatchExit).toBeInstanceOf(InvalidInputError);
      expect(workflowMismatchExit.message).toContain("Invalid workflow resume payload.");
      expect(workflowMismatchCli.exitCode).toBe(2);
      expect(JSON.parse(workflowMismatchCli.output)).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });

      const tamperedCheckpointCli = yield* Effect.promise(() =>
        executeCli([
          "workflow",
          "inspect",
          "--input",
          JSON.stringify({
            compiledPlan: compiled.data.compiled,
            checkpoint: {
              ...workflowRun.data.checkpoint,
              nextStepId: "step-diff",
            },
            pack: makePackDefinition("shadow").pack,
          }),
        ]),
      );

      expect(tamperedCheckpointCli.exitCode).toBe(2);
      expect(JSON.parse(tamperedCheckpointCli.output)).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });

      const invalidWorkflowStatsCli = yield* Effect.promise(() =>
        executeCli([
          "workflow",
          "inspect",
          "--input",
          JSON.stringify({
            compiledPlan: compiled.data.compiled,
            checkpoint: {
              ...workflowRun.data.checkpoint,
              stats: {
                ...workflowRun.data.checkpoint.stats,
                checkpointCount: 999,
              },
            },
            pack: makePackDefinition("shadow").pack,
          }),
        ]),
      );

      expect(invalidWorkflowStatsCli.exitCode).toBe(2);
      expect(JSON.parse(invalidWorkflowStatsCli.output)).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });
    }),
  );

  it.effect("emits consistent extraction diff verify and compare payloads across SDK and CLI", () =>
    Effect.gen(function* () {
      yield* resetAccessHealthGatewayForTests();
      const extractInput = {
        url: "https://example.com/e8-extract",
        selector: "h1",
        all: true,
        limit: 5,
      };
      const baseline = makeSnapshot({
        id: "snapshot-baseline-001",
        targetId: "target-quality-001",
        title: "Effect Scrapling",
        price: 199.9,
      });
      const candidate = makeSnapshot({
        id: "snapshot-candidate-001",
        targetId: "target-quality-001",
        title: "Effect Scrapling v2",
        price: 219.9,
      });
      const qualityVerifyInput = {
        pack: makePackDefinition("shadow").pack,
        snapshotDiff: {
          id: "diff-quality-001",
          baselineSnapshotId: baseline.id,
          candidateSnapshotId: candidate.id,
          metrics: {
            fieldRecallDelta: 0,
            falsePositiveDelta: 0,
            driftDelta: 0.05,
            latencyDeltaMs: 20,
            memoryDelta: 2,
          },
          createdAt: "2026-03-09T14:00:00.000Z",
        },
        checks: {
          replayDeterminism: true,
          workflowResume: true,
          canary: true,
          chaos: true,
          securityRedaction: true,
          soakStability: true,
        },
        createdAt: "2026-03-09T14:30:00.000Z",
      };
      const baselineCorpus = yield* Effect.promise(() => runDefaultBaselineCorpus());
      const comparison = yield* runIncumbentComparison({
        id: "comparison-e8-quality",
        createdAt: "2026-03-09T15:00:00.000Z",
        incumbent: baselineCorpus,
        candidate: baselineCorpus,
      });
      const extract = yield* runExtractRunOperation(
        extractInput,
        mockHtmlFetch("<html><body><h1>Effect</h1><h1>Scrapling</h1></body></html>"),
      );

      const diff = yield* runSnapshotDiffOperation({
        baseline,
        candidate,
        createdAt: "2026-03-09T14:00:00.000Z",
        latencyDeltaMs: 20,
        memoryDelta: 2,
      });
      const verify = yield* runQualityVerifyOperation(qualityVerifyInput);
      const compare = yield* runQualityCompareOperation({
        metricsId: "metrics-e8-quality",
        generatedAt: "2026-03-09T15:30:00.000Z",
        baseline: baselineCorpus,
        comparison,
      });
      const cliExtract = yield* Effect.promise(() =>
        executeCli(
          [
            "extract",
            "run",
            "--url",
            extractInput.url,
            "--selector",
            extractInput.selector,
            "--all",
            "--limit",
            String(extractInput.limit),
          ],
          mockHtmlFetch("<html><body><h1>Effect</h1><h1>Scrapling</h1></body></html>"),
        ),
      );
      const cliDiff = yield* Effect.promise(() =>
        executeCli([
          "quality",
          "diff",
          "--input",
          JSON.stringify({
            baseline,
            candidate,
            createdAt: "2026-03-09T14:00:00.000Z",
            latencyDeltaMs: 20,
            memoryDelta: 2,
          }),
        ]),
      );
      const cliVerify = yield* Effect.promise(() =>
        executeCli(["quality", "verify", "--input", JSON.stringify(qualityVerifyInput)]),
      );
      const cliCompare = yield* Effect.promise(() =>
        executeCli([
          "quality",
          "compare",
          "--input",
          JSON.stringify({
            metricsId: "metrics-e8-quality",
            generatedAt: "2026-03-09T15:30:00.000Z",
            baseline: baselineCorpus,
            comparison,
          }),
        ]),
      );

      expect(extract.command).toBe("extract run");
      expect(extract.data.values).toEqual(["Effect", "Scrapling"]);
      expect(normalizeExtractRunResponse(extract)).toEqual(
        normalizeExtractRunResponse(JSON.parse(cliExtract.output)),
      );
      expect(Schema.decodeUnknownSync(SnapshotDiffEnvelopeSchema)(diff)).toEqual(
        Schema.decodeUnknownSync(SnapshotDiffEnvelopeSchema)(JSON.parse(cliDiff.output)),
      );
      expect(diff.data.diff.id).toBe(`diff-${candidate.targetId}-${baseline.id}-${candidate.id}`);
      expect(diff.data.diff.metrics.latencyDeltaMs).toBe(20);
      expect(diff.data.diff.metrics.memoryDelta).toBe(2);
      expect(Schema.decodeUnknownSync(QualityVerifyEnvelopeSchema)(verify)).toEqual(
        Schema.decodeUnknownSync(QualityVerifyEnvelopeSchema)(JSON.parse(cliVerify.output)),
      );
      expect(compare.data.metrics.overall.fieldRecallRate).toBe(1);
      expect(Schema.decodeUnknownSync(QualityCompareEnvelopeSchema)(compare)).toEqual(
        Schema.decodeUnknownSync(QualityCompareEnvelopeSchema)(JSON.parse(cliCompare.output)),
      );
      expect(
        Schema.decodeUnknownSync(QualityVerifyEnvelopeSchema)(verify).data.verdict.action,
      ).toBe("active");

      const invalidQualityCli = yield* Effect.promise(() =>
        executeCli([
          "quality",
          "verify",
          "unexpected",
          "--input",
          JSON.stringify(qualityVerifyInput),
        ]),
      );

      expect(invalidQualityCli.exitCode).toBe(2);
      expect(JSON.parse(invalidQualityCli.output)).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });

      const invalidScrapeCli = yield* Effect.promise(() =>
        executeCli([
          "scrape",
          "unexpected",
          "--url",
          extractInput.url,
          "--selector",
          extractInput.selector,
        ]),
      );

      expect(invalidScrapeCli.exitCode).toBe(2);
      expect(JSON.parse(invalidScrapeCli.output)).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });

      const invalidQualityTimestampCli = yield* Effect.promise(() =>
        executeCli([
          "quality",
          "diff",
          "--input",
          JSON.stringify({
            baseline,
            candidate,
            createdAt: "2026-99-99Tnot-a-date",
          }),
        ]),
      );

      expect(invalidQualityTimestampCli.exitCode).toBe(2);
      expect(JSON.parse(invalidQualityTimestampCli.output)).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });
    }),
  );
});
