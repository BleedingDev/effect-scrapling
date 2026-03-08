import { Effect, Layer, Schema } from "effect";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import { PromptModelProvider } from "./service-topology.ts";
import { PolicyViolation, ProviderUnavailable } from "./tagged-errors.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const PromptRouteSchema = Schema.Literal("shadowValidation");
const PromptModelPurposeSchema = Schema.Literals([
  "scaffoldDriftDiagnosis",
  "anomalyExpansion",
] as const);
const PromptModelProviderStatusSchema = Schema.Literals(["disabled", "completed"] as const);
const UniqueIdentifierListSchema = Schema.Array(CanonicalIdentifierSchema).pipe(
  Schema.refine(
    (ids): ids is ReadonlyArray<string> => ids.length > 0 && new Set(ids).size === ids.length,
    {
      message: "Expected unique evidence identifiers for prompt-model requests.",
    },
  ),
);
const UniqueSelectorPathListSchema = Schema.Array(NonEmptyStringSchema).pipe(
  Schema.refine((paths): paths is ReadonlyArray<string> => new Set(paths).size === paths.length, {
    message: "Expected unique selector paths in prompt-model completions.",
  }),
);

export class PromptModelRequest extends Schema.Class<PromptModelRequest>("PromptModelRequest")({
  requestId: CanonicalIdentifierSchema,
  templateId: CanonicalIdentifierSchema,
  packId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  route: PromptRouteSchema,
  modelPurpose: PromptModelPurposeSchema,
  artifactIds: UniqueIdentifierListSchema,
  prompt: NonEmptyStringSchema,
}) {}

export class PromptModelFinding extends Schema.Class<PromptModelFinding>("PromptModelFinding")({
  kind: Schema.Literals(["selectorDrift", "schemaGap", "anomaly"] as const),
  summary: NonEmptyStringSchema,
}) {}

export class PromptModelCompletion extends Schema.Class<PromptModelCompletion>(
  "PromptModelCompletion",
)({
  route: PromptRouteSchema,
  summary: NonEmptyStringSchema,
  findings: Schema.Array(PromptModelFinding),
  candidateSelectorPaths: UniqueSelectorPathListSchema,
}) {}

export class PromptModelInvocation extends Schema.Class<PromptModelInvocation>(
  "PromptModelInvocation",
)({
  providerId: CanonicalIdentifierSchema,
  modelId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  request: PromptModelRequest,
  status: PromptModelProviderStatusSchema,
  reason: Schema.optional(NonEmptyStringSchema),
  response: Schema.optional(PromptModelCompletion),
}) {}

export const PromptModelRequestSchema = PromptModelRequest;
export const PromptModelFindingSchema = PromptModelFinding;
export const PromptModelCompletionSchema = PromptModelCompletion;
export const PromptModelInvocationSchema = PromptModelInvocation;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

export function makeDisabledPromptModelProvider(options?: {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly now?: () => Date;
}) {
  const providerId = options?.providerId ?? "provider-prompt-disabled";
  const modelId = options?.modelId ?? "model-prompt-disabled";
  const now = options?.now ?? (() => new Date());

  const invoke = (request: PromptModelRequest) =>
    Effect.sync(() =>
      Schema.decodeUnknownSync(PromptModelInvocationSchema)({
        providerId,
        modelId,
        generatedAt: now().toISOString(),
        request,
        status: "disabled",
        reason: "Prompt model provider is disabled by configuration.",
      }),
    );

  return PromptModelProvider.of({ invoke });
}

export function makeOptionalPromptModelProvider(options: {
  readonly providerId: string;
  readonly modelId: string;
  readonly now?: () => Date;
  readonly invoke: (request: PromptModelRequest) => Promise<unknown> | unknown;
}) {
  const now = options.now ?? (() => new Date());

  const invoke = Effect.fn("PromptModelProvider.invoke")(function* (request: PromptModelRequest) {
    const rawResponse = yield* Effect.tryPromise({
      try: () => Promise.resolve(options.invoke(request)),
      catch: (cause) =>
        new ProviderUnavailable({
          message: readCauseMessage(cause, "Prompt model provider invocation failed."),
        }),
    });
    const decodedResponse = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(PromptModelCompletionSchema)(rawResponse),
      catch: (cause) =>
        new PolicyViolation({
          message: `Prompt model provider returned a payload that failed schema validation: ${readCauseMessage(
            cause,
            "schema decode failed",
          )}`,
        }),
    });

    return Schema.decodeUnknownSync(PromptModelInvocationSchema)({
      providerId: options.providerId,
      modelId: options.modelId,
      generatedAt: now().toISOString(),
      request,
      status: "completed",
      response: decodedResponse,
    });
  });

  return PromptModelProvider.of({ invoke });
}

export function PromptModelProviderDisabledLive(options?: {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly now?: () => Date;
}) {
  return Layer.succeed(PromptModelProvider)(makeDisabledPromptModelProvider(options));
}
