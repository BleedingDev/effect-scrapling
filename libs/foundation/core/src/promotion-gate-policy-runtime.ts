import { Effect, Schema } from "effect";
import {
  DriftRegressionArtifactSchema,
  RegressionSeverityLevelSchema,
} from "./drift-regression-runtime.ts";
import { PerformanceBudgetArtifactSchema } from "./performance-gate-runtime.ts";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import { ParserFailure } from "./tagged-errors.ts";

const NonNegativeFiniteSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const PromotionGateVerdictSchema = Schema.Literals(["promote", "hold", "quarantine"] as const);
const PromotionGateRationaleScopeSchema = Schema.Literals(["quality", "performance"] as const);
const PromotionGateRationaleCodeSchema = Schema.Literals([
  "quality-clean",
  "quality-hold",
  "quality-quarantine",
  "performance-clean",
  "performance-hold",
  "performance-quarantine",
] as const);
const PromotionGateSeverityThresholdSchema = Schema.Literals([
  "low",
  "moderate",
  "high",
  "critical",
] as const);
const PerformanceBudgetStatusSchema = Schema.Literals(["pass", "fail"] as const);

const IdentifierListSchema = Schema.Array(CanonicalIdentifierSchema).pipe(
  Schema.refine((ids): ids is ReadonlyArray<string> => new Set(ids).size === ids.length, {
    message: "Expected unique pack identifiers in promotion gate output.",
  }),
);

const DefaultPromotionGatePolicy = Object.freeze({
  minimumHoldSeverity: "low",
  minimumQuarantineSeverity: "high",
  requireComparablePerformanceBaseline: true,
  maximumPromoteBaselineCorpusP95DeltaMs: 25,
  maximumPromoteIncumbentComparisonP95DeltaMs: 50,
  maximumPromoteHeapDeltaKiB: 1024,
  minimumQuarantineBaselineCorpusP95DeltaMs: 100,
  minimumQuarantineIncumbentComparisonP95DeltaMs: 200,
  minimumQuarantineHeapDeltaKiB: 4096,
});

const PromotionGatePolicyBaseSchema = Schema.Struct({
  minimumHoldSeverity: PromotionGateSeverityThresholdSchema,
  minimumQuarantineSeverity: PromotionGateSeverityThresholdSchema,
  requireComparablePerformanceBaseline: Schema.Boolean,
  maximumPromoteBaselineCorpusP95DeltaMs: NonNegativeFiniteSchema,
  maximumPromoteIncumbentComparisonP95DeltaMs: NonNegativeFiniteSchema,
  maximumPromoteHeapDeltaKiB: NonNegativeFiniteSchema,
  minimumQuarantineBaselineCorpusP95DeltaMs: NonNegativeFiniteSchema,
  minimumQuarantineIncumbentComparisonP95DeltaMs: NonNegativeFiniteSchema,
  minimumQuarantineHeapDeltaKiB: NonNegativeFiniteSchema,
});

export const PromotionGatePolicySchema = PromotionGatePolicyBaseSchema.pipe(
  Schema.refine(
    (policy): policy is Schema.Schema.Type<typeof PromotionGatePolicyBaseSchema> =>
      regressionSeverityRank(policy.minimumHoldSeverity) <=
        regressionSeverityRank(policy.minimumQuarantineSeverity) &&
      policy.maximumPromoteBaselineCorpusP95DeltaMs <=
        policy.minimumQuarantineBaselineCorpusP95DeltaMs &&
      policy.maximumPromoteIncumbentComparisonP95DeltaMs <=
        policy.minimumQuarantineIncumbentComparisonP95DeltaMs &&
      policy.maximumPromoteHeapDeltaKiB <= policy.minimumQuarantineHeapDeltaKiB,
    {
      message:
        "Expected promotion gate policy severity and performance thresholds ordered from hold to quarantine.",
    },
  ),
);

