import { Effect, Schema } from "effect";
import { BaselineCorpusArtifactSchema } from "@effect-scrapling/foundation-core/baseline-corpus-runtime";
import { IncumbentComparisonArtifactSchema } from "@effect-scrapling/foundation-core/incumbent-comparison-runtime";
import {
  AccessPreviewResponseSchema,
  ExtractRunResponseSchema,
  RenderPreviewResponseSchema,
  provideSdkRuntime,
} from "../src/sdk/index.ts";
import {
  CrawlCompileEnvelopeSchema,
  E8BenchmarkRunEnvelopeSchema,
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
  WorkspaceConfigShowEnvelopeSchema,
  WorkspaceDoctorEnvelopeSchema,
  runAccessPreviewOperation,
  runArtifactExportOperation,
  runBenchmarkOperation,
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
  runWorkspaceDoctor,
  showWorkspaceConfig,
} from "../src/e8.ts";
import { resetBrowserPoolForTests, setBrowserPoolTestConfig } from "../src/sdk/browser-pool.ts";
import { runE8ParityDryRunSuite } from "../scripts/benchmarks/e8-parity-dry-run.ts";

const BROWSER_PREVIEW_URL = "https://shop.example.com/products/sku-42";
const EXTRACT_URL = "https://shop.example.com/products/sku-42/extract";
const RENDER_PREVIEW_URL = "https://shop.example.com/products/sku-42?view=rendered";
const SYNTHETIC_BROWSER_HTML = `
  <html>
    <head>
      <title>Effect Scrapling E8 Render Preview</title>
    </head>
    <body>
      <main data-runtime="browser">
        <h1>Effect Scrapling browser preview</h1>
        <a href="/offers/sku-42">Offer</a>
        <input type="hidden" name="session" value="sensitive" />
      </main>
    </body>
  </html>
`;

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

const E8ArtifactExportSummarySchema = Schema.Struct({
  exportId: NonEmptyStringSchema,
  artifactCount: Schema.Int,
  sanitizedPathCount: Schema.Int,
  manifestKeys: Schema.Array(NonEmptyStringSchema),
});

const E8ParitySummarySchema = Schema.Struct({
  suiteId: NonEmptyStringSchema,
  status: Schema.Literals(["pass", "fail"] as const),
  caseCount: Schema.Int,
  mismatchCount: Schema.Int,
  commands: Schema.Array(NonEmptyStringSchema),
});

const E8CapabilitySlicePathSchema = Schema.Struct({
  importedTargetIds: Schema.Array(NonEmptyStringSchema),
  listedTargetIds: Schema.Array(NonEmptyStringSchema),
  packId: NonEmptyStringSchema,
  promotedPackVersion: NonEmptyStringSchema,
  workflowRunId: NonEmptyStringSchema,
  workflowCheckpointId: NonEmptyStringSchema,
  workflowResumeCheckpointId: NonEmptyStringSchema,
  workflowInspectionRunId: NonEmptyStringSchema,
  snapshotDiffId: NonEmptyStringSchema,
  qualityMetricsId: NonEmptyStringSchema,
  benchmarkBundleId: NonEmptyStringSchema,
  artifactExportId: NonEmptyStringSchema,
  paritySuiteId: NonEmptyStringSchema,
});

export class E8CapabilitySliceEvidence extends Schema.Class<E8CapabilitySliceEvidence>(
  "E8CapabilitySliceEvidence",
)({
  evidencePath: E8CapabilitySlicePathSchema,
  workspaceDoctor: WorkspaceDoctorEnvelopeSchema,
  workspaceConfig: WorkspaceConfigShowEnvelopeSchema,
  targetImport: TargetImportEnvelopeSchema,
  targetList: TargetListEnvelopeSchema,
  packCreate: PackCreateEnvelopeSchema,
  packInspect: PackInspectEnvelopeSchema,
  packValidate: PackValidateEnvelopeSchema,
  packPromote: PackPromoteEnvelopeSchema,
  accessPreview: AccessPreviewResponseSchema,
  renderPreview: RenderPreviewResponseSchema,
  crawlCompile: CrawlCompileEnvelopeSchema,
  workflowRun: WorkflowRunEnvelopeSchema,
  workflowResume: WorkflowResumeEnvelopeSchema,
  workflowInspect: WorkflowInspectEnvelopeSchema,
  extractRun: ExtractRunResponseSchema,
  snapshotDiff: SnapshotDiffEnvelopeSchema,
  qualityVerify: QualityVerifyEnvelopeSchema,
  qualityCompare: QualityCompareEnvelopeSchema,
  benchmarkRun: E8BenchmarkRunEnvelopeSchema,
  artifactExportSummary: E8ArtifactExportSummarySchema,
  paritySummary: E8ParitySummarySchema,
}) {}

export const E8CapabilitySliceEvidenceSchema = E8CapabilitySliceEvidence;

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

function makePackDefinition(state: "shadow" | "active") {
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
      labels: ["retail"],
    },
  };
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
    createdAt: "2026-03-09T16:00:00.000Z",
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

