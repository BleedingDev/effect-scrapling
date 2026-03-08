import { Effect, Schema } from "effect";
import { AccessPolicySchema } from "./access-policy.ts";
import { PlannerRationaleEntrySchema, planAccessExecution } from "./access-planner-runtime.ts";
import { SnapshotDiffSchema } from "./diff-verdict.ts";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import { SitePackSchema } from "./site-pack.ts";
import { CoreErrorCodeSchema, ParserFailure } from "./tagged-errors.ts";
import { TargetProfileSchema } from "./target-profile.ts";
import { evaluateValidatorLadder } from "./validator-ladder-runtime.ts";

const RateDeltaSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(-1)).check(
  Schema.isLessThanOrEqualTo(1),
);
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const CaptureProviderSchema = Schema.Literals(["http", "browser"] as const);
const QualityActionSchema = Schema.Literals([
  "promote-shadow",
  "active",
  "guarded",
  "quarantined",
  "retired",
] as const);
const ValidatorStageNameSchema = Schema.Literals(["schema", "replay", "canary", "chaos"] as const);
const ChaosSuiteStatusSchema = Schema.Literals(["pass", "fail"] as const);

const FailureCountSchema = NonNegativeIntSchema.check(Schema.isLessThanOrEqualTo(32));

const FailureContextSchema = Schema.Struct({
  recentFailureCount: FailureCountSchema,
  lastFailureCode: Schema.optional(CoreErrorCodeSchema),
});

const ValidatorChecksSchema = Schema.Struct({
  replayDeterminism: Schema.Boolean,
  workflowResume: Schema.Boolean,
  canary: Schema.Boolean,
  chaos: Schema.Boolean,
  securityRedaction: Schema.Boolean,
  soakStability: Schema.Boolean,
});

const ValidatorMetricsSchema = Schema.Struct({
  fieldRecallDelta: RateDeltaSchema,
  falsePositiveDelta: RateDeltaSchema,
  driftDelta: RateDeltaSchema,
  latencyDeltaMs: Schema.Int,
  memoryDelta: Schema.Finite,
});

export class ChaosScenarioValidation extends Schema.Class<ChaosScenarioValidation>(
  "ChaosScenarioValidation",
)({
  checks: ValidatorChecksSchema,
  metrics: ValidatorMetricsSchema,
}) {}

export class ChaosScenarioExpectation extends Schema.Class<ChaosScenarioExpectation>(
  "ChaosScenarioExpectation",
)({
  provider: CaptureProviderSchema,
  action: QualityActionSchema,
  failedStages: Schema.Array(ValidatorStageNameSchema),
}) {}

export class ChaosProviderScenario extends Schema.Class<ChaosProviderScenario>(
  "ChaosProviderScenario",
)({
  scenarioId: CanonicalIdentifierSchema,
  target: TargetProfileSchema,
  pack: SitePackSchema,
  accessPolicy: AccessPolicySchema,
  createdAt: IsoDateTimeSchema,
  failureContext: Schema.optional(FailureContextSchema),
  validation: ChaosScenarioValidation,
  expected: ChaosScenarioExpectation,
}) {}

const ChaosProviderScenariosSchema = Schema.Array(ChaosProviderScenario).pipe(
  Schema.refine(
    (scenarios): scenarios is ReadonlyArray<ChaosProviderScenario> =>
      scenarios.length > 0 &&
      new Set(scenarios.map(({ scenarioId }) => scenarioId)).size === scenarios.length,
    {
      message: "Expected at least one unique chaos provider scenario.",
    },
  ),
);

export class ChaosProviderSuiteInput extends Schema.Class<ChaosProviderSuiteInput>(
  "ChaosProviderSuiteInput",
)({
  suiteId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  scenarios: ChaosProviderScenariosSchema,
}) {}

const PlannerRationaleEntriesSchema = Schema.Array(PlannerRationaleEntrySchema).pipe(
  Schema.refine(
    (entries): entries is ReadonlyArray<Schema.Schema.Type<typeof PlannerRationaleEntrySchema>> =>
      entries.length > 0 && new Set(entries.map(({ key }) => key)).size === entries.length,
    {
      message: "Expected deterministic planner rationale entries in each chaos scenario result.",
    },
  ),
);

const FailedStagesSchema = Schema.Array(ValidatorStageNameSchema).pipe(
  Schema.refine(
    (stages): stages is ReadonlyArray<Schema.Schema.Type<typeof ValidatorStageNameSchema>> =>
      new Set(stages).size === stages.length,
    {
      message: "Expected failed validator stages without duplicates.",
    },
  ),
);

export class ChaosProviderScenarioResult extends Schema.Class<ChaosProviderScenarioResult>(
  "ChaosProviderScenarioResult",
)({
  scenarioId: CanonicalIdentifierSchema,
  expectedProvider: CaptureProviderSchema,
  actualProvider: CaptureProviderSchema,
  expectedAction: QualityActionSchema,
  actualAction: QualityActionSchema,
  expectedFailedStages: FailedStagesSchema,
  actualFailedStages: FailedStagesSchema,
  status: ChaosSuiteStatusSchema,
  plannerRationale: PlannerRationaleEntriesSchema,
}) {}

const ChaosProviderScenarioResultsSchema = Schema.Array(ChaosProviderScenarioResult).pipe(
  Schema.refine(
    (results): results is ReadonlyArray<ChaosProviderScenarioResult> =>
      results.length > 0 &&
      new Set(results.map(({ scenarioId }) => scenarioId)).size === results.length,
    {
      message: "Expected one deterministic result per chaos provider scenario.",
    },
  ),
);

