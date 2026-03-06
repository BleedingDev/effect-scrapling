import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  E2CapabilitySliceEvidenceSchema,
  runE2CapabilitySlice,
  runE2CapabilitySliceEncoded,
} from "../../examples/e2-capability-slice.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const exampleEntry = fileURLToPath(
  new URL("../../examples/e2-capability-slice.ts", import.meta.url),
);

describe("examples/e2-capability-slice", () => {
  it.effect("executes the deterministic E2 capability slice in-process with typed evidence", () =>
    Effect.gen(function* () {
      const evidence = yield* runE2CapabilitySlice();
      const encoded = Schema.encodeSync(E2CapabilitySliceEvidenceSchema)(evidence);
      const priceObservation =
        encoded.candidateOrchestration.snapshotAssembly.snapshot.observations.find(
          ({ field }) => field === "price",
        );
      const priceDiff = encoded.snapshotDiff.changes?.find(({ field }) => field === "price");

      expect(encoded.fixtureId).toBe("golden-product-relocated");
      expect(encoded.baselineReplay.documentArtifactId).toBe("golden-plan-001-html");
      expect(
        encoded.baselineReplay.selectorResolutions.map(({ selectorPath }) => selectorPath),
      ).toEqual(["title/primary", "price/fallback", "availability/primary"]);

      expect(encoded.candidateCaptureBundle.artifacts.map(({ kind }) => kind)).toEqual([
        "requestMetadata",
        "responseMetadata",
        "html",
        "timings",
      ]);
      expect(
        encoded.candidateOrchestration.selectorResolutions.map(({ selectorPath }) => selectorPath),
      ).toEqual(["title/primary", "price/primary", "availability/primary"]);
      expect(encoded.candidateOrchestration.assertionReport.evaluatedRuleCount).toBe(5);
      expect(encoded.candidateOrchestration.evidenceManifest.observations).toHaveLength(3);

      expect(priceObservation).toEqual({
        field: "price",
        normalizedValue: {
          amount: 21.49,
          currency: "USD",
        },
        confidence: 0.96,
        evidenceRefs: ["golden-plan-001-candidate-html"],
      });
      expect(priceDiff).toEqual({
        changeType: "change",
        field: "price",
        baseline: {
          field: "price",
          normalizedValue: {
            amount: 19.99,
            currency: "USD",
          },
          confidence: 0.8,
          evidenceRefs: ["golden-plan-001-html"],
        },
        candidate: {
          field: "price",
          normalizedValue: {
            amount: 21.49,
            currency: "USD",
          },
          confidence: 0.96,
          evidenceRefs: ["golden-plan-001-candidate-html"],
        },
        confidenceDelta: 0.16,
      });
      expect(encoded.snapshotDiff.canonicalMetrics).toEqual({
        baselineFieldCount: 3,
        candidateFieldCount: 3,
        unchangedFieldCount: 2,
        addedFieldCount: 0,
        removedFieldCount: 0,
        changedFieldCount: 1,
        baselineConfidenceScore: 0.906667,
        candidateConfidenceScore: 0.96,
        confidenceDelta: 0.053333,
      });
      expect(encoded.snapshotDiff.metrics.fieldRecallDelta).toBeLessThan(0);
      expect(encoded.snapshotDiff.metrics.falsePositiveDelta).toBe(0);
      expect(encoded.snapshotDiff.metrics.driftDelta).toBeLessThan(0);
      expect(encoded.snapshotDiff.metrics.latencyDeltaMs).toBe(-4);
      expect(encoded.snapshotDiff.metrics.memoryDelta).toBe(-128);
    }),
  );

  it("runs standalone and emits the same typed evidence JSON", async () => {
    const expected = await Effect.runPromise(runE2CapabilitySliceEncoded());
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
    const decoded = Schema.decodeUnknownSync(E2CapabilitySliceEvidenceSchema)(JSON.parse(stdout));
    const actual = Schema.encodeSync(E2CapabilitySliceEvidenceSchema)(decoded);

    expect(actual).toEqual(expected);
  });
});
