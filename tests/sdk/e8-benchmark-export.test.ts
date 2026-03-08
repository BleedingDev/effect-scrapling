import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  E8ArtifactExportEnvelopeSchema,
  E8BenchmarkRunEnvelopeSchema,
  runArtifactExportOperation,
  runBenchmarkOperation,
} from "effect-scrapling/e8";

describe("E8 benchmark and artifact export surface", () => {
  it.effect("runs deterministic benchmark metadata through the public E8 SDK", () =>
    Effect.gen(function* () {
      const result = yield* runBenchmarkOperation();
      const decoded = Schema.decodeUnknownSync(E8BenchmarkRunEnvelopeSchema)(result);

      expect(decoded.command).toBe("benchmark run");
      expect(decoded.data.bundleId).toBe("bundle-e8-benchmark-surface");
      expect(decoded.data.artifactCount).toBe(9);
      expect(decoded.data.manifest.map(({ key }) => key)).toEqual([
        "baselineCorpus",
        "incumbentComparison",
        "performanceBudget",
        "qualityMetrics",
        "liveCanary",
        "chaosProviderSuite",
        "promotionGate",
        "qualityReport",
        "soakEndurance",
      ]);
      expect(
        decoded.data.manifest.every(({ artifactPath }) =>
          artifactPath.startsWith("docs/artifacts/"),
        ),
      ).toBe(true);
    }),
  );

  it.effect("sanitizes absolute benchmark paths before exporting the E8 artifact bundle", () =>
    Effect.gen(function* () {
      const firstExport = yield* runArtifactExportOperation();
      const firstArtifact = Schema.decodeUnknownSync(E8ArtifactExportEnvelopeSchema)(firstExport)
        .data.artifact;
      const absolutePathArtifact = yield* runArtifactExportOperation({
        exportId: "export-e8-absolute-path-test",
        generatedAt: "2026-03-09T12:30:00.000Z",
        bundle: {
          ...firstArtifact.bundle,
          performanceBudget: {
            ...firstArtifact.bundle.performanceBudget,
            comparison: {
              ...firstArtifact.bundle.performanceBudget.comparison,
              baselinePath:
                "/Users/satan/side/experiments/effect-scrapling/docs/artifacts/e7-performance-budget-baseline.json",
            },
          },
        },
      });
      const secondArtifact = Schema.decodeUnknownSync(E8ArtifactExportEnvelopeSchema)(
        absolutePathArtifact,
      ).data.artifact;

      expect(secondArtifact.benchmark).toBe("e8-artifact-export");
      expect(secondArtifact.metadata.bundleId).toBe("bundle-e8-benchmark-surface");
      expect(secondArtifact.metadata.sanitizedPathCount).toBe(1);
      expect(secondArtifact.metadata.sanitizedPaths).toEqual([
        "docs/artifacts/e7-performance-budget-baseline.json",
      ]);
      expect(secondArtifact.bundle.performanceBudget.comparison.baselinePath).toBe(
        "docs/artifacts/e7-performance-budget-baseline.json",
      );
    }),
  );
});
