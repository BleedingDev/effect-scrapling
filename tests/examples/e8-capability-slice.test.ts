import { fileURLToPath } from "node:url";
import { describe, expect, it, setDefaultTimeout } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { resetAccessHealthGatewayForTests } from "../../src/sdk/access-health-gateway.ts";
import { resetBrowserPoolForTests } from "../../src/sdk/browser-pool.ts";
import { provideSdkRuntime } from "../../src/sdk/runtime-layer.ts";
import {
  E8CapabilitySliceEvidenceSchema,
  runE8CapabilitySlice,
} from "../../examples/e8-capability-slice.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const exampleEntry = fileURLToPath(
  new URL("../../examples/e8-capability-slice.ts", import.meta.url),
);
const decodeEvidence = Schema.decodeUnknownSync(E8CapabilitySliceEvidenceSchema);
type CapabilityEvidence = Schema.Schema.Type<typeof E8CapabilitySliceEvidenceSchema>;

setDefaultTimeout(20_000);

function stableProjection(encoded: CapabilityEvidence) {
  return {
    evidencePath: encoded.evidencePath,
    workspace: {
      doctorCommand: encoded.workspaceDoctor.command,
      configCommand: encoded.workspaceConfig.command,
      sourceOrder: encoded.workspaceConfig.data.sourceOrder,
    },
    target: {
      imported: encoded.targetImport.data.targets.map(({ id }) => id),
      listed: encoded.targetList.data.targets.map(({ id }) => id),
    },
    pack: {
      create: encoded.packCreate.data.definition.pack,
      inspect: encoded.packInspect.data.summary,
      validateAction: encoded.packValidate.data.verdict.qualityVerdict.action,
      promoteVersion: encoded.packPromote.data.result.activeArtifact?.definition.pack.version,
    },
    preview: {
      accessCommand: encoded.accessPreview.command,
      renderCommand: encoded.renderPreview.command,
      renderArtifactKinds: encoded.renderPreview.data.artifacts.map(({ kind }) => kind),
    },
    workflow: {
      compiledPlanId: encoded.crawlCompile.data.compiled.plan.id,
      runId: encoded.workflowRun.data.checkpoint.runId,
      resumeCheckpointId: encoded.workflowResume.data.checkpoint.id,
      inspectRunId: encoded.workflowInspect.data.inspection.runId,
    },
    extractionQuality: {
      extractValues: encoded.extractRun.data.values,
      snapshotDiffId: encoded.snapshotDiff.data.diff.id,
      verifyDecision: encoded.qualityVerify.data.packDecision.action,
      qualityMetricsId: encoded.qualityCompare.data.metrics.metricsId,
    },
    benchmark: {
      bundleId: encoded.benchmarkRun.data.bundleId,
      artifactCount: encoded.benchmarkRun.data.artifactCount,
      manifestKeys: encoded.artifactExportSummary.manifestKeys,
    },
    parity: encoded.paritySummary,
  };
}

describe("examples/e8-capability-slice", () => {
  it.effect("executes the E8 end-to-end capability slice with typed linked evidence", () =>
    Effect.gen(function* () {
      yield* resetAccessHealthGatewayForTests();
      yield* resetBrowserPoolForTests();
      const evidence = yield* provideSdkRuntime(runE8CapabilitySlice());
      const encoded = evidence;

      expect(encoded.evidencePath.importedTargetIds).toEqual([
        "target-blog-001",
        "target-shop-001",
      ]);
      expect(encoded.evidencePath.listedTargetIds).toEqual(["target-shop-001"]);
      expect(encoded.workspaceDoctor.command).toBe("doctor");
      expect(encoded.workspaceConfig.command).toBe("config show");
      expect(encoded.packCreate.data.definition.pack.id).toBe(encoded.evidencePath.packId);
      expect(encoded.packInspect.data.summary.selectorFieldCount).toBe(1);
      expect(encoded.packPromote.data.result.activeArtifact?.definition.pack.version).toBe(
        encoded.evidencePath.promotedPackVersion,
      );
      expect(encoded.accessPreview.command).toBe("access preview");
      expect(encoded.renderPreview.command).toBe("render preview");
      expect(encoded.renderPreview.data.artifacts.map(({ kind }) => kind)).toEqual([
        "navigation",
        "renderedDom",
        "timings",
      ]);
      expect(encoded.crawlCompile.command).toBe("crawl compile");
      expect(encoded.workflowRun.data.checkpoint.runId).toBe(encoded.evidencePath.workflowRunId);
      expect(encoded.workflowResume.data.checkpoint.id).toBe(
        encoded.evidencePath.workflowResumeCheckpointId,
      );
      expect(encoded.workflowInspect.data.inspection.runId).toBe(
        encoded.evidencePath.workflowInspectionRunId,
      );
      expect(encoded.extractRun.data.values).toEqual(["Effect", "Scrapling"]);
      expect(encoded.snapshotDiff.data.diff.id).toBe(encoded.evidencePath.snapshotDiffId);
      expect(encoded.qualityCompare.data.metrics.metricsId).toBe(
        encoded.evidencePath.qualityMetricsId,
      );
      expect(encoded.benchmarkRun.data.bundleId).toBe(encoded.evidencePath.benchmarkBundleId);
      expect(encoded.artifactExportSummary.exportId).toBe(encoded.evidencePath.artifactExportId);
      expect(encoded.paritySummary.suiteId).toBe(encoded.evidencePath.paritySuiteId);
      expect(encoded.paritySummary.status).toBe("pass");
      expect(encoded.paritySummary.mismatchCount).toBe(0);
      expect(encoded.paritySummary.commands).toContain("workspace doctor");
      expect(encoded.paritySummary.commands).toContain("artifact export");
    }),
  );

  it("runs standalone and emits schema-valid deterministic evidence JSON", async () => {
    const expected = await Effect.runPromise(
      Effect.gen(function* () {
        yield* resetAccessHealthGatewayForTests();
        yield* resetBrowserPoolForTests();
        return yield* provideSdkRuntime(runE8CapabilitySlice());
      }),
    );
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", exampleEntry],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    const stderr = new TextDecoder().decode(result.stderr).trim();
    expect(result.exitCode).toBe(0);
    expect(stderr).toBe("");

    const stdout = new TextDecoder().decode(result.stdout);
    const decoded = decodeEvidence(JSON.parse(stdout));

    expect(stableProjection(decoded)).toEqual(stableProjection(expected));
  });
});
