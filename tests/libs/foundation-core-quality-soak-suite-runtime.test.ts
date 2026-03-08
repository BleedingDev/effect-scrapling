import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  evaluateQualitySoakSuite,
  QualitySoakArtifactSchema,
} from "../../libs/foundation/core/src/quality-soak-suite-runtime.ts";

function makeSample(input: {
  readonly iteration: number;
  readonly baselineCorpusMs: number;
  readonly incumbentComparisonMs: number;
  readonly heapDeltaKiB: number;
}) {
  return {
    iteration: input.iteration,
    baselineCorpusMs: input.baselineCorpusMs,
    incumbentComparisonMs: input.incumbentComparisonMs,
    heapDeltaKiB: input.heapDeltaKiB,
    baselineFingerprint: "baseline-stable",
    comparisonFingerprint: "comparison-stable",
  };
}

describe("foundation-core quality soak suite runtime", () => {
  it.effect("passes when repeated runs stay fingerprint-stable and bounded", () =>
    Effect.gen(function* () {
      const artifact = yield* evaluateQualitySoakSuite({
        suiteId: "suite-e7-soak-endurance",
        generatedAt: "2026-03-08T19:45:00.000Z",
        samples: [
          makeSample({
            iteration: 1,
            baselineCorpusMs: 12,
            incumbentComparisonMs: 20,
            heapDeltaKiB: 100,
          }),
          makeSample({
            iteration: 2,
            baselineCorpusMs: 18,
            incumbentComparisonMs: 30,
            heapDeltaKiB: 120,
          }),
          makeSample({
            iteration: 3,
            baselineCorpusMs: 16,
            incumbentComparisonMs: 28,
            heapDeltaKiB: 115,
          }),
        ],
      });

      expect(Schema.is(QualitySoakArtifactSchema)(artifact)).toBe(true);
      expect(artifact.status).toBe("pass");
      expect(artifact.violations).toEqual([]);
      expect(artifact.stability.unboundedGrowthDetected).toBe(false);
      expect(artifact.stability.maxConsecutiveHeapGrowth).toBe(1);
    }),
  );

  it.effect("fails when fingerprints drift or growth exceeds the configured thresholds", () =>
    Effect.gen(function* () {
      const artifact = yield* evaluateQualitySoakSuite({
        suiteId: "suite-e7-soak-endurance",
        generatedAt: "2026-03-08T19:45:00.000Z",
        policy: {
          maxBaselineCorpusGrowthMs: 50,
          maxIncumbentComparisonGrowthMs: 75,
          maxHeapGrowthKiB: 512,
          maxConsecutiveHeapGrowth: 1,
        },
        samples: [
          makeSample({
            iteration: 1,
            baselineCorpusMs: 20,
            incumbentComparisonMs: 35,
            heapDeltaKiB: 100,
          }),
          {
            ...makeSample({
              iteration: 2,
              baselineCorpusMs: 90,
              incumbentComparisonMs: 150,
              heapDeltaKiB: 400,
            }),
            comparisonFingerprint: "comparison-drifted",
          },
          makeSample({
            iteration: 3,
            baselineCorpusMs: 95,
            incumbentComparisonMs: 160,
            heapDeltaKiB: 700,
          }),
        ],
      });

      expect(artifact.status).toBe("fail");
      expect(
        artifact.violations.some((message) => message.includes("comparison fingerprint")),
      ).toBe(true);
      expect(artifact.violations.some((message) => message.includes("heap growth"))).toBe(true);
      expect(artifact.stability.unboundedGrowthDetected).toBe(true);
    }),
  );

  it.effect(
    "rejects malformed suites with non-contiguous iterations through shared contracts",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          evaluateQualitySoakSuite({
            suiteId: "suite-e7-soak-endurance",
            generatedAt: "2026-03-08T19:45:00.000Z",
            samples: [
              makeSample({
                iteration: 1,
                baselineCorpusMs: 12,
                incumbentComparisonMs: 20,
                heapDeltaKiB: 100,
              }),
              makeSample({
                iteration: 3,
                baselineCorpusMs: 18,
                incumbentComparisonMs: 30,
                heapDeltaKiB: 120,
              }),
            ],
          }),
        );

        expect(error.message).toContain("contiguous iteration");
      }),
  );
});
