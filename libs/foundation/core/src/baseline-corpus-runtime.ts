import { Effect, Schema } from "effect";
import {
  ExtractionRecipeSchema,
  ExtractorOrchestrationResultSchema,
  makeHttpCapturePayloadLoader,
  runExtractorOrchestration,
} from "./extractor-runtime.ts";
import { HttpCaptureBundleSchema } from "./http-access-runtime.ts";
import { RunPlanSchema } from "./run-state.ts";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import { SitePackSchema } from "./site-pack.ts";
import { CanonicalSnapshotSchema, canonicalizeSnapshot } from "./snapshot-diff-engine.ts";
import { ParserFailure } from "./tagged-errors.ts";

const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export class BaselineCorpusCase extends Schema.Class<BaselineCorpusCase>("BaselineCorpusCase")({
  caseId: CanonicalIdentifierSchema,
  pack: SitePackSchema,
  plan: RunPlanSchema,
  recipe: ExtractionRecipeSchema,
  captureBundle: HttpCaptureBundleSchema,
}) {}

const BaselineCorpusCasesSchema = Schema.Array(BaselineCorpusCase).pipe(
  Schema.refine(
    (cases): cases is ReadonlyArray<BaselineCorpusCase> =>
      cases.length > 0 &&
      new Set(cases.map(({ caseId }) => caseId)).size === cases.length &&
      cases.every(
        (entry) =>
          entry.plan.packId === entry.pack.id &&
          entry.recipe.packId === entry.pack.id &&
          entry.captureBundle.artifacts.every(({ runId }) => runId === entry.plan.id),
      ),
    {
      message:
        "Expected baseline corpus cases with unique case ids, aligned pack/plan/recipe ids, and capture artifacts bound to the case run id.",
    },
  ),
);

export class BaselineCorpusInput extends Schema.Class<BaselineCorpusInput>("BaselineCorpusInput")({
  id: CanonicalIdentifierSchema,
  createdAt: IsoDateTimeSchema,
  cases: BaselineCorpusCasesSchema,
}) {}

export class BaselineCorpusCaseResult extends Schema.Class<BaselineCorpusCaseResult>(
  "BaselineCorpusCaseResult",
)({
  caseId: CanonicalIdentifierSchema,
  packId: CanonicalIdentifierSchema,
  targetId: CanonicalIdentifierSchema,
  runId: CanonicalIdentifierSchema,
  orchestration: ExtractorOrchestrationResultSchema,
  canonicalSnapshot: CanonicalSnapshotSchema,
}) {}

const BaselineCorpusCaseResultsSchema = Schema.Array(BaselineCorpusCaseResult).pipe(
  Schema.refine(
    (results): results is ReadonlyArray<BaselineCorpusCaseResult> =>
      new Set(results.map(({ caseId }) => caseId)).size === results.length,
    {
      message: "Expected baseline corpus results without duplicate case ids.",
    },
  ),
);

export class BaselineCorpusArtifact extends Schema.Class<BaselineCorpusArtifact>(
  "BaselineCorpusArtifact",
)({
  benchmark: Schema.Literal("e7-baseline-corpus"),
  corpusId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  caseCount: NonNegativeIntSchema,
  packCount: NonNegativeIntSchema,
  results: BaselineCorpusCaseResultsSchema,
}) {}

export const BaselineCorpusCaseSchema = BaselineCorpusCase;
export const BaselineCorpusInputSchema = BaselineCorpusInput;
export const BaselineCorpusCaseResultSchema = BaselineCorpusCaseResult;
export const BaselineCorpusArtifactSchema = BaselineCorpusArtifact;

function compareCases(left: BaselineCorpusCase, right: BaselineCorpusCase) {
  return (
    left.pack.id.localeCompare(right.pack.id) ||
    left.plan.targetId.localeCompare(right.plan.targetId) ||
    left.caseId.localeCompare(right.caseId)
  );
}

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

export function runBaselineCorpus(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(BaselineCorpusInputSchema)(input),
      catch: (cause) =>
        new ParserFailure({
          message: readCauseMessage(
            cause,
            "Failed to decode baseline corpus input through shared contracts.",
          ),
        }),
    });
    const orderedCases = [...decoded.cases].sort(compareCases);
    const results = new Array<Schema.Schema.Type<typeof BaselineCorpusCaseResultSchema>>();

    for (const entry of orderedCases) {
      const orchestration = yield* runExtractorOrchestration(
        {
          plan: entry.plan,
          artifacts: entry.captureBundle.artifacts,
          recipe: entry.recipe,
          createdAt: decoded.createdAt,
        },
        makeHttpCapturePayloadLoader(entry.captureBundle),
      );
      const canonicalSnapshot = yield* canonicalizeSnapshot(
        orchestration.snapshotAssembly.snapshot,
      ).pipe(
        Effect.catchTag("DriftDetected", ({ message }) =>
          Effect.fail(
            new ParserFailure({
              message: `Failed to canonicalize baseline corpus case ${entry.caseId}: ${message}`,
            }),
          ),
        ),
      );

      results.push(
        Schema.decodeUnknownSync(BaselineCorpusCaseResultSchema)({
          caseId: entry.caseId,
          packId: entry.pack.id,
          targetId: entry.plan.targetId,
          runId: entry.plan.id,
          orchestration,
          canonicalSnapshot,
        }),
      );
    }

    return Schema.decodeUnknownSync(BaselineCorpusArtifactSchema)({
      benchmark: "e7-baseline-corpus",
      corpusId: decoded.id,
      generatedAt: decoded.createdAt,
      caseCount: results.length,
      packCount: new Set(results.map(({ packId }) => packId)).size,
      results,
    });
  });
}

export type BaselineCorpusCaseEncoded = Schema.Codec.Encoded<typeof BaselineCorpusCaseSchema>;
export type BaselineCorpusInputEncoded = Schema.Codec.Encoded<typeof BaselineCorpusInputSchema>;
export type BaselineCorpusCaseResultEncoded = Schema.Codec.Encoded<
  typeof BaselineCorpusCaseResultSchema
>;
export type BaselineCorpusArtifactEncoded = Schema.Codec.Encoded<
  typeof BaselineCorpusArtifactSchema
>;
