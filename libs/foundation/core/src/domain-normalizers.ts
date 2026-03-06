import { Data, Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";
import { IsoDateTimeSchema } from "./schema-primitives.ts";

const ZERO_WIDTH_PATTERN = /[\u200b-\u200d\u2060\ufeff]/gu;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const PRODUCT_IDENTIFIER_VALUE_PATTERN = /^[A-Z0-9][A-Z0-9._-]*$/u;
const DIGITS_ONLY_PATTERN = /^\d+$/u;
const DATE_ONLY_YMD_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DATE_ONLY_YMD_SLASH_PATTERN = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/u;
const DATE_ONLY_MDY_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u;
const MONTH_NAME_DATE_PATTERN =
  /^(JANUARY|JAN|FEBRUARY|FEB|MARCH|MAR|APRIL|APR|MAY|JUNE|JUN|JULY|JUL|AUGUST|AUG|SEPTEMBER|SEPT|SEP|OCTOBER|OCT|NOVEMBER|NOV|DECEMBER|DEC)\s+(\d{1,2})(?:,)?\s+(\d{4})$/iu;

const NonEmptyTrimmedString = Schema.Trim.check(Schema.isNonEmpty());
const NonNegativeFiniteSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const PriceInputSchema = Schema.Union([
  NonEmptyTrimmedString,
  Schema.Struct({
    amount: Schema.Union([NonNegativeFiniteSchema, NonEmptyTrimmedString]),
    currency: NonEmptyTrimmedString,
  }),
]);

const DateInputSchema = Schema.Union([NonEmptyTrimmedString, Schema.Number, Schema.Date]);

const ProductIdentifierInputSchema = Schema.Union([
  NonEmptyTrimmedString,
  Schema.Struct({
    kind: NonEmptyTrimmedString,
    value: NonEmptyTrimmedString,
  }),
]);

const MonthNumbersByName = new Map<string, number>([
  ["JANUARY", 1],
  ["JAN", 1],
  ["FEBRUARY", 2],
  ["FEB", 2],
  ["MARCH", 3],
  ["MAR", 3],
  ["APRIL", 4],
  ["APR", 4],
  ["MAY", 5],
  ["JUNE", 6],
  ["JUN", 6],
  ["JULY", 7],
  ["JUL", 7],
  ["AUGUST", 8],
  ["AUG", 8],
  ["SEPTEMBER", 9],
  ["SEPT", 9],
  ["SEP", 9],
  ["OCTOBER", 10],
  ["OCT", 10],
  ["NOVEMBER", 11],
  ["NOV", 11],
  ["DECEMBER", 12],
  ["DEC", 12],
]);

const CurrencyAliases = new Map<string, string>([
  ["USD", "USD"],
  ["US DOLLAR", "USD"],
  ["US DOLLARS", "USD"],
  ["UNITED STATES DOLLAR", "USD"],
  ["$", "USD"],
  ["US$", "USD"],
  ["CAD", "CAD"],
  ["CANADIAN DOLLAR", "CAD"],
  ["CANADIAN DOLLARS", "CAD"],
  ["C$", "CAD"],
  ["CA$", "CAD"],
  ["AUD", "AUD"],
  ["AUSTRALIAN DOLLAR", "AUD"],
  ["AUSTRALIAN DOLLARS", "AUD"],
  ["A$", "AUD"],
  ["AU$", "AUD"],
  ["NZD", "NZD"],
  ["NEW ZEALAND DOLLAR", "NZD"],
  ["NEW ZEALAND DOLLARS", "NZD"],
  ["NZ$", "NZD"],
  ["EUR", "EUR"],
  ["EURO", "EUR"],
  ["EUROS", "EUR"],
  ["€", "EUR"],
  ["GBP", "GBP"],
  ["BRITISH POUND", "GBP"],
  ["BRITISH POUNDS", "GBP"],
  ["POUND", "GBP"],
  ["POUNDS", "GBP"],
  ["£", "GBP"],
  ["JPY", "JPY"],
  ["YEN", "JPY"],
  ["JAPANESE YEN", "JPY"],
  ["¥", "JPY"],
  ["INR", "INR"],
  ["INDIAN RUPEE", "INR"],
  ["INDIAN RUPEES", "INR"],
  ["RUPEE", "INR"],
  ["RUPEES", "INR"],
  ["₹", "INR"],
  ["CHF", "CHF"],
  ["SWISS FRANC", "CHF"],
  ["HKD", "HKD"],
  ["HK$", "HKD"],
  ["SGD", "SGD"],
  ["S$", "SGD"],
  ["SEK", "SEK"],
  ["NOK", "NOK"],
  ["DKK", "DKK"],
  ["PLN", "PLN"],
  ["CZK", "CZK"],
  ["HUF", "HUF"],
  ["RON", "RON"],
  ["MXN", "MXN"],
  ["MX$", "MXN"],
  ["BRL", "BRL"],
  ["R$", "BRL"],
  ["ZAR", "ZAR"],
  ["TRY", "TRY"],
  ["TWD", "TWD"],
  ["NT$", "TWD"],
  ["THB", "THB"],
  ["฿", "THB"],
  ["AED", "AED"],
  ["DIRHAM", "AED"],
  ["SAR", "SAR"],
  ["RIYAL", "SAR"],
]);

const AvailabilityMatchers = [
  {
    status: "outOfStock",
    patterns: ["out of stock", "sold out", "unavailable", "not available"],
  },
  {
    status: "discontinued",
    patterns: ["discontinued", "no longer available"],
  },
  {
    status: "preorder",
    patterns: ["preorder", "pre-order", "coming soon"],
  },
  {
    status: "backorder",
    patterns: ["backorder", "back-order", "ships in", "restocking"],
  },
  {
    status: "limitedAvailability",
    patterns: ["limited stock", "low stock", "few left", "only"],
  },
  {
    status: "inStock",
    patterns: ["in stock", "available now", "ready to ship", "ships today"],
  },
] as const;

export const DomainNormalizationFieldSchema = Schema.Literals([
  "price",
  "currency",
  "availability",
  "date",
  "text",
  "productIdentifier",
] as const);

export const NormalizedCurrencySchema = Schema.String.pipe(
  Schema.decodeTo(NonEmptyTrimmedString.pipe(Schema.check(Schema.isPattern(CURRENCY_PATTERN))), {
    decode: SchemaGetter.transformOrFail((value) => {
      const normalized = value.replace(/\s+/gu, "").replace(/\./gu, "").toUpperCase();
      if (CURRENCY_PATTERN.test(normalized)) {
        return Effect.succeed(normalized);
      }

      return Effect.fail(new SchemaIssue.InvalidValue(Option.some(value)));
    }),
    encode: SchemaGetter.passthrough(),
  }),
);

export const NormalizedAvailabilitySchema = Schema.Literals([
  "inStock",
  "limitedAvailability",
  "outOfStock",
  "preorder",
  "backorder",
  "discontinued",
] as const);

export const NormalizedTextSchema = Schema.String.pipe(
  Schema.decodeTo(NonEmptyTrimmedString, {
    decode: SchemaGetter.transform((value) => canonicalizeText(value)),
    encode: SchemaGetter.passthrough(),
  }),
);

export class NormalizedPrice extends Schema.Class<NormalizedPrice>("NormalizedPrice")({
  amount: NonNegativeFiniteSchema,
  currency: NormalizedCurrencySchema,
}) {}

export const ProductIdentifierKindSchema = Schema.Literals([
  "sku",
  "mpn",
  "upc",
  "ean",
  "gtin",
  "isbn",
] as const);

const ProductIdentifierValueSchema = Schema.String.pipe(
  Schema.decodeTo(
    NonEmptyTrimmedString.pipe(Schema.check(Schema.isPattern(PRODUCT_IDENTIFIER_VALUE_PATTERN))),
    {
      decode: SchemaGetter.transformOrFail((value) => {
        const normalized = value.replace(/\s+/gu, "").toUpperCase();
        if (PRODUCT_IDENTIFIER_VALUE_PATTERN.test(normalized)) {
          return Effect.succeed(normalized);
        }

        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(value)));
      }),
      encode: SchemaGetter.passthrough(),
    },
  ),
);

