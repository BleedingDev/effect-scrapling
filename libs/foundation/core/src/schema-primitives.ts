import { Schema } from "effect";

const DOMAIN_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

const NonEmptyTrimmedString = Schema.Trim.check(Schema.isNonEmpty());
const LowercasedNonEmptyTrimmedString = NonEmptyTrimmedString.check(Schema.isLowercased());

function isCanonicalHttpUrl(value: string): value is string {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.hash.length === 0
    );
  } catch {
    return false;
  }
}

function isIsoDateTime(value: string): value is string {
  return (
    ISO_DATE_TIME_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export const CanonicalIdentifierSchema = NonEmptyTrimmedString.pipe(
  Schema.refine((value): value is string => !/\s/gu.test(value), {
    message: "Expected a canonical identifier without whitespace.",
  }),
);

export const CanonicalDomainSchema = LowercasedNonEmptyTrimmedString.pipe(
  Schema.refine((value): value is string => DOMAIN_PATTERN.test(value), {
    message: "Expected a canonical lowercased domain without protocol or path.",
  }),
);

export const CanonicalKeySchema = NonEmptyTrimmedString.pipe(
  Schema.refine((value): value is string => !/\s/gu.test(value), {
    message: "Expected a canonical key without whitespace.",
  }),
);

export const CanonicalHttpUrlSchema = NonEmptyTrimmedString.pipe(
  Schema.refine(isCanonicalHttpUrl, {
    message:
      "Expected a canonical absolute HTTP(S) URL without credentials or fragment components.",
  }),
);

export const IsoDateTimeSchema = NonEmptyTrimmedString.pipe(
  Schema.refine(isIsoDateTime, {
    message: "Expected an ISO-8601 datetime string.",
  }),
);

export type CanonicalIdentifier = Schema.Schema.Type<typeof CanonicalIdentifierSchema>;
export type CanonicalDomain = Schema.Schema.Type<typeof CanonicalDomainSchema>;
export type CanonicalKey = Schema.Schema.Type<typeof CanonicalKeySchema>;
export type CanonicalHttpUrl = Schema.Schema.Type<typeof CanonicalHttpUrlSchema>;
export type IsoDateTime = Schema.Schema.Type<typeof IsoDateTimeSchema>;
