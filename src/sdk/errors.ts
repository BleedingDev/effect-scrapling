import { Data } from "effect";

export class InvalidInputError extends Data.TaggedError("InvalidInputError")<{
  readonly message: string;
  readonly details?: string;
}> {}

export class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly message: string;
  readonly details?: string;
}> {}

export class ExtractionError extends Data.TaggedError("ExtractionError")<{
  readonly message: string;
  readonly details?: string;
}> {}

export class BrowserError extends Data.TaggedError("BrowserError")<{
  readonly message: string;
  readonly details?: string;
}> {}
