import { Effect, Schema } from "effect";
import { BaselineCorpusArtifactSchema } from "./baseline-corpus-runtime.ts";
import { SnapshotDiffSchema } from "./diff-verdict.ts";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import { compareSnapshots } from "./snapshot-diff-engine.ts";
import { ParserFailure } from "./tagged-errors.ts";

const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const RateDeltaSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(-1)).check(
  Schema.isLessThanOrEqualTo(1),
);
const ComparisonVerdictSchema = Schema.Literals(["match", "diff"] as const);

type BaselineCorpusArtifact = Schema.Schema.Type<typeof BaselineCorpusArtifactSchema>;
type BaselineCorpusCaseResult = BaselineCorpusArtifact["results"][number];
type SnapshotDiff = Schema.Schema.Type<typeof SnapshotDiffSchema>;
type ComparisonVerdict = Schema.Schema.Type<typeof ComparisonVerdictSchema>;

export class IncumbentComparisonInput extends Schema.Class<IncumbentComparisonInput>(
  "IncumbentComparisonInput",
)({
  id: CanonicalIdentifierSchema,
  createdAt: IsoDateTimeSchema,
  incumbent: BaselineCorpusArtifactSchema,
  candidate: BaselineCorpusArtifactSchema,
}) {}

export class IncumbentCaseComparisonResult extends Schema.Class<IncumbentCaseComparisonResult>(
  "IncumbentCaseComparisonResult",
)({
  caseId: CanonicalIdentifierSchema,
  packId: CanonicalIdentifierSchema,
  targetId: CanonicalIdentifierSchema,
  incumbentRunId: CanonicalIdentifierSchema,
  candidateRunId: CanonicalIdentifierSchema,
  verdict: ComparisonVerdictSchema,
  snapshotDiff: SnapshotDiffSchema,
}) {}

const IncumbentCaseComparisonResultsSchema = Schema.Array(IncumbentCaseComparisonResult).pipe(
  Schema.refine(
    (results): results is ReadonlyArray<IncumbentCaseComparisonResult> =>
      new Set(results.map(({ caseId }) => caseId)).size === results.length,
    {
      message: "Expected incumbent comparison results without duplicate case ids.",
    },
  ),
);

export class PackDeltaSummary extends Schema.Class<PackDeltaSummary>("PackDeltaSummary")({
  caseCount: NonNegativeIntSchema,
  matchedCaseCount: NonNegativeIntSchema,
  changedCaseCount: NonNegativeIntSchema,
  totalAddedFieldCount: NonNegativeIntSchema,
  totalRemovedFieldCount: NonNegativeIntSchema,
  totalChangedFieldCount: NonNegativeIntSchema,
  meanFieldRecallDelta: RateDeltaSchema,
  meanFalsePositiveDelta: RateDeltaSchema,
  meanDriftDelta: RateDeltaSchema,
  meanConfidenceDelta: RateDeltaSchema,
  meanLatencyDeltaMs: Schema.Finite,
  meanMemoryDelta: Schema.Finite,
}) {}

export class PackComparisonSummary extends Schema.Class<PackComparisonSummary>(
  "PackComparisonSummary",
)({
  packId: CanonicalIdentifierSchema,
  verdict: ComparisonVerdictSchema,
  caseIds: Schema.Array(CanonicalIdentifierSchema),
  deltaSummary: PackDeltaSummary,
}) {}

const PackComparisonSummariesSchema = Schema.Array(PackComparisonSummary).pipe(
  Schema.refine(
    (summaries): summaries is ReadonlyArray<PackComparisonSummary> =>
      new Set(summaries.map(({ packId }) => packId)).size === summaries.length,
    {
      message: "Expected one incumbent comparison summary per pack id.",
    },
  ),
);

export class IncumbentComparisonArtifact extends Schema.Class<IncumbentComparisonArtifact>(
  "IncumbentComparisonArtifact",
)({
  benchmark: Schema.Literal("e7-incumbent-comparison"),
  comparisonId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  incumbentCorpusId: CanonicalIdentifierSchema,
  candidateCorpusId: CanonicalIdentifierSchema,
  caseCount: NonNegativeIntSchema,
  packCount: NonNegativeIntSchema,
  results: IncumbentCaseComparisonResultsSchema,
  packSummaries: PackComparisonSummariesSchema,
}) {}

