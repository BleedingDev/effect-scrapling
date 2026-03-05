import { Schema } from "effect";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonEmptyTrimmedString = Schema.Trim.check(Schema.isNonEmpty());
const AccessModeSchema = Schema.Literals(["http", "browser"] as const);
const BrowserWaitUntilSchema = Schema.Literals([
  "load",
  "domcontentloaded",
  "networkidle",
  "commit",
] as const);

export const BrowserOptionsSchema = Schema.Struct({
  waitUntil: Schema.optional(BrowserWaitUntilSchema),
  timeoutMs: Schema.optional(PositiveInt),
  userAgent: Schema.optional(NonEmptyTrimmedString),
});

export const AccessPreviewRequestSchema = Schema.Struct({
  url: NonEmptyTrimmedString,
  mode: Schema.optional(AccessModeSchema),
  timeoutMs: Schema.optional(PositiveInt),
  userAgent: Schema.optional(NonEmptyTrimmedString),
  browser: Schema.optional(BrowserOptionsSchema),
});

export const ExtractRunRequestSchema = Schema.Struct({
  url: NonEmptyTrimmedString,
  mode: Schema.optional(AccessModeSchema),
  selector: Schema.optional(NonEmptyTrimmedString),
  attr: Schema.optional(NonEmptyTrimmedString),
  all: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PositiveInt),
  timeoutMs: Schema.optional(PositiveInt),
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
