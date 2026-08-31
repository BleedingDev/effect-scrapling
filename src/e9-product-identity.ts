import { Effect, Schema } from "effect";
import { normalizeText } from "@effect-scrapling/foundation-core/domain-normalizers";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const CanonicalTokenPattern = /^[a-z0-9]+$/u;
const CanonicalTokenSchema = Schema.String.check(Schema.isPattern(CanonicalTokenPattern)).check(
  Schema.isNonEmpty(),
);
const CanonicalTokenListSchema = Schema.Array(CanonicalTokenSchema);
const RawTokenListSchema = Schema.Array(NonEmptyStringSchema);

export const E9ProductIdentityNormalizationInputSchema = Schema.Struct({
  title: NonEmptyStringSchema,
  modelTokens: Schema.optional(RawTokenListSchema),
  officialIsAccessory: Schema.optional(Schema.Boolean),
});

export const E9ProductIdentitySignalsSchema = Schema.Struct({
  accessory: CanonicalTokenListSchema,
  bundle: CanonicalTokenListSchema,
  compatible: CanonicalTokenListSchema,
  replacement: CanonicalTokenListSchema,
});

export const E9ProductIdentitySchema = Schema.Struct({
  normalizedTitle: NonEmptyStringSchema,
  canonicalTitle: NonEmptyStringSchema,
  canonicalTokens: CanonicalTokenListSchema,
  normalizedModelTokens: CanonicalTokenListSchema,
  anchoredModelTokens: CanonicalTokenListSchema,
  missingModelTokens: CanonicalTokenListSchema,
  variantTokens: CanonicalTokenListSchema,
  signals: E9ProductIdentitySignalsSchema,
  officialIsAccessory: Schema.optional(Schema.Boolean),
});

export type E9ProductIdentityNormalizationInput = Schema.Schema.Type<
  typeof E9ProductIdentityNormalizationInputSchema
>;
export type E9ProductIdentitySignals = Schema.Schema.Type<typeof E9ProductIdentitySignalsSchema>;
export type E9ProductIdentity = Schema.Schema.Type<typeof E9ProductIdentitySchema>;

const ACCESSORY_SIGNAL_TOKENS = new Set([
  "adapter",
  "av",
  "baterie",
  "battery",
  "brush",
  "brushes",
  "cable",
  "case",
  "cover",
  "dalkove",
  "dock",
  "filtr",
  "filter",
  "head",
  "heads",
  "hlavice",
  "holder",
  "kartac",
  "kartace",
  "kartacky",
  "kabel",
  "krytka",
  "microfiber",
  "mikrovlakna",
  "mop",
  "napajeci",
  "ovladani",
  "poklicka",
  "remote",
  "rost",
  "sacek",
  "zdroj",
]);

const BUNDLE_SIGNAL_TOKENS = new Set(["bundle", "kit", "pack", "sada", "set"]);
const REPLACEMENT_SIGNAL_TOKENS = new Set(["nahradni", "replacement", "spare", "vymena"]);
const VARIANT_STOP_TOKENS = new Set(["barva", "color"]);
const ACCESSORY_TRAILING_VARIANT_TOKENS = new Set([
  "bila",
  "bile",
  "bily",
  "black",
  "blue",
  "cerna",
  "cerne",
  "cerny",
  "gray",
  "green",
  "grey",
  "pink",
  "red",
  "silver",
  "white",
]);
const MODEL_TOKEN_MERGE_BLOCKLIST = new Set([
  ...ACCESSORY_SIGNAL_TOKENS,
  ...BUNDLE_SIGNAL_TOKENS,
  ...REPLACEMENT_SIGNAL_TOKENS,
  ...VARIANT_STOP_TOKENS,
]);

function foldIdentityText(value: string) {
  return value.normalize("NFKD").replace(/\p{M}+/gu, "");
}

function compactIdentityWhitespace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function canonicalizeNormalizedIdentityText(value: string) {
  return compactIdentityWhitespace(foldIdentityText(value).toLowerCase());
}

