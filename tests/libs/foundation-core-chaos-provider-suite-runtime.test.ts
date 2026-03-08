import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  ChaosProviderSuiteArtifactSchema,
  runChaosProviderSuite,
} from "../../libs/foundation/core/src/chaos-provider-suite-runtime.ts";
import { AccessPolicySchema } from "../../libs/foundation/core/src/access-policy.ts";
import { SitePackSchema } from "../../libs/foundation/core/src/site-pack.ts";
import { TargetProfileSchema } from "../../libs/foundation/core/src/target-profile.ts";

function makeTarget(input: { readonly id: string; readonly kind: "productPage" | "searchResult" }) {
  return Schema.decodeUnknownSync(TargetProfileSchema)({
    id: input.id,
    tenantId: "tenant-main",
    domain: "example.com",
    kind: input.kind,
    canonicalKey: `catalog/${input.id}`,
    seedUrls: [`https://example.com/${input.id}`],
    accessPolicyId: "policy-hybrid-main",
    packId: "pack-example-com",
    priority: 10,
  });
}

function makePack() {
  return Schema.decodeUnknownSync(SitePackSchema)({
    id: "pack-example-com",
    tenantId: "tenant-main",
    domainPattern: "*.example.com",
    state: "active",
    accessPolicyId: "policy-hybrid-main",
    version: "2026.03.08",
  });
}

function makeAccessPolicy() {
  return Schema.decodeUnknownSync(AccessPolicySchema)({
    id: "policy-hybrid-main",
    mode: "hybrid",
    perDomainConcurrency: 8,
    globalConcurrency: 64,
    timeoutMs: 30_000,
    maxRetries: 2,
    render: "onDemand",
  });
}

function makeSuiteInput() {
  const pack = makePack();
  const accessPolicy = makeAccessPolicy();

  return {
    suiteId: "suite-e7-chaos-provider",
    generatedAt: "2026-03-08T18:00:00.000Z",
    scenarios: [
      {
        scenarioId: "scenario-provider-outage",
        target: makeTarget({
          id: "target-provider-outage",
          kind: "productPage",
        }),
        pack,
        accessPolicy,
        createdAt: "2026-03-08T18:00:00.000Z",
        failureContext: {
          recentFailureCount: 2,
          lastFailureCode: "provider_unavailable",
        },
        validation: {
          checks: {
            replayDeterminism: true,
            workflowResume: true,
            canary: true,
            chaos: false,
            securityRedaction: true,
            soakStability: false,
          },
          metrics: {
            fieldRecallDelta: 0.01,
            falsePositiveDelta: 0.01,
            driftDelta: 0.03,
            latencyDeltaMs: 30,
            memoryDelta: 4,
          },
        },
        expected: {
          provider: "browser",
          action: "quarantined",
          failedStages: ["chaos"],
        },
      },
      {
        scenarioId: "scenario-throttling-window",
        target: makeTarget({
          id: "target-throttling-window",
          kind: "searchResult",
        }),
        pack,
        accessPolicy,
        createdAt: "2026-03-08T18:00:00.000Z",
        failureContext: {
          recentFailureCount: 2,
        },
        validation: {
          checks: {
            replayDeterminism: true,
            workflowResume: true,
            canary: false,
            chaos: true,
            securityRedaction: true,
            soakStability: true,
          },
          metrics: {
            fieldRecallDelta: 0.01,
            falsePositiveDelta: 0.01,
            driftDelta: 0.14,
            latencyDeltaMs: 360,
            memoryDelta: 5,
          },
        },
        expected: {
          provider: "browser",
          action: "guarded",
          failedStages: ["canary"],
        },
      },
    ],
  };
}

describe("foundation-core chaos provider suite runtime", () => {
  it.effect(
    "passes when the suite matches planner fallback and validator resilience outcomes",
    () =>
      Effect.gen(function* () {
        const suite = makeSuiteInput();
        const artifact = yield* runChaosProviderSuite({
          ...suite,
          scenarios: [...suite.scenarios].reverse(),
        });

        expect(Schema.is(ChaosProviderSuiteArtifactSchema)(artifact)).toBe(true);
        expect(artifact.status).toBe("pass");
        expect(artifact.failedScenarioIds).toEqual([]);
        expect(artifact.results.map(({ scenarioId }) => scenarioId)).toEqual([
          "scenario-provider-outage",
          "scenario-throttling-window",
        ]);
        expect(artifact.results.map(({ actualProvider }) => actualProvider)).toEqual([
          "browser",
          "browser",
        ]);
        expect(artifact.results.map(({ actualAction }) => actualAction)).toEqual([
          "quarantined",
          "guarded",
        ]);
        expect(artifact.results.map(({ actualFailedStages }) => actualFailedStages)).toEqual([
          ["chaos"],
          ["canary"],
        ]);
        expect(artifact.results[0]?.plannerRationale.map(({ key }) => key)).toEqual([
          "mode",
          "rendering",
          "budget",
          "capture-path",
        ]);
      }),
  );

  it.effect(
    "fails deterministically when expected fallback evidence does not match the actual runtime result",
    () =>
      Effect.gen(function* () {
        const artifact = yield* runChaosProviderSuite({
          ...makeSuiteInput(),
          scenarios: makeSuiteInput().scenarios.map((scenario) =>
            scenario.scenarioId === "scenario-provider-outage"
              ? {
                  ...scenario,
                  expected: {
                    provider: "http",
                    action: "quarantined",
                    failedStages: ["chaos"],
                  },
                }
              : scenario,
          ),
        });

        expect(artifact.status).toBe("fail");
        expect(artifact.failedScenarioIds).toEqual(["scenario-provider-outage"]);
        expect(artifact.results[0]?.actualProvider).toBe("browser");
        expect(artifact.results[0]?.actualFailedStages).toEqual(["chaos"]);
      }),
  );

  it.effect("rejects malformed suite input through shared schema contracts", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        runChaosProviderSuite({
          ...makeSuiteInput(),
          scenarios: [
            {
              ...makeSuiteInput().scenarios[0],
              failureContext: {
                recentFailureCount: -1,
                lastFailureCode: "timeout",
              },
            },
          ],
        }),
      );

      expect(error.message).toContain("greater than or equal");
    }),
  );
});
