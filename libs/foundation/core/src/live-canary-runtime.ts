import { Effect, Schema } from "effect";
import { AccessPolicySchema } from "./access-policy.ts";
import { PlannerRationaleEntrySchema, planAccessExecution } from "./access-planner-runtime.ts";
import { SnapshotDiffSchema } from "./diff-verdict.ts";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import { SitePackSchema } from "./site-pack.ts";
import { CoreErrorCodeSchema, ParserFailure } from "./tagged-errors.ts";
import { TargetProfileSchema } from "./target-profile.ts";
import { evaluateValidatorLadder } from "./validator-ladder-runtime.ts";

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
const CanaryStatusSchema = Schema.Literals(["pass", "fail"] as const);
const CanaryPromotionVerdictSchema = Schema.Literals(["promote", "hold", "quarantine"] as const);
const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

const FailureContextSchema = Schema.Struct({
  recentFailureCount: NonNegativeIntSchema.check(Schema.isLessThanOrEqualTo(32)),
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
  fieldRecallDelta: Schema.Number.check(Schema.isGreaterThanOrEqualTo(-1)).check(
    Schema.isLessThanOrEqualTo(1),
  ),
  falsePositiveDelta: Schema.Number.check(Schema.isGreaterThanOrEqualTo(-1)).check(
    Schema.isLessThanOrEqualTo(1),
  ),
  driftDelta: Schema.Number.check(Schema.isGreaterThanOrEqualTo(-1)).check(
    Schema.isLessThanOrEqualTo(1),
  ),
  latencyDeltaMs: Schema.Int,
  memoryDelta: Schema.Finite,
});

export class LiveCanaryValidation extends Schema.Class<LiveCanaryValidation>(
  "LiveCanaryValidation",
)({
  checks: ValidatorChecksSchema,
  metrics: ValidatorMetricsSchema,
}) {}

export class LiveCanaryScenario extends Schema.Class<LiveCanaryScenario>("LiveCanaryScenario")({
  scenarioId: CanonicalIdentifierSchema,
  authorizationId: CanonicalIdentifierSchema,
  target: TargetProfileSchema,
  pack: SitePackSchema,
  accessPolicy: AccessPolicySchema,
  createdAt: IsoDateTimeSchema,
  notes: Schema.optional(NonEmptyStringSchema),
  failureContext: Schema.optional(FailureContextSchema),
  validation: LiveCanaryValidation,
}) {}

const LiveCanaryScenariosSchema = Schema.Array(LiveCanaryScenario).pipe(
  Schema.refine(
    (scenarios): scenarios is ReadonlyArray<LiveCanaryScenario> =>
      scenarios.length > 0 &&
      new Set(scenarios.map(({ scenarioId }) => scenarioId)).size === scenarios.length &&
      new Set(scenarios.map(({ authorizationId }) => authorizationId)).size === scenarios.length,
    {
      message:
        "Expected controlled live canary scenarios with unique scenarioId and authorizationId values.",
    },
  ),
);

export class LiveCanaryInput extends Schema.Class<LiveCanaryInput>("LiveCanaryInput")({
  suiteId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  scenarios: LiveCanaryScenariosSchema,
}) {}

const PlannerRationaleEntriesSchema = Schema.Array(PlannerRationaleEntrySchema).pipe(
  Schema.refine(
    (entries): entries is ReadonlyArray<Schema.Schema.Type<typeof PlannerRationaleEntrySchema>> =>
      entries.length > 0 && new Set(entries.map(({ key }) => key)).size === entries.length,
    {
      message: "Expected deterministic planner rationale entries in each live canary result.",
    },
  ),
);

const FailedStagesSchema = Schema.Array(ValidatorStageNameSchema).pipe(
  Schema.refine(
    (stages): stages is ReadonlyArray<Schema.Schema.Type<typeof ValidatorStageNameSchema>> =>
      new Set(stages).size === stages.length,
    {
      message: "Expected failed validator stages without duplicates in the live canary result.",
    },
  ),
);

export class LiveCanaryScenarioResult extends Schema.Class<LiveCanaryScenarioResult>(
  "LiveCanaryScenarioResult",
)({
  scenarioId: CanonicalIdentifierSchema,
  authorizationId: CanonicalIdentifierSchema,
  provider: CaptureProviderSchema,
  action: QualityActionSchema,
  failedStages: FailedStagesSchema,
  status: CanaryStatusSchema,
  plannerRationale: PlannerRationaleEntriesSchema,
}) {}

const LiveCanaryResultsSchema = Schema.Array(LiveCanaryScenarioResult).pipe(
  Schema.refine(
    (results): results is ReadonlyArray<LiveCanaryScenarioResult> =>
      results.length > 0 &&
      new Set(results.map(({ scenarioId }) => scenarioId)).size === results.length,
    {
      message: "Expected one deterministic result per live canary scenario.",
    },
  ),
);

export class LiveCanarySummary extends Schema.Class<LiveCanarySummary>("LiveCanarySummary")({
  scenarioCount: NonNegativeIntSchema,
  passedScenarioCount: NonNegativeIntSchema,
  failedScenarioIds: Schema.Array(CanonicalIdentifierSchema),
  verdict: CanaryPromotionVerdictSchema,
}) {}

export class LiveCanaryArtifact extends Schema.Class<LiveCanaryArtifact>("LiveCanaryArtifact")({
  benchmark: Schema.Literal("e7-live-canary"),
  suiteId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  status: CanaryStatusSchema,
  summary: LiveCanarySummary,
  results: LiveCanaryResultsSchema,
}) {}