function tokenizeCanonicalPiece(piece: string) {
  if (piece.trim() === "") {
    return [];
  }

  const segmentedTokens = piece.split(/[^a-z0-9]+/gu).filter((token) => token !== "");
  if (segmentedTokens.length > 1) {
    return segmentedTokens;
  }

  if (/\d/u.test(piece)) {
    const compact = piece.replace(/[^a-z0-9]+/gu, "");
    return compact === "" ? [] : [compact];
  }

  return piece.split(/[^a-z0-9]+/gu).filter((token) => token !== "");
}

function tokenizeCanonicalIdentityText(canonicalText: string) {
  const tokens = canonicalText
    .split(/\s+/gu)
    .flatMap((piece) => piece.split(/[/|+]/gu))
    .flatMap(tokenizeCanonicalPiece);

  const mergedTokens = new Array<string>();
  for (const token of tokens) {
    const previous = mergedTokens.at(-1);
    if (previous !== undefined && /^\d+$/u.test(previous) && /^(ks|x)$/u.test(token)) {
      mergedTokens[mergedTokens.length - 1] = `${previous}${token}`;
      continue;
    }
    if (
      previous !== undefined &&
      /^[a-z]{1,4}$/u.test(previous) &&
      /^\d+[a-z]{0,2}$/u.test(token) &&
      !MODEL_TOKEN_MERGE_BLOCKLIST.has(previous)
    ) {
      mergedTokens[mergedTokens.length - 1] = `${previous}${token}`;
      continue;
    }
    if (
      previous !== undefined &&
      /^[a-z]{1,4}\d+[a-z]{0,2}$/u.test(previous) &&
      /^[a-z]{1,2}$/u.test(token)
    ) {
      mergedTokens[mergedTokens.length - 1] = `${previous}${token}`;
      continue;
    }

    mergedTokens.push(token);
  }

  return mergedTokens;
}

function dedupeTokens(tokens: ReadonlyArray<string>) {
  return [...new Set(tokens)];
}

function containsCompatibilityTargetToken(value: string) {
  return /\b(?:tesla|[a-z]*\d[a-z0-9]*)\b/iu.test(value);
}

function buildSignalRecord(canonicalText: string, titleTokens: ReadonlyArray<string>) {
  const accessory = titleTokens.filter((token) => ACCESSORY_SIGNAL_TOKENS.has(token));
  const bundle = titleTokens.filter((token) => BUNDLE_SIGNAL_TOKENS.has(token));
  const replacement = titleTokens.filter((token) => REPLACEMENT_SIGNAL_TOKENS.has(token));
  const compatible = new Array<string>();
  const hasAccessoryLikeSignal =
    accessory.length > 0 || bundle.length > 0 || replacement.length > 0;

  if (canonicalText.includes("compatible with") || /\bcompatible\b/iu.test(canonicalText)) {
    compatible.push("compatible");
  }

  if (canonicalText.includes("kompatibilni s")) {
    compatible.push("kompatibilni");
  }

  if (hasAccessoryLikeSignal && /\bfor\b/iu.test(canonicalText)) {
    compatible.push("for");
  }

  const standaloneProMatch = /\bpro\b/iu.exec(canonicalText);
  if (
    hasAccessoryLikeSignal &&
    standaloneProMatch?.index !== undefined &&
    !containsCompatibilityTargetToken(canonicalText.slice(0, standaloneProMatch.index)) &&
    containsCompatibilityTargetToken(
      canonicalText.slice(standaloneProMatch.index + standaloneProMatch[0].length),
    )
  ) {
    compatible.push("pro");
  }

  return Schema.decodeUnknownSync(E9ProductIdentitySignalsSchema)({
    accessory: dedupeTokens(accessory),
    bundle: dedupeTokens(bundle),
    compatible: dedupeTokens(compatible),
    replacement: dedupeTokens(replacement),
  });
}

function extractParentheticalVariantSegments(canonicalText: string) {
  const candidates = new Array<string>();

  for (const match of canonicalText.matchAll(/\(([^)]+)\)/gu)) {
    const captured = match[1]?.trim();
    if (captured !== undefined && captured !== "") {
      candidates.push(captured);
    }
  }

  return candidates;
}

