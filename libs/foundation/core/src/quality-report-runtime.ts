import { Effect, Schema } from "effect";
import { BaselineCorpusArtifactSchema } from "./baseline-corpus-runtime.ts";
import { ChaosProviderSuiteArtifactSchema } from "./chaos-provider-suite-runtime.ts";
import { IncumbentComparisonArtifactSchema } from "./incumbent-comparison-runtime.ts";
import { PerformanceBudgetArtifactSchema } from "./performance-gate-runtime.ts";
import { PromotionGateEvaluationSchema } from "./promotion-gate-policy-runtime.ts";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import { ParserFailure } from "./tagged-errors.ts";
import { DriftRegressionArtifactSchema } from "./drift-regression-runtime.ts";

const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const ReportSectionKeySchema = Schema.Literals([
  "baselineCorpus",
  "incumbentComparison",
  "driftRegression",
  "performanceBudget",
  "chaosProviderSuite",
  "promotionGate",
] as const);
const ReportSectionStatusSchema = Schema.Literals(["pass", "warn", "fail"] as const);
const PromotionDecisionSchema = Schema.Literals(["promote", "hold", "quarantine"] as const);

const ReportEvidenceIdsSchema = Schema.Array(CanonicalIdentifierSchema).pipe(
  Schema.refine(
    (ids): ids is ReadonlyArray<string> => ids.length > 0 && new Set(ids).size === ids.length,
    {
      message: "Expected deterministic quality report evidence identifiers.",
    },
  ),
);

export class QualityReportEvidenceBundle extends Schema.Class<QualityReportEvidenceBundle>(
  "QualityReportEvidenceBundle",
)({
  baselineCorpus: BaselineCorpusArtifactSchema,
  incumbentComparison: IncumbentComparisonArtifactSchema,
  driftRegression: DriftRegressionArtifactSchema,
  performanceBudget: PerformanceBudgetArtifactSchema,
  chaosProviderSuite: ChaosProviderSuiteArtifactSchema,
  promotionGate: PromotionGateEvaluationSchema,
}) {}

export class QualityReportSection extends Schema.Class<QualityReportSection>(
  "QualityReportSection",
)({
  key: ReportSectionKeySchema,
  title: NonEmptyStringSchema,
  status: ReportSectionStatusSchema,
  headline: NonEmptyStringSchema,
  evidenceIds: ReportEvidenceIdsSchema,
}) {}

const QualityReportSectionsSchema = Schema.Array(QualityReportSection).pipe(
  Schema.refine(
    (sections): sections is ReadonlyArray<QualityReportSection> =>
      sections.length === 6 && new Set(sections.map(({ key }) => key)).size === sections.length,
    {
      message: "Expected one deterministic quality report section for every E7 evidence surface.",
    },
  ),
);

export class QualityReportSummary extends Schema.Class<QualityReportSummary>(
  "QualityReportSummary",
)({
  decision: PromotionDecisionSchema,
  status: ReportSectionStatusSchema,
  caseCount: NonNegativeIntSchema,
  packCount: NonNegativeIntSchema,
  warningSectionKeys: Schema.Array(ReportSectionKeySchema),
  failingSectionKeys: Schema.Array(ReportSectionKeySchema),
  highlights: Schema.Array(NonEmptyStringSchema),
}) {}

export class QualityReportArtifact extends Schema.Class<QualityReportArtifact>(
  "QualityReportArtifact",
)({
  benchmark: Schema.Literal("e7-quality-report"),
  reportId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  corpusId: CanonicalIdentifierSchema,
  caseCount: NonNegativeIntSchema,
  packCount: NonNegativeIntSchema,
  summary: QualityReportSummary,
  sections: QualityReportSectionsSchema,
  evidence: QualityReportEvidenceBundle,
}) {}

const QualityReportInputSchema = Schema.Struct({
  reportId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  evidence: QualityReportEvidenceBundle,
});

type ReportSectionStatus = Schema.Schema.Type<typeof ReportSectionStatusSchema>;
type PromotionDecision = Schema.Schema.Type<typeof PromotionDecisionSchema>;
type QualityReportEvidence = Schema.Schema.Type<typeof QualityReportEvidenceBundle>;
type DriftSeverity = Schema.Schema.Type<
  typeof DriftRegressionArtifactSchema
>["packSummaries"][number]["severity"];

