import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { join } from "node:path";
import {
  ArtifactMetadataRecordSchema,
  CoreErrorEnvelopeSchema,
  PackPromotionDecisionSchema,
  QualityVerdictSchema,
  RunCheckpointSchema,
  RunExecutionConfigSchema,
  RunPlanSchema,
  RunStatsSchema,
  SnapshotDiffSchema,
  SnapshotSchema,
  StorageLocatorSchema,
  WorkflowInspectionSnapshotSchema,
} from "../../libs/foundation/core/src";
import { runE1CapabilitySlice } from "../../examples/e1-capability-slice.ts";

const REPO_ROOT = import.meta.dir ? join(import.meta.dir, "..", "..") : process.cwd();
const ARTIFACTS_SCHEMA = Schema.Array(ArtifactMetadataRecordSchema);

describe("E1 capability slice verification", () => {
  it.effect("executes the public foundation-core capability slice and emits durable evidence", () =>
    Effect.gen(function* () {
      const result = yield* runE1CapabilitySlice();
      const resolvedConfig = Schema.decodeUnknownSync(RunExecutionConfigSchema)(
        result.resolvedConfig,
      );
      const plan = Schema.decodeUnknownSync(RunPlanSchema)(result.plan);
      const checkpoint = Schema.decodeUnknownSync(RunCheckpointSchema)(result.checkpoint);
      const stats = Schema.decodeUnknownSync(RunStatsSchema)(result.stats);
      const inspection = Schema.decodeUnknownSync(WorkflowInspectionSnapshotSchema)(
        result.inspection,
      );
      const artifacts = Schema.decodeUnknownSync(ARTIFACTS_SCHEMA)(result.artifacts);
      const snapshot = Schema.decodeUnknownSync(SnapshotSchema)(result.snapshot);
      const diff = Schema.decodeUnknownSync(SnapshotDiffSchema)(result.diff);
      const verdict = Schema.decodeUnknownSync(QualityVerdictSchema)(result.verdict);
      const decision = Schema.decodeUnknownSync(PackPromotionDecisionSchema)(result.decision);
      const exportedLocator = Schema.decodeUnknownSync(StorageLocatorSchema)(
        result.exportedLocator,
      );
      const errorEnvelope = Schema.decodeUnknownSync(CoreErrorEnvelopeSchema)(result.errorEnvelope);

      expect(plan.steps.map(({ stage }) => stage)).toEqual(["capture", "extract", "snapshot"]);
      expect(checkpoint.stage).toBe("extract");
      expect(stats.completedSteps).toBe(1);
      expect(inspection.progress.pendingSteps).toBe(2);
      expect(inspection.budget.stepsUntilNextCheckpoint).toBe(2);
      expect(artifacts).toHaveLength(2);
      expect(snapshot.observations[0]?.field).toBe("price");
      expect(diff.metrics.fieldRecallDelta).toBe(0.03);
      expect(verdict.gates).toHaveLength(7);
      expect(decision.action).toBe("promote-shadow");
      expect(exportedLocator.namespace).toBe("exports/example-com");
      expect(errorEnvelope.code).toBe("policy_violation");
      expect(resolvedConfig.mode).toBe("browser");
    }),
  );

  it("executes as a standalone example script", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", "examples/e1-capability-slice.ts"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    expect(result.exitCode).toBe(0);

    const stdout = new TextDecoder().decode(result.stdout);
    const payload = JSON.parse(stdout);
    const resolvedConfig = Schema.decodeUnknownSync(RunExecutionConfigSchema)(
      payload.resolvedConfig,
    );
    const plan = Schema.decodeUnknownSync(RunPlanSchema)(payload.plan);
    const checkpoint = Schema.decodeUnknownSync(RunCheckpointSchema)(payload.checkpoint);
    const stats = Schema.decodeUnknownSync(RunStatsSchema)(payload.stats);
    const inspection = Schema.decodeUnknownSync(WorkflowInspectionSnapshotSchema)(
      payload.inspection,
    );
    const artifacts = Schema.decodeUnknownSync(ARTIFACTS_SCHEMA)(payload.artifacts);
    const snapshot = Schema.decodeUnknownSync(SnapshotSchema)(payload.snapshot);
    const diff = Schema.decodeUnknownSync(SnapshotDiffSchema)(payload.diff);
    const verdict = Schema.decodeUnknownSync(QualityVerdictSchema)(payload.verdict);
    const decision = Schema.decodeUnknownSync(PackPromotionDecisionSchema)(payload.decision);
    const exportedLocator = Schema.decodeUnknownSync(StorageLocatorSchema)(payload.exportedLocator);
    const errorEnvelope = Schema.decodeUnknownSync(CoreErrorEnvelopeSchema)(payload.errorEnvelope);

    expect(decision.action).toBe("promote-shadow");
    expect(errorEnvelope.code).toBe("policy_violation");
    expect(artifacts).toHaveLength(2);
    expect(resolvedConfig.mode).toBe("browser");
    expect(plan.steps).toHaveLength(3);
    expect(checkpoint.stage).toBe("extract");
    expect(stats.completedSteps).toBe(1);
    expect(inspection.stage).toBe("extract");
    expect(snapshot.observations[0]?.field).toBe("price");
    expect(diff.metrics.latencyDeltaMs).toBe(-50);
    expect(verdict.action).toBe("promote-shadow");
    expect(exportedLocator.namespace).toBe("exports/example-com");
  });
});
