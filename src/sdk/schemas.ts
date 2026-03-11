import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const NonEmptyTrimmedString = Schema.Trim.check(Schema.isNonEmpty());

export const AccessModeSchema = Schema.Literals(["http", "browser"] as const);
export const AccessProviderIdSchema = NonEmptyTrimmedString;
export const BrowserWaitUntilSchema = Schema.Literals([
  "load",
  "domcontentloaded",
  "networkidle",
  "commit",
] as const);
export const EgressRouteKindSchema = NonEmptyTrimmedString;

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_SELECTOR = "title";
export const DEFAULT_LIMIT = 20;
export const DEFAULT_BROWSER_WAIT_UNTIL = "domcontentloaded";

const BrowserRuntimeProfileIdSchema = NonEmptyTrimmedString;
const PositiveIntFromString = Schema.FiniteFromString.check(Schema.isInt()).check(
  Schema.isGreaterThan(0),
);

const PositiveIntInputSchema = Schema.Union([
  PositiveInt,
  Schema.Trim.pipe(
    Schema.check(Schema.isPattern(/^\d+$/u)),
    Schema.decodeTo(PositiveIntFromString, {
      decode: SchemaGetter.passthrough(),
      encode: SchemaGetter.String(),
    }),
  ),
]);

const BrowserWaitUntilInputSchema = Schema.Trim.pipe(
  Schema.decodeTo(BrowserWaitUntilSchema, {
    decode: SchemaGetter.transformOrFail((value) => {
      if (
        value === "load" ||
        value === "domcontentloaded" ||
        value === "networkidle" ||
        value === "commit"
      ) {
        return Effect.succeed(value);
      }

      return Effect.fail(new SchemaIssue.InvalidValue(Option.some(value)));
    }),
    encode: SchemaGetter.String(),
  }),
);

const AccessProviderIdInputSchema = NonEmptyTrimmedString;
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown);

const AccessModeInputSchema = Schema.Trim.pipe(
  Schema.decodeTo(AccessModeSchema, {
    decode: SchemaGetter.transformOrFail((value) => {
      if (value === "http" || value === "browser") {
        return Effect.succeed(value);
      }

      return Effect.fail(new SchemaIssue.InvalidValue(Option.some(value)));
    }),
    encode: SchemaGetter.String(),
  }),
);

const BooleanInputSchema = Schema.Union([
  Schema.Boolean,
  Schema.Trim.pipe(
    Schema.decodeTo(Schema.Boolean, {
      decode: SchemaGetter.transformOrFail((value) => {
        const normalized = value.toLowerCase();
        if (normalized === "true") {
          return Effect.succeed(true);
        }
        if (normalized === "false") {
          return Effect.succeed(false);
        }
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(value)));
      }),
      encode: SchemaGetter.transform((value) => (value ? "true" : "false")),
    }),
  ),
]);

export const BrowserExecutionOptionsSchema = Schema.Struct({
  waitUntil: Schema.optional(BrowserWaitUntilInputSchema),
  timeoutMs: Schema.optional(PositiveIntInputSchema),
  userAgent: Schema.optional(NonEmptyTrimmedString),
});

export const HttpExecutionOptionsSchema = Schema.Struct({
  userAgent: Schema.optional(NonEmptyTrimmedString),
});

export const AccessProfileSelectorSchema = Schema.Struct({
  profileId: Schema.optional(NonEmptyTrimmedString),
  pluginConfig: Schema.optional(JsonObjectSchema),
});

export const AccessExecutionFallbackSchema = Schema.Struct({
  browserOnAccessWall: BooleanInputSchema.pipe(Schema.withDecodingDefault(() => false)),
});

export const AccessExecutionProfileSchema = Schema.Struct({
  mode: Schema.optional(AccessModeInputSchema),
  providerId: Schema.optional(AccessProviderIdInputSchema),
  egress: Schema.optional(AccessProfileSelectorSchema),
  identity: Schema.optional(AccessProfileSelectorSchema),
  browserRuntimeProfileId: Schema.optional(BrowserRuntimeProfileIdSchema),
  http: Schema.optional(HttpExecutionOptionsSchema),
  browser: Schema.optional(BrowserExecutionOptionsSchema),
  fallback: Schema.optional(AccessExecutionFallbackSchema),
});