function makeSyntheticPlaywrightModule() {
  return {
    chromium: {
      launch: async () => ({
        newContext: async () => ({
          newPage: async () => {
            let currentUrl = RENDER_PREVIEW_URL;

            return {
              route: async () => undefined,
              goto: async (url: string) => {
                currentUrl = url;
                return {
                  status: () => 200,
                  allHeaders: async () => ({
                    "content-type": "text/html; charset=utf-8",
                  }),
                };
              },
              waitForLoadState: async () => undefined,
              content: async () => SYNTHETIC_BROWSER_HTML,
              screenshot: async () => Buffer.from("e8-render-preview"),
              evaluate: async () => ({
                requestCount: 1,
                responseCount: 1,
                failedRequestCount: 0,
              }),
              url: () => currentUrl,
              close: async () => undefined,
            };
          },
          close: async () => undefined,
        }),
        close: async () => undefined,
      }),
    },
  };
}

function withSyntheticPlaywright<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    setBrowserPoolTestConfig({
      loadPatchright: () => Effect.succeed(makeSyntheticPlaywrightModule()),
    }),
    () => effect,
    () => resetBrowserPoolForTests(),
  );
}

async function readJsonFile(path: string) {
  return Bun.file(path).json();
}

export function runE8CapabilitySlice() {
  return provideSdkRuntime(
    withSyntheticPlaywright(
      Effect.gen(function* () {
        const listingTarget = makeTarget({
          id: "target-blog-001",
          tenantId: "tenant-alt",
          domain: "blog.example.com",
          kind: "productListing",
          priority: 10,
        });
        const productTarget = makeTarget({
          id: "target-shop-001",
          tenantId: "tenant-main",
          domain: "shop.example.com",
          kind: "productPage",
          priority: 40,
        });
        const targets = [listingTarget, productTarget];
        const shadowDefinition = makePackDefinition("shadow");
        const activeDefinition = makePackDefinition("active");
        const doctor = yield* runWorkspaceDoctor();
        const config = yield* showWorkspaceConfig();
        const targetImport = yield* runTargetImportOperation({ targets });
        const targetList = yield* runTargetListOperation({
          targets,
          filters: {
            tenantId: "tenant-main",
            domain: "shop.example.com",
            kind: "productPage",
          },
        });
        const packCreate = yield* runPackCreateOperation({
          definition: shadowDefinition,
        });
        const packInspect = yield* runPackInspectOperation({
          definition: shadowDefinition,
        });
        const packValidate = yield* runPackValidateOperation({
          pack: shadowDefinition.pack,
          snapshotDiff: {
            id: "diff-pack-shadow",
            baselineSnapshotId: "snapshot-pack-baseline",
            candidateSnapshotId: "snapshot-pack-candidate",
            metrics: {
              fieldRecallDelta: 0.01,
              falsePositiveDelta: 0,
              driftDelta: 0.02,
              latencyDeltaMs: 10,
              memoryDelta: 1,
            },
            createdAt: "2026-03-09T16:05:00.000Z",
          },
          checks: {
            replayDeterminism: true,
            workflowResume: true,
            canary: true,
            chaos: false,
            securityRedaction: true,
            soakStability: false,
          },
          createdAt: "2026-03-09T16:06:00.000Z",
        });
        const packPromote = yield* runPackPromoteOperation({
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
            id: "decision-pack-shadow-active",
            packId: shadowDefinition.pack.id,
            sourceVersion: shadowDefinition.pack.version,
            triggerVerdictId: "verdict-pack-shadow",
            createdAt: "2026-03-09T16:07:00.000Z",
            fromState: "shadow",
            toState: "active",
            action: "active",
          },
          changedBy: "curator-main",
          rationale: "Shadow pack passed the validation ladder.",
          occurredAt: "2026-03-09T16:08:00.000Z",
          nextVersion: "2026.03.10",
        });
        const accessPreview = yield* runAccessPreviewOperation(
          { url: BROWSER_PREVIEW_URL },
          mockHtmlFetch(
            "<html><body><main><h1>Effect Scrapling access preview</h1></main></body></html>",
          ),
        );
        const renderPreview = yield* runRenderPreviewOperation({
          url: RENDER_PREVIEW_URL,
          execution: {
            browser: {
              waitUntil: "commit",
              timeoutMs: 400,
              userAgent: "E8 Capability Slice Browser",
            },
          },
        });
        const crawlCompile = yield* runCrawlCompileOperation({
          createdAt: "2026-03-09T16:10:00.000Z",
          entries: [
            {
              target: productTarget,
              pack: shadowDefinition.pack,
              accessPolicy: makeAccessPolicy(),
            },
          ],
        });
        const workflowRun = yield* runWorkflowRunOperation({
          compiledPlan: crawlCompile.data.compiled,
          pack: shadowDefinition.pack,
        });
        const workflowResume = yield* runWorkflowResumeOperation({
          compiledPlan: crawlCompile.data.compiled,
          checkpoint: workflowRun.data.checkpoint,
          pack: shadowDefinition.pack,
        });
        const workflowInspect = yield* runWorkflowInspectOperation({
          compiledPlan: crawlCompile.data.compiled,
          checkpoint: workflowResume.data.checkpoint,
          pack: shadowDefinition.pack,
        });
        const extractRun = yield* runExtractRunOperation(
          {
            url: EXTRACT_URL,
            selector: "h1",
            all: true,
            limit: 5,
          },
          mockHtmlFetch("<html><body><h1>Effect</h1><h1>Scrapling</h1></body></html>"),
        );
        const baselineSnapshot = makeSnapshot({
          id: "snapshot-baseline-001",
          targetId: productTarget.id,
          title: "Effect Scrapling",
          price: 199.9,
        });
        const candidateSnapshot = makeSnapshot({
          id: "snapshot-candidate-001",
          targetId: productTarget.id,
          title: "Effect Scrapling v2",
          price: 219.9,
        });
        const snapshotDiff = yield* runSnapshotDiffOperation({
          baseline: baselineSnapshot,
          candidate: candidateSnapshot,
          createdAt: "2026-03-09T16:15:00.000Z",
          latencyDeltaMs: 20,
          memoryDelta: 2,
        });
        const greenDiff = yield* runSnapshotDiffOperation({
          baseline: baselineSnapshot,
          candidate: {
            ...baselineSnapshot,
            id: "snapshot-candidate-green-001",
          },
          createdAt: "2026-03-09T16:16:00.000Z",
        });
        const qualityVerify = yield* runQualityVerifyOperation({
          pack: shadowDefinition.pack,
          snapshotDiff: greenDiff.data.diff,
          checks: {
            replayDeterminism: true,
            workflowResume: true,
            canary: true,
            chaos: true,
            securityRedaction: true,
            soakStability: true,
          },
          createdAt: "2026-03-09T16:17:00.000Z",
        });
        const baselineCorpus = Schema.decodeUnknownSync(BaselineCorpusArtifactSchema)(
          yield* Effect.promise(() =>
            readJsonFile("docs/artifacts/e7-baseline-corpus-artifact.json"),
          ),
        );
        const comparison = Schema.decodeUnknownSync(IncumbentComparisonArtifactSchema)(
          yield* Effect.promise(() =>
            readJsonFile("docs/artifacts/e7-incumbent-comparison-artifact.json"),
          ),
        );
        const qualityCompare = yield* runQualityCompareOperation({
          metricsId: "metrics-e8-capability-slice",
          generatedAt: "2026-03-09T16:18:00.000Z",
          baseline: baselineCorpus,
          comparison,
        });
        const benchmarkRun = yield* runBenchmarkOperation();
        const artifactExport = yield* runArtifactExportOperation();
        const paritySuite = yield* Effect.promise(() => runE8ParityDryRunSuite());

        return new E8CapabilitySliceEvidence({
          evidencePath: {
            importedTargetIds: targetImport.data.targets.map(({ id }) => id),
            listedTargetIds: targetList.data.targets.map(({ id }) => id),
            packId: shadowDefinition.pack.id,
            promotedPackVersion:
              packPromote.data.result.activeArtifact?.definition.pack.version ?? "missing",
            workflowRunId: workflowRun.data.checkpoint.runId,
            workflowCheckpointId: workflowRun.data.checkpoint.id,
            workflowResumeCheckpointId: workflowResume.data.checkpoint.id,
            workflowInspectionRunId: workflowInspect.data.inspection.runId,
            snapshotDiffId: snapshotDiff.data.diff.id,
            qualityMetricsId: qualityCompare.data.metrics.metricsId,
            benchmarkBundleId: benchmarkRun.data.bundleId,
            artifactExportId: artifactExport.data.artifact.exportId,
            paritySuiteId: paritySuite.suiteId,
          },
          workspaceDoctor: doctor,
          workspaceConfig: config,
          targetImport,
          targetList,
          packCreate,
          packInspect,
          packValidate,
          packPromote,
          accessPreview,
          renderPreview,
          crawlCompile,
          workflowRun,
          workflowResume,
          workflowInspect,
          extractRun,
          snapshotDiff,
          qualityVerify,
          qualityCompare,
          benchmarkRun,
          artifactExportSummary: {
            exportId: artifactExport.data.artifact.exportId,
            artifactCount: artifactExport.data.artifact.metadata.artifactCount,
            sanitizedPathCount: artifactExport.data.artifact.metadata.sanitizedPathCount,
            manifestKeys: artifactExport.data.artifact.metadata.manifest.map(({ key }) => key),
          },
          paritySummary: {
            suiteId: paritySuite.suiteId,
            status: paritySuite.status,
            caseCount: paritySuite.caseCount,
            mismatchCount: paritySuite.mismatches.length,
            commands: paritySuite.cases.map(({ command }) => command),
          },
        });
      }),
    ),
  );
}

if (import.meta.main) {
  const payload = await Effect.runPromise(runE8CapabilitySlice());
  console.log(JSON.stringify(payload, null, 2));
}
