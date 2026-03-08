import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  LiveCanaryArtifactSchema,
  runLiveCanaryHarness,
} from "../../libs/foundation/core/src/live-canary-runtime.ts";
import { evaluatePromotionGatePolicy } from "../../libs/foundation/core/src/promotion-gate-policy-runtime.ts";
import { createDefaultLiveCanaryInput } from "../../scripts/benchmarks/e7-live-canary.ts";
import { makePerformanceArtifact, makeQualityArtifact } from "../helpers/e7-promotion-fixtures.ts";

describe("foundation-core live canary runtime", () => {
  it.effect(
    "records authorized canary results and can feed them into promotion-gate evaluation",
    () =>
      Effect.gen(function* () {
        const artifact = yield* runLiveCanaryHarness(createDefaultLiveCanaryInput());
        const baseline = yield* Effect.promise(() => makePerformanceArtifact());
        const performance = yield* Effect.promise(() =>
          makePerformanceArtifact({
            baselinePath: "/tmp/e7-performance-budget-baseline.json",
            baseline,
          }),
        );
        const evaluation = yield* evaluatePromotionGatePolicy({
          evaluationId: "promotion-e7-live-canary",
          generatedAt: "2026-03-08T21:15:00.000Z",
          quality: makeQualityArtifact(),
          performance,
          canary: artifact,
        });

        expect(Schema.is(LiveCanaryArtifactSchema)(artifact)).toBe(true);
        expect(artifact.status).toBe("pass");
        expect(artifact.summary.verdict).toBe("promote");
        expect(artifact.summary.passedScenarioCount).toBe(2);
        expect(artifact.summary.failedScenarioIds).toEqual([]);
        expect(artifact.results).toMatchObject([
          {
            scenarioId: "canary-product-browser",
            authorizationId: "auth-canary-product-browser",
            provider: "browser",
            action: "active",
            failedStages: [],
            status: "pass",
          },
          {
            scenarioId: "canary-product-http",
            authorizationId: "auth-canary-product-http",
            provider: "http",
            action: "active",
            failedStages: [],
            status: "pass",
          },
        ]);
        expect(
          artifact.results.map(({ plannerRationale }) => plannerRationale.map(({ key }) => key)),
        ).toEqual([
          ["mode", "rendering", "budget", "capture-path"],
          ["mode", "rendering", "budget", "capture-path"],
        ]);
        expect(evaluation.verdict).toBe("promote");
        expect(evaluation.canary).toMatchObject({
          suiteId: "suite-e7-live-canary",
          scenarioCount: 2,
          passedScenarioCount: 2,
          failedScenarioIds: [],
          verdict: "promote",
        });
        expect(evaluation.rationale.map(({ code }) => code)).toEqual([
          "quality-clean",
          "performance-clean",
          "canary-clean",
        ]);
      }),
  );

  it.effect("holds promotion decisions when a canary scenario degrades without quarantine", () =>
    Effect.gen(function* () {
      const input = createDefaultLiveCanaryInput();
      const artifact = yield* runLiveCanaryHarness({
        ...input,
        scenarios: input.scenarios.map((scenario) =>
          scenario.scenarioId === "canary-product-http"
            ? {
                ...scenario,
                validation: {
                  ...scenario.validation,
                  checks: {
                    ...scenario.validation.checks,
                    canary: false,
                  },
                  metrics: {
                    ...scenario.validation.metrics,
                    driftDelta: 0.12,
                    latencyDeltaMs: 320,
                  },
                },
              }
            : scenario,
        ),
      });

      expect(artifact.status).toBe("fail");
      expect(artifact.summary.verdict).toBe("hold");
      expect(artifact.summary.passedScenarioCount).toBe(1);
      expect(artifact.summary.failedScenarioIds).toEqual(["canary-product-http"]);
      expect(artifact.results).toMatchObject([
        {
          scenarioId: "canary-product-browser",
          action: "active",
          failedStages: [],
          status: "pass",
        },
        {
          scenarioId: "canary-product-http",
          action: "guarded",
          failedStages: ["canary"],
          status: "fail",
        },
      ]);
    }),
  );

  it.effect(
    "quarantines promotion decisions when a canary scenario hits a critical validation failure",
    () =>
      Effect.gen(function* () {
        const input = createDefaultLiveCanaryInput();
        const artifact = yield* runLiveCanaryHarness({
          ...input,
          scenarios: input.scenarios.map((scenario) =>
            scenario.scenarioId === "canary-product-http"
              ? {
                  ...scenario,
                  validation: {
                    ...scenario.validation,
                    checks: {
                      ...scenario.validation.checks,
                      workflowResume: false,
                    },
                  },
                }
              : scenario,
          ),
        });
        const baseline = yield* Effect.promise(() => makePerformanceArtifact());
        const performance = yield* Effect.promise(() =>
          makePerformanceArtifact({
            baselinePath: "/tmp/e7-performance-budget-baseline.json",
            baseline,
          }),
        );
        const evaluation = yield* evaluatePromotionGatePolicy({
          evaluationId: "promotion-e7-live-canary-quarantine",
          generatedAt: "2026-03-08T21:15:00.000Z",
          quality: makeQualityArtifact(),
          performance,
          canary: artifact,
        });

        expect(artifact.status).toBe("fail");
        expect(artifact.summary.verdict).toBe("quarantine");
        expect(artifact.summary.failedScenarioIds).toEqual(["canary-product-http"]);
        expect(artifact.results).toMatchObject([
          {
            scenarioId: "canary-product-browser",
            action: "active",
            failedStages: [],
            status: "pass",
          },
          {
            scenarioId: "canary-product-http",
            action: "quarantined",
            failedStages: ["replay"],
            status: "fail",
          },
        ]);
        expect(evaluation.verdict).toBe("quarantine");
        expect(evaluation.canary).toMatchObject({
          suiteId: "suite-e7-live-canary",
          scenarioCount: 2,
          passedScenarioCount: 1,
          failedScenarioIds: ["canary-product-http"],
          verdict: "quarantine",
        });
        expect(evaluation.rationale.map(({ code }) => code)).toEqual([
          "quality-clean",
          "performance-clean",
          "canary-quarantine",
        ]);
      }),
  );

  it.effect("rejects unauthorized seed URLs before executing canary scenarios", () =>
    Effect.gen(function* () {
      const input = createDefaultLiveCanaryInput();
      const error = yield* Effect.flip(
        runLiveCanaryHarness({
          ...input,
          scenarios: input.scenarios.map((scenario) =>
            scenario.scenarioId === "canary-product-http"
              ? {
                  ...scenario,
                  target: {
                    ...scenario.target,
                    seedUrls: ["http://catalog.example.com/products/widget-http#unsafe"],
                  },
                }
              : scenario,
          ),
        }),
      );

      expect(error.message).toContain("canonical absolute HTTP(S) URL");
    }),
  );
});
