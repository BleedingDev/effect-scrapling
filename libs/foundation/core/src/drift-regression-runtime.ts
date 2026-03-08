import { Effect, Schema } from "effect";
import { IncumbentComparisonArtifactSchema } from "./incumbent-comparison-runtime.ts";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import { ParserFailure } from "./tagged-errors.ts";

const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const RateMagnitudeSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);
const RegressionSeveritySchema = Schema.Literals([
  "none",
  "low",
  "moderate",
  "high",
  "critical",
] as const);
const RegressionKindSchema = Schema.Literals([
  "fieldAdded",
  "fieldRemoved",
  "fieldChanged",
  "confidenceDrop",
] as const);

type RegressionSeverity = Schema.Schema.Type<typeof RegressionSeveritySchema>;

const DefaultDriftRegressionPolicy = Object.freeze({
  lowDriftThreshold: 0.01,
  moderateDriftThreshold: 0.05,
  highDriftThreshold: 0.12,
  criticalDriftThreshold: 0.25,
  lowConfidenceDropThreshold: 0.02,
  moderateConfidenceDropThreshold: 0.08,
  highConfidenceDropThreshold: 0.15,
  criticalConfidenceDropThreshold: 0.3,
});

const ThresholdSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);

const DriftRegressionPolicyBaseSchema = Schema.Struct({
  lowDriftThreshold: ThresholdSchema,
  moderateDriftThreshold: ThresholdSchema,
  highDriftThreshold: ThresholdSchema,
  criticalDriftThreshold: ThresholdSchema,
  lowConfidenceDropThreshold: ThresholdSchema,
  moderateConfidenceDropThreshold: ThresholdSchema,
  highConfidenceDropThreshold: ThresholdSchema,
  criticalConfidenceDropThreshold: ThresholdSchema,
});

export const DriftRegressionPolicySchema = DriftRegressionPolicyBaseSchema.pipe(
  Schema.refine(
    (policy): policy is Schema.Schema.Type<typeof DriftRegressionPolicyBaseSchema> =>
      policy.lowDriftThreshold <= policy.moderateDriftThreshold &&
      policy.moderateDriftThreshold <= policy.highDriftThreshold &&
      policy.highDriftThreshold <= policy.criticalDriftThreshold &&
      policy.lowConfidenceDropThreshold <= policy.moderateConfidenceDropThreshold &&
      policy.moderateConfidenceDropThreshold <= policy.highConfidenceDropThreshold &&
      policy.highConfidenceDropThreshold <= policy.criticalConfidenceDropThreshold,
    {
      message:
        "Expected drift and confidence-drop thresholds ordered from low to critical severity.",
    },
  ),
);

export class RegressionFinding extends Schema.Class<RegressionFinding>("RegressionFinding")({
  id: CanonicalIdentifierSchema,
  caseId: CanonicalIdentifierSchema,
  packId: CanonicalIdentifierSchema,
  targetId: CanonicalIdentifierSchema,
  snapshotDiffId: CanonicalIdentifierSchema,
  field: Schema.optional(Schema.String),
  kind: RegressionKindSchema,
  signature: Schema.String,
  severity: RegressionSeveritySchema,
  driftMagnitude: RateMagnitudeSchema,
  confidenceDrop: RateMagnitudeSchema,
  message: Schema.String,
}) {}

const RegressionFindingsSchema = Schema.Array(RegressionFinding).pipe(
  Schema.refine(
    (findings): findings is ReadonlyArray<RegressionFinding> =>
      new Set(findings.map(({ id }) => id)).size === findings.length,
    {
      message: "Expected drift regression findings with unique identifiers.",
    },
  ),
);

export class PackRegressionSummary extends Schema.Class<PackRegressionSummary>(
  "PackRegressionSummary",
)({
  packId: CanonicalIdentifierSchema,
  severity: RegressionSeveritySchema,
  caseCount: NonNegativeIntSchema,
  regressedCaseCount: NonNegativeIntSchema,
  findingCount: NonNegativeIntSchema,
  highestDriftMagnitude: RateMagnitudeSchema,
  highestConfidenceDrop: RateMagnitudeSchema,
  signatures: Schema.Array(Schema.String),
}) {}