export class PromotionGateRationale extends Schema.Class<PromotionGateRationale>(
  "PromotionGateRationale",
)({
  scope: PromotionGateRationaleScopeSchema,
  code: PromotionGateRationaleCodeSchema,
  message: NonEmptyStringSchema,
}) {}

const PromotionGateRationalesSchema = Schema.Array(PromotionGateRationale).pipe(
  Schema.refine(
    (rationales): rationales is ReadonlyArray<PromotionGateRationale> =>
      rationales.length > 0 &&
      new Set(rationales.map(({ scope, code, message }) => `${scope}:${code}:${message}`)).size ===
        rationales.length,
    {
      message: "Expected deterministic promotion gate rationales without duplicate entries.",
    },
  ),
);

const PerformanceDeltaSummarySchema = Schema.Struct({
  baselineCorpusP95Ms: Schema.NullOr(Schema.Finite),
  incumbentComparisonP95Ms: Schema.NullOr(Schema.Finite),
  heapDeltaKiB: Schema.NullOr(Schema.Finite),
});

export class PromotionGateQualitySummary extends Schema.Class<PromotionGateQualitySummary>(
  "PromotionGateQualitySummary",
)({
  analysisId: CanonicalIdentifierSchema,
  packCount: NonNegativeIntSchema,
  regressedPackCount: NonNegativeIntSchema,
  findingCount: NonNegativeIntSchema,
  highestSeverity: RegressionSeverityLevelSchema,
  verdict: PromotionGateVerdictSchema,
  holdPackIds: IdentifierListSchema,
  quarantinePackIds: IdentifierListSchema,
}) {}

export class PromotionGatePerformanceSummary extends Schema.Class<PromotionGatePerformanceSummary>(
  "PromotionGatePerformanceSummary",
)({
  benchmarkId: CanonicalIdentifierSchema,
  budgetStatus: PerformanceBudgetStatusSchema,
  comparable: Schema.Boolean,
  incompatibleReason: Schema.NullOr(NonEmptyStringSchema),
  verdict: PromotionGateVerdictSchema,
  deltas: PerformanceDeltaSummarySchema,
  budgetViolations: Schema.Array(Schema.String),
  holdDeltaMetrics: Schema.Array(Schema.String),
  quarantineDeltaMetrics: Schema.Array(Schema.String),
}) {}

export class PromotionGateEvaluation extends Schema.Class<PromotionGateEvaluation>(
  "PromotionGateEvaluation",
)({
  benchmark: Schema.Literal("e7-promotion-gate-policy"),
  evaluationId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  verdict: PromotionGateVerdictSchema,
  policy: PromotionGatePolicySchema,
  quality: PromotionGateQualitySummary,
  performance: PromotionGatePerformanceSummary,
  rationale: PromotionGateRationalesSchema,
}) {}

const PromotionGateInputSchema = Schema.Struct({
  evaluationId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  quality: DriftRegressionArtifactSchema,
  performance: PerformanceBudgetArtifactSchema,
  policy: Schema.optional(PromotionGatePolicySchema),
});

type DriftRegressionArtifact = Schema.Schema.Type<typeof DriftRegressionArtifactSchema>;
type PerformanceBudgetArtifact = Schema.Schema.Type<typeof PerformanceBudgetArtifactSchema>;
type PromotionGatePolicyType = Schema.Schema.Type<typeof PromotionGatePolicySchema>;
type PromotionGateRationaleCode = Schema.Schema.Type<typeof PromotionGateRationaleCodeSchema>;
type PromotionGateRationaleScope = Schema.Schema.Type<typeof PromotionGateRationaleScopeSchema>;
type PromotionGateSeverityThreshold = Schema.Schema.Type<
  typeof PromotionGateSeverityThresholdSchema
>;
type PromotionGateVerdictType = Schema.Schema.Type<typeof PromotionGateVerdictSchema>;
type RegressionSeverity = Schema.Schema.Type<typeof RegressionSeverityLevelSchema>;

type PromotionGateEvaluationSection<
  TSummary extends PromotionGateQualitySummary | PromotionGatePerformanceSummary,
