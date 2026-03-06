import { load } from "cheerio";
import { Effect, Schema } from "effect";
import { ParsedHtmlDocumentSchema } from "./extraction-parser.js";
import { CanonicalKeySchema } from "./schema-primitives.js";
import { ExtractionMismatch, ParserFailure } from "./tagged-errors.js";

const NonEmptySelectorSchema = Schema.Trim.check(Schema.isNonEmpty());

export class SelectorCandidate extends Schema.Class<SelectorCandidate>("SelectorCandidate")({
  path: CanonicalKeySchema,
  selector: NonEmptySelectorSchema,
  attr: Schema.optional(NonEmptySelectorSchema),
  all: Schema.optional(Schema.Boolean),
}) {}

const SelectorCandidatesSchema = Schema.Array(SelectorCandidate).pipe(
  Schema.refine(
    (candidates): candidates is ReadonlyArray<SelectorCandidate> =>
      candidates.length > 0 &&
      new Set(candidates.map(({ path }) => path)).size === candidates.length,
    {
      message:
        "Expected selector candidates with deterministic ordering, at least one candidate, and unique selector paths.",
    },
  ),
);

export const SelectorEngineInputSchema = Schema.Struct({
  document: ParsedHtmlDocumentSchema,
  candidates: SelectorCandidatesSchema,
});

export class SelectorResolution extends Schema.Class<SelectorResolution>("SelectorResolution")({
  selectorPath: CanonicalKeySchema,
  selector: NonEmptySelectorSchema,
  attr: Schema.optional(NonEmptySelectorSchema),
  values: Schema.Array(Schema.String),
  matchedCount: Schema.Int.check(Schema.isGreaterThan(0)),
  candidateOrder: Schema.Array(CanonicalKeySchema),
}) {}

export const SelectorCandidateSchema = SelectorCandidate;
export const SelectorResolutionSchema = SelectorResolution;

function normalizeExtractedValue(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function extractCandidateValues($: ReturnType<typeof load>, candidate: SelectorCandidate) {
  return $(candidate.selector)
    .toArray()
    .map((element) => {
      const rawValue =
        candidate.attr === undefined ? $(element).text() : ($(element).attr(candidate.attr) ?? "");
      return normalizeExtractedValue(rawValue);
    })
    .filter((value) => value.length > 0);
}

export function resolveSelectorPrecedence(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(SelectorEngineInputSchema)(input),
      catch: (cause) =>
        new ParserFailure({
          message: readCauseMessage(cause, "Failed to decode selector-engine input."),
        }),
    });
    const $ = yield* Effect.try({
      try: () => load(decoded.document.normalizedHtml),
      catch: (cause) =>
        new ParserFailure({
          message: readCauseMessage(
            cause,
            "Failed to load parsed document for selector resolution.",
          ),
        }),
    });

    for (const candidate of decoded.candidates) {
      const values = extractCandidateValues($, candidate);
      if (values.length > 0) {
        return Schema.decodeUnknownSync(SelectorResolutionSchema)({
          selectorPath: candidate.path,
          selector: candidate.selector,
          attr: candidate.attr,
          values: candidate.all === true ? values : values.slice(0, 1),
          matchedCount: values.length,
          candidateOrder: decoded.candidates.map(({ path }) => path),
        });
      }
    }

    return yield* Effect.fail(
      new ExtractionMismatch({
        message: `No selector candidates matched in configured order: ${decoded.candidates
          .map(({ path }) => path)
          .join(", ")}`,
      }),
    );
  });
}