const PackRegressionSummariesSchema = Schema.Array(PackRegressionSummary).pipe(
  Schema.refine(
    (summaries): summaries is ReadonlyArray<PackRegressionSummary> =>
      new Set(summaries.map(({ packId }) => packId)).size === summaries.length,
    {
      message: "Expected one drift regression summary per pack id.",
    },
  ),
);

export class DriftRegressionArtifact extends Schema.Class<DriftRegressionArtifact>(
  "DriftRegressionArtifact",
)({
  benchmark: Schema.Literal("e7-drift-regression-analysis"),
  analysisId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  comparisonId: CanonicalIdentifierSchema,
  caseCount: NonNegativeIntSchema,
  packCount: NonNegativeIntSchema,
  findings: RegressionFindingsSchema,
  packSummaries: PackRegressionSummariesSchema,
}) {}

const DriftRegressionInputSchema = Schema.Struct({
  id: CanonicalIdentifierSchema,
  createdAt: IsoDateTimeSchema,
  comparison: IncumbentComparisonArtifactSchema,
  policy: Schema.optional(DriftRegressionPolicySchema),
});

export const RegressionSeverityLevelSchema = RegressionSeveritySchema;
export const RegressionFindingSchema = RegressionFinding;
export const PackRegressionSummarySchema = PackRegressionSummary;
export const DriftRegressionArtifactSchema = DriftRegressionArtifact;

type DriftRegressionPolicy = Schema.Schema.Type<typeof DriftRegressionPolicySchema>;
type SnapshotDiffChange = NonNullable<
  Schema.Schema.Type<
    typeof IncumbentComparisonArtifactSchema
  >["results"][number]["snapshotDiff"]["changes"]
>[number];

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function roundRate(value: number) {
  return Number(value.toFixed(6));
}