export const IncumbentComparisonInputSchema = IncumbentComparisonInput;
export const IncumbentCaseComparisonResultSchema = IncumbentCaseComparisonResult;
export const PackDeltaSummarySchema = PackDeltaSummary;
export const PackComparisonSummarySchema = PackComparisonSummary;
export const IncumbentComparisonArtifactSchema = IncumbentComparisonArtifact;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function roundMetric(value: number) {
  return Number(value.toFixed(6));
}

function compareCaseResults(left: BaselineCorpusCaseResult, right: BaselineCorpusCaseResult) {
  return (
    left.packId.localeCompare(right.packId) ||
    left.targetId.localeCompare(right.targetId) ||
    left.caseId.localeCompare(right.caseId)
  );
}

function comparePackSummaries(left: PackComparisonSummary, right: PackComparisonSummary) {
  return left.packId.localeCompare(right.packId);
}

function buildCandidateIndex(candidate: BaselineCorpusArtifact) {
  return new Map(candidate.results.map((result) => [result.caseId, result] as const));
}

function validateCorpusAlignment(
  incumbent: BaselineCorpusArtifact,
  candidate: BaselineCorpusArtifact,
) {
  if (incumbent.corpusId !== candidate.corpusId) {
    return Effect.fail(
      new ParserFailure({
        message: "Expected incumbent and candidate artifacts produced from the same corpus id.",
      }),
    );
  }

  if (incumbent.results.length !== candidate.results.length) {
    return Effect.fail(
      new ParserFailure({
        message: "Expected incumbent and candidate artifacts with the same case count.",
      }),
    );
  }

  const candidateIndex = buildCandidateIndex(candidate);
  for (const result of incumbent.results) {
    const candidateResult = candidateIndex.get(result.caseId);
    if (candidateResult === undefined) {
      return Effect.fail(
        new ParserFailure({
          message: `Expected candidate artifact result for case ${result.caseId}.`,
        }),
      );
    }

    if (candidateResult.packId !== result.packId || candidateResult.targetId !== result.targetId) {
      return Effect.fail(
        new ParserFailure({
          message:
            "Expected incumbent and candidate artifacts to align case ids with the same pack id and target id.",
        }),
      );
    }
  }

  return Effect.succeed(candidateIndex);
}

function readVerdict(snapshotDiff: SnapshotDiff): ComparisonVerdict {
  return snapshotDiff.changes === undefined || snapshotDiff.changes.length === 0 ? "match" : "diff";
}

function mean(values: ReadonlyArray<number>) {
  if (values.length === 0) {
    return 0;
  }

  return roundMetric(values.reduce((total, value) => total + value, 0) / values.length);
}

function sum(values: ReadonlyArray<number>) {
  return values.reduce((total, value) => total + value, 0);
}

function buildPackSummary(
  packId: string,
  results: ReadonlyArray<Schema.Schema.Type<typeof IncumbentCaseComparisonResultSchema>>,
) {
  const changedCaseCount = results.filter(({ verdict }) => verdict === "diff").length;
  const matchedCaseCount = results.length - changedCaseCount;
  const diffs = results.map(({ snapshotDiff }) => snapshotDiff);

  return Schema.decodeUnknownSync(PackComparisonSummarySchema)({
    packId,
    verdict: changedCaseCount === 0 ? "match" : "diff",
    caseIds: results.map(({ caseId }) => caseId).sort((left, right) => left.localeCompare(right)),
    deltaSummary: {
      caseCount: results.length,
      matchedCaseCount,
      changedCaseCount,
      totalAddedFieldCount: sum(diffs.map((diff) => diff.canonicalMetrics?.addedFieldCount ?? 0)),
      totalRemovedFieldCount: sum(
        diffs.map((diff) => diff.canonicalMetrics?.removedFieldCount ?? 0),
      ),
      totalChangedFieldCount: sum(
        diffs.map((diff) => diff.canonicalMetrics?.changedFieldCount ?? 0),
      ),
      meanFieldRecallDelta: mean(diffs.map((diff) => diff.metrics.fieldRecallDelta)),
      meanFalsePositiveDelta: mean(diffs.map((diff) => diff.metrics.falsePositiveDelta)),
      meanDriftDelta: mean(diffs.map((diff) => diff.metrics.driftDelta)),
      meanConfidenceDelta: mean(diffs.map((diff) => diff.canonicalMetrics?.confidenceDelta ?? 0)),
      meanLatencyDeltaMs: mean(diffs.map((diff) => diff.metrics.latencyDeltaMs)),
      meanMemoryDelta: mean(diffs.map((diff) => diff.metrics.memoryDelta)),
    },
  });
}