export class NormalizedProductIdentifier extends Schema.Class<NormalizedProductIdentifier>(
  "NormalizedProductIdentifier",
)({
  kind: ProductIdentifierKindSchema,
  value: ProductIdentifierValueSchema,
}) {}

export const NormalizedPriceSchema = NormalizedPrice;
export const NormalizedProductIdentifierSchema = NormalizedProductIdentifier;
export const NormalizedDateSchema = IsoDateTimeSchema;

export class DomainNormalizationError extends Data.TaggedError("DomainNormalizationError")<{
  readonly field: Schema.Schema.Type<typeof DomainNormalizationFieldSchema>;
  readonly message: string;
}> {}

export type DomainNormalizationField = Schema.Schema.Type<typeof DomainNormalizationFieldSchema>;
export type NormalizedCurrency = Schema.Schema.Type<typeof NormalizedCurrencySchema>;
export type NormalizedAvailability = Schema.Schema.Type<typeof NormalizedAvailabilitySchema>;
export type NormalizedText = Schema.Schema.Type<typeof NormalizedTextSchema>;
export type NormalizedPriceEncoded = Schema.Codec.Encoded<typeof NormalizedPriceSchema>;
export type ProductIdentifierKind = Schema.Schema.Type<typeof ProductIdentifierKindSchema>;
export type NormalizedProductIdentifierEncoded = Schema.Codec.Encoded<
  typeof NormalizedProductIdentifierSchema