function regressionSeverityRank(severity: RegressionSeverity) {
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

function compareSeverity(left: RegressionSeverity, right: RegressionSeverity) {
  return regressionSeverityRank(left) - regressionSeverityRank(right);
}

function maxSeverity(
  current: RegressionSeverity,
  candidate: RegressionSeverity,
): RegressionSeverity {
  return compareSeverity(current, candidate) >= 0 ? current : candidate;
}

function normalizeDriftMagnitude(value: number) {
  return roundRate(Math.abs(Math.min(value, 0)));
}

function resolvePolicy(policy: DriftRegressionPolicy | undefined) {
  return (
    policy ?? Schema.decodeUnknownSync(DriftRegressionPolicySchema)(DefaultDriftRegressionPolicy)
  );
}

function classifyMagnitudeSeverity(
  magnitude: number,
  thresholds: {
    readonly low: number;
    readonly moderate: number;
    readonly high: number;
    readonly critical: number;
  },
) {
  if (magnitude >= thresholds.critical) {
    return "critical" as const;
  }

  if (magnitude >= thresholds.high) {
    return "high" as const;
  }

  if (magnitude >= thresholds.moderate) {
    return "moderate" as const;
  }

  if (magnitude >= thresholds.low) {
    return "low" as const;
  }

  return "none" as const;
}

function classifyChangeSeverity(
  change: SnapshotDiffChange,
  driftMagnitude: number,
  confidenceDrop: number,
  policy: DriftRegressionPolicy,
) {
  if (change.changeType === "remove") {
    return "critical" as const;
  }

  const driftSeverity = classifyMagnitudeSeverity(driftMagnitude, {
    low: policy.lowDriftThreshold,
    moderate: policy.moderateDriftThreshold,
    high: policy.highDriftThreshold,
    critical: policy.criticalDriftThreshold,
  });
  const confidenceSeverity = classifyMagnitudeSeverity(confidenceDrop, {
    low: policy.lowConfidenceDropThreshold,
    moderate: policy.moderateConfidenceDropThreshold,
    high: policy.highConfidenceDropThreshold,
    critical: policy.criticalConfidenceDropThreshold,
  });
  let severity = maxSeverity(driftSeverity, confidenceSeverity);

  if (severity === "none") {
    severity = change.changeType === "add" ? "moderate" : "low";
  }

  return severity;
}

function buildFindingMessage(input: {
  readonly kind: Schema.Schema.Type<typeof RegressionKindSchema>;
  readonly field?: string;
  readonly severity: RegressionSeverity;
  readonly caseId: string;
  readonly driftMagnitude: number;
  readonly confidenceDrop: number;
}) {
  const fieldLabel = input.field === undefined ? "the case" : `field ${input.field}`;
  switch (input.kind) {
    case "fieldAdded":
      return `Regression analysis flagged ${fieldLabel} as an unexpected addition for case ${input.caseId} with ${input.severity} severity.`;
    case "fieldRemoved":
      return `Regression analysis flagged ${fieldLabel} as missing for case ${input.caseId} with ${input.severity} severity.`;
    case "fieldChanged":
      return `Regression analysis flagged ${fieldLabel} as changed for case ${input.caseId} with ${input.severity} severity.`;
    case "confidenceDrop":
      return `Regression analysis flagged ${fieldLabel} as a confidence-only regression for case ${input.caseId} (drift=${input.driftMagnitude}, confidenceDrop=${input.confidenceDrop}).`;
  }
}

function buildChangeFinding(input: {
  readonly caseId: string;
  readonly packId: string;
  readonly targetId: string;
  readonly snapshotDiffId: string;
  readonly change: SnapshotDiffChange;
  readonly driftMagnitude: number;
  readonly confidenceDrop: number;
  readonly policy: DriftRegressionPolicy;
}) {
  const kind =
    input.change.changeType === "add"
      ? "fieldAdded"
      : input.change.changeType === "remove"
        ? "fieldRemoved"
        : "fieldChanged";
  const severity = classifyChangeSeverity(
    input.change,
    input.driftMagnitude,
    input.confidenceDrop,
    input.policy,
  );

  return Schema.decodeUnknownSync(RegressionFindingSchema)({
    id: `${input.snapshotDiffId}-${input.change.field}-${kind}`,
    caseId: input.caseId,
    packId: input.packId,
    targetId: input.targetId,
    snapshotDiffId: input.snapshotDiffId,
    field: input.change.field,
    kind,
    signature: `${input.change.field}:${kind}:${severity}`,
    severity,
    driftMagnitude: input.driftMagnitude,
    confidenceDrop: input.confidenceDrop,
    message: buildFindingMessage({
      kind,
      field: input.change.field,
      severity,
      caseId: input.caseId,
      driftMagnitude: input.driftMagnitude,
      confidenceDrop: input.confidenceDrop,
    }),
  });
}

function buildConfidenceFinding(input: {
  readonly caseId: string;
  readonly packId: string;
  readonly targetId: string;
  readonly snapshotDiffId: string;
  readonly driftMagnitude: number;
  readonly confidenceDrop: number;
  readonly policy: DriftRegressionPolicy;
}) {
  const severity = classifyMagnitudeSeverity(input.confidenceDrop, {
    low: input.policy.lowConfidenceDropThreshold,
    moderate: input.policy.moderateConfidenceDropThreshold,
    high: input.policy.highConfidenceDropThreshold,
    critical: input.policy.criticalConfidenceDropThreshold,
  });

  if (severity === "none") {
    return undefined;
  }

  return Schema.decodeUnknownSync(RegressionFindingSchema)({
    id: `${input.snapshotDiffId}-confidence-drop`,
    caseId: input.caseId,
    packId: input.packId,
    targetId: input.targetId,
    snapshotDiffId: input.snapshotDiffId,
    kind: "confidenceDrop",
    signature: `confidence:${severity}`,
    severity,
    driftMagnitude: input.driftMagnitude,
    confidenceDrop: input.confidenceDrop,
    message: buildFindingMessage({
      kind: "confidenceDrop",
      severity,
      caseId: input.caseId,
      driftMagnitude: input.driftMagnitude,
      confidenceDrop: input.confidenceDrop,
    }),
  });
}

function compareFindings(left: RegressionFinding, right: RegressionFinding) {
  return (
    compareSeverity(right.severity, left.severity) ||
    left.packId.localeCompare(right.packId) ||
    left.caseId.localeCompare(right.caseId) ||
    (left.field ?? "").localeCompare(right.field ?? "") ||
    left.kind.localeCompare(right.kind)
  );
}

function buildPackSummary(
  packId: string,
  findings: ReadonlyArray<RegressionFinding>,
  totalCaseCount: number,
) {
  const signatures = [...new Set(findings.map(({ signature }) => signature))].sort((left, right) =>
    left.localeCompare(right),
  );
  const regressedCaseCount = new Set(findings.map(({ caseId }) => caseId)).size;

  return Schema.decodeUnknownSync(PackRegressionSummarySchema)({
    packId,
    severity: findings.reduce<RegressionSeverity>(
      (current, finding) => maxSeverity(current, finding.severity),
      "none",
    ),
    caseCount: totalCaseCount,
    regressedCaseCount,
    findingCount: findings.length,
    highestDriftMagnitude: findings.reduce(
      (current, finding) => Math.max(current, finding.driftMagnitude),
      0,
    ),
    highestConfidenceDrop: findings.reduce(
      (current, finding) => Math.max(current, finding.confidenceDrop),
      0,
    ),
    signatures,
  });
}

export function analyzeDriftRegression(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(DriftRegressionInputSchema)(input),
      catch: (cause) =>
        new ParserFailure({
          message: readCauseMessage(
            cause,
            "Failed to decode drift regression analysis input through shared contracts.",
          ),
        }),
    });
    const policy = resolvePolicy(decoded.policy);
    const findings = new Array<Schema.Schema.Type<typeof RegressionFindingSchema>>();

    for (const result of decoded.comparison.results) {
      const driftMagnitude = normalizeDriftMagnitude(result.snapshotDiff.metrics.driftDelta);
      const confidenceDrop = normalizeDriftMagnitude(
        result.snapshotDiff.canonicalMetrics?.confidenceDelta ?? 0,
      );
      const changes = result.snapshotDiff.changes ?? [];

      for (const change of changes) {
        findings.push(
          buildChangeFinding({
            caseId: result.caseId,
            packId: result.packId,
            targetId: result.targetId,
            snapshotDiffId: result.snapshotDiff.id,
            change,
            driftMagnitude,
            confidenceDrop,
            policy,
          }),
        );
      }

      if (changes.length === 0) {
        const confidenceFinding = buildConfidenceFinding({
          caseId: result.caseId,
          packId: result.packId,
          targetId: result.targetId,
          snapshotDiffId: result.snapshotDiff.id,
          driftMagnitude,
          confidenceDrop,
          policy,
        });
        if (confidenceFinding !== undefined) {
          findings.push(confidenceFinding);
        }
      }
    }

    const orderedFindings = [...findings].sort(compareFindings);
    const resultsByPack = new Map<string, Array<RegressionFinding>>();

    for (const result of decoded.comparison.results) {
      if (!resultsByPack.has(result.packId)) {
        resultsByPack.set(result.packId, []);
      }
    }

    for (const finding of orderedFindings) {
      const current = resultsByPack.get(finding.packId);
      if (current === undefined) {
        resultsByPack.set(finding.packId, [finding]);
        continue;
      }

      current.push(finding);
    }

    const packCaseCounts = new Map<string, number>();
    for (const result of decoded.comparison.results) {
      packCaseCounts.set(result.packId, (packCaseCounts.get(result.packId) ?? 0) + 1);
    }

    const packSummaries = Array.from(resultsByPack.entries())
      .map(([packId, packFindings]) =>
        buildPackSummary(packId, packFindings, packCaseCounts.get(packId) ?? 0),
      )
      .sort((left, right) => left.packId.localeCompare(right.packId));

    return Schema.decodeUnknownSync(DriftRegressionArtifactSchema)({
      benchmark: "e7-drift-regression-analysis",
      analysisId: decoded.id,
      generatedAt: decoded.createdAt,
      comparisonId: decoded.comparison.comparisonId,
      caseCount: decoded.comparison.caseCount,
      packCount: decoded.comparison.packCount,
      findings: orderedFindings,
      packSummaries,
    });
  });
}

export type RegressionFindingEncoded = Schema.Codec.Encoded<typeof RegressionFindingSchema>;
export type PackRegressionSummaryEncoded = Schema.Codec.Encoded<typeof PackRegressionSummarySchema>;
export type DriftRegressionArtifactEncoded = Schema.Codec.Encoded<
  typeof DriftRegressionArtifactSchema
>;