export const AccessPreviewRequestSchema = Schema.Struct({
  url: NonEmptyTrimmedString,
  timeoutMs: PositiveIntInputSchema.pipe(Schema.withDecodingDefault(() => DEFAULT_TIMEOUT_MS)),
  execution: Schema.optional(AccessExecutionProfileSchema),
});

export const RenderPreviewRequestSchema = Schema.Struct({
  url: NonEmptyTrimmedString,
  timeoutMs: PositiveIntInputSchema.pipe(Schema.withDecodingDefault(() => DEFAULT_TIMEOUT_MS)),
  execution: Schema.optional(AccessExecutionProfileSchema),
});

export const ExtractRunRequestSchema = Schema.Struct({
  url: NonEmptyTrimmedString,
  selector: NonEmptyTrimmedString.pipe(Schema.withDecodingDefault(() => DEFAULT_SELECTOR)),
  attr: Schema.optional(NonEmptyTrimmedString),
  all: BooleanInputSchema.pipe(Schema.withDecodingDefault(() => false)),
  limit: PositiveIntInputSchema.pipe(Schema.withDecodingDefault(() => DEFAULT_LIMIT)),
  timeoutMs: PositiveIntInputSchema.pipe(Schema.withDecodingDefault(() => DEFAULT_TIMEOUT_MS)),
  execution: Schema.optional(AccessExecutionProfileSchema),
});

export const AccessExecutionMetadataSchema = Schema.Struct({
  providerId: AccessProviderIdSchema,
  mode: AccessModeSchema,
  egressProfileId: NonEmptyTrimmedString,
  egressPluginId: NonEmptyTrimmedString,
  egressRouteKind: EgressRouteKindSchema,
  egressRouteKey: NonEmptyTrimmedString,
  egressPoolId: NonEmptyTrimmedString,
  egressRoutePolicyId: NonEmptyTrimmedString,
  egressKey: NonEmptyTrimmedString,
  identityProfileId: NonEmptyTrimmedString,
  identityPluginId: NonEmptyTrimmedString,
  identityTenantId: NonEmptyTrimmedString,
  identityKey: NonEmptyTrimmedString,
  browserRuntimeProfileId: Schema.optional(BrowserRuntimeProfileIdSchema),
  browserPoolKey: Schema.optional(NonEmptyTrimmedString),
});

export const AccessPreviewResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("access preview"),
  data: Schema.Struct({
    url: Schema.String,
    status: PositiveInt,
    finalUrl: Schema.String,
    contentType: Schema.String,
    contentLength: NonNegativeInt,
    durationMs: NonNegativeNumber,
    execution: AccessExecutionMetadataSchema,
    timings: Schema.optional(
      Schema.Struct({
        requestCount: PositiveInt,
        redirectCount: NonNegativeInt,
        blockedRequestCount: Schema.optional(NonNegativeInt),
        responseHeadersDurationMs: Schema.optional(NonNegativeNumber),
        bodyReadDurationMs: Schema.optional(NonNegativeNumber),
        routeRegistrationDurationMs: Schema.optional(NonNegativeNumber),
        gotoDurationMs: Schema.optional(NonNegativeNumber),
        loadStateDurationMs: Schema.optional(NonNegativeNumber),
        domReadDurationMs: Schema.optional(NonNegativeNumber),
        headerReadDurationMs: Schema.optional(NonNegativeNumber),
      }),
    ),
  }),
  warnings: Schema.Array(Schema.String),
});

const RenderPreviewStatusFamilySchema = Schema.Literals([
  "informational",
  "success",
  "redirect",
  "clientError",
  "serverError",
] as const);

const RenderPreviewStatusSchema = Schema.Struct({
  code: PositiveInt,
  ok: Schema.Boolean,
  redirected: Schema.Boolean,
  family: RenderPreviewStatusFamilySchema,
});