>;
export type NormalizedDate = Schema.Schema.Type<typeof NormalizedDateSchema>;

export function normalizeCurrency(input: unknown) {
  return Effect.try({
    try: () => {
      const decoded = Schema.decodeUnknownSync(NormalizedTextSchema)(input);
      const compactCode = decoded.replace(/\s+/gu, "").replace(/\./gu, "").toUpperCase();
      if (CURRENCY_PATTERN.test(compactCode)) {
        return Schema.decodeUnknownSync(NormalizedCurrencySchema)(compactCode);
      }

      const alias = CurrencyAliases.get(currencyLookupKey(decoded));
      if (alias !== undefined) {
        return Schema.decodeUnknownSync(NormalizedCurrencySchema)(alias);
      }

      throw new Error("Expected a supported ISO currency code, currency symbol, or known alias.");
    },
    catch: (cause) =>
      createNormalizationError("currency", cause, "Failed to normalize currency input."),
  });
}

export function normalizePrice(input: unknown) {
  return Effect.try({
    try: () => {
      const decoded = Schema.decodeUnknownSync(PriceInputSchema)(input);
      if (typeof decoded === "string") {
        return Schema.decodeUnknownSync(NormalizedPriceSchema)({
          amount: parseDecimalAmount(extractAmountToken(decoded)),
          currency: extractCurrencyFromPriceText(decoded),
        });
      }

      return Schema.decodeUnknownSync(NormalizedPriceSchema)({
        amount:
          typeof decoded.amount === "number" ? decoded.amount : parseDecimalAmount(decoded.amount),
        currency: Effect.runSync(normalizeCurrency(decoded.currency)),
      });
    },
    catch: (cause) => createNormalizationError("price", cause, "Failed to normalize price input."),
  });
}

export function normalizeAvailability(input: unknown) {
  return Effect.try({
    try: () => {
      const normalized = Schema.decodeUnknownSync(NormalizedTextSchema)(input).toLowerCase();
      const matched = AvailabilityMatchers.find(({ patterns }) =>
        patterns.some((pattern) => normalized.includes(pattern)),
      );
      if (matched === undefined) {
        throw new Error("Expected recognizable availability text.");
      }

      return Schema.decodeUnknownSync(NormalizedAvailabilitySchema)(matched.status);
    },
    catch: (cause) =>
      createNormalizationError("availability", cause, "Failed to normalize availability input."),
  });
}