function extractAnchoredParentheticalVariantSegments(
  canonicalText: string,
  anchoredModelTokens: ReadonlySet<string>,
) {
  if (anchoredModelTokens.size === 0) {
    return extractParentheticalVariantSegments(canonicalText);
  }

  const candidates = new Array<string>();
  for (const match of canonicalText.matchAll(/\(([^)]+)\)/gu)) {
    const captured = match[1]?.trim();
    const matchIndex = match.index;
    const tokensBeforeMatch =
      matchIndex === undefined
        ? []
        : tokenizeCanonicalIdentityText(canonicalText.slice(0, matchIndex));
    const tokensAfterMatch =
      matchIndex === undefined
        ? []
        : tokenizeCanonicalIdentityText(canonicalText.slice(matchIndex + match[0].length));
    const hasAnchoredTokenBeforeMatch = tokensBeforeMatch.some((token) =>
      anchoredModelTokens.has(token),
    );
    const hasAnchoredTokenAfterMatch = tokensAfterMatch.some((token) =>
      anchoredModelTokens.has(token),
    );
    const hasAccessoryLikePrefixContext = tokensBeforeMatch.some(
      (token) =>
        ACCESSORY_SIGNAL_TOKENS.has(token) ||
        BUNDLE_SIGNAL_TOKENS.has(token) ||
        REPLACEMENT_SIGNAL_TOKENS.has(token) ||
        token === "compatible" ||
        token === "for" ||
        token === "kompatibilni" ||
        token === "pro",
    );
    if (
      captured === undefined ||
      captured === "" ||
      matchIndex === undefined ||
      (!hasAnchoredTokenBeforeMatch &&
        !(hasAnchoredTokenAfterMatch && hasAccessoryLikePrefixContext))
    ) {
      continue;
    }

    candidates.push(captured);
  }

  return candidates;
}

