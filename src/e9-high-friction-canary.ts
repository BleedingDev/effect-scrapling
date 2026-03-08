import { Effect, Schema } from "effect";
import {
  AccessPolicySchema,
  CanonicalIdentifierSchema,
  IsoDateTimeSchema,
  LiveCanaryArtifactSchema,
  LiveCanaryInputSchema,
  runLiveCanaryHarness,
} from "@effect-scrapling/foundation-core";
import { createDefaultE9RetailerCorpus } from "./e9-fixture-corpus.ts";

const UnitIntervalSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);

const E9CanaryScenarioSchema = Schema.Struct({
  caseId: CanonicalIdentifierSchema,
  retailer: Schema.Literals(["alza", "datart", "tsbohemia"] as const),
  provider: Schema.Literals(["http", "browser"] as const),
  action: Schema.Literals([
    "promote-shadow",
    "active",
    "guarded",
    "quarantined",
    "retired",
  ] as const),
  status: Schema.Literals(["pass", "fail"] as const),
  requiresBypass: Schema.Boolean,
  bypassQualified: Schema.Boolean,
  policyCompliant: Schema.Boolean,
});
const E9CanaryResultsSchema = Schema.Array(E9CanaryScenarioSchema);

export const E9HighFrictionCanaryArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e9-high-friction-canary"),
  suiteId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  status: Schema.Literals(["pass", "fail"] as const),
  summary: Schema.Struct({
    scenarioCount: Schema.Int.check(Schema.isGreaterThan(0)),
    browserEscalationRate: UnitIntervalSchema,
    bypassSuccessRate: UnitIntervalSchema,
    policyViolationCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    promotionVerdict: Schema.Literals(["promote", "hold", "quarantine"] as const),
  }),
  results: Schema.Array(E9CanaryScenarioSchema),
  liveCanary: LiveCanaryArtifactSchema,
});

const GENERATED_AT = "2026-03-08T22:25:00.000Z";

function makeAccessPolicy() {
  return Schema.decodeUnknownSync(AccessPolicySchema)({
    id: "policy-e9-high-friction",
    mode: "hybrid",
    perDomainConcurrency: 2,
    globalConcurrency: 8,
    timeoutMs: 20_000,
    maxRetries: 1,
    render: "onDemand",
  });
}

export async function runE9HighFrictionCanary(
  overrides: {
    readonly generatedAt?: string;
    readonly mutateInput?: (
      input: Schema.Schema.Type<typeof LiveCanaryInputSchema>,
    ) => Schema.Schema.Type<typeof LiveCanaryInputSchema>;
  } = {},
) {
  const generatedAt = overrides.generatedAt ?? GENERATED_AT;
  const corpus = await createDefaultE9RetailerCorpus();
  const accessPolicy = makeAccessPolicy();
  const baseInput = Schema.decodeUnknownSync(LiveCanaryInputSchema)({
    suiteId: "suite-e9-high-friction-canary",
    generatedAt,
    scenarios: corpus.map((caseInput) => {
      const host = new URL(caseInput.entryUrl).hostname;
      return {
        scenarioId: `scenario-${caseInput.caseId}`,
        authorizationId: `auth-${caseInput.caseId}`,
        target: {
          id: `target-${caseInput.caseId}`,
          tenantId: "tenant-reference-packs",
          domain: host,
          kind: "productPage",
          canonicalKey: `reference/${caseInput.caseId}`,
          seedUrls: [caseInput.entryUrl],
          accessPolicyId: accessPolicy.id,
          packId: caseInput.referencePack.definition.pack.id,
          priority: 100,
        },
        pack: {
          ...caseInput.referencePack.definition.pack,
          accessPolicyId: accessPolicy.id,
          state: "active",
          version: "2026.03.08",
        },
        accessPolicy,
        createdAt: generatedAt,
        notes: `Authorized high-friction canary for ${caseInput.retailer}.`,
        failureContext: {
          recentFailureCount: 2,
          lastFailureCode: "provider_unavailable",
        },
        validation: {
          checks: {
            replayDeterminism: true,
            workflowResume: true,
            canary: true,
            chaos: true,
            securityRedaction: true,
            soakStability: true,
          },
          metrics: {
            fieldRecallDelta: 0,
            falsePositiveDelta: 0,
            driftDelta: 0.01,
            latencyDeltaMs: 20,
            memoryDelta: 4,
          },
        },
      };
    }),
  });
  const input = overrides.mutateInput === undefined ? baseInput : overrides.mutateInput(baseInput);
  const liveCanary = await Effect.runPromise(runLiveCanaryHarness(input));
  const results = Schema.decodeUnknownSync(E9CanaryResultsSchema)(
    liveCanary.results.map((result) => {
      const caseId = result.scenarioId.replace(/^scenario-/u, "");
      const corpusCase = corpus.find((candidate) => candidate.caseId === caseId);
      if (corpusCase === undefined) {
        throw new Error(`Missing corpus case for canary scenario ${result.scenarioId}.`);
      }

      return {
        caseId,
        retailer: corpusCase.retailer,
        provider: result.provider,
        action: result.action,
        status: result.status,
        requiresBypass: corpusCase.requiresBypass,
        bypassQualified: corpusCase.requiresBypass ? result.provider === "browser" : true,
        policyCompliant: result.plannerRationale.length > 0,
      };
    }),
  );
  const scenarioCount = results.length;
  const browserEscalationRate =
    results.filter(({ provider }) => provider === "browser").length / scenarioCount;
  const bypassSuccessRate =
    results.filter(
      ({ requiresBypass, bypassQualified, status }) =>
        !requiresBypass || (bypassQualified && status === "pass"),
    ).length / scenarioCount;
  const policyViolationCount = results.filter(({ policyCompliant }) => !policyCompliant).length;
  const status =
    liveCanary.status === "pass" &&
    policyViolationCount === 0 &&
    browserEscalationRate === 1 &&
    bypassSuccessRate === 1
      ? "pass"
      : "fail";

  return Schema.decodeUnknownSync(E9HighFrictionCanaryArtifactSchema)({
    benchmark: "e9-high-friction-canary",
    suiteId: "suite-e9-high-friction-canary",
    generatedAt,
    status,
    summary: {
      scenarioCount,
      browserEscalationRate,
      bypassSuccessRate,
      policyViolationCount,
      promotionVerdict: liveCanary.summary.verdict,
    },
    results,
    liveCanary,
  });
}
