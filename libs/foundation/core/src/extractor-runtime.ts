import { Effect, Layer, Schema } from "effect";
import {
  AssertionReportSchema,
  type AssertionFailure,
  BusinessInvariantAssertionSchema,
  type BusinessInvariantAssertion,
  RequiredFieldAssertionSchema,
  runAssertionEngine,
} from "./assertion-engine.ts";
import { ArtifactMetadataRecordSchema } from "./config-storage.ts";
import {
  DomainNormalizationError,
  DomainNormalizationFieldSchema,
  type DomainNormalizationField,
  normalizeAvailability,
  normalizeCurrency,
  normalizeDate,
  normalizePrice,
  normalizeProductIdentifier,
  normalizeText,
} from "./domain-normalizers.ts";
import {
  EvidenceFieldBindingSchema,
  EvidenceManifestSchema,
  generateEvidenceManifest,
} from "./evidence-manifest.ts";
import {
  ParsedHtmlDocumentSchema,
  ParsedHtmlDocumentSummarySchema,
  parseDeterministicHtml,
  summarizeParsedHtmlDocument,
} from "./extraction-parser.ts";
import { HttpCaptureBundleSchema } from "./http-access-runtime.ts";
import { ObservationSchema } from "./observation-snapshot.ts";
import { RunPlanSchema } from "./run-state.ts";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import {
  SelectorCandidateSchema,
  SelectorFallbackPolicySchema,
  SelectorResolutionSchema,
  resolveSelectorPrecedence,
} from "./selector-engine.ts";
import { Extractor } from "./service-topology.ts";
import { SnapshotAssemblyResultSchema, buildObservationSnapshot } from "./snapshot-builder.ts";
import { ExtractionMismatch, ParserFailure } from "./tagged-errors.ts";

const NonEmptyFieldSchema = Schema.Trim.check(Schema.isNonEmpty());
const BoundedScoreSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);

type ArtifactMetadataRecord = Schema.Schema.Type<typeof ArtifactMetadataRecordSchema>;
type EvidenceFieldBinding = Schema.Schema.Type<typeof EvidenceFieldBindingSchema>;
type Observation = Schema.Schema.Type<typeof ObservationSchema>;
type SelectorCandidate = Schema.Schema.Type<typeof SelectorCandidateSchema>;
type SelectorResolution = Schema.Schema.Type<typeof SelectorResolutionSchema>;

const ExtractorFieldSelectorsSchema = Schema.Array(SelectorCandidateSchema).pipe(
  Schema.refine(
    (selectors): selectors is ReadonlyArray<SelectorCandidate> =>
      selectors.length > 0 && new Set(selectors.map(({ path }) => path)).size === selectors.length,
    {
      message:
        "Expected extractor field selectors with at least one candidate and unique selector paths.",
    },
  ),
);

export class ExtractorFieldConfig extends Schema.Class<ExtractorFieldConfig>(
  "ExtractorFieldConfig",
)({
  field: NonEmptyFieldSchema,
  selectors: ExtractorFieldSelectorsSchema,
  fallbackPolicy: Schema.optional(SelectorFallbackPolicySchema),
  normalizer: DomainNormalizationFieldSchema,
  confidence: Schema.optional(BoundedScoreSchema),
}) {}

const ExtractorFieldConfigsSchema = Schema.Array(ExtractorFieldConfig).pipe(
  Schema.refine(
    (fields): fields is ReadonlyArray<ExtractorFieldConfig> =>
      fields.length > 0 && new Set(fields.map(({ field }) => field)).size === fields.length,
    {
      message:
        "Expected extractor recipes with at least one field and without duplicate field names.",
    },
  ),
);

export class ExtractionRecipe extends Schema.Class<ExtractionRecipe>("ExtractionRecipe")({
  packId: CanonicalIdentifierSchema,
  fields: ExtractorFieldConfigsSchema,
  requiredFields: Schema.Array(RequiredFieldAssertionSchema),
  businessInvariants: Schema.Array(BusinessInvariantAssertionSchema),
}) {}