export function runIncumbentComparison(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(IncumbentComparisonInputSchema)(input),
      catch: (cause) =>
        new ParserFailure({
          message: readCauseMessage(
            cause,
            "Failed to decode incumbent comparison input through shared contracts.",
          ),
        }),
    });
    const candidateIndex = yield* validateCorpusAlignment(decoded.incumbent, decoded.candidate);
    const orderedIncumbentResults = [...decoded.incumbent.results].sort(compareCaseResults);
    const results = new Array<Schema.Schema.Type<typeof IncumbentCaseComparisonResultSchema>>();

    for (const incumbentResult of orderedIncumbentResults) {
      const candidateResult = candidateIndex.get(incumbentResult.caseId);
      if (candidateResult === undefined) {
        return yield* Effect.fail(
          new ParserFailure({
            message: `Expected candidate artifact result for case ${incumbentResult.caseId}.`,
          }),
        );
      }

      const snapshotDiff = yield* compareSnapshots({
        id: `diff-${incumbentResult.caseId}`,
        baseline: incumbentResult.orchestration.snapshotAssembly.snapshot,
        candidate: candidateResult.orchestration.snapshotAssembly.snapshot,
        createdAt: decoded.createdAt,
        latencyDeltaMs: 0,
        memoryDelta: 0,
      }).pipe(
        Effect.catchTag("DriftDetected", ({ message }) =>
          Effect.fail(
            new ParserFailure({
              message: `Failed to compare incumbent case ${incumbentResult.caseId}: ${message}`,
            }),
          ),
        ),
      );

      results.push(
        Schema.decodeUnknownSync(IncumbentCaseComparisonResultSchema)({
          caseId: incumbentResult.caseId,
          packId: incumbentResult.packId,
          targetId: incumbentResult.targetId,
          incumbentRunId: incumbentResult.runId,
          candidateRunId: candidateResult.runId,
          verdict: readVerdict(snapshotDiff),
          snapshotDiff,
        }),
      );
    }

    const groupedResults = new Map<
      string,
      Array<Schema.Schema.Type<typeof IncumbentCaseComparisonResultSchema>>
    >();
    for (const result of results) {
      const current = groupedResults.get(result.packId);
      if (current === undefined) {
        groupedResults.set(result.packId, [result]);
        continue;
      }

      current.push(result);
    }

    const packSummaries = Array.from(groupedResults.entries())
      .map(([packId, packResults]) => buildPackSummary(packId, packResults))
      .sort(comparePackSummaries);

    return Schema.decodeUnknownSync(IncumbentComparisonArtifactSchema)({
      benchmark: "e7-incumbent-comparison",
      comparisonId: decoded.id,
      generatedAt: decoded.createdAt,
      incumbentCorpusId: decoded.incumbent.corpusId,
      candidateCorpusId: decoded.candidate.corpusId,
      caseCount: results.length,
      packCount: packSummaries.length,
      results,
      packSummaries,
    });
  });
}

export type IncumbentComparisonInputEncoded = Schema.Codec.Encoded<
  typeof IncumbentComparisonInputSchema
>;
export type IncumbentCaseComparisonResultEncoded = Schema.Codec.Encoded<
  typeof IncumbentCaseComparisonResultSchema
>;
export type PackDeltaSummaryEncoded = Schema.Codec.Encoded<typeof PackDeltaSummarySchema>;
export type PackComparisonSummaryEncoded = Schema.Codec.Encoded<typeof PackComparisonSummarySchema>;
export type IncumbentComparisonArtifactEncoded = Schema.Codec.Encoded<
  typeof IncumbentComparisonArtifactSchema
>;
