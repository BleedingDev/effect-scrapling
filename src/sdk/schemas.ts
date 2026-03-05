import { Schema } from "effect";

const PositiveInt = Schema.Number.pipe(Schema.int(), Schema.positive());

export const AccessPreviewRequestSchema = Schema.Struct({
  url: Schema.NonEmptyTrimmedString,
  timeoutMs: Schema.optional(PositiveInt),
  userAgent: Schema.optional(Schema.NonEmptyTrimmedString),
});

export const ExtractRunRequestSchema = Schema.Struct({
  url: Schema.NonEmptyTrimmedString,
  selector: Schema.optional(Schema.NonEmptyTrimmedString),
  attr: Schema.optional(Schema.NonEmptyTrimmedString),
  all: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PositiveInt),
  timeoutMs: Schema.optional(PositiveInt),
  userAgent: Schema.optional(Schema.NonEmptyTrimmedString),
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