const ExtractionRecipesSchema = Schema.Array(ExtractionRecipe).pipe(
  Schema.refine(
    (recipes): recipes is ReadonlyArray<ExtractionRecipe> =>
      recipes.length > 0 &&
      new Set(recipes.map(({ packId }) => packId)).size === recipes.length &&
      recipes.every(
        (recipe) => recipe.requiredFields.length + recipe.businessInvariants.length > 0,
      ),
    {
      message:
        "Expected extractor recipes with unique pack ids and at least one assertion rule per recipe.",
    },
  ),
);

const ExtractorFieldBindingsSchema = Schema.Array(EvidenceFieldBindingSchema).pipe(
  Schema.refine(
    (bindings): bindings is ReadonlyArray<EvidenceFieldBinding> =>
      bindings.length > 0 && new Set(bindings.map(({ field }) => field)).size === bindings.length,
    {
      message:
        "Expected extractor field bindings with at least one field and without duplicate field entries.",
    },
  ),
);

export class ExtractorOrchestrationResult extends Schema.Class<ExtractorOrchestrationResult>(
  "ExtractorOrchestrationResult",
)({
  planId: CanonicalIdentifierSchema,
  recipePackId: CanonicalIdentifierSchema,
  documentArtifactId: CanonicalIdentifierSchema,
  documentSummary: ParsedHtmlDocumentSummarySchema,
  selectorResolutions: Schema.Array(SelectorResolutionSchema),
  fieldBindings: ExtractorFieldBindingsSchema,
  snapshotAssembly: SnapshotAssemblyResultSchema,
  assertionReport: AssertionReportSchema,
  evidenceManifest: EvidenceManifestSchema,
}) {}

const ExtractorOrchestrationInputSchema = Schema.Struct({
  plan: RunPlanSchema,
  artifacts: Schema.Array(ArtifactMetadataRecordSchema),
  recipe: ExtractionRecipe,
  createdAt: IsoDateTimeSchema,
});

export const ExtractorFieldConfigSchema = ExtractorFieldConfig;
export const ExtractionRecipeSchema = ExtractionRecipe;
export const ExtractorOrchestrationResultSchema = ExtractorOrchestrationResult;

export type ExtractorPayloadLoader = (
  artifact: ArtifactMetadataRecord,
) => Effect.Effect<string, ExtractionMismatch | ParserFailure>;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function locatorKey(artifact: { readonly locator: ArtifactMetadataRecord["locator"] }) {
  return `${artifact.locator.namespace}/${artifact.locator.key}`;
}

function roundBoundedScore(value: number) {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000;
}

function deriveObservationConfidence(field: ExtractorFieldConfig, resolution: SelectorResolution) {
  const baselineConfidence = field.confidence ?? 0.96;
  const pluralMatchPenalty = resolution.matchedCount > 1 ? 0.05 : 0;
  return roundBoundedScore(
    Math.min(baselineConfidence, resolution.confidence) - pluralMatchPenalty,
  );
}

function renderAssertionFailure(failure: AssertionFailure) {
  switch (failure.kind) {
    case "missingRequiredField":
      return failure.message;
    case "businessInvariantFailure":
      return `Field ${failure.context.field} violates extractor assertions.`;
  }
}

function selectDocumentArtifact(
  plan: Schema.Schema.Type<typeof RunPlanSchema>,
  artifacts: ReadonlyArray<ArtifactMetadataRecord>,
) {
  const preferredKinds =
    plan.steps.find(({ stage }) => stage === "capture")?.artifactKind === "renderedDom"
      ? ["renderedDom", "html"]
      : ["html", "renderedDom"];
  const documentArtifact = [...artifacts]
    .filter((artifact) => preferredKinds.includes(artifact.kind))
    .sort((left, right) => {
      const kindOrder = preferredKinds.indexOf(left.kind) - preferredKinds.indexOf(right.kind);
      if (kindOrder !== 0) {
        return kindOrder;
      }

      const locatorOrder = locatorKey(left).localeCompare(locatorKey(right));
      if (locatorOrder !== 0) {
        return locatorOrder;
      }

      return left.artifactId.localeCompare(right.artifactId);
    })[0];

  if (documentArtifact === undefined) {
    return Effect.fail(
      new ExtractionMismatch({
        message:
          "Extractor could not find an HTML or rendered DOM artifact in the provided capture set.",
      }),
    );
  }

  return Effect.succeed(documentArtifact);
}

