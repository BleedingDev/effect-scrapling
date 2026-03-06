import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { readFileSync } from "node:fs";
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
} from "../../libs/foundation/core/src";
import {
  capabilitySlicePitfalls,
  capabilitySlicePrerequisites,
  runE1CapabilitySlice,
} from "../../examples/e1-capability-slice";

const REPO_ROOT = import.meta.dir ? join(import.meta.dir, "..", "..") : process.cwd();
const EXAMPLE_PATH = join(REPO_ROOT, "examples", "e1-capability-slice.ts");
const ARTIFACTS_SCHEMA = Schema.Array(ArtifactMetadataRecordSchema);

describe("E1 capability slice verification", () => {
  it.effect("executes the public foundation-core capability slice and emits durable evidence", () =>
    Effect.gen(function* () {
      const result = yield* runE1CapabilitySlice();

      expect(result.importPath).toBe("@effect-scrapling/foundation-core");
      expect(result.plan.steps.map(({ stage }) => stage)).toEqual([
        "capture",
        "extract",
        "snapshot",
      ]);
      expect(result.checkpoint.stage).toBe("extract");
      expect(result.stats.completedSteps).toBe(1);
      expect(result.artifacts).toHaveLength(2);
      expect(result.snapshot.observations[0]?.field).toBe("price");
      expect(result.verdict.gates).toHaveLength(7);
      expect(result.decision.action).toBe("promote-shadow");
      expect(result.exportedLocator.namespace).toBe("exports/example-com");
      expect(result.errorEnvelope.code).toBe("policy_violation");
      expect(
        Schema.encodeSync(RunExecutionConfigSchema)(
          Schema.decodeUnknownSync(RunExecutionConfigSchema)(result.resolvedConfig),
        ),
      ).toEqual(result.resolvedConfig);
      expect(
        Schema.encodeSync(RunPlanSchema)(Schema.decodeUnknownSync(RunPlanSchema)(result.plan)),
      ).toEqual(result.plan);
      expect(
        Schema.encodeSync(RunCheckpointSchema)(
          Schema.decodeUnknownSync(RunCheckpointSchema)(result.checkpoint),
        ),
      ).toEqual(result.checkpoint);
      expect(
        Schema.encodeSync(RunStatsSchema)(Schema.decodeUnknownSync(RunStatsSchema)(result.stats)),
      ).toEqual(result.stats);
      expect(
        Schema.encodeSync(ARTIFACTS_SCHEMA)(
          Schema.decodeUnknownSync(ARTIFACTS_SCHEMA)(result.artifacts),
        ),
      ).toEqual(result.artifacts);
      expect(
        Schema.encodeSync(SnapshotSchema)(
          Schema.decodeUnknownSync(SnapshotSchema)(result.snapshot),
        ),
      ).toEqual(result.snapshot);
      expect(
        Schema.encodeSync(SnapshotDiffSchema)(
          Schema.decodeUnknownSync(SnapshotDiffSchema)(result.diff),
        ),
      ).toEqual(result.diff);
      expect(
        Schema.encodeSync(QualityVerdictSchema)(
          Schema.decodeUnknownSync(QualityVerdictSchema)(result.verdict),
        ),
      ).toEqual(result.verdict);
      expect(
        Schema.encodeSync(PackPromotionDecisionSchema)(
          Schema.decodeUnknownSync(PackPromotionDecisionSchema)(result.decision),
        ),
      ).toEqual(result.decision);
      expect(
        Schema.encodeSync(StorageLocatorSchema)(
          Schema.decodeUnknownSync(StorageLocatorSchema)(result.exportedLocator),
        ),
      ).toEqual(result.exportedLocator);
      expect(
        Schema.encodeSync(CoreErrorEnvelopeSchema)(
          Schema.decodeUnknownSync(CoreErrorEnvelopeSchema)(result.errorEnvelope),
        ),
      ).toEqual(result.errorEnvelope);
    }),
  );

  it("documents prerequisites and pitfall guidance for downstream teams", () => {
    expect(capabilitySlicePrerequisites).toContain("Bun >= 1.3.10");
    expect(capabilitySlicePitfalls).toContain(
      "Do not bypass schema decode for config, run state, or quality payloads.",
    );
  });

  it("uses only the public foundation-core import path", () => {
    const source = readFileSync(EXAMPLE_PATH, "utf8");

    expect(source).toContain('from "@effect-scrapling/foundation-core"');
    expect(/from\s+["'](?:\.\.?\/)+libs\/foundation\/core\//u.test(source)).toBe(false);
  });

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

    expect(payload.importPath).toBe("@effect-scrapling/foundation-core");
    expect(payload.decision.action).toBe("promote-shadow");
    expect(payload.errorEnvelope.code).toBe("policy_violation");
    expect(Schema.decodeUnknownSync(ARTIFACTS_SCHEMA)(payload.artifacts)).toHaveLength(2);
    expect(
      Schema.encodeSync(RunExecutionConfigSchema)(
        Schema.decodeUnknownSync(RunExecutionConfigSchema)(payload.resolvedConfig),
      ),
    ).toEqual(payload.resolvedConfig);
    expect(
      Schema.encodeSync(RunPlanSchema)(Schema.decodeUnknownSync(RunPlanSchema)(payload.plan)),
    ).toEqual(payload.plan);
    expect(
      Schema.encodeSync(RunCheckpointSchema)(
        Schema.decodeUnknownSync(RunCheckpointSchema)(payload.checkpoint),
      ),
    ).toEqual(payload.checkpoint);
    expect(
      Schema.encodeSync(RunStatsSchema)(Schema.decodeUnknownSync(RunStatsSchema)(payload.stats)),
    ).toEqual(payload.stats);
    expect(
      Schema.encodeSync(ARTIFACTS_SCHEMA)(
        Schema.decodeUnknownSync(ARTIFACTS_SCHEMA)(payload.artifacts),
      ),
    ).toEqual(payload.artifacts);
    expect(
      Schema.encodeSync(SnapshotSchema)(Schema.decodeUnknownSync(SnapshotSchema)(payload.snapshot)),
    ).toEqual(payload.snapshot);
    expect(
      Schema.encodeSync(SnapshotDiffSchema)(
        Schema.decodeUnknownSync(SnapshotDiffSchema)(payload.diff),
      ),
    ).toEqual(payload.diff);
    expect(
      Schema.encodeSync(QualityVerdictSchema)(
        Schema.decodeUnknownSync(QualityVerdictSchema)(payload.verdict),
      ),
    ).toEqual(payload.verdict);
    expect(
      Schema.encodeSync(PackPromotionDecisionSchema)(
        Schema.decodeUnknownSync(PackPromotionDecisionSchema)(payload.decision),
      ),
    ).toEqual(payload.decision);
    expect(
      Schema.encodeSync(StorageLocatorSchema)(
        Schema.decodeUnknownSync(StorageLocatorSchema)(payload.exportedLocator),
      ),
    ).toEqual(payload.exportedLocator);
    expect(
      Schema.encodeSync(CoreErrorEnvelopeSchema)(
        Schema.decodeUnknownSync(CoreErrorEnvelopeSchema)(payload.errorEnvelope),
      ),
    ).toEqual(payload.errorEnvelope);
  });
});