const RenderPreviewNavigationArtifactSchema = Schema.Struct({
  kind: Schema.Literal("navigation"),
  mediaType: Schema.Literal("application/json"),
  finalUrl: Schema.String,
  contentType: Schema.String,
  contentLength: NonNegativeInt,
});

const RenderPreviewRenderedDomArtifactSchema = Schema.Struct({
  kind: Schema.Literal("renderedDom"),
  mediaType: Schema.Literal("application/json"),
  title: Schema.NullOr(Schema.String),
  textPreview: Schema.String,
  linkTargets: Schema.Array(Schema.String),
  hiddenFieldCount: NonNegativeInt,
});

const RenderPreviewTimingsArtifactSchema = Schema.Struct({
  kind: Schema.Literal("timings"),
  mediaType: Schema.Literal("application/json"),
  durationMs: NonNegativeNumber,
  requestCount: Schema.optional(PositiveInt),
  redirectCount: Schema.optional(NonNegativeInt),
  blockedRequestCount: Schema.optional(NonNegativeInt),
  responseHeadersDurationMs: Schema.optional(NonNegativeNumber),
  bodyReadDurationMs: Schema.optional(NonNegativeNumber),
  routeRegistrationDurationMs: Schema.optional(NonNegativeNumber),
  gotoDurationMs: Schema.optional(NonNegativeNumber),
  loadStateDurationMs: Schema.optional(NonNegativeNumber),
  domReadDurationMs: Schema.optional(NonNegativeNumber),
  headerReadDurationMs: Schema.optional(NonNegativeNumber),
});

export const RenderPreviewArtifactBundleSchema = Schema.Tuple([
  RenderPreviewNavigationArtifactSchema,
  RenderPreviewRenderedDomArtifactSchema,
  RenderPreviewTimingsArtifactSchema,
]);

export const RenderPreviewResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("render preview"),
  data: Schema.Struct({
    url: Schema.String,
    execution: AccessExecutionMetadataSchema,
    status: RenderPreviewStatusSchema,
    artifacts: RenderPreviewArtifactBundleSchema,
  }),
  warnings: Schema.Array(Schema.String),
});

export const ExtractRunResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("extract run"),
  data: Schema.Struct({
    url: Schema.String,
    selector: Schema.String,
    attr: Schema.NullOr(Schema.String),
    count: Schema.Number,
    values: Schema.Array(Schema.String),
    durationMs: NonNegativeNumber,
    execution: AccessExecutionMetadataSchema,
  }),
  warnings: Schema.Array(Schema.String),
});

export type AccessPreviewRequest = Schema.Schema.Type<typeof AccessPreviewRequestSchema>;
export type RenderPreviewRequest = Schema.Schema.Type<typeof RenderPreviewRequestSchema>;
export type ExtractRunRequest = Schema.Schema.Type<typeof ExtractRunRequestSchema>;
export type AccessPreviewResponse = Schema.Schema.Type<typeof AccessPreviewResponseSchema>;
export type RenderPreviewResponse = Schema.Schema.Type<typeof RenderPreviewResponseSchema>;
export type ExtractRunResponse = Schema.Schema.Type<typeof ExtractRunResponseSchema>;
export type AccessMode = Schema.Schema.Type<typeof AccessModeSchema>;
export type AccessProviderId = Schema.Schema.Type<typeof AccessProviderIdSchema>;
export type AccessProfileSelector = Schema.Schema.Type<typeof AccessProfileSelectorSchema>;
export type AccessExecutionFallback = Schema.Schema.Type<typeof AccessExecutionFallbackSchema>;
export type BrowserWaitUntil = Schema.Schema.Type<typeof BrowserWaitUntilSchema>;
export type BrowserRuntimeProfileId = Schema.Schema.Type<typeof BrowserRuntimeProfileIdSchema>;
export type BrowserExecutionOptions = Schema.Schema.Type<typeof BrowserExecutionOptionsSchema>;
export type HttpExecutionOptions = Schema.Schema.Type<typeof HttpExecutionOptionsSchema>;
export type AccessExecutionProfile = Schema.Schema.Type<typeof AccessExecutionProfileSchema>;
export type AccessExecutionMetadata = Schema.Schema.Type<typeof AccessExecutionMetadataSchema>;