export const LiveCanaryValidationSchema = LiveCanaryValidation;
export const LiveCanaryScenarioSchema = LiveCanaryScenario;
export const LiveCanaryInputSchema = LiveCanaryInput;
export const LiveCanaryScenarioResultSchema = LiveCanaryScenarioResult;
export const LiveCanarySummarySchema = LiveCanarySummary;
export const LiveCanaryArtifactSchema = LiveCanaryArtifact;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function compareScenarios(left: LiveCanaryScenario, right: LiveCanaryScenario) {
  return left.scenarioId.localeCompare(right.scenarioId);
}

function makeSnapshotDiff(scenario: LiveCanaryScenario) {
  return Schema.decodeUnknownSync(SnapshotDiffSchema)({
    id: `diff-${scenario.scenarioId}`,
    baselineSnapshotId: `baseline-${scenario.scenarioId}`,
    candidateSnapshotId: `candidate-${scenario.scenarioId}`,
    metrics: scenario.validation.metrics,
    createdAt: scenario.createdAt,
  });
}

function validateSafeguards(scenarios: ReadonlyArray<LiveCanaryScenario>) {
  for (const scenario of scenarios) {
    if (scenario.target.accessPolicyId !== scenario.accessPolicy.id) {
      return Effect.fail(
        new ParserFailure({
          message:
            "Expected live canary scenarios with aligned target and access policy identifiers.",
        }),
      );
    }

    if (
      scenario.target.packId !== scenario.pack.id ||
      scenario.pack.accessPolicyId !== scenario.accessPolicy.id
    ) {
      return Effect.fail(
        new ParserFailure({
          message:
            "Expected live canary scenarios with aligned target, pack, and access policy identifiers.",
        }),
      );
    }

    for (const seedUrl of scenario.target.seedUrls) {
      const parsed = new URL(seedUrl);
      const hostMatches =
        parsed.hostname === scenario.target.domain ||
        parsed.hostname.endsWith(`.${scenario.target.domain}`);

      if (
        parsed.protocol !== "https:" ||
        !hostMatches ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.hash !== ""
      ) {
        return Effect.fail(
          new ParserFailure({
            message:
              "Expected live canary scenarios restricted to authorized https targets without credentials, fragments, or host escape.",
          }),
        );
      }
    }
  }

  return Effect.void;
}

function captureProviderFromScenario(scenario: LiveCanaryScenario) {
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
          message: `Expected a capture step for live canary scenario ${scenario.scenarioId}.`,
        }),
      );
    }

    return {
      provider: captureStep.requiresBrowser ? "browser" : "http",
      plannerRationale: decision.rationale,
    } as const;
  });
}

function runScenario(scenario: LiveCanaryScenario) {
  return Effect.gen(function* () {
    const provider = yield* captureProviderFromScenario(scenario);
    const validationVerdict = yield* evaluateValidatorLadder({
      pack: scenario.pack,
      snapshotDiff: makeSnapshotDiff(scenario),
      checks: scenario.validation.checks,
      createdAt: scenario.createdAt,
    });
    const failedStages = validationVerdict.stages
      .filter(({ status }) => status === "fail")
      .map(({ stage }) => stage);
    const action = validationVerdict.qualityVerdict.action;
    const status =
      failedStages.length === 0 && (action === "active" || action === "promote-shadow")
        ? "pass"
        : "fail";

    return Schema.decodeUnknownSync(LiveCanaryScenarioResultSchema)({
      scenarioId: scenario.scenarioId,
      authorizationId: scenario.authorizationId,
      provider: provider.provider,
      action,
      failedStages,
      status,
      plannerRationale: provider.plannerRationale,
    });
  });
}

function summarizeResults(results: ReadonlyArray<LiveCanaryScenarioResult>) {
  const failedScenarioIds = results
    .filter(({ status }) => status === "fail")
    .map(({ scenarioId }) => scenarioId);
  const verdict = results.some(({ action }) => action === "quarantined" || action === "retired")
    ? "quarantine"
    : failedScenarioIds.length > 0
      ? "hold"
      : "promote";

  return Schema.decodeUnknownSync(LiveCanarySummarySchema)({
    scenarioCount: results.length,
    passedScenarioCount: results.length - failedScenarioIds.length,
    failedScenarioIds,
    verdict,
  });
}

export function runLiveCanaryHarness(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(LiveCanaryInputSchema)(input),
      catch: (cause) =>
        new ParserFailure({
          message: readCauseMessage(
            cause,
            "Failed to decode E7 live canary input through shared contracts.",
          ),
        }),
    });
    const orderedScenarios = [...decoded.scenarios].sort(compareScenarios);
    yield* validateSafeguards(orderedScenarios);

    const results = new Array<Schema.Schema.Type<typeof LiveCanaryScenarioResultSchema>>();
    for (const scenario of orderedScenarios) {
      results.push(yield* runScenario(scenario));
    }

    const summary = summarizeResults(results);

    return Schema.decodeUnknownSync(LiveCanaryArtifactSchema)({
      benchmark: "e7-live-canary",
      suiteId: decoded.suiteId,
      generatedAt: decoded.generatedAt,
      status: summary.failedScenarioIds.length === 0 ? "pass" : "fail",
      summary,
      results,
    });
  });
}

export type LiveCanaryValidationEncoded = Schema.Codec.Encoded<typeof LiveCanaryValidationSchema>;
export type LiveCanaryScenarioEncoded = Schema.Codec.Encoded<typeof LiveCanaryScenarioSchema>;
export type LiveCanaryScenarioResultEncoded = Schema.Codec.Encoded<
  typeof LiveCanaryScenarioResultSchema
>;
export type LiveCanarySummaryEncoded = Schema.Codec.Encoded<typeof LiveCanarySummarySchema>;
export type LiveCanaryArtifactEncoded = Schema.Codec.Encoded<typeof LiveCanaryArtifactSchema>;
