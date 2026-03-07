import { load } from "cheerio";
import { Effect, Schema } from "effect";
import { ParsedHtmlDocumentSchema } from "./extraction-parser.ts";
import { CanonicalKeySchema } from "./schema-primitives.ts";
import { ExtractionMismatch, ParserFailure } from "./tagged-errors.ts";

const NonEmptySelectorSchema = Schema.Trim.check(Schema.isNonEmpty());
const BOUNDED_SCORE_SCHEMA = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);
const FallbackCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(8),
);
const NonNegativeMatchCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const DEFAULT_SELECTOR_FALLBACK_POLICY = {
  maxFallbackCount: 2,
  fallbackConfidenceImpact: 0.15,
  maxConfidenceImpact: 0.45,
} as const;

export class SelectorCandidate extends Schema.Class<SelectorCandidate>("SelectorCandidate")({
  path: CanonicalKeySchema,
  selector: NonEmptySelectorSchema,
  attr: Schema.optional(NonEmptySelectorSchema),
  all: Schema.optional(Schema.Boolean),
}) {}

export class SelectorFallbackPolicy extends Schema.Class<SelectorFallbackPolicy>(
  "SelectorFallbackPolicy",
)({
  maxFallbackCount: FallbackCountSchema,
  fallbackConfidenceImpact: BOUNDED_SCORE_SCHEMA,
  maxConfidenceImpact: BOUNDED_SCORE_SCHEMA,
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
  fallbackPolicy: SelectorFallbackPolicy.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SELECTOR_FALLBACK_POLICY),
  ),
});

export class SelectorRelocationTraceEntry extends Schema.Class<SelectorRelocationTraceEntry>(
  "SelectorRelocationTraceEntry",
)({
  selectorPath: CanonicalKeySchema,
  selector: NonEmptySelectorSchema,
  attr: Schema.optional(NonEmptySelectorSchema),
  fallbackDepth: FallbackCountSchema,
  matchedCount: NonNegativeMatchCountSchema,
  confidenceImpact: BOUNDED_SCORE_SCHEMA,
  selected: Schema.Boolean,
}) {}

const SelectorRelocationTraceSchema = Schema.Array(SelectorRelocationTraceEntry).pipe(
  Schema.refine(
    (trace): trace is ReadonlyArray<SelectorRelocationTraceEntry> =>
      trace.length > 0 &&
      new Set(trace.map(({ selectorPath }) => selectorPath)).size === trace.length &&
      trace.every((entry, index) => entry.fallbackDepth === index),
    {
      message:
        "Expected selector relocation trace entries with deterministic ordering, at least one attempt, and unique selector paths.",
    },
  ),
);

const SelectorResolutionTraceSchema = SelectorRelocationTraceSchema.pipe(
  Schema.refine(
    (trace): trace is ReadonlyArray<SelectorRelocationTraceEntry> =>
      trace.filter(({ selected }) => selected).length === 1,
    {
      message: "Expected selector relocation trace to contain exactly one selected attempt.",
    },
  ),
);

export class SelectorResolution extends Schema.Class<SelectorResolution>("SelectorResolution")({
  selectorPath: CanonicalKeySchema,
  selector: NonEmptySelectorSchema,
  attr: Schema.optional(NonEmptySelectorSchema),
  values: Schema.Array(Schema.String),
  matchedCount: Schema.Int.check(Schema.isGreaterThan(0)),
  candidateOrder: Schema.Array(CanonicalKeySchema),
  relocated: Schema.Boolean,
  fallbackCount: FallbackCountSchema,
  confidence: BOUNDED_SCORE_SCHEMA,
  confidenceImpact: BOUNDED_SCORE_SCHEMA,
  relocationTrace: SelectorResolutionTraceSchema,
}) {}

export const SelectorCandidateSchema = SelectorCandidate;
export const SelectorFallbackPolicySchema = SelectorFallbackPolicy;
export const SelectorRelocationTraceEntrySchema = SelectorRelocationTraceEntry;
export const SelectorResolutionSchema = SelectorResolution;

