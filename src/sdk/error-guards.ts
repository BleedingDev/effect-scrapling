import { Predicate } from "effect";
import type { BrowserError, ExtractionError, InvalidInputError, NetworkError } from "./errors.ts";

type ErrorShape = {
  readonly message: string;
  readonly details?: string;
};

function hasMessageAndOptionalDetails(error: unknown): error is ErrorShape {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  if (!Predicate.hasProperty(error, "message") || typeof error.message !== "string") {
    return false;
  }

  if (!Predicate.hasProperty(error, "details")) {
    return true;
  }

  return error.details === undefined || typeof error.details === "string";
}

export function formatUnknownError(error: unknown): string {
  return Predicate.isError(error) ? `${error.name}: ${error.message}` : String(error);
}

export function isInvalidInputError(error: unknown): error is InvalidInputError {
  return Predicate.isTagged("InvalidInputError")(error) && hasMessageAndOptionalDetails(error);
}

export function isNetworkError(error: unknown): error is NetworkError {
  return Predicate.isTagged("NetworkError")(error) && hasMessageAndOptionalDetails(error);
}

export function isExtractionError(error: unknown): error is ExtractionError {
  return Predicate.isTagged("ExtractionError")(error) && hasMessageAndOptionalDetails(error);
}

export function isBrowserError(error: unknown): error is BrowserError {
  return Predicate.isTagged("BrowserError")(error) && hasMessageAndOptionalDetails(error);
}
