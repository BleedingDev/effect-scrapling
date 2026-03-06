import { Effect, Schema } from "effect";
import { AssertionReportSchema } from "./assertion-engine.ts";
import { EvidenceManifestSchema } from "./evidence-manifest.ts";
import {
  ExtractionRecipeSchema,
  makeHttpCapturePayloadLoader,
  runExtractorOrchestration,
} from "./extractor-runtime.ts";
import { HttpCaptureBundleSchema } from "./http-access-runtime.ts";
import { RunPlanSchema } from "./run-state.ts";
import { CanonicalIdentifierSchema } from "./schema-primitives.ts";
import { SelectorResolutionSchema } from "./selector-engine.ts";
import { SnapshotAssemblyResultSchema } from "./snapshot-builder.ts";
import {
  CoreErrorEnvelopeSchema,
  ExtractionMismatch,
  ParserFailure,
  toCoreErrorEnvelope,
} from "./tagged-errors.ts";

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

export class GoldenFixtureReplaySuccess extends Schema.Class<GoldenFixtureReplaySuccess>(
  "GoldenFixtureReplaySuccess",
)({
  documentArtifactId: CanonicalIdentifierSchema,
  selectorResolutions: Schema.Array(SelectorResolutionSchema),
  snapshotAssembly: SnapshotAssemblyResultSchema,
  assertionReport: AssertionReportSchema,
  evidenceManifest: EvidenceManifestSchema,
}) {}

export const GoldenFixtureReplayResultSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("success"),
    result: GoldenFixtureReplaySuccess,
  }),
  Schema.Struct({
    kind: Schema.Literal("failure"),
    error: CoreErrorEnvelopeSchema,
  }),
]);

export class GoldenFixtureCase extends Schema.Class<GoldenFixtureCase>("GoldenFixtureCase")({
  fixtureId: CanonicalIdentifierSchema,
  plan: RunPlanSchema,
  recipe: ExtractionRecipeSchema,
  captureBundle: HttpCaptureBundleSchema,
  expected: GoldenFixtureReplayResultSchema,
}) {}

export const GoldenFixtureReplaySuccessSchema = GoldenFixtureReplaySuccess;
export const GoldenFixtureCaseSchema = GoldenFixtureCase;
export const GoldenFixtureBankSchema = Schema.Array(GoldenFixtureCase).pipe(
  Schema.refine(
    (fixtures): fixtures is ReadonlyArray<GoldenFixtureCase> =>
      fixtures.length > 0 &&
      new Set(fixtures.map(({ fixtureId }) => fixtureId)).size === fixtures.length,
    {
      message: "Expected a non-empty golden fixture bank without duplicate fixture identifiers.",
    },
  ),
);

function toReplaySuccessResult(result: {
  readonly documentArtifactId: string;
  readonly selectorResolutions: ReadonlyArray<Schema.Schema.Type<typeof SelectorResolutionSchema>>;
  readonly snapshotAssembly: Schema.Schema.Type<typeof SnapshotAssemblyResultSchema>;
  readonly assertionReport: Schema.Schema.Type<typeof AssertionReportSchema>;
  readonly evidenceManifest: Schema.Schema.Type<typeof EvidenceManifestSchema>;
}) {
  return Schema.decodeUnknownSync(GoldenFixtureReplaySuccessSchema)({
    documentArtifactId: result.documentArtifactId,
    selectorResolutions: result.selectorResolutions,
    snapshotAssembly: result.snapshotAssembly,
    assertionReport: result.assertionReport,
    evidenceManifest: result.evidenceManifest,
  });
}

export function makeGoldenReplayLoader(fixture: unknown) {
  const decodedFixture = Schema.decodeUnknownSync(GoldenFixtureCaseSchema)(fixture);
  return makeHttpCapturePayloadLoader(decodedFixture.captureBundle);
}

export function replayGoldenFixture(fixture: unknown) {
  return Effect.gen(function* () {
    const decodedFixture = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(GoldenFixtureCaseSchema)(fixture),
      catch: (cause) =>
        new ParserFailure({
          message: readCauseMessage(cause, "Failed to decode golden fixture case."),
        }),
    });

    return yield* runExtractorOrchestration(
      {
        plan: decodedFixture.plan,
        artifacts: decodedFixture.captureBundle.artifacts,
        recipe: decodedFixture.recipe,
        createdAt: decodedFixture.plan.createdAt,
      },
      makeGoldenReplayLoader(decodedFixture),
    ).pipe(
      Effect.match({
        onSuccess: (result) =>
          Schema.decodeUnknownSync(GoldenFixtureReplayResultSchema)({
            kind: "success",
            result: toReplaySuccessResult(result),
          }),
        onFailure: (error: ExtractionMismatch | ParserFailure) =>
          Schema.decodeUnknownSync(GoldenFixtureReplayResultSchema)({
            kind: "failure",
            error: toCoreErrorEnvelope(error),
          }),
      }),
    );
  });
}

export type GoldenFixtureCaseEncoded = Schema.Codec.Encoded<typeof GoldenFixtureCaseSchema>;
export type GoldenFixtureReplayResultEncoded = Schema.Codec.Encoded<
  typeof GoldenFixtureReplayResultSchema
>;
