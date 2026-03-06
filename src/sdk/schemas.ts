import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonEmptyTrimmedString = Schema.Trim.check(Schema.isNonEmpty());
const AccessModeSchema = Schema.Literals(["http", "browser"] as const);
const BrowserWaitUntilSchema = Schema.Literals([
  "load",
  "domcontentloaded",
  "networkidle",
  "commit",
] as const);

export const DEFAULT_ACCESS_MODE = "http";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_SELECTOR = "title";
export const DEFAULT_LIMIT = 20;
export const DEFAULT_BROWSER_WAIT_UNTIL = "networkidle";
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

export const BrowserOptionsSchema = Schema.Struct({
  waitUntil: Schema.optional(BrowserWaitUntilInputSchema),
  timeoutMs: Schema.optional(PositiveIntInputSchema),
  userAgent: Schema.optional(NonEmptyTrimmedString),
});

export const AccessPreviewRequestSchema = Schema.Struct({
  url: NonEmptyTrimmedString,
  mode: AccessModeInputSchema.pipe(Schema.withDecodingDefault(() => DEFAULT_ACCESS_MODE)),
  timeoutMs: PositiveIntInputSchema.pipe(Schema.withDecodingDefault(() => DEFAULT_TIMEOUT_MS)),
  userAgent: Schema.optional(NonEmptyTrimmedString),
  browser: Schema.optional(BrowserOptionsSchema),
});

export const ExtractRunRequestSchema = Schema.Struct({
  url: NonEmptyTrimmedString,
  mode: AccessModeInputSchema.pipe(Schema.withDecodingDefault(() => DEFAULT_ACCESS_MODE)),
  selector: NonEmptyTrimmedString.pipe(Schema.withDecodingDefault(() => DEFAULT_SELECTOR)),
  attr: Schema.optional(NonEmptyTrimmedString),
  all: BooleanInputSchema.pipe(Schema.withDecodingDefault(() => false)),
  limit: PositiveIntInputSchema.pipe(Schema.withDecodingDefault(() => DEFAULT_LIMIT)),
  timeoutMs: PositiveIntInputSchema.pipe(Schema.withDecodingDefault(() => DEFAULT_TIMEOUT_MS)),
  userAgent: Schema.optional(NonEmptyTrimmedString),
  browser: Schema.optional(BrowserOptionsSchema),
});

export const AccessPreviewResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("access preview"),
  data: Schema.Struct({
    url: Schema.String,
    status: PositiveInt,
    finalUrl: Schema.String,
    contentType: Schema.String,
    contentLength: PositiveInt,
    durationMs: PositiveInt,
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
    durationMs: PositiveInt,
  }),
  warnings: Schema.Array(Schema.String),
});

export type AccessPreviewRequest = Schema.Schema.Type<typeof AccessPreviewRequestSchema>;
export type ExtractRunRequest = Schema.Schema.Type<typeof ExtractRunRequestSchema>;
export type AccessPreviewResponse = Schema.Schema.Type<typeof AccessPreviewResponseSchema>;
export type ExtractRunResponse = Schema.Schema.Type<typeof ExtractRunResponseSchema>;
export type AccessMode = Schema.Schema.Type<typeof AccessModeSchema>;
export type BrowserWaitUntil = Schema.Schema.Type<typeof BrowserWaitUntilSchema>;
export type BrowserOptions = Schema.Schema.Type<typeof BrowserOptionsSchema>;