function extractDashVariantSegments(canonicalText: string) {
  return canonicalText
    .split(/\s[-\u2012-\u2015]\s/gu)
    .slice(1)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

function filterVariantTokens(
  tokens: ReadonlyArray<string>,
  anchoredModelTokens: ReadonlySet<string>,
  signals: E9ProductIdentitySignals,
) {
  const signalTokens = new Set([
    ...signals.accessory,
    ...signals.bundle,
    ...signals.compatible,
    ...signals.replacement,
  ]);

  return dedupeTokens(
    tokens.filter(
      (token) =>
        !anchoredModelTokens.has(token) &&
        !signalTokens.has(token) &&
        !VARIANT_STOP_TOKENS.has(token),
    ),
  );
}

function decodeIdentityInput(input: unknown) {
  return Schema.decodeUnknownEffect(E9ProductIdentityNormalizationInputSchema)(input).pipe(
    Effect.flatMap((decodedInput) => {
      const canonicalTitle = canonicalizeNormalizedIdentityText(decodedInput.title);
      if (tokenizeCanonicalIdentityText(canonicalTitle).length === 0) {
        return Effect.fail(
          new Error(
            `Expected title to contain canonicalizable content, received ${JSON.stringify(decodedInput.title)}.`,
          ),
        );
      }

      const invalidModelToken = decodedInput.modelTokens?.find(
        (token) => normalizeModelToken(token) === "",
      );

      if (invalidModelToken !== undefined) {
        return Effect.fail(
          new Error(
            `Expected modelTokens to contain canonicalizable content, received ${JSON.stringify(invalidModelToken)}.`,
          ),
        );
      }

      return Effect.succeed(decodedInput);
    }),
  );
}

function analyzeIdentity(input: E9ProductIdentityNormalizationInput) {
  return normalizeText(input.title).pipe(
    Effect.map((normalizedTitle) => {
      const canonicalTitle = canonicalizeNormalizedIdentityText(normalizedTitle);
      const titleTokens = tokenizeCanonicalIdentityText(canonicalTitle);
      const canonicalTokens = dedupeTokens(titleTokens);
      const explicitNormalizedModelTokens = dedupeTokens(
        (input.modelTokens ?? [])
          .map((token) => normalizeModelToken(token))
          .filter((token) => token !== ""),
      );
      const normalizedModelTokens =
        explicitNormalizedModelTokens.length > 0
          ? explicitNormalizedModelTokens
          : dedupeTokens(
              titleTokens.filter((token) => /\d/u.test(token) && !/^\d+(?:ks|x)$/u.test(token)),
            );
      const titleTokenSet = new Set(titleTokens);
      const anchoredModelTokens = normalizedModelTokens.filter((token) => titleTokenSet.has(token));
      const missingModelTokens = normalizedModelTokens.filter((token) => !titleTokenSet.has(token));
      const signals = buildSignalRecord(canonicalTitle, titleTokens);
      const anchoredModelTokenSet = new Set(anchoredModelTokens);
      const parentheticalVariantTokens = filterVariantTokens(
        extractAnchoredParentheticalVariantSegments(canonicalTitle, anchoredModelTokenSet).flatMap(
          tokenizeCanonicalIdentityText,
        ),
        anchoredModelTokenSet,
        signals,
      );
      const dashVariantTokens = filterVariantTokens(
        extractDashVariantSegments(canonicalTitle).flatMap(tokenizeCanonicalIdentityText),
        anchoredModelTokenSet,
        signals,
      );
      const lastAnchoredModelIndex = [...titleTokens.keys()]
        .reverse()
        .find((index) => anchoredModelTokenSet.has(titleTokens[index] ?? ""));
      const trailingVariantTokens =
        lastAnchoredModelIndex === undefined
          ? []
          : filterVariantTokens(
              titleTokens.slice(lastAnchoredModelIndex + 1),
              anchoredModelTokenSet,
              signals,
            );
      const accessoryTrailingVariantTokens = trailingVariantTokens.filter(
        (token) => /\d/u.test(token) || ACCESSORY_TRAILING_VARIANT_TOKENS.has(token),
      );
      const accessoryDashVariantTokens = dashVariantTokens.filter(
        (token) => /\d/u.test(token) || ACCESSORY_TRAILING_VARIANT_TOKENS.has(token),
      );
      const hasAccessoryLikeSignals =
        signals.accessory.length > 0 ||
        signals.compatible.length > 0 ||
        signals.replacement.length > 0;
      const mergedVariantTokens = dedupeTokens([
        ...trailingVariantTokens,
        ...dashVariantTokens,
        ...parentheticalVariantTokens,
      ]);

      return Schema.decodeUnknownSync(E9ProductIdentitySchema)({
        normalizedTitle,
        canonicalTitle,
        canonicalTokens,
        normalizedModelTokens,
        anchoredModelTokens,
        missingModelTokens,
        variantTokens:
          hasAccessoryLikeSignals && parentheticalVariantTokens.length > 0
            ? dedupeTokens([
                ...accessoryTrailingVariantTokens,
                ...accessoryDashVariantTokens,
                ...parentheticalVariantTokens,
              ])
            : hasAccessoryLikeSignals && dashVariantTokens.length > 0
              ? dedupeTokens([
                  ...accessoryTrailingVariantTokens,
                  ...accessoryDashVariantTokens,
                  ...parentheticalVariantTokens,
                ])
              : hasAccessoryLikeSignals
                ? accessoryTrailingVariantTokens
                : mergedVariantTokens,
        signals,
        ...(input.officialIsAccessory === undefined
          ? {}
          : {
              officialIsAccessory: input.officialIsAccessory,
            }),
      });
    }),
  );
}

export function canonicalizeIdentityText(input: string) {
  return decodeIdentityInput({ title: input }).pipe(
    Effect.flatMap(analyzeIdentity),
    Effect.map((identity) => identity.canonicalTitle),
  );
}

export function tokenizeProductIdentity(input: string) {
  return decodeIdentityInput({ title: input }).pipe(
    Effect.flatMap(analyzeIdentity),
    Effect.map((identity) => identity.canonicalTokens),
  );
}

export function normalizeModelToken(input: string) {
  return canonicalizeNormalizedIdentityText(input).replace(/[^a-z0-9]+/gu, "");
}

export function detectProductIdentitySignals(input: string) {
  return decodeIdentityInput({ title: input }).pipe(
    Effect.flatMap(analyzeIdentity),
    Effect.map((identity) => identity.signals),
  );
}

export function extractVariantTokens(input: {
  readonly title: string;
  readonly modelTokens?: ReadonlyArray<string>;
}) {
  return decodeIdentityInput(input).pipe(
    Effect.flatMap(analyzeIdentity),
    Effect.map((identity) => identity.variantTokens),
  );
}

export function buildProductIdentity(input: E9ProductIdentityNormalizationInput) {
  return decodeIdentityInput(input).pipe(Effect.flatMap(analyzeIdentity));
}