function normalizeObservedValue(
  field: ExtractorFieldConfig,
  value: string,
): Effect.Effect<unknown, ExtractionMismatch> {
  const mapNormalizationFailure = <A>(
    effect: Effect.Effect<A, DomainNormalizationError, never>,
  ): Effect.Effect<A, ExtractionMismatch> =>
    effect.pipe(
      Effect.catchTag("DomainNormalizationError", ({ message }) =>
        Effect.fail(
          new ExtractionMismatch({
            message: `Failed to normalize field ${field.field}: ${message}`,
          }),
        ),
      ),
    );

  switch (field.normalizer) {
    case "availability":
      return mapNormalizationFailure(normalizeAvailability(value));
    case "currency":
      return mapNormalizationFailure(normalizeCurrency(value));
    case "date":
      return mapNormalizationFailure(normalizeDate(value));
    case "price":
      return mapNormalizationFailure(normalizePrice(value));
    case "productIdentifier":
      return mapNormalizationFailure(normalizeProductIdentifier(value));
    case "text":
      return mapNormalizationFailure(normalizeText(value));
  }
}

const buildFieldArtifacts = Effect.fn("ExtractorRuntime.buildFieldArtifacts")(function* (
  document: Schema.Schema.Type<typeof ParsedHtmlDocumentSchema>,
  recipe: ExtractionRecipe,
  documentArtifact: ArtifactMetadataRecord,
) {
  const selectorResolutions: Array<SelectorResolution> = [];
  const fieldBindings: Array<EvidenceFieldBinding> = [];
  const observations: Array<Observation> = [];

  for (const field of recipe.fields) {
    const resolution = yield* resolveSelectorPrecedence({
      document,
      candidates: field.selectors,
      fallbackPolicy: field.fallbackPolicy,
    });
    const confidence = deriveObservationConfidence(field, resolution);
    selectorResolutions.push(resolution);
    fieldBindings.push(
      Schema.decodeUnknownSync(EvidenceFieldBindingSchema)({
        field: field.field,
        selectorResolutions: [resolution],
      }),
    );

    for (const value of resolution.values) {
      const normalizedValue = yield* normalizeObservedValue(field, value);
      observations.push(
        Schema.decodeUnknownSync(ObservationSchema)({
          field: field.field,
          normalizedValue,
          confidence,
          evidenceRefs: [documentArtifact.artifactId],
        }),
      );
    }
  }

  return {
    selectorResolutions,
    fieldBindings: Schema.decodeUnknownSync(ExtractorFieldBindingsSchema)(fieldBindings),
    observations,
  };
});

export function makeHttpCapturePayloadLoader(bundle: unknown): ExtractorPayloadLoader {
  const decodedBundle = Schema.decodeUnknownSync(HttpCaptureBundleSchema)(bundle);
  const payloadsByLocator = new Map(
    decodedBundle.payloads.map((payload) => [locatorKey(payload), payload] as const),
  );

  return Effect.fn("ExtractorRuntime.makeHttpCapturePayloadLoader")(function* (
    artifact: ArtifactMetadataRecord,
  ) {
    const payload = payloadsByLocator.get(locatorKey(artifact));
    if (payload === undefined) {
      return yield* Effect.fail(
        new ExtractionMismatch({
          message: `Capture payload for artifact ${artifact.artifactId} is missing from the provided bundle.`,
        }),
      );
    }

    return payload.body;
  });
}