export function normalizeDate(input: unknown) {
  return Effect.try({
    try: () => {
      const decoded = Schema.decodeUnknownSync(DateInputSchema)(input);
      const dateTime =
        typeof decoded === "string"
          ? decodeDateString(decoded)
          : typeof decoded === "number"
            ? Schema.decodeUnknownSync(Schema.DateTimeUtcFromMillis)(decoded)
            : Schema.decodeUnknownSync(Schema.DateTimeUtcFromDate)(decoded);
      const encoded = Schema.encodeSync(Schema.DateTimeUtcFromString)(dateTime);
      return Schema.decodeUnknownSync(NormalizedDateSchema)(encoded);
    },
    catch: (cause) => createNormalizationError("date", cause, "Failed to normalize date input."),
  });
}

export function normalizeText(input: unknown) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(NormalizedTextSchema)(input),
    catch: (cause) => createNormalizationError("text", cause, "Failed to normalize text input."),
  });
}

export function normalizeProductIdentifier(input: unknown) {
  return Effect.try({
    try: () => {
      const decoded = Schema.decodeUnknownSync(ProductIdentifierInputSchema)(input);
      const normalized =
        typeof decoded === "string"
          ? inferProductIdentifier(decoded)
          : {
              kind: normalizeProductIdentifierKind(decoded.kind),
              value: normalizeProductIdentifierValue(
                normalizeProductIdentifierKind(decoded.kind),
                decoded.value,
              ),
            };

      return Schema.decodeUnknownSync(NormalizedProductIdentifierSchema)(normalized);
    },
    catch: (cause) =>
      createNormalizationError(
        "productIdentifier",
        cause,
        "Failed to normalize product identifier input.",
      ),
  });
}