function normalizeExtractedValue(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function roundBoundedScore(value: number) {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000;
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

function rawConfidenceImpact(fallbackDepth: number, policy: SelectorFallbackPolicy) {
  return fallbackDepth * policy.fallbackConfidenceImpact;
}

function calculateConfidenceImpact(fallbackDepth: number, policy: SelectorFallbackPolicy) {
  return roundBoundedScore(
    Math.min(policy.maxConfidenceImpact, rawConfidenceImpact(fallbackDepth, policy)),
  );
}

function canAttemptCandidate(fallbackDepth: number, policy: SelectorFallbackPolicy) {
  return (
    fallbackDepth <= policy.maxFallbackCount &&
    rawConfidenceImpact(fallbackDepth, policy) <= policy.maxConfidenceImpact
  );
}

function buildRelocationTraceEntry(
  candidate: SelectorCandidate,
  fallbackDepth: number,
  matchedCount: number,
  confidenceImpact: number,
  selected: boolean,
) {
  const relocationTraceEntry = {
    selectorPath: candidate.path,
    selector: candidate.selector,
    fallbackDepth,
    matchedCount,
    confidenceImpact,
    selected,
  };

  return Schema.decodeUnknownSync(SelectorRelocationTraceEntrySchema)(
    candidate.attr === undefined
      ? relocationTraceEntry
      : {
          ...relocationTraceEntry,
          attr: candidate.attr,
        },
  );
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
    const relocationTrace: Array<SelectorRelocationTraceEntry> = [];

    for (const [fallbackDepth, candidate] of decoded.candidates.entries()) {
      if (!canAttemptCandidate(fallbackDepth, decoded.fallbackPolicy)) {
        break;
      }

      const values = extractCandidateValues($, candidate);
      const confidenceImpact = calculateConfidenceImpact(fallbackDepth, decoded.fallbackPolicy);
      if (values.length > 0) {
        const selectedTrace = [
          ...relocationTrace,
          buildRelocationTraceEntry(
            candidate,
            fallbackDepth,
            values.length,
            confidenceImpact,
            true,
          ),
        ];
        const resolution = {
          selectorPath: candidate.path,
          selector: candidate.selector,
          values: candidate.all === true ? values : values.slice(0, 1),
          matchedCount: values.length,
          candidateOrder: decoded.candidates.map(({ path }) => path),
          relocated: fallbackDepth > 0,
          fallbackCount: fallbackDepth,
          confidence: roundBoundedScore(1 - confidenceImpact),
          confidenceImpact,
          relocationTrace: selectedTrace,
        };

        return Schema.decodeUnknownSync(SelectorResolutionSchema)(
          candidate.attr === undefined
            ? resolution
            : {
                ...resolution,
                attr: candidate.attr,
              },
        );
      }

      relocationTrace.push(
        buildRelocationTraceEntry(candidate, fallbackDepth, 0, confidenceImpact, false),
      );
    }

    const attemptedCandidateOrder = relocationTrace.map(({ selectorPath }) => selectorPath);
    const skippedCandidateOrder = decoded.candidates
      .slice(relocationTrace.length)
      .map(({ path }) => path);
    const attemptedCandidateMessage =
      attemptedCandidateOrder.length > 0 ? attemptedCandidateOrder.join(", ") : "none";
    const skippedCandidateMessage =
      skippedCandidateOrder.length > 0
        ? ` Skipped candidates beyond fallback bounds: ${skippedCandidateOrder.join(", ")}.`
        : "";

    return yield* Effect.fail(
      new ExtractionMismatch({
        message: `No selector candidates matched within bounded fallback policy after ${Math.max(
          0,
          attemptedCandidateOrder.length - 1,
        )} fallback candidate(s). Attempted candidates: ${attemptedCandidateMessage}.${skippedCandidateMessage}`,
      }),
    );
  });
}
