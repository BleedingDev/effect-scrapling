#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema } from "effect";
import {
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
  runSnapshotDiffOperation,
  runTargetImportOperation,
  runTargetListOperation,
  runWorkflowInspectOperation,
  runWorkflowResumeOperation,
  runWorkflowRunOperation,
  runWorkspaceDoctor,
  showWorkspaceConfig,
} from "../../src/e8.ts";
import { executeCli } from "../../src/standalone.ts";
import { runE8BenchmarkCli } from "./e8-benchmark-export.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

const E8ParityCaseSchema = Schema.Struct({
  caseId: NonEmptyStringSchema,
  command: NonEmptyStringSchema,
  matched: Schema.Boolean,
  replayStable: Schema.Boolean,
  sdkEnvelope: Schema.Unknown,
  cliEnvelope: Schema.Unknown,
  replayEnvelope: Schema.Unknown,
});

export const E8ParityArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e8-parity-dry-run"),
  suiteId: NonEmptyStringSchema,
  generatedAt: Schema.String,
  caseCount: Schema.Int.check(Schema.isGreaterThan(0)),
  status: Schema.Literals(["pass", "fail"] as const),
  mismatches: Schema.Array(NonEmptyStringSchema),
  cases: Schema.Array(E8ParityCaseSchema),
});

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
      labels: [],
    },
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

function normalizeEnvelope(payload: unknown) {
  if (typeof payload !== "object" || payload === null) {
    return payload;
  }

  const normalized = structuredClone(payload);
  const command = Reflect.get(normalized, "command");
  const data = Reflect.get(normalized, "data");

  if (command === "access preview" && typeof data === "object" && data !== null) {
    Reflect.set(data, "durationMs", 1);
  }

  if (command === "extract run" && typeof data === "object" && data !== null) {
    Reflect.set(data, "durationMs", 1);
  }

  return normalized;
}

async function createParityCase(input: {
  readonly caseId: string;
  readonly command: string;
  readonly sdk: () => Promise<unknown>;
  readonly cli: () => Promise<unknown>;
}) {
  const sdkEnvelope = normalizeEnvelope(await input.sdk());
  const cliEnvelope = normalizeEnvelope(await input.cli());
  const replayEnvelope = normalizeEnvelope(await input.cli());

  return Schema.decodeUnknownSync(E8ParityCaseSchema)({
    caseId: input.caseId,
    command: input.command,
    matched: JSON.stringify(sdkEnvelope) === JSON.stringify(cliEnvelope),
    replayStable: JSON.stringify(cliEnvelope) === JSON.stringify(replayEnvelope),
    sdkEnvelope,
    cliEnvelope,
    replayEnvelope,
  });
}