export class ChaosProviderSuiteArtifact extends Schema.Class<ChaosProviderSuiteArtifact>(
  "ChaosProviderSuiteArtifact",
)({
  benchmark: Schema.Literal("e7-chaos-provider-suite"),
  suiteId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  scenarioCount: NonNegativeIntSchema,
  failedScenarioIds: Schema.Array(CanonicalIdentifierSchema),
  results: ChaosProviderScenarioResultsSchema,
  status: ChaosSuiteStatusSchema,
}) {}

export const ChaosScenarioValidationSchema = ChaosScenarioValidation;
export const ChaosScenarioExpectationSchema = ChaosScenarioExpectation;
export const ChaosProviderScenarioSchema = ChaosProviderScenario;
export const ChaosProviderSuiteInputSchema = ChaosProviderSuiteInput;
export const ChaosProviderScenarioResultSchema = ChaosProviderScenarioResult;
export const ChaosProviderSuiteArtifactSchema = ChaosProviderSuiteArtifact;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function compareScenarios(left: ChaosProviderScenario, right: ChaosProviderScenario) {
  return left.scenarioId.localeCompare(right.scenarioId);
}

function makeSnapshotDiff(scenario: ChaosProviderScenario, generatedAt: string) {
  return Schema.decodeUnknownSync(SnapshotDiffSchema)({
    id: `diff-${scenario.scenarioId}`,
    baselineSnapshotId: `baseline-${scenario.scenarioId}`,
    candidateSnapshotId: `candidate-${scenario.scenarioId}`,
    metrics: scenario.validation.metrics,
    createdAt: generatedAt,
  });
}

function captureProviderFromScenario(scenario: ChaosProviderScenario) {
  return Effect.gen(function* () {
    const decision = yield* planAccessExecution({
      target: scenario.target,
      pack: scenario.pack,
      accessPolicy: scenario.accessPolicy,
      createdAt: scenario.createdAt,
      ...(scenario.failureContext === undefined ? {} : { failureContext: scenario.failureContext }),
    });
    const captureStep = decision.plan.steps.find(({ stage }) => stage === "capture");
    if (captureStep === undefined) {
      return yield* Effect.fail(
        new ParserFailure({
          message: `Expected a capture step for chaos provider scenario ${scenario.scenarioId}.`,
        }),
      );
    }

    return {
      provider: captureStep.requiresBrowser ? "browser" : "http",
      plannerRationale: decision.rationale,
    } as const;
  });
}

function runScenario(scenario: ChaosProviderScenario) {
  return Effect.gen(function* () {
    const provider = yield* captureProviderFromScenario(scenario);
    const validationVerdict = yield* evaluateValidatorLadder({
      pack: scenario.pack,
      snapshotDiff: makeSnapshotDiff(scenario, scenario.createdAt),
      checks: scenario.validation.checks,
      createdAt: scenario.createdAt,
    });
    const actualFailedStages = validationVerdict.stages
      .filter(({ status }) => status === "fail")
      .map(({ stage }) => stage);
    const actualAction = validationVerdict.qualityVerdict.action;
    const status =
      provider.provider === scenario.expected.provider &&
      actualAction === scenario.expected.action &&
      JSON.stringify(actualFailedStages) === JSON.stringify(scenario.expected.failedStages)
        ? "pass"
        : "fail";

    return Schema.decodeUnknownSync(ChaosProviderScenarioResultSchema)({
      scenarioId: scenario.scenarioId,
      expectedProvider: scenario.expected.provider,
      actualProvider: provider.provider,
      expectedAction: scenario.expected.action,
      actualAction,
      expectedFailedStages: scenario.expected.failedStages,
      actualFailedStages,
      status,
      plannerRationale: provider.plannerRationale,
    });
  });
}

export function runChaosProviderSuite(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(ChaosProviderSuiteInputSchema)(input),
      catch: (cause) =>
        new ParserFailure({
          message: readCauseMessage(
            cause,
            "Failed to decode E7 chaos provider suite input through shared contracts.",
          ),
        }),
    });
    const orderedScenarios = [...decoded.scenarios].sort(compareScenarios);
    const results = new Array<Schema.Schema.Type<typeof ChaosProviderScenarioResultSchema>>();

    for (const scenario of orderedScenarios) {
      results.push(yield* runScenario(scenario));
    }

    const failedScenarioIds = results
      .filter(({ status }) => status === "fail")
      .map(({ scenarioId }) => scenarioId);

    return Schema.decodeUnknownSync(ChaosProviderSuiteArtifactSchema)({
      benchmark: "e7-chaos-provider-suite",
      suiteId: decoded.suiteId,
      generatedAt: decoded.generatedAt,
      scenarioCount: results.length,
      failedScenarioIds,
      results,
      status: failedScenarioIds.length === 0 ? "pass" : "fail",
    });
  });
}

export type ChaosProviderSuiteInputEncoded = Schema.Codec.Encoded<
  typeof ChaosProviderSuiteInputSchema
>;
export type ChaosProviderScenarioResultEncoded = Schema.Codec.Encoded<
  typeof ChaosProviderScenarioResultSchema
>;
export type ChaosProviderSuiteArtifactEncoded = Schema.Codec.Encoded<
  typeof ChaosProviderSuiteArtifactSchema
>;