> = {
  readonly summary: TSummary;
  readonly rationales: ReadonlyArray<PromotionGateRationale>;
};

type PerformanceDeltaMetric = {
  readonly label: string;
  readonly delta: number | null;
  readonly holdThreshold: number;
  readonly quarantineThreshold: number;
};

export const PromotionGateRationaleSchema = PromotionGateRationale;
export const PromotionGateQualitySummarySchema = PromotionGateQualitySummary;
export const PromotionGatePerformanceSummarySchema = PromotionGatePerformanceSummary;
export const PromotionGateEvaluationSchema = PromotionGateEvaluation;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function regressionSeverityRank(severity: RegressionSeverity | PromotionGateSeverityThreshold) {
  switch (severity) {
    case "none":
      return 0;
    case "low":
      return 1;
    case "moderate":
      return 2;
    case "high":
      return 3;
    case "critical":
      return 4;
  }
}

function compareVerdicts(left: PromotionGateVerdict, right: PromotionGateVerdict) {
  const verdictRank = (verdict: PromotionGateVerdictType) => {
    switch (verdict) {
      case "promote":
        return 0;
      case "hold":
        return 1;
      case "quarantine":
        return 2;
    }
  };

  return verdictRank(left) - verdictRank(right);
}

function buildRationale(
  scope: PromotionGateRationaleScope,
  code: PromotionGateRationaleCode,
  message: string,
) {
  return Schema.decodeUnknownSync(PromotionGateRationaleSchema)({
    scope,
    code,
    message,
  });
}

function resolvePolicy(policy: PromotionGatePolicyType | undefined) {
  return policy ?? Schema.decodeUnknownSync(PromotionGatePolicySchema)(DefaultPromotionGatePolicy);
}

function comparePackSummaries(
  left: DriftRegressionArtifact["packSummaries"][number],
  right: DriftRegressionArtifact["packSummaries"][number],
) {
  return left.packId.localeCompare(right.packId);
}

function highestSeverity(artifact: DriftRegressionArtifact): RegressionSeverity {
  return artifact.packSummaries.reduce<RegressionSeverity>(
    (current, summary) =>
      regressionSeverityRank(summary.severity) > regressionSeverityRank(current)
        ? summary.severity
        : current,
    "none",
  );
}

function hasSeverityAtLeast(
  severity: RegressionSeverity,
  threshold: PromotionGateSeverityThreshold,
) {
  return regressionSeverityRank(severity) >= regressionSeverityRank(threshold);
}

function buildQualityEvaluation(
  quality: DriftRegressionArtifact,
  policy: PromotionGatePolicyType,
): PromotionGateEvaluationSection<PromotionGateQualitySummary> {
  const orderedSummaries = [...quality.packSummaries].sort(comparePackSummaries);
  const quarantinePackIds = orderedSummaries
    .filter(({ severity }) => hasSeverityAtLeast(severity, policy.minimumQuarantineSeverity))
    .map(({ packId }) => packId);
  const holdPackIds = orderedSummaries
    .filter(
      ({ severity }) =>
        hasSeverityAtLeast(severity, policy.minimumHoldSeverity) &&
        !hasSeverityAtLeast(severity, policy.minimumQuarantineSeverity),
    )
    .map(({ packId }) => packId);
  const regressedPackCount = orderedSummaries.filter(({ severity }) => severity !== "none").length;
  const verdict: PromotionGateVerdictType =
    quarantinePackIds.length > 0 ? "quarantine" : holdPackIds.length > 0 ? "hold" : "promote";
  const summary = Schema.decodeUnknownSync(PromotionGateQualitySummarySchema)({
    analysisId: quality.analysisId,
    packCount: orderedSummaries.length,
    regressedPackCount,
    findingCount: quality.findings.length,
    highestSeverity: highestSeverity(quality),
    verdict,
    holdPackIds,
    quarantinePackIds,
  });

  const rationales =
    verdict === "quarantine"
      ? [
          buildRationale(
            "quality",
            "quality-quarantine",
            `Quarantine because drift regression severities for pack(s) ${quarantinePackIds.join(
              ", ",
            )} reached ${policy.minimumQuarantineSeverity} or worse.`,
          ),
        ]
      : verdict === "hold"
        ? [
            buildRationale(
              "quality",
              "quality-hold",
              `Hold because drift regression severities for pack(s) ${holdPackIds.join(
                ", ",
              )} reached ${policy.minimumHoldSeverity} or worse without crossing the quarantine threshold.`,
            ),
          ]
        : [
            buildRationale(
              "quality",
              "quality-clean",
              "Quality regression analysis stayed below the configured hold severity threshold for every pack.",
            ),
          ];

  return {
    summary,
    rationales,
  };
}

