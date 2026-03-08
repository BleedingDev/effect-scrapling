import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  E5CapabilitySliceEvidenceSchema,
  runE5CapabilitySlice,
  runE5CapabilitySliceEncoded,
} from "../../examples/e5-capability-slice.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const exampleEntry = fileURLToPath(
  new URL("../../examples/e5-capability-slice.ts", import.meta.url),
);

describe("examples/e5-capability-slice", () => {
  it.effect("executes the deterministic E5 capability slice in-process with typed evidence", () =>
    Effect.gen(function* () {
      const evidence = yield* runE5CapabilitySlice();
      const encoded = Schema.encodeSync(E5CapabilitySliceEvidenceSchema)(evidence);

      expect(encoded.profile).toEqual({
        targetCount: 2,
        observationsPerTarget: 6,
        totalObservations: 12,
      });
      expect(encoded.compiledPlans).toHaveLength(2);
      expect(encoded.compiledPlans.map(({ plan }) => plan.targetId)).toEqual([
        "target-product-0001",
        "target-product-0002",
      ]);
      expect(encoded.compiledPlans.map(({ plan }) => plan.steps.map(({ stage }) => stage))).toEqual(
        [
          ["capture", "extract", "snapshot", "diff", "quality", "reflect"],
          ["capture", "extract", "snapshot", "diff", "quality", "reflect"],
        ],
      );
      expect(encoded.compiledPlans.map(({ checkpoint }) => checkpoint.stage)).toEqual([
        "capture",
        "capture",
      ]);
      expect(encoded.compiledPlans.map(({ rationale }) => rationale.map(({ key }) => key))).toEqual(
        [
          ["mode", "rendering", "budget", "capture-path", "workflow-graph"],
          ["mode", "rendering", "budget", "capture-path", "workflow-graph"],
        ],
      );
      expect(encoded.compiledPlans.map(({ checkpoint }) => checkpoint.pendingStepIds)).toEqual([
        [
          "step-capture",
          "step-extract",
          "step-snapshot",
          "step-diff",
          "step-quality",
          "step-reflect",
        ],
        [
          "step-capture",
          "step-extract",
          "step-snapshot",
          "step-diff",
          "step-quality",
          "step-reflect",
        ],
      ]);

      expect(encoded.crashResume.crashAfterSequences).toEqual([1, 2]);
      expect(encoded.crashResume.restartCount).toBe(4);
      expect(encoded.crashResume.matchedOutputs).toBe(true);
      expect(encoded.crashResume.matchedBudgetEvents).toBe(true);
      expect(encoded.crashResume.matchedWorkClaims).toBe(true);
      expect(encoded.crashResume.baseline).toHaveLength(2);
      expect(encoded.crashResume.recovered).toHaveLength(2);
      expect(encoded.crashResume.baselineBudgetEvents).toEqual({
        acquired: 2,
        rejected: 0,
        released: 2,
        peakGlobalInUse: 1,
        peakPerDomainInUse: 1,
      });
      expect(encoded.crashResume.recoveredBudgetEvents).toEqual(
        encoded.crashResume.baselineBudgetEvents,
      );
      expect(encoded.crashResume.baselineWorkClaims).toEqual({
        recordCount: 12,
        maxClaimCount: 1,
        maxTakeoverCount: 0,
        decisions: {
          acquired: 12,
          alreadyClaimed: 0,
          alreadyCompleted: 0,
          superseded: 0,
        },
      });
      expect(encoded.crashResume.recoveredWorkClaims).toEqual(
        encoded.crashResume.baselineWorkClaims,
      );
      expect(
        encoded.crashResume.recovered.map(
          ({ checkpointCount, finalOutcome, finalSequence, finalStage, stageFingerprint }) => ({
            checkpointCount,
            finalOutcome,
            finalSequence,
            finalStage,
            stageFingerprint,
          }),
        ),
      ).toEqual([
        {
          checkpointCount: 3,
          finalOutcome: "succeeded",
          finalSequence: 3,
          finalStage: "reflect",
          stageFingerprint: "snapshot>quality>reflect",
        },
        {
          checkpointCount: 3,
          finalOutcome: "succeeded",
          finalSequence: 3,
          finalStage: "reflect",
          stageFingerprint: "snapshot>quality>reflect",
        },
      ]);
      expect(
        encoded.crashResume.recovered.map(({ inspection }) => inspection.progress.completionRatio),
      ).toEqual([1, 1]);
      expect(
        encoded.crashResume.recovered.map(({ inspection }) => inspection.progress.pendingSteps),
      ).toEqual([0, 0]);
      expect(encoded.crashResume.recovered.map(({ inspection }) => inspection.status)).toEqual([
        "succeeded",
        "succeeded",
      ]);
    }),
  );

  it("runs standalone and emits the same typed evidence JSON", async () => {
    const expected = await Effect.runPromise(runE5CapabilitySliceEncoded());
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", exampleEntry],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = new TextDecoder().decode(result.stderr).trim();
    expect(result.exitCode).toBe(0);
    expect(stderr).toBe("");

    const stdout = new TextDecoder().decode(result.stdout);
    const decoded = Schema.decodeUnknownSync(E5CapabilitySliceEvidenceSchema)(JSON.parse(stdout));
    const actual = Schema.encodeSync(E5CapabilitySliceEvidenceSchema)(decoded);

    expect(actual).toEqual(expected);
  });
});
