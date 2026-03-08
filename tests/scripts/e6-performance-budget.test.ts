import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  BenchmarkArtifactSchema,
  DEFAULT_SAMPLE_SIZE,
  DEFAULT_WARMUP_ITERATIONS,
  EXPECTED_CAPABILITY_OBSERVATION,
  EXPECTED_PROMOTION_GOVERNANCE_OBSERVATION,
  EXPECTED_REFLECTION_RECOMMENDATION_OBSERVATION,
  EXPECTED_REGISTRY_RESOLUTION_OBSERVATION,
  PERFORMANCE_BUDGETS,
  buildArtifact,
  buildBenchmarkSuite,
  buildStability,
  parseOptions,
  roundToThree,
  runBenchmark,
  runCapabilitySliceObservation,
  runPromotionGovernanceProfile,
  runReflectionRecommendationProfile,
  runRegistryResolutionProfile,
  summarizeMeasurements,
} from "../../scripts/benchmarks/e6-performance-budget.ts";

describe("e6 performance budget benchmark harness", () => {
  it("parses explicit benchmark options through schema-backed integer decoding", () => {
    expect(
      parseOptions([
        "--artifact",
        "tmp/e6-scorecard.json",
        "--baseline",
        "tmp/e6-baseline.json",
        "--sample-size",
        "5",
        "--warmup",
        "0",
      ]),
    ).toEqual({
      artifactPath: expect.stringContaining("tmp/e6-scorecard.json"),
      baselinePath: expect.stringContaining("tmp/e6-baseline.json"),
      sampleSize: 5,
      warmupIterations: 0,
    });

    expect(parseOptions([])).toEqual({
      sampleSize: DEFAULT_SAMPLE_SIZE,
      warmupIterations: DEFAULT_WARMUP_ITERATIONS,
    });
  });

  it.effect(
    "runs the real E6 registry, reflection, and governance flows with deterministic outputs",
    () =>
      Effect.gen(function* () {
        const suite = buildBenchmarkSuite();
        const capability = yield* runCapabilitySliceObservation();
        const registry = yield* runRegistryResolutionProfile(suite);
        const reflection = yield* runReflectionRecommendationProfile(suite);
        const promotion = yield* runPromotionGovernanceProfile(suite);

        expect(capability).toEqual(EXPECTED_CAPABILITY_OBSERVATION);
        expect(registry).toEqual({
          resolvedPackFingerprint: "pack-shop-example-com-shadow:shadow@2026.03.08",
        });
        expect(reflection.clusterFingerprint).toBe(
          "price:selectorRegressionPattern:24>title:fixtureConsensusPattern:24",
        );
        expect(reflection.proposalFingerprint).toBe(
          EXPECTED_CAPABILITY_OBSERVATION.proposalFingerprint,
        );
        expect(promotion).toEqual({
          qualityAction: "active",
          decisionAction: "active",
          governanceAuditFingerprint: "demote-previous-active>activate-version",
          activeVersion: "2026.03.09",
        });
      }),
  );

  it("writes a comparable scorecard artifact when the benchmark harness runs end-to-end", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e6-performance-budget-"));
    const baselinePath = join(directory, "baseline.json");
    const artifactPath = join(directory, "artifact.json");

    try {
      await runBenchmark(["--artifact", baselinePath, "--sample-size", "2", "--warmup", "0"]);

      const artifact = await runBenchmark([
        "--artifact",
        artifactPath,
        "--baseline",
        baselinePath,
        "--sample-size",
        "2",
        "--warmup",
        "0",
      ]);
      const persisted = Schema.decodeUnknownSync(BenchmarkArtifactSchema)(
        JSON.parse(await readFile(artifactPath, "utf8")),
      );

      expect(persisted).toEqual(artifact);
      expect(persisted.comparison.baselinePath).toBe(resolve(baselinePath));
      expect(persisted.comparison.comparable).toBe(true);
      expect(persisted.comparison.incompatibleReason).toBeNull();
      expect(persisted.measurements.capabilitySlice.p95Ms).toBeGreaterThan(0);
      expect(persisted.measurements.registryResolution.p95Ms).toBeGreaterThan(0);
      expect(persisted.measurements.reflectionRecommendation.p95Ms).toBeGreaterThan(0);
      expect(persisted.measurements.promotionGovernance.p95Ms).toBeGreaterThan(0);
      expect(persisted.stability.resolvedPackFingerprint.consistent).toBe(true);
      expect(persisted.stability.registryResolvedPackFingerprint.consistent).toBe(true);
      expect(persisted.stability.reflectionProposalFingerprint.consistent).toBe(true);
      expect(persisted.stability.promotionGovernanceAuditFingerprint.consistent).toBe(true);
      expect(persisted.stability.activeVersion.consistent).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("computes pass/fail scorecards from deterministic summaries and stability evidence", () => {
    const suite = buildBenchmarkSuite();
    const options = {
      baselinePath: resolve("./docs/artifacts/e6-performance-budget-baseline.json"),
      sampleSize: 3,
      warmupIterations: 0,
    };
    const stable = buildStability({
      capabilitySlice: [
        EXPECTED_CAPABILITY_OBSERVATION,
        EXPECTED_CAPABILITY_OBSERVATION,
        EXPECTED_CAPABILITY_OBSERVATION,
      ],
      registryResolution: [
        EXPECTED_REGISTRY_RESOLUTION_OBSERVATION,
        EXPECTED_REGISTRY_RESOLUTION_OBSERVATION,
        EXPECTED_REGISTRY_RESOLUTION_OBSERVATION,
      ],
      reflectionRecommendation: [
        EXPECTED_REFLECTION_RECOMMENDATION_OBSERVATION,
        EXPECTED_REFLECTION_RECOMMENDATION_OBSERVATION,
        EXPECTED_REFLECTION_RECOMMENDATION_OBSERVATION,
      ],
      promotionGovernance: [
        EXPECTED_PROMOTION_GOVERNANCE_OBSERVATION,
        EXPECTED_PROMOTION_GOVERNANCE_OBSERVATION,
        EXPECTED_PROMOTION_GOVERNANCE_OBSERVATION,
      ],
    });
    const baseline = buildArtifact(
      options,
      suite.profile,
      {
        capabilitySlice: summarizeMeasurements([4, 5, 6]),
        registryResolution: summarizeMeasurements([8, 9, 10]),
        reflectionRecommendation: summarizeMeasurements([9, 10, 11]),
        promotionGovernance: summarizeMeasurements([10, 11, 12]),
        heapDeltaKiB: 512,
      },
      stable,
      undefined,
    );

    expect(baseline.status).toBe("pass");
    expect(baseline.comparison.deltas).toEqual({
      capabilitySliceP95Ms: null,
      registryResolutionP95Ms: null,
      reflectionRecommendationP95Ms: null,
      promotionGovernanceP95Ms: null,
      heapDeltaKiB: null,
    });
    expect(baseline.comparison.comparable).toBe(false);
    expect(baseline.comparison.incompatibleReason).toBeNull();

    const unstable = buildStability({
      capabilitySlice: [
        EXPECTED_CAPABILITY_OBSERVATION,
        EXPECTED_CAPABILITY_OBSERVATION,
        {
          ...EXPECTED_CAPABILITY_OBSERVATION,
          activeVersion: "2026.03.10",
        },
      ],
      registryResolution: [
        EXPECTED_REGISTRY_RESOLUTION_OBSERVATION,
        EXPECTED_REGISTRY_RESOLUTION_OBSERVATION,
        EXPECTED_REGISTRY_RESOLUTION_OBSERVATION,
      ],
      reflectionRecommendation: [
        EXPECTED_REFLECTION_RECOMMENDATION_OBSERVATION,
        EXPECTED_REFLECTION_RECOMMENDATION_OBSERVATION,
        {
          ...EXPECTED_REFLECTION_RECOMMENDATION_OBSERVATION,
          proposalFingerprint: "price:promoteSelectorCandidate:price/secondary",
        },
      ],
      promotionGovernance: [
        EXPECTED_PROMOTION_GOVERNANCE_OBSERVATION,
        EXPECTED_PROMOTION_GOVERNANCE_OBSERVATION,
        EXPECTED_PROMOTION_GOVERNANCE_OBSERVATION,
      ],
    });
    const candidate = buildArtifact(
      options,
      suite.profile,
      {
        capabilitySlice: summarizeMeasurements([
          1,
          1,
          PERFORMANCE_BUDGETS.capabilitySliceP95Ms + 1,
          PERFORMANCE_BUDGETS.capabilitySliceP95Ms + 1,
        ]),
        registryResolution: summarizeMeasurements([
          1,
          1,
          PERFORMANCE_BUDGETS.registryResolutionP95Ms + 1,
          PERFORMANCE_BUDGETS.registryResolutionP95Ms + 1,
        ]),
        reflectionRecommendation: summarizeMeasurements([
          1,
          1,
          PERFORMANCE_BUDGETS.reflectionRecommendationP95Ms + 1,
          PERFORMANCE_BUDGETS.reflectionRecommendationP95Ms + 1,
        ]),
        promotionGovernance: summarizeMeasurements([
          1,
          1,
          PERFORMANCE_BUDGETS.promotionGovernanceP95Ms + 1,
          PERFORMANCE_BUDGETS.promotionGovernanceP95Ms + 1,
        ]),
        heapDeltaKiB: PERFORMANCE_BUDGETS.heapDeltaKiB + 1,
      },
      unstable,
      baseline,
    );

    expect(candidate.status).toBe("fail");
    expect(candidate.violations.some((message) => message.includes("capability-slice p95"))).toBe(
      true,
    );
    expect(
      candidate.violations.some((message) => message.includes("registry-resolution p95")),
    ).toBe(true);
    expect(
      candidate.violations.some((message) => message.includes("reflection-recommendation p95")),
    ).toBe(true);
    expect(
      candidate.violations.some((message) => message.includes("promotion-governance p95")),
    ).toBe(true);
    expect(candidate.violations.some((message) => message.includes("heap delta"))).toBe(true);
    expect(candidate.violations.some((message) => message.includes("activeVersion"))).toBe(true);
    expect(
      candidate.violations.some((message) => message.includes("reflectionProposalFingerprint")),
    ).toBe(true);
    expect(candidate.comparison.comparable).toBe(true);
    expect(candidate.comparison.incompatibleReason).toBeNull();
    expect(candidate.comparison.deltas).toEqual({
      capabilitySliceP95Ms: roundToThree(
        candidate.measurements.capabilitySlice.p95Ms - baseline.measurements.capabilitySlice.p95Ms,
      ),
      registryResolutionP95Ms: roundToThree(
        candidate.measurements.registryResolution.p95Ms -
          baseline.measurements.registryResolution.p95Ms,
      ),
      reflectionRecommendationP95Ms: roundToThree(
        candidate.measurements.reflectionRecommendation.p95Ms -
          baseline.measurements.reflectionRecommendation.p95Ms,
      ),
      promotionGovernanceP95Ms: roundToThree(
        candidate.measurements.promotionGovernance.p95Ms -
          baseline.measurements.promotionGovernance.p95Ms,
      ),
      heapDeltaKiB: roundToThree(
        candidate.measurements.heapDeltaKiB - baseline.measurements.heapDeltaKiB,
      ),
    });
  });

  it("suppresses baseline deltas when the baseline profile is not comparable", () => {
    const suite = buildBenchmarkSuite();
    const baseline = buildArtifact(
      {
        baselinePath: resolve("./docs/artifacts/e6-performance-budget-baseline.json"),
        sampleSize: DEFAULT_SAMPLE_SIZE,
        warmupIterations: DEFAULT_WARMUP_ITERATIONS,
      },
      suite.profile,
      {
        capabilitySlice: summarizeMeasurements([4, 5, 6]),
        registryResolution: summarizeMeasurements([8, 9, 10]),
        reflectionRecommendation: summarizeMeasurements([9, 10, 11]),
        promotionGovernance: summarizeMeasurements([10, 11, 12]),
        heapDeltaKiB: 512,
      },
      buildStability({
        capabilitySlice: [EXPECTED_CAPABILITY_OBSERVATION],
        registryResolution: [EXPECTED_REGISTRY_RESOLUTION_OBSERVATION],
        reflectionRecommendation: [EXPECTED_REFLECTION_RECOMMENDATION_OBSERVATION],
        promotionGovernance: [EXPECTED_PROMOTION_GOVERNANCE_OBSERVATION],
      }),
      undefined,
    );

    const candidate = buildArtifact(
      {
        baselinePath: resolve("./docs/artifacts/e6-performance-budget-baseline.json"),
        sampleSize: 3,
        warmupIterations: 1,
      },
      suite.profile,
      {
        capabilitySlice: summarizeMeasurements([4, 5, 6]),
        registryResolution: summarizeMeasurements([8, 9, 10]),
        reflectionRecommendation: summarizeMeasurements([9, 10, 11]),
        promotionGovernance: summarizeMeasurements([10, 11, 12]),
        heapDeltaKiB: 512,
      },
      buildStability({
        capabilitySlice: [EXPECTED_CAPABILITY_OBSERVATION],
        registryResolution: [EXPECTED_REGISTRY_RESOLUTION_OBSERVATION],
        reflectionRecommendation: [EXPECTED_REFLECTION_RECOMMENDATION_OBSERVATION],
        promotionGovernance: [EXPECTED_PROMOTION_GOVERNANCE_OBSERVATION],
      }),
      baseline,
    );

    expect(candidate.comparison.comparable).toBe(false);
    expect(candidate.comparison.incompatibleReason).toBe(
      "Expected baseline sampleSize 3, received 12.",
    );
    expect(candidate.comparison.deltas).toEqual({
      capabilitySliceP95Ms: null,
      registryResolutionP95Ms: null,
      reflectionRecommendationP95Ms: null,
      promotionGovernanceP95Ms: null,
      heapDeltaKiB: null,
    });
  });
});
