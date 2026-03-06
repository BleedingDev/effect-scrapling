import { Effect, Schema } from "effect";
import { ArtifactMetadataRecordSchema } from "./config-storage.ts";
import { ParsedHtmlDocumentSchema } from "./extraction-parser.ts";
import { ObservationSchema, SnapshotSchema } from "./observation-snapshot.ts";
import {
  CanonicalIdentifierSchema,
  CanonicalKeySchema,
  IsoDateTimeSchema,
} from "./schema-primitives.ts";
import { SelectorResolutionSchema } from "./selector-engine.ts";
import { ExtractionMismatch } from "./tagged-errors.ts";

const NonEmptyFieldSchema = Schema.Trim.check(Schema.isNonEmpty());
const ObservationIndexSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const EvidenceArtifactsSchema = Schema.Array(ArtifactMetadataRecordSchema).pipe(
  Schema.refine(
    (
      artifacts,
    ): artifacts is ReadonlyArray<Schema.Schema.Type<typeof ArtifactMetadataRecordSchema>> =>
      artifacts.length > 0 &&
      new Set(artifacts.map(({ artifactId }) => artifactId)).size === artifacts.length,
    {
      message: "Expected evidence artifacts with at least one record and unique artifact ids.",
    },
  ),
);

const EvidenceSelectorResolutionsSchema = Schema.Array(SelectorResolutionSchema).pipe(
  Schema.refine(
    (
      resolutions,
    ): resolutions is ReadonlyArray<Schema.Schema.Type<typeof SelectorResolutionSchema>> =>
      resolutions.length > 0 &&
      new Set(resolutions.map(({ selectorPath }) => selectorPath)).size === resolutions.length,
    {
      message:
        "Expected selector traces with at least one resolution and without duplicate selector paths.",
    },
  ),
);

export class EvidenceFieldBinding extends Schema.Class<EvidenceFieldBinding>(
  "EvidenceFieldBinding",
)({
  field: NonEmptyFieldSchema,
  selectorResolutions: EvidenceSelectorResolutionsSchema,
}) {}

const EvidenceArtifactCatalogSchema = Schema.Array(ArtifactMetadataRecordSchema).pipe(
  Schema.refine(
    (
      artifacts,
    ): artifacts is ReadonlyArray<Schema.Schema.Type<typeof ArtifactMetadataRecordSchema>> =>
      new Set(artifacts.map(({ artifactId }) => artifactId)).size === artifacts.length,
    {
      message: "Expected evidence artifact catalogs without duplicate artifact ids.",
    },
  ),
);

const EvidenceFieldBindingsSchema = Schema.Array(EvidenceFieldBinding).pipe(
  Schema.refine(
    (bindings): bindings is ReadonlyArray<EvidenceFieldBinding> =>
      new Set(bindings.map(({ field }) => field)).size === bindings.length,
    {
      message: "Expected evidence field bindings without duplicate fields.",
    },
  ),
);

export const EvidenceManifestInputSchema = Schema.Struct({
  snapshot: SnapshotSchema,
  document: ParsedHtmlDocumentSchema,
  artifacts: EvidenceArtifactCatalogSchema,
  fieldBindings: EvidenceFieldBindingsSchema,
});

export class EvidenceSelectorTrace extends Schema.Class<EvidenceSelectorTrace>(
  "EvidenceSelectorTrace",
)({
  documentId: CanonicalIdentifierSchema,
  rootPath: CanonicalKeySchema,
  resolution: SelectorResolutionSchema,
}) {}

const EvidenceSelectorTracesSchema = Schema.Array(EvidenceSelectorTrace).pipe(
  Schema.refine(
    (traces): traces is ReadonlyArray<EvidenceSelectorTrace> =>
      traces.length > 0 &&
      new Set(traces.map(({ resolution }) => resolution.selectorPath)).size === traces.length,
    {
      message:
        "Expected selector traces with at least one entry and without duplicate selector paths.",
    },
  ),
);

export class EvidenceManifestObservation extends Schema.Class<EvidenceManifestObservation>(
  "EvidenceManifestObservation",
)({
  observationIndex: ObservationIndexSchema,
  field: NonEmptyFieldSchema,
  observation: ObservationSchema,
  artifacts: EvidenceArtifactsSchema,
  selectorTraces: EvidenceSelectorTracesSchema,
}) {}

const EvidenceManifestObservationsSchema = Schema.Array(EvidenceManifestObservation).pipe(
  Schema.refine(
    (observations): observations is ReadonlyArray<EvidenceManifestObservation> =>
      new Set(observations.map(({ observationIndex }) => observationIndex)).size ===
      observations.length,
    {
      message: "Expected evidence manifest observations without duplicate observation indexes.",
    },
  ),
);