export function runExtractorOrchestration(input: unknown, loadPayload: ExtractorPayloadLoader) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(ExtractorOrchestrationInputSchema)(input),
      catch: (cause) =>
        new ParserFailure({
          message: readCauseMessage(cause, "Failed to decode extractor orchestration input."),
        }),
    });
    const documentArtifact = yield* selectDocumentArtifact(decoded.plan, decoded.artifacts);
    const html = yield* loadPayload(documentArtifact);
    const document = yield* parseDeterministicHtml({
      documentId: documentArtifact.artifactId,
      html,
    });
    const extracted = yield* buildFieldArtifacts(document, decoded.recipe, documentArtifact);
    const snapshotAssembly = yield* buildObservationSnapshot({
      id: `${decoded.plan.id}-snapshot`,
      targetId: decoded.plan.targetId,
      observations: extracted.observations,
      createdAt: decoded.createdAt,
    }).pipe(
      Effect.catchTag("SnapshotBuilderFailure", ({ message }) =>
        Effect.fail(
          new ExtractionMismatch({
            message: `Failed to assemble extraction snapshot: ${message}`,
          }),
        ),
      ),
    );
    const assertionReport = yield* runAssertionEngine({
      snapshot: snapshotAssembly.snapshot,
      requiredFields: decoded.recipe.requiredFields,
      businessInvariants: decoded.recipe.businessInvariants,
    }).pipe(
      Effect.catchTag("AssertionEngineFailure", ({ failures }) =>
        Effect.fail(
          new ExtractionMismatch({
            message: `Extraction assertions failed: ${failures.map(renderAssertionFailure).join("; ")}`,
          }),
        ),
      ),
    );
    const evidenceManifest = yield* generateEvidenceManifest({
      snapshot: snapshotAssembly.snapshot,
      document,
      artifacts: decoded.artifacts,
      fieldBindings: extracted.fieldBindings,
    });

    return Schema.decodeUnknownSync(ExtractorOrchestrationResultSchema)({
      planId: decoded.plan.id,
      recipePackId: decoded.recipe.packId,
      documentArtifactId: documentArtifact.artifactId,
      documentSummary: summarizeParsedHtmlDocument(document),
      selectorResolutions: extracted.selectorResolutions,
      fieldBindings: extracted.fieldBindings,
      snapshotAssembly,
      assertionReport,
      evidenceManifest,
    });
  });
}

export function makeExtractor(
  recipes: ReadonlyArray<ExtractionRecipe>,
  loadPayload: ExtractorPayloadLoader,
  now: () => Date = () => new Date(),
) {
  const decodedRecipes = Schema.decodeUnknownSync(ExtractionRecipesSchema)(recipes);
  const recipesByPackId = new Map(decodedRecipes.map((recipe) => [recipe.packId, recipe] as const));

  const extract = Effect.fn("ExtractorLive.extract")(function* (
    plan: Schema.Schema.Type<typeof RunPlanSchema>,
    artifacts: ReadonlyArray<ArtifactMetadataRecord>,
  ) {
    const recipe = recipesByPackId.get(plan.packId);
    if (recipe === undefined) {
      return yield* Effect.fail(
        new ExtractionMismatch({
          message: `Extractor does not have a configured recipe for pack ${plan.packId}.`,
        }),
      );
    }

    const result = yield* runExtractorOrchestration(
      {
        plan,
        artifacts,
        recipe,
        createdAt: now().toISOString(),
      },
      loadPayload,
    );

    return result.snapshotAssembly.snapshot;
  });

  return Extractor.of({ extract });
}

export function ExtractorLive(
  recipes: ReadonlyArray<ExtractionRecipe>,
  loadPayload: ExtractorPayloadLoader,
  now: () => Date = () => new Date(),
) {
  return Layer.succeed(Extractor)(makeExtractor(recipes, loadPayload, now));
}

export type ExtractorFieldConfigEncoded = Schema.Codec.Encoded<typeof ExtractorFieldConfigSchema>;
export type ExtractionRecipeEncoded = Schema.Codec.Encoded<typeof ExtractionRecipeSchema>;
export type ExtractorOrchestrationResultEncoded = Schema.Codec.Encoded<
  typeof ExtractorOrchestrationResultSchema
>;
export type ExtractorFieldNormalizer = DomainNormalizationField;
export type RequiredFieldAssertion = Schema.Schema.Type<typeof RequiredFieldAssertionSchema>;
export type BusinessInvariant = BusinessInvariantAssertion;
