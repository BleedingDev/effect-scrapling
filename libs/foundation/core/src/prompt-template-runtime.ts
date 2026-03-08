import { Effect, Schema } from "effect";
import { ArtifactKindSchema } from "./budget-lease-artifact.ts";
import {
  PromptModelInvocation,
  PromptModelRequestSchema,
  makeDisabledPromptModelProvider,
} from "./llm-provider-runtime.ts";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import { REDACTED_SECRET_VALUE, containsUnsanitizedSecretMaterial } from "./secret-sanitization.ts";
import { PromptModelProvider } from "./service-topology.ts";
import { PolicyViolation } from "./tagged-errors.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const PromptRouteSchema = Schema.Literal("shadowValidation");
const PromptTemplateKindSchema = Schema.Literals([
  "scaffoldDriftDiagnosis",
  "anomalyExpansion",
] as const);
const PromptArtifactVisibilitySchema = Schema.Literal("redacted");

export class PromptTemplateArtifact extends Schema.Class<PromptTemplateArtifact>(
  "PromptTemplateArtifact",
)({
  artifactId: CanonicalIdentifierSchema,
  artifactKind: ArtifactKindSchema,
  sourceVisibility: PromptArtifactVisibilitySchema,
  mediaType: NonEmptyStringSchema,
  body: NonEmptyStringSchema,
}) {}

const PromptArtifactListSchema = Schema.Array(PromptTemplateArtifact).pipe(
  Schema.refine(
    (artifacts): artifacts is ReadonlyArray<PromptTemplateArtifact> =>
      artifacts.length > 0 &&
      new Set(artifacts.map(({ artifactId }) => artifactId)).size === artifacts.length,
    {
      message: "Expected at least one unique redacted artifact for prompt-template execution.",
    },
  ),
);

export class PromptTemplateInput extends Schema.Class<PromptTemplateInput>("PromptTemplateInput")({
  templateId: CanonicalIdentifierSchema,
  packId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  kind: PromptTemplateKindSchema,
  artifacts: PromptArtifactListSchema,
}) {}

export class PromptTemplateRender extends Schema.Class<PromptTemplateRender>(
  "PromptTemplateRender",
)({
  templateId: CanonicalIdentifierSchema,
  route: PromptRouteSchema,
  prompt: NonEmptyStringSchema,
  request: PromptModelRequestSchema,
}) {}

export const PromptTemplateKindSchemaExport = PromptTemplateKindSchema;
export const PromptTemplateInputSchema = PromptTemplateInput;
export const PromptTemplateRenderSchema = PromptTemplateRender;

function validatePromptTemplateArtifacts(artifacts: ReadonlyArray<PromptTemplateArtifact>) {
  return Effect.forEach(artifacts, (artifact) =>
    containsUnsanitizedSecretMaterial(artifact.body)
      ? Effect.fail(
          new PolicyViolation({
            message:
              "Prompt templates only accept sanitized redacted artifacts; unsanitized secret material was detected.",
          }),
        )
      : Effect.void,
  ).pipe(Effect.asVoid);
}

function buildPrompt(input: Schema.Schema.Type<typeof PromptTemplateInputSchema>) {
  const artifactBlocks = input.artifacts.map((artifact) =>
    [
      `Artifact: ${artifact.artifactId}`,
      `Kind: ${artifact.artifactKind}`,
      `Visibility: ${artifact.sourceVisibility}`,
      `MediaType: ${artifact.mediaType}`,
      "Body:",
      artifact.body,
    ].join("\n"),
  );

  const templateHeading =
    input.kind === "scaffoldDriftDiagnosis"
      ? "Diagnose scaffold drift from redacted evidence only."
      : "Expand anomaly hypotheses from redacted evidence only.";

  return [
    "Route: shadowValidation",
    `TemplateId: ${input.templateId}`,
    `PackId: ${input.packId}`,
    `GeneratedAt: ${input.generatedAt}`,
    `Mode: ${input.kind}`,
    templateHeading,
    `Redaction sentinel: ${REDACTED_SECRET_VALUE}`,
    "Return JSON that matches the shared prompt-model completion schema.",
    ...artifactBlocks,
  ].join("\n\n");
}

export const renderPromptTemplate = Effect.fn("PromptTemplate.render")(function* (input: unknown) {
  const decodedInput: PromptTemplateInput = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(PromptTemplateInputSchema)(input),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode prompt-template input through shared contracts.",
      }),
  });
  yield* validatePromptTemplateArtifacts(decodedInput.artifacts);

  const prompt = buildPrompt(decodedInput);
  const request = Schema.decodeUnknownSync(PromptModelRequestSchema)({
    requestId: `${decodedInput.templateId}-request`,
    templateId: decodedInput.templateId,
    packId: decodedInput.packId,
    generatedAt: decodedInput.generatedAt,
    route: "shadowValidation",
    modelPurpose: decodedInput.kind,
    artifactIds: decodedInput.artifacts.map(({ artifactId }) => artifactId),
    prompt,
  });

  return Schema.decodeUnknownSync(PromptTemplateRenderSchema)({
    templateId: decodedInput.templateId,
    route: "shadowValidation",
    prompt,
    request,
  });
});

export const runPromptTemplateWithProvider = Effect.fn("PromptTemplate.runWithProvider")(function* (
  input: unknown,
) {
  const rendered = yield* renderPromptTemplate(input);
  const provider = yield* PromptModelProvider;
  return yield* provider.invoke(rendered.request);
});

export function runPromptTemplate(input: unknown) {
  const provider = makeDisabledPromptModelProvider();

  return renderPromptTemplate(input).pipe(
    Effect.flatMap((rendered) => provider.invoke(rendered.request)),
  );
}

export type PromptModelInvocationResult = PromptModelInvocation;