export class EvidenceManifest extends Schema.Class<EvidenceManifest>("EvidenceManifest")({
  id: CanonicalIdentifierSchema,
  snapshotId: CanonicalIdentifierSchema,
  targetId: CanonicalIdentifierSchema,
  documentId: CanonicalIdentifierSchema,
  createdAt: IsoDateTimeSchema,
  observations: EvidenceManifestObservationsSchema,
}) {}

export const EvidenceFieldBindingSchema = EvidenceFieldBinding;
export const EvidenceSelectorTraceSchema = EvidenceSelectorTrace;
export const EvidenceManifestObservationSchema = EvidenceManifestObservation;
export const EvidenceManifestSchema = EvidenceManifest;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function buildSelectorTraces(
  document: Schema.Schema.Type<typeof ParsedHtmlDocumentSchema>,
  binding: EvidenceFieldBinding,
) {
  return Schema.decodeUnknownSync(EvidenceSelectorTracesSchema)(
    binding.selectorResolutions.map((resolution) => ({
      documentId: document.documentId,
      rootPath: document.rootPath,
      resolution,
    })),
  );
}

function buildEvidenceArtifacts(
  field: string,
  observation: Schema.Schema.Type<typeof ObservationSchema>,
  artifactIndex: ReadonlyMap<string, Schema.Schema.Type<typeof ArtifactMetadataRecordSchema>>,
) {
  const artifacts = observation.evidenceRefs.flatMap((artifactId) => {
    const artifact = artifactIndex.get(artifactId);
    return artifact === undefined ? [] : [artifact];
  });
  const missingArtifactIds = observation.evidenceRefs.filter(
    (artifactId) => !artifactIndex.has(artifactId),
  );

  if (missingArtifactIds.length > 0) {
    return Effect.fail(
      new ExtractionMismatch({
        message: `Observation field ${field} references missing evidence artifacts: ${missingArtifactIds.join(", ")}`,
      }),
    );
  }

  return Effect.try({
    try: () => Schema.decodeUnknownSync(EvidenceArtifactsSchema)(artifacts),
    catch: (cause) =>
      new ExtractionMismatch({
        message: readCauseMessage(
          cause,
          `Observation field ${field} must resolve to at least one evidence artifact.`,
        ),
      }),
  });
}

export function generateEvidenceManifest(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(EvidenceManifestInputSchema)(input),
      catch: (cause) =>
        new ExtractionMismatch({
          message: readCauseMessage(
            cause,
            "Failed to decode evidence-manifest input through shared contracts.",
          ),
        }),
    });
    const artifactIndex = new Map(
      decoded.artifacts.map((artifact) => [artifact.artifactId, artifact]),
    );
    const fieldBindingIndex = new Map(
      decoded.fieldBindings.map((binding) => [binding.field, binding]),
    );
    const observations: Array<EvidenceManifestObservation> = [];

    for (const [observationIndex, observation] of decoded.snapshot.observations.entries()) {
      const fieldBinding = fieldBindingIndex.get(observation.field);
      if (fieldBinding === undefined) {
        return yield* Effect.fail(
          new ExtractionMismatch({
            message: `Observation field ${observation.field} does not have a selector trace binding.`,
          }),
        );
      }

      const artifacts = yield* buildEvidenceArtifacts(
        observation.field,
        observation,
        artifactIndex,
      );
      const selectorTraces = yield* Effect.try({
        try: () => buildSelectorTraces(decoded.document, fieldBinding),
        catch: (cause) =>
          new ExtractionMismatch({
            message: readCauseMessage(
              cause,
              `Observation field ${observation.field} could not encode selector traces.`,
            ),
          }),
      });

      observations.push(
        Schema.decodeUnknownSync(EvidenceManifestObservationSchema)({
          observationIndex,
          field: observation.field,
          observation,
          artifacts,
          selectorTraces,
        }),
      );
    }

    return Schema.decodeUnknownSync(EvidenceManifestSchema)({
      id: `${decoded.snapshot.id}-evidence-manifest`,
      snapshotId: decoded.snapshot.id,
      targetId: decoded.snapshot.targetId,
      documentId: decoded.document.documentId,
      createdAt: decoded.snapshot.createdAt,
      observations,
    });
  });
}

export type EvidenceManifestInput = Schema.Schema.Type<typeof EvidenceManifestInputSchema>;
export type EvidenceFieldBindingEncoded = Schema.Codec.Encoded<typeof EvidenceFieldBindingSchema>;
export type EvidenceSelectorTraceEncoded = Schema.Codec.Encoded<typeof EvidenceSelectorTraceSchema>;
export type EvidenceManifestObservationEncoded = Schema.Codec.Encoded<
  typeof EvidenceManifestObservationSchema
>;
export type EvidenceManifestEncoded = Schema.Codec.Encoded<typeof EvidenceManifestSchema>;