export async function runE8ParityDryRunSuite() {
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
  const shadowDefinition = makePackDefinition("shadow");
  const activeDefinition = makePackDefinition("active");
  const qualityDiffInput = {
    baseline: makeSnapshot({
      id: "snapshot-baseline-quality",
      targetId: "target-quality-001",
      title: "Widget",
      price: 199,
    }),
    candidate: makeSnapshot({
      id: "snapshot-candidate-quality",
      targetId: "target-quality-001",
      title: "Widget",
      price: 209,
    }),
    createdAt: "2026-03-09T11:00:00.000Z",
    latencyDeltaMs: 12,
    memoryDelta: 2,
  };
  const qualityVerifyInput = {
    pack: shadowDefinition.pack,
    snapshotDiff: {
      id: "diff-quality-001",
      baselineSnapshotId: qualityDiffInput.baseline.id,
      candidateSnapshotId: qualityDiffInput.candidate.id,
      metrics: {
        fieldRecallDelta: 0,
        falsePositiveDelta: 0,
        driftDelta: 0.01,
        latencyDeltaMs: 12,
        memoryDelta: 2,
      },
      createdAt: "2026-03-09T11:01:00.000Z",
    },
    checks: {
      replayDeterminism: true,
      workflowResume: true,
      canary: true,
      chaos: true,
      securityRedaction: true,
      soakStability: true,
    },
    createdAt: "2026-03-09T11:02:00.000Z",
  };
  const baselineBundle = await Effect.runPromise(runArtifactExportOperation());
  const qualityCompareInput = {
    metricsId: "metrics-e8-quality",
    generatedAt: "2026-03-09T11:03:00.000Z",
    baseline: baselineBundle.data.artifact.bundle.baselineCorpus,
    comparison: baselineBundle.data.artifact.bundle.incumbentComparison,
  };
  const crawlCompileInput = {
    createdAt: "2026-03-09T09:00:00.000Z",
    defaults: {
      checkpointInterval: 2,
    },
    entries: [
      {
        target: makeTarget({
          id: "target-workflow-001",
          tenantId: "tenant-main",
          domain: "shop.example.com",
          kind: "productPage",
          priority: 10,
        }),
        pack: shadowDefinition.pack,
        accessPolicy: {
          id: "policy-default",
          mode: "http",
          perDomainConcurrency: 2,
          globalConcurrency: 8,
          timeoutMs: 30000,
          maxRetries: 1,
          render: "never",
        },
      },
    ],
  };
  const compiled = await Effect.runPromise(runCrawlCompileOperation(crawlCompileInput));
  const workflowRunInput = {
    compiledPlan: compiled.data.compiled,
    pack: shadowDefinition.pack,
  };
  const workflowRun = await Effect.runPromise(runWorkflowRunOperation(workflowRunInput));
  const workflowResumeInput = {
    compiledPlan: compiled.data.compiled,
    checkpoint: workflowRun.data.checkpoint,
    pack: shadowDefinition.pack,
  };

  const cases = [
    await createParityCase({
      caseId: "workspace-doctor",
      command: "workspace doctor",
      sdk: () => Effect.runPromise(runWorkspaceDoctor()),
      cli: () => executeCli(["workspace", "doctor"]).then((result) => JSON.parse(result.output)),
    }),
    await createParityCase({
      caseId: "workspace-config-show",
      command: "workspace config show",
      sdk: () => Effect.runPromise(showWorkspaceConfig()),
      cli: () =>
        executeCli(["workspace", "config", "show"]).then((result) => JSON.parse(result.output)),
    }),
    await createParityCase({
      caseId: "target-import",
      command: "target import",
      sdk: () => Effect.runPromise(runTargetImportOperation({ targets })),
      cli: () =>
        executeCli(["target", "import", "--input", JSON.stringify({ targets })]).then((result) =>
          JSON.parse(result.output),
        ),
    }),
    await createParityCase({
      caseId: "target-list",
      command: "target list",
      sdk: () =>
        Effect.runPromise(
          runTargetListOperation({ targets, filters: { tenantId: "tenant-main" } }),
        ),
      cli: () =>
        executeCli([
          "target",
          "list",
          "--input",
          JSON.stringify({ targets, filters: { tenantId: "tenant-main" } }),
        ]).then((result) => JSON.parse(result.output)),
    }),
    await createParityCase({
      caseId: "pack-create",
      command: "pack create",
      sdk: () => Effect.runPromise(runPackCreateOperation({ definition: shadowDefinition })),
      cli: () =>
        executeCli([
          "pack",
          "create",
          "--input",
          JSON.stringify({ definition: shadowDefinition }),
        ]).then((result) => JSON.parse(result.output)),
    }),
    await createParityCase({
      caseId: "pack-inspect",
      command: "pack inspect",
      sdk: () => Effect.runPromise(runPackInspectOperation({ definition: shadowDefinition })),
      cli: () =>
        executeCli([
          "pack",
          "inspect",
          "--input",
          JSON.stringify({ definition: shadowDefinition }),
        ]).then((result) => JSON.parse(result.output)),
    }),
    await createParityCase({
      caseId: "pack-validate",
      command: "pack validate",
      sdk: () => Effect.runPromise(runPackValidateOperation(qualityVerifyInput)),
      cli: () =>
        executeCli(["pack", "validate", "--input", JSON.stringify(qualityVerifyInput)]).then(
          (result) => JSON.parse(result.output),
        ),
    }),
    await createParityCase({
      caseId: "pack-promote",
      command: "pack promote",
      sdk: () =>
        Effect.runPromise(
          runPackPromoteOperation({
            catalog: [
              {
                definition: activeDefinition,
                recordedAt: "2026-03-09T09:10:00.000Z",
                recordedBy: "curator-main",
              },
              {
                definition: shadowDefinition,
                recordedAt: "2026-03-09T09:11:00.000Z",
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
              fromState: "shadow",
              toState: "active",
              action: "active",
              createdAt: "2026-03-09T09:12:00.000Z",
            },
            changedBy: "curator-main",
            rationale: "shadow pack passed the validation ladder",
            occurredAt: "2026-03-09T09:13:00.000Z",
            nextVersion: "2026.03.10",
          }),
        ),
      cli: () =>
        executeCli([
          "pack",
          "promote",
          "--input",
          JSON.stringify({
            catalog: [
              {
                definition: activeDefinition,
                recordedAt: "2026-03-09T09:10:00.000Z",
                recordedBy: "curator-main",
              },
              {
                definition: shadowDefinition,
                recordedAt: "2026-03-09T09:11:00.000Z",
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
              fromState: "shadow",
              toState: "active",
              action: "active",
              createdAt: "2026-03-09T09:12:00.000Z",
            },
            changedBy: "curator-main",
            rationale: "shadow pack passed the validation ladder",
            occurredAt: "2026-03-09T09:13:00.000Z",
            nextVersion: "2026.03.10",
          }),
        ]).then((result) => JSON.parse(result.output)),
    }),
    await createParityCase({
      caseId: "access-preview-http",
      command: "access preview",
      sdk: () =>
        Effect.runPromise(
          runAccessPreviewOperation(
            { url: "https://example.com/e8-preview" },
            mockHtmlFetch("<html><head><title>E8 Preview</title></head></html>"),
          ),
        ),
      cli: () =>
        executeCli(
          ["access", "preview", "--url", "https://example.com/e8-preview"],
          mockHtmlFetch("<html><head><title>E8 Preview</title></head></html>"),
        ).then((result) => JSON.parse(result.output)),
    }),
    await createParityCase({
      caseId: "extract-run-http",
      command: "extract run",
      sdk: () =>
        Effect.runPromise(
          runExtractRunOperation(
            { url: "https://example.com/e8-extract", selector: "h1" },
            mockHtmlFetch("<html><body><h1>Effect Scrapling</h1></body></html>"),
          ),
        ),
      cli: () =>
        executeCli(
          ["extract", "run", "--url", "https://example.com/e8-extract", "--selector", "h1"],
          mockHtmlFetch("<html><body><h1>Effect Scrapling</h1></body></html>"),
        ).then((result) => JSON.parse(result.output)),
    }),
    await createParityCase({
      caseId: "crawl-compile",
      command: "crawl compile",
      sdk: () => Effect.runPromise(runCrawlCompileOperation(crawlCompileInput)),
      cli: () =>
        executeCli(["crawl", "compile", "--input", JSON.stringify(crawlCompileInput)]).then(
          (result) => JSON.parse(result.output),
        ),
    }),
    await createParityCase({
      caseId: "workflow-run",
      command: "workflow run",
      sdk: () => Effect.runPromise(runWorkflowRunOperation(workflowRunInput)),
      cli: () =>
        executeCli(["workflow", "run", "--input", JSON.stringify(workflowRunInput)]).then(
          (result) => JSON.parse(result.output),
        ),
    }),
    await createParityCase({
      caseId: "workflow-resume",
      command: "workflow resume",
      sdk: () => Effect.runPromise(runWorkflowResumeOperation(workflowResumeInput)),
      cli: () =>
        executeCli(["workflow", "resume", "--input", JSON.stringify(workflowResumeInput)]).then(
          (result) => JSON.parse(result.output),
        ),
    }),
    await createParityCase({
      caseId: "workflow-inspect",
      command: "workflow inspect",
      sdk: () =>
        Effect.runPromise(
          runWorkflowInspectOperation({
            compiledPlan: compiled.data.compiled,
            checkpoint: workflowRun.data.checkpoint,
            pack: shadowDefinition.pack,
          }),
        ),
      cli: () =>
        executeCli([
          "workflow",
          "inspect",
          "--input",
          JSON.stringify({
            compiledPlan: compiled.data.compiled,
            checkpoint: workflowRun.data.checkpoint,
            pack: shadowDefinition.pack,
          }),
        ]).then((result) => JSON.parse(result.output)),
    }),
    await createParityCase({
      caseId: "quality-diff",
      command: "quality diff",
      sdk: () => Effect.runPromise(runSnapshotDiffOperation(qualityDiffInput)),
      cli: () =>
        executeCli(["quality", "diff", "--input", JSON.stringify(qualityDiffInput)]).then(
          (result) => JSON.parse(result.output),
        ),
    }),
    await createParityCase({
      caseId: "quality-verify",
      command: "quality verify",
      sdk: () => Effect.runPromise(runQualityVerifyOperation(qualityVerifyInput)),
      cli: () =>
        executeCli(["quality", "verify", "--input", JSON.stringify(qualityVerifyInput)]).then(
          (result) => JSON.parse(result.output),
        ),
    }),
    await createParityCase({
      caseId: "quality-compare",
      command: "quality compare",
      sdk: () => Effect.runPromise(runQualityCompareOperation(qualityCompareInput)),
      cli: () =>
        executeCli(["quality", "compare", "--input", JSON.stringify(qualityCompareInput)]).then(
          (result) => JSON.parse(result.output),
        ),
    }),
    await createParityCase({
      caseId: "benchmark-run",
      command: "benchmark run",
      sdk: () => Effect.runPromise(runBenchmarkOperation()),
      cli: () => runE8BenchmarkCli(["run"]),
    }),
    await createParityCase({
      caseId: "artifact-export",
      command: "artifact export",
      sdk: () => Effect.runPromise(runArtifactExportOperation()),
      cli: () => runE8BenchmarkCli(["export"]),
    }),
  ];

  const mismatches = cases.flatMap((entry) =>
    entry.matched && entry.replayStable ? [] : [entry.caseId],
  );

  return Schema.decodeUnknownSync(E8ParityArtifactSchema)({
    benchmark: "e8-parity-dry-run",
    suiteId: "suite-e8-parity-dry-run",
    generatedAt: "2026-03-09T12:00:00.000Z",
    caseCount: cases.length,
    status: mismatches.length === 0 ? "pass" : "fail",
    mismatches,
    cases,
  });
}

export function parseOptions(args: readonly string[]) {
  let artifactPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--artifact") {
      const rawValue = args[index + 1];
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error("Missing value for argument: --artifact");
      }

      artifactPath = resolve(Schema.decodeUnknownSync(NonEmptyStringSchema)(rawValue));
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return { artifactPath };
}

async function persistArtifact(path: string, artifact: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  const artifact = await runE8ParityDryRunSuite();
  if (options.artifactPath !== undefined) {
    await persistArtifact(options.artifactPath, artifact);
  }
  console.log(JSON.stringify(artifact, null, 2));
}