function positiveDelta(value: number | null) {
  return value === null ? null : Math.max(0, value);
}

function joinLabels(labels: ReadonlyArray<string>) {
  return labels.join(", ");
}

function buildPerformanceMetrics(
  artifact: PerformanceBudgetArtifact,
  policy: PromotionGatePolicyType,
) {
  return [
    {
      label: "baseline-corpus p95",
      delta: positiveDelta(artifact.comparison.deltas.baselineCorpusP95Ms),
      holdThreshold: policy.maximumPromoteBaselineCorpusP95DeltaMs,
      quarantineThreshold: policy.minimumQuarantineBaselineCorpusP95DeltaMs,
    },
    {
      label: "incumbent-comparison p95",
      delta: positiveDelta(artifact.comparison.deltas.incumbentComparisonP95Ms),
      holdThreshold: policy.maximumPromoteIncumbentComparisonP95DeltaMs,
      quarantineThreshold: policy.minimumQuarantineIncumbentComparisonP95DeltaMs,
    },
    {
      label: "heap delta",
      delta: positiveDelta(artifact.comparison.deltas.heapDeltaKiB),
      holdThreshold: policy.maximumPromoteHeapDeltaKiB,
      quarantineThreshold: policy.minimumQuarantineHeapDeltaKiB,
    },
  ] satisfies ReadonlyArray<PerformanceDeltaMetric>;
}

function buildPerformanceEvaluation(
  performance: PerformanceBudgetArtifact,
  policy: PromotionGatePolicyType,
): PromotionGateEvaluationSection<PromotionGatePerformanceSummary> {
  const metrics = buildPerformanceMetrics(performance, policy);
  const quarantineDeltaMetrics = metrics
    .filter(({ delta, quarantineThreshold }) => delta !== null && delta >= quarantineThreshold)
    .map(({ label }) => label);
  const holdDeltaMetrics = metrics
    .filter(
      ({ delta, holdThreshold, quarantineThreshold }) =>
        delta !== null && delta > holdThreshold && delta < quarantineThreshold,
    )
    .map(({ label }) => label);

  const comparable = performance.comparison.comparable;
  const incompatibleReason = performance.comparison.incompatibleReason;
  const verdict: PromotionGateVerdictType =
    performance.status === "fail" || quarantineDeltaMetrics.length > 0
      ? "quarantine"
      : policy.requireComparablePerformanceBaseline && !comparable
        ? "hold"
        : holdDeltaMetrics.length > 0
          ? "hold"
          : "promote";

  const summary = Schema.decodeUnknownSync(PromotionGatePerformanceSummarySchema)({
    benchmarkId: performance.benchmarkId,
    budgetStatus: performance.status,
    comparable,
    incompatibleReason,
    verdict,
    deltas: performance.comparison.deltas,
    budgetViolations: performance.violations,
    holdDeltaMetrics,
    quarantineDeltaMetrics,
  });

  const rationales = new Array<PromotionGateRationale>();

  if (performance.status === "fail") {
    const violationSummary =
      performance.violations.length === 0
        ? "The benchmark artifact reported fail status without explicit violations."
        : performance.violations.join(" ");
    rationales.push(
      buildRationale(
        "performance",
        "performance-quarantine",
        `Quarantine because the performance budget failed. ${violationSummary}`.trim(),
      ),
    );
  }

  if (quarantineDeltaMetrics.length > 0) {
    rationales.push(
      buildRationale(
        "performance",
        "performance-quarantine",
        `Quarantine because ${joinLabels(
          quarantineDeltaMetrics,
        )} exceeded the configured quarantine delta threshold.`,
      ),
    );
  }

  if (policy.requireComparablePerformanceBaseline && !comparable) {
    rationales.push(
      buildRationale(
        "performance",
        "performance-hold",
        `Hold because the performance baseline is not comparable. ${
          incompatibleReason ?? "The benchmark did not report a compatible baseline."
        }`,
      ),
    );
  }

  if (holdDeltaMetrics.length > 0) {
    rationales.push(
      buildRationale(
        "performance",
        "performance-hold",
        `Hold because ${joinLabels(
          holdDeltaMetrics,
        )} exceeded the configured promote delta threshold.`,
      ),
    );
  }

  if (rationales.length === 0) {
    rationales.push(
      buildRationale(
        "performance",
        "performance-clean",
        "Performance budgets passed and comparable deltas stayed within the configured promote thresholds.",
      ),
    );
  }

  return {
    summary,
    rationales,
  };
}