function createNormalizationError(
  field: Schema.Schema.Type<typeof DomainNormalizationFieldSchema>,
  cause: unknown,
  fallback: string,
) {
  return new DomainNormalizationError({
    field,
    message: readCauseMessage(cause, fallback),
  });
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

function canonicalizeText(value: string) {
  return value
    .replace(ZERO_WIDTH_PATTERN, "")
    .replace(/[^\P{Cc}\t\n\r]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function currencyLookupKey(value: string) {
  return canonicalizeText(value).replace(/\.$/u, "").toUpperCase();
}

function extractAmountToken(value: string) {
  const normalized = canonicalizeText(value).replace(/[^\d,.'\-+]/gu, "");
  if (!/\d/u.test(normalized)) {
    throw new Error("Expected price input to contain at least one digit.");
  }

  return normalized;
}

function extractCurrencyFromPriceText(value: string) {
  const normalized = canonicalizeText(value);
  const codeMatch = normalized.toUpperCase().match(/\b[A-Z]{3}\b/u)?.[0];
  if (codeMatch !== undefined) {
    return Schema.decodeUnknownSync(NormalizedCurrencySchema)(codeMatch);
  }

  const matchedAlias = [...CurrencyAliases.entries()]
    .sort(([leftKey], [rightKey]) => rightKey.length - leftKey.length)
    .find(([alias]) => normalized.toUpperCase().includes(alias));
  if (matchedAlias !== undefined) {
    return Schema.decodeUnknownSync(NormalizedCurrencySchema)(matchedAlias[1]);
  }

  throw new Error("Expected a supported ISO currency code, currency symbol, or known alias.");
}

function parseDecimalAmount(value: string) {
  const canonicalToken = canonicalizeDecimalToken(value);
  return Schema.decodeUnknownSync(NonNegativeFiniteSchema)(
    Schema.decodeUnknownSync(Schema.NumberFromString)(canonicalToken),
  );
}

function canonicalizeDecimalToken(value: string) {
  let normalized = value.replace(/['’_\s]/gu, "");
  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");

  if (lastComma >= 0 && lastDot >= 0) {
    normalized =
      lastComma > lastDot
        ? normalized.replaceAll(".", "").replace(",", ".")
        : normalized.replaceAll(",", "");
  } else if (lastComma >= 0) {
    const digitsAfterSeparator = normalized.length - lastComma - 1;
    normalized =
      digitsAfterSeparator > 0 && digitsAfterSeparator <= 2
        ? normalized.replace(",", ".")
        : normalized.replaceAll(",", "");
  } else if ((normalized.match(/\./gu)?.length ?? 0) > 1) {
    const lastSeparator = normalized.lastIndexOf(".");
    const digitsAfterSeparator = normalized.length - lastSeparator - 1;
    const digitsOnly = normalized.replaceAll(".", "");
    normalized =
      digitsAfterSeparator > 0 && digitsAfterSeparator <= 2
        ? `${digitsOnly.slice(0, -digitsAfterSeparator)}.${digitsOnly.slice(-digitsAfterSeparator)}`
        : digitsOnly;
  }

  if (
    (normalized.match(/-/gu)?.length ?? 0) > 1 ||
    (normalized.includes("-") && !normalized.startsWith("-"))
  ) {
    throw new Error("Expected a canonical decimal token with an optional leading sign.");
  }

  return normalized;
}

function decodeDateString(value: string) {
  const normalized = canonicalizeText(value);
  const ymdMatch = normalized.match(DATE_ONLY_YMD_PATTERN);
  if (ymdMatch !== null) {
    return decodeUtcDateParts(ymdMatch[1], ymdMatch[2], ymdMatch[3]);
  }

  const ymdSlashMatch = normalized.match(DATE_ONLY_YMD_SLASH_PATTERN);
  if (ymdSlashMatch !== null) {
    return decodeUtcDateParts(ymdSlashMatch[1], ymdSlashMatch[2], ymdSlashMatch[3]);
  }

  const mdyMatch = normalized.match(DATE_ONLY_MDY_PATTERN);
  if (mdyMatch !== null) {
    return decodeUtcDateParts(mdyMatch[3], mdyMatch[1], mdyMatch[2]);
  }

  const monthNameMatch = normalized.match(MONTH_NAME_DATE_PATTERN);
  if (monthNameMatch !== null) {
    const month = MonthNumbersByName.get(monthNameMatch[1]!.toUpperCase());
    if (month === undefined) {
      throw new Error("Expected a supported month name.");
    }

    return decodeUtcDateParts(monthNameMatch[3], `${month}`, monthNameMatch[2]);
  }

  try {
    return Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(normalized);
  } catch {
    const parsed = new Date(normalized);
    if (!Number.isFinite(parsed.getTime())) {
      throw new Error("Expected a parseable datetime input.");
    }

    return Schema.decodeUnknownSync(Schema.DateTimeUtcFromDate)(parsed);
  }
}

function decodeUtcDateParts(
  yearInput: string | undefined,
  monthInput: string | undefined,
  dayInput: string | undefined,
) {
  const year = Number(yearInput);
  const month = Number(monthInput);
  const day = Number(dayInput);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error("Expected valid numeric date parts.");
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error("Expected a valid calendar date.");
  }

  return Schema.decodeUnknownSync(Schema.DateTimeUtcFromDate)(date);
}

function inferProductIdentifier(value: string) {
  const normalized = Schema.decodeUnknownSync(NormalizedTextSchema)(value);
  const prefixedMatch = normalized.match(/^(sku|mpn|upc|ean|gtin|isbn)\s*[:#-]?\s*(.+)$/iu);
  if (prefixedMatch !== null) {
    const kind = normalizeProductIdentifierKind(prefixedMatch[1]!);
    return {
      kind,
      value: normalizeProductIdentifierValue(kind, prefixedMatch[2]!),
    };
  }

  const kind = inferProductIdentifierKind(normalized);
  return {
    kind,
    value: normalizeProductIdentifierValue(kind, normalized),
  };
}

function normalizeProductIdentifierKind(
  input: string,
): Schema.Schema.Type<typeof ProductIdentifierKindSchema> {
  const normalized = canonicalizeText(input)
    .replace(/[\s_-]/gu, "")
    .toLowerCase();
  switch (normalized) {
    case "sku":
    case "mpn":
    case "upc":
    case "ean":
    case "gtin":
    case "isbn":
      return normalized;
    case "barcode":
      return "gtin";
    default:
      throw new Error("Expected a supported product identifier kind.");
  }
}

function inferProductIdentifierKind(
  input: string,
): Schema.Schema.Type<typeof ProductIdentifierKindSchema> {
  const digitsOnly = input.replace(/[\s-]/gu, "");
  if (DIGITS_ONLY_PATTERN.test(digitsOnly) && digitsOnly.length === 12) {
    return "upc";
  }

  if (DIGITS_ONLY_PATTERN.test(digitsOnly) && digitsOnly.length === 13) {
    return "ean";
  }

  if (
    DIGITS_ONLY_PATTERN.test(digitsOnly) &&
    (digitsOnly.length === 8 || digitsOnly.length === 14)
  ) {
    return "gtin";
  }

  if (/^\d{9}[\dX]$/iu.test(digitsOnly) || /^\d{13}$/u.test(digitsOnly)) {
    return "isbn";
  }

  return "sku";
}

function normalizeProductIdentifierValue(
  kind: Schema.Schema.Type<typeof ProductIdentifierKindSchema>,
  rawValue: string,
) {
  const normalizedText = Schema.decodeUnknownSync(NormalizedTextSchema)(rawValue);
  switch (kind) {
    case "sku":
    case "mpn":
      return Schema.decodeUnknownSync(ProductIdentifierValueSchema)(normalizedText);
    case "upc": {
      const digitsOnly = normalizedText.replace(/[\s-]/gu, "");
      if (!/^\d{12}$/u.test(digitsOnly) || !hasValidGs1CheckDigit(digitsOnly)) {
        throw new Error("Expected UPC identifiers with a valid GS1 check digit.");
      }

      return digitsOnly;
    }
    case "ean": {
      const digitsOnly = normalizedText.replace(/[\s-]/gu, "");
      if (!/^\d{13}$/u.test(digitsOnly) || !hasValidGs1CheckDigit(digitsOnly)) {
        throw new Error("Expected EAN identifiers with a valid GS1 check digit.");
      }

      return digitsOnly;
    }
    case "gtin": {
      const digitsOnly = normalizedText.replace(/[\s-]/gu, "");
      if (
        !/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/u.test(digitsOnly) ||
        !hasValidGs1CheckDigit(digitsOnly)
      ) {
        throw new Error("Expected GTIN identifiers with a valid GS1 check digit.");
      }

      return digitsOnly;
    }
    case "isbn": {
      const digitsOnly = normalizedText.replace(/[\s-]/gu, "").toUpperCase();
      if (!isValidIsbn(digitsOnly)) {
        throw new Error("Expected ISBN identifiers with a valid ISBN checksum.");
      }

      return digitsOnly;
    }
  }
}

function hasValidGs1CheckDigit(value: string) {
  const body = value.slice(0, -1);
  const providedCheckDigit = Number(value.at(-1));
  if (!Number.isInteger(providedCheckDigit)) {
    return false;
  }

  let total = 0;
  for (let index = 0; index < body.length; index += 1) {
    const digitText = body[body.length - index - 1];
    if (digitText === undefined) {
      continue;
    }

    total += Number(digitText) * (index % 2 === 0 ? 3 : 1);
  }

  const expectedCheckDigit = (10 - (total % 10)) % 10;
  return expectedCheckDigit === providedCheckDigit;
}

function isValidIsbn(value: string) {
  if (/^\d{13}$/u.test(value)) {
    return hasValidGs1CheckDigit(value);
  }

  if (!/^\d{9}[\dX]$/u.test(value)) {
    return false;
  }

  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === undefined) {
      continue;
    }

    const numericValue = character === "X" ? 10 : Number(character);
    total += numericValue * (10 - index);
  }

  return total % 11 === 0;
}
