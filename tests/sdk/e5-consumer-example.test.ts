import { join } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { RunCheckpointSchema, WorkflowInspectionSnapshotSchema } from "effect-scrapling/e5";
import { runE5SdkConsumerExample } from "../../examples/e5-sdk-consumer.ts";

const REPO_ROOT = import.meta.dir ? join(import.meta.dir, "..", "..") : process.cwd();
const EXAMPLE_PATH = join(REPO_ROOT, "examples", "e5-sdk-consumer.ts");

describe("E5 SDK consumer example", () => {
  it.effect("runs a durable workflow through the public E5 consumer contract", () =>
    Effect.gen(function* () {
      const result = yield* runE5SdkConsumerExample();
      const started = Schema.decodeUnknownSync(RunCheckpointSchema)(result.payload.started);
      const resumed = Schema.decodeUnknownSync(RunCheckpointSchema)(result.payload.resumed);
      const finished = Schema.decodeUnknownSync(RunCheckpointSchema)(result.payload.finished);
      const inspection = Schema.decodeUnknownSync(WorkflowInspectionSnapshotSchema)(
        result.payload.inspection,
      );

      expect(result.importPath).toBe("effect-scrapling/e5");
      expect(
        result.prerequisites.some((entry: string) => entry.includes("effect-scrapling/e5")),
      ).toBe(true);
      expect(
        result.pitfalls.some((entry: string) => entry.includes("foundation-core private files")),
      ).toBe(true);

      expect(result.payload.plan.runId).toBe("plan-target-product-0001-pack-example-com");
      expect(result.payload.plan.targetId).toBe("target-product-0001");
      expect(result.payload.plan.checkpointInterval).toBe(2);
      expect(result.payload.plan.stages).toEqual([
        "capture",
        "extract",
        "snapshot",
        "diff",
        "quality",
        "reflect",
      ]);
      expect(result.payload.plan.rationaleKeys).toEqual([
        "mode",
        "rendering",
        "budget",
        "capture-path",
        "workflow-graph",
      ]);

      expect(started.sequence).toBe(1);
      expect(started.stage).toBe("snapshot");
      expect(started.stats.outcome).toBe("running");
      expect(started.completedStepIds).toEqual(["step-capture", "step-extract"]);

      expect(resumed.sequence).toBe(2);
      expect(resumed.stage).toBe("quality");
      expect(resumed.stats.outcome).toBe("running");
      expect(resumed.completedStepIds).toEqual([
        "step-capture",
        "step-extract",
        "step-snapshot",
        "step-diff",
      ]);

      expect(finished.sequence).toBe(3);
      expect(finished.stage).toBe("reflect");
      expect(finished.stats.outcome).toBe("succeeded");
      expect(finished.pendingStepIds).toEqual([]);

      expect(inspection.status).toBe("succeeded");
      expect(inspection.stage).toBe("reflect");
      expect(inspection.progress.checkpointCount).toBe(3);
      expect(inspection.progress.pendingSteps).toBe(0);
      expect(inspection.progress.completionRatio).toBe(1);

      expect(result.payload.expectedError.caughtTag).toBe("PolicyViolation");
      expect(result.payload.expectedError.message).toContain("Synthetic extractor failure");
      expect(result.payload.expectedError.persistedStatus).toBe("failed");
      expect(result.payload.expectedError.persistedStage).toBe("extract");
      expect(result.payload.expectedError.checkpointCount).toBe(1);
    }),
  );

  it("keeps the example on the public E5 import path", async () => {
    const source = await Bun.file(EXAMPLE_PATH).text();
    const importSpecifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].flatMap((match) => {
      const specifier = match[1];
      return specifier === undefined ? [] : [specifier];
    });

    expect(source).toContain('"effect-scrapling/e5"');
    expect(importSpecifiers).toEqual(["effect", "effect-scrapling/e5"]);
    expect(source.includes("../libs/foundation/core")).toBeFalse();
    expect(source.includes("../src/")).toBeFalse();
  });
});