function validateEvidenceCompatibility(input: {
  readonly quality: DriftRegressionArtifact;
  readonly performance: PerformanceBudgetArtifact;
}) {
  if (input.quality.packCount !== input.quality.packSummaries.length) {
    return Effect.fail(
      new ParserFailure({
        message:
          "Expected promotion gate quality analysis to keep packCount aligned with pack summaries.",
      }),
    );
  }

  if (input.quality.caseCount !== input.performance.profile.caseCount) {
    return Effect.fail(
      new ParserFailure({
        message:
          "Expected promotion gate quality analysis and performance profile to reference the same case count.",
      }),
    );
  }

  if (input.quality.packCount !== input.performance.profile.packCount) {
    return Effect.fail(
      new ParserFailure({
        message:
          "Expected promotion gate quality analysis and performance profile to reference the same pack count.",
      }),
    );
  }

  return Effect.void;
}

export function evaluatePromotionGatePolicy(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(PromotionGateInputSchema)(input),
      catch: (cause) =>
        new ParserFailure({
          message: readCauseMessage(
            cause,
            "Failed to decode promotion gate policy input through shared contracts.",
          ),
        }),
    });
    yield* validateEvidenceCompatibility(decoded);
    const policy = resolvePolicy(decoded.policy);
    const quality = buildQualityEvaluation(decoded.quality, policy);
    const performance = buildPerformanceEvaluation(decoded.performance, policy);
    const verdict =
      compareVerdicts(quality.summary.verdict, performance.summary.verdict) >= 0
        ? quality.summary.verdict
        : performance.summary.verdict;

    return Schema.decodeUnknownSync(PromotionGateEvaluationSchema)({
      benchmark: "e7-promotion-gate-policy",
      evaluationId: decoded.evaluationId,
      generatedAt: decoded.generatedAt,
      verdict,
      policy,
      quality: quality.summary,
      performance: performance.summary,
      rationale: [...quality.rationales, ...performance.rationales],
    });
  });
}

export type PromotionGateVerdict = Schema.Schema.Type<typeof PromotionGateVerdictSchema>;
export type PromotionGatePolicy = Schema.Schema.Type<typeof PromotionGatePolicySchema>;
export type PromotionGateRationaleEncoded = Schema.Codec.Encoded<
  typeof PromotionGateRationaleSchema
>;
export type PromotionGateQualitySummaryEncoded = Schema.Codec.Encoded<
  typeof PromotionGateQualitySummarySchema
>;
export type PromotionGatePerformanceSummaryEncoded = Schema.Codec.Encoded<
  typeof PromotionGatePerformanceSummarySchema
>;
export type PromotionGateEvaluationEncoded = Schema.Codec.Encoded<
  typeof PromotionGateEvaluationSchema
>;
