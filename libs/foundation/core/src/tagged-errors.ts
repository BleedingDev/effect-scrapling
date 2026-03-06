import { Data, Match, Schema } from "effect";

const NonEmptyMessageSchema = Schema.Trim.check(Schema.isNonEmpty());

export const CoreErrorCodeSchema = Schema.Literals([
  "timeout",
  "render_crash",
  "parser_failure",
  "extraction_mismatch",
  "drift_detected",
  "checkpoint_corruption",
  "policy_violation",
  "provider_unavailable",
] as const);

export const CoreErrorEnvelopeSchema = Schema.Struct({
  code: CoreErrorCodeSchema,
  retryable: Schema.Boolean,
  message: NonEmptyMessageSchema,
});

export class TimeoutError extends Data.TaggedError("TimeoutError")<{
  readonly message: string;
}> {}

export class RenderCrashError extends Data.TaggedError("RenderCrashError")<{
  readonly message: string;
}> {}

export class ParserFailure extends Data.TaggedError("ParserFailure")<{
  readonly message: string;
}> {}

export class ExtractionMismatch extends Data.TaggedError("ExtractionMismatch")<{
  readonly message: string;
}> {}

export class DriftDetected extends Data.TaggedError("DriftDetected")<{
  readonly message: string;
}> {}

export class CheckpointCorruption extends Data.TaggedError("CheckpointCorruption")<{
  readonly message: string;
}> {}

export class PolicyViolation extends Data.TaggedError("PolicyViolation")<{
  readonly message: string;
}> {}

export class ProviderUnavailable extends Data.TaggedError("ProviderUnavailable")<{
  readonly message: string;
}> {}

export type CoreTaggedError =
  | TimeoutError
  | RenderCrashError
  | ParserFailure
  | ExtractionMismatch
  | DriftDetected
  | CheckpointCorruption
  | PolicyViolation
  | ProviderUnavailable;

export type CoreErrorCode = Schema.Schema.Type<typeof CoreErrorCodeSchema>;
export type CoreErrorEnvelope = Schema.Schema.Type<typeof CoreErrorEnvelopeSchema>;

function toEnvelope(code: CoreErrorCode, retryable: boolean, message: string): CoreErrorEnvelope {
  return Schema.decodeUnknownSync(CoreErrorEnvelopeSchema)({
    code,
    retryable,
    message,
  });
}

export const toCoreErrorEnvelope = Match.type<CoreTaggedError>().pipe(
  Match.tag("TimeoutError", ({ message }) => toEnvelope("timeout", true, message)),
  Match.tag("RenderCrashError", ({ message }) => toEnvelope("render_crash", true, message)),
  Match.tag("ParserFailure", ({ message }) => toEnvelope("parser_failure", false, message)),
  Match.tag("ExtractionMismatch", ({ message }) =>
    toEnvelope("extraction_mismatch", false, message),
  ),
  Match.tag("DriftDetected", ({ message }) => toEnvelope("drift_detected", false, message)),
  Match.tag("CheckpointCorruption", ({ message }) =>
    toEnvelope("checkpoint_corruption", false, message),
  ),
  Match.tag("PolicyViolation", ({ message }) => toEnvelope("policy_violation", false, message)),
  Match.tag("ProviderUnavailable", ({ message }) =>
    toEnvelope("provider_unavailable", true, message),
  ),
  Match.exhaustive,
);