export const QualityReportEvidenceBundleSchema = QualityReportEvidenceBundle;
export const QualityReportSectionSchema = QualityReportSection;
export const QualityReportSummarySchema = QualityReportSummary;
export const QualityReportArtifactSchema = QualityReportArtifact;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function driftSeverityRank(severity: DriftSeverity) {
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

function reportStatusRank(status: ReportSectionStatus) {
  switch (status) {
    case "pass":
      return 0;
    case "warn":
      return 1;
    case "fail":
      return 2;
  }
}

function maxReportStatus(
  current: ReportSectionStatus,
  candidate: ReportSectionStatus,
): ReportSectionStatus {
  return reportStatusRank(current) >= reportStatusRank(candidate) ? current : candidate;
}

function validateEvidenceAlignment(evidence: QualityReportEvidence) {
  if (evidence.baselineCorpus.corpusId !== evidence.incumbentComparison.incumbentCorpusId) {
    return Effect.fail(
      new ParserFailure({
        message:
          "Expected the quality report incumbent comparison to reference the same baseline corpus id.",
      }),
    );
  }

  if (evidence.baselineCorpus.corpusId !== evidence.incumbentComparison.candidateCorpusId) {
    return Effect.fail(
      new ParserFailure({
        message:
          "Expected the quality report candidate comparison to reference the same baseline corpus id.",
      }),
    );
  }

  if (evidence.incumbentComparison.comparisonId !== evidence.driftRegression.comparisonId) {
    return Effect.fail(
      new ParserFailure({
        message:
          "Expected the quality report drift regression analysis to reference the incumbent comparison id.",
      }),
    );
  }

  if (evidence.driftRegression.analysisId !== evidence.promotionGate.quality.analysisId) {
    return Effect.fail(
      new ParserFailure({
        message:
          "Expected the quality report promotion gate to reference the drift regression analysis id.",
      }),
    );
  }

  if (evidence.performanceBudget.benchmarkId !== evidence.promotionGate.performance.benchmarkId) {
    return Effect.fail(
      new ParserFailure({
        message:
          "Expected the quality report promotion gate to reference the performance budget benchmark id.",
      }),
    );
  }

  if (
    evidence.performanceBudget.profile.caseCount !== evidence.baselineCorpus.caseCount ||
    evidence.performanceBudget.profile.packCount !== evidence.baselineCorpus.packCount
  ) {
    return Effect.fail(
      new ParserFailure({
        message:
          "Expected the quality report performance budget profile to align with the baseline corpus profile.",
      }),
    );
  }

  if (
    evidence.chaosProviderSuite.results.some(
      ({ plannerRationale }) => plannerRationale.length === 0,
    )
  ) {
    return Effect.fail(
      new ParserFailure({
        message:
          "Expected every chaos provider suite result in the quality report to retain planner rationale evidence.",
      }),
    );
  }

  return Effect.void;
}

function comparisonChangedCaseCount(
  artifact: Schema.Schema.Type<typeof IncumbentComparisonArtifactSchema>,
) {
  return artifact.packSummaries.reduce(
    (total, summary) => total + summary.deltaSummary.changedCaseCount,
    0,
  );
}

function highestDriftSeverity(
  artifact: Schema.Schema.Type<typeof DriftRegressionArtifactSchema>,
): DriftSeverity {
  return artifact.packSummaries.reduce<DriftSeverity>(
    (current, summary) =>
      driftSeverityRank(summary.severity) > driftSeverityRank(current) ? summary.severity : current,
    "none",
  );
}

function sectionStatusFromDrift(severity: DriftSeverity): ReportSectionStatus {
  if (severity === "none") {
    return "pass";
  }

  if (severity === "high" || severity === "critical") {
    return "fail";
  }

  return "warn";
}

function sectionStatusFromPerformance(
  artifact: Schema.Schema.Type<typeof PerformanceBudgetArtifactSchema>,
): ReportSectionStatus {
  if (artifact.status === "fail") {
    return "fail";
  }

  return artifact.comparison.comparable ? "pass" : "warn";
}

function sectionStatusFromPromotion(decision: PromotionDecision): ReportSectionStatus {
  switch (decision) {
    case "promote":
      return "pass";
    case "hold":
      return "warn";
    case "quarantine":
      return "fail";
  }
}

function reportDecision(
  evaluation: Schema.Schema.Type<typeof PromotionGateEvaluationSchema>,
): PromotionDecision {
  switch (evaluation.verdict) {
    case "promote":
      return "promote";
    case "hold":
      return "hold";
    case "quarantine":
      return "quarantine";
  }
}

function buildSections(evidence: QualityReportEvidence) {
  const driftSeverity = highestDriftSeverity(evidence.driftRegression);
  const promotionDecision = reportDecision(evidence.promotionGate);
  const sections = [
    {
      key: "baselineCorpus",
      title: "Baseline Corpus",
      status: "pass",
      headline: `Baseline corpus captured ${evidence.baselineCorpus.caseCount} case(s) across ${evidence.baselineCorpus.packCount} pack(s).`,
      evidenceIds: [evidence.baselineCorpus.corpusId],
    },
    {
      key: "incumbentComparison",
      title: "Incumbent Comparison",
      status: "pass",
      headline: `Incumbent comparison evaluated ${evidence.incumbentComparison.caseCount} case(s) and found ${comparisonChangedCaseCount(evidence.incumbentComparison)} changed case(s).`,
      evidenceIds: [evidence.incumbentComparison.comparisonId],
    },
    {
      key: "driftRegression",
      title: "Drift Regression",
      status: sectionStatusFromDrift(driftSeverity),
      headline: `Drift regression recorded ${evidence.driftRegression.findings.length} finding(s); highest severity ${driftSeverity}.`,
      evidenceIds: [evidence.driftRegression.analysisId, evidence.driftRegression.comparisonId],
    },
    {
      key: "performanceBudget",
      title: "Performance Budget",
      status: sectionStatusFromPerformance(evidence.performanceBudget),
      headline: evidence.performanceBudget.comparison.comparable
        ? `Performance budget ${evidence.performanceBudget.status} with baseline-corpus p95 ${evidence.performanceBudget.measurements.baselineCorpus.p95Ms}ms and incumbent-comparison p95 ${evidence.performanceBudget.measurements.incumbentComparison.p95Ms}ms.`
        : `Performance budget ${evidence.performanceBudget.status} without a comparable baseline: ${evidence.performanceBudget.comparison.incompatibleReason ?? "No baseline was supplied."}`,
      evidenceIds: [evidence.performanceBudget.benchmarkId],
    },
    {
      key: "chaosProviderSuite",
      title: "Chaos Provider Suite",
      status: evidence.chaosProviderSuite.status === "pass" ? "pass" : "fail",
      headline: `Chaos provider suite ${evidence.chaosProviderSuite.status} across ${evidence.chaosProviderSuite.scenarioCount} scenario(s).`,
      evidenceIds: [evidence.chaosProviderSuite.suiteId],
    },
    {
      key: "promotionGate",
      title: "Promotion Gate",
      status: sectionStatusFromPromotion(promotionDecision),
      headline: `Promotion gate decided ${promotionDecision} with ${evidence.promotionGate.rationale.length} rationale entr${evidence.promotionGate.rationale.length === 1 ? "y" : "ies"}.`,
      evidenceIds: [
        evidence.promotionGate.evaluationId,
        evidence.promotionGate.quality.analysisId,
        evidence.promotionGate.performance.benchmarkId,
      ],
    },
  ] as const;

  return sections.map((section) => Schema.decodeUnknownSync(QualityReportSectionSchema)(section));
}

function buildSummary(
  decision: PromotionDecision,
  sections: ReadonlyArray<Schema.Schema.Type<typeof QualityReportSectionSchema>>,
  evidence: QualityReportEvidence,
) {
  const warningSectionKeys = sections
    .filter(({ status }) => status === "warn")
    .map(({ key }) => key);
  const failingSectionKeys = sections
    .filter(({ status }) => status === "fail")
    .map(({ key }) => key);
  const status = sections.reduce<ReportSectionStatus>(
    (current, section) => maxReportStatus(current, section.status),
    "pass",
  );
  const highlights = [
    `Promotion gate: ${decision}.`,
    `Drift findings: ${evidence.driftRegression.findings.length} with highest severity ${highestDriftSeverity(evidence.driftRegression)}.`,
    `Chaos suite: ${evidence.chaosProviderSuite.status} across ${evidence.chaosProviderSuite.scenarioCount} scenario(s).`,
    evidence.performanceBudget.comparison.comparable
      ? `Performance deltas stayed comparable against the persisted baseline.`
      : `Performance deltas were not comparable against the persisted baseline.`,
  ];

  return Schema.decodeUnknownSync(QualityReportSummarySchema)({
    decision,
    status,
    caseCount: evidence.baselineCorpus.caseCount,
    packCount: evidence.baselineCorpus.packCount,
    warningSectionKeys,
    failingSectionKeys,
    highlights,
  });
}

export function buildQualityReportExport(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(QualityReportInputSchema)(input),
      catch: (cause) =>
        new ParserFailure({
          message: readCauseMessage(
            cause,
            "Failed to decode the E7 quality report input through shared contracts.",
          ),
        }),
    });
    yield* validateEvidenceAlignment(decoded.evidence);
    const sections = buildSections(decoded.evidence);
    const decision = reportDecision(decoded.evidence.promotionGate);
    const summary = buildSummary(decision, sections, decoded.evidence);

    return Schema.decodeUnknownSync(QualityReportArtifactSchema)({
      benchmark: "e7-quality-report",
      reportId: decoded.reportId,
      generatedAt: decoded.generatedAt,
      corpusId: decoded.evidence.baselineCorpus.corpusId,
      caseCount: decoded.evidence.baselineCorpus.caseCount,
      packCount: decoded.evidence.baselineCorpus.packCount,
      summary,
      sections,
      evidence: decoded.evidence,
    });
  });
}

export type QualityReportEvidenceBundleEncoded = Schema.Codec.Encoded<
  typeof QualityReportEvidenceBundleSchema
>;
export type QualityReportSectionEncoded = Schema.Codec.Encoded<typeof QualityReportSectionSchema>;
export type QualityReportSummaryEncoded = Schema.Codec.Encoded<typeof QualityReportSummarySchema>;
export type QualityReportArtifactEncoded = Schema.Codec.Encoded<typeof QualityReportArtifactSchema>;
