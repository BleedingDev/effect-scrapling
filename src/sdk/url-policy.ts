import { isIP } from "node:net";
import { Effect, Schema } from "effect";
import { formatUnknownError } from "./error-guards.ts";
import { InvalidInputError } from "./errors.ts";

const IPV4_SEGMENT_TEXT_SCHEMA = Schema.String.check(Schema.isPattern(/^(?:0|[1-9]\d{0,2})$/u));
const IPV4_SEGMENT_SCHEMA = Schema.FiniteFromString.check(Schema.isInt())
  .check(Schema.isGreaterThanOrEqualTo(0))
  .check(Schema.isLessThanOrEqualTo(255));
const IPV6_SEGMENT_TEXT_SCHEMA = Schema.String.check(Schema.isPattern(/^[0-9a-f]{1,4}$/iu));
const IPV6_SEGMENT_SCHEMA = Schema.NumberFromString.check(Schema.isInt())
  .check(Schema.isGreaterThanOrEqualTo(0))
  .check(Schema.isLessThanOrEqualTo(0xffff));
const decodeIpv4SegmentText = Schema.decodeUnknownSync(IPV4_SEGMENT_TEXT_SCHEMA);
const decodeIpv4Segment = Schema.decodeUnknownSync(IPV4_SEGMENT_SCHEMA);
const decodeIpv6SegmentText = Schema.decodeUnknownSync(IPV6_SEGMENT_TEXT_SCHEMA);
const decodeIpv6Segment = Schema.decodeUnknownSync(IPV6_SEGMENT_SCHEMA);

function parseIpv4Segments(
  hostname: string,
): readonly [number, number, number, number] | undefined {
  const segments = hostname.split(".");
  if (segments.length !== 4) {
    return undefined;
  }

  const [firstSegment, secondSegment, thirdSegment, fourthSegment] = segments;

  try {
    return [
      decodeIpv4Segment(decodeIpv4SegmentText(firstSegment)),
      decodeIpv4Segment(decodeIpv4SegmentText(secondSegment)),
      decodeIpv4Segment(decodeIpv4SegmentText(thirdSegment)),
      decodeIpv4Segment(decodeIpv4SegmentText(fourthSegment)),
    ];
  } catch {
    return undefined;
  }
}

function parseIpv6SegmentsPart(part: string): number[] | undefined {
  if (part.length === 0) {
    return [];
  }

  const segments = part.split(":");
  const parsed: number[] = [];

  for (const segment of segments) {
    if (segment.includes(".")) {
      const ipv4 = parseIpv4Segments(segment);
      if (!ipv4) {
        return undefined;
      }

      parsed.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      continue;
    }

    try {
      parsed.push(decodeIpv6Segment(`0x${decodeIpv6SegmentText(segment)}`));
    } catch {
      return undefined;
    }
  }

  return parsed;
}

function parseIpv6Segments(hostname: string): readonly number[] | undefined {
  const normalized = hostname.toLowerCase().replace(/%.+$/u, "");
  const hasCompression = normalized.includes("::");

  if (!hasCompression) {
    const parsed = parseIpv6SegmentsPart(normalized);
    return parsed?.length === 8 ? parsed : undefined;
  }

  if (normalized.indexOf("::") !== normalized.lastIndexOf("::")) {
    return undefined;
  }

  const [leftRaw = "", rightRaw = ""] = normalized.split("::", 2);
  const left = parseIpv6SegmentsPart(leftRaw);
  const right = parseIpv6SegmentsPart(rightRaw);

  if (!left || !right) {
    return undefined;
  }

  const zerosToInsert = 8 - (left.length + right.length);
  if (zerosToInsert < 1) {
    return undefined;
  }

  return [...left, ...Array.from({ length: zerosToInsert }, () => 0), ...right];
}

function isDisallowedIpv4(hostname: string): boolean {
  const segments = parseIpv4Segments(hostname);
  if (!segments) {
    return false;
  }

  const [first, second] = segments;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isDisallowedIpv6(hostname: string): boolean {
  const segments = parseIpv6Segments(hostname);
  if (!segments || segments.length !== 8) {
    return false;
  }

  const isUnspecified = segments.every((segment) => segment === 0);
  const isLoopback = segments.slice(0, 7).every((segment) => segment === 0) && segments[7] === 1;
  const first = segments[0] ?? 0;
  const second = segments[1] ?? 0;
  const isUniqueLocal = (first & 0xfe00) === 0xfc00;
  const isLinkLocal = (first & 0xffc0) === 0xfe80;
  const isIpv4Mapped =
    segments.slice(0, 5).every((segment) => segment === 0) && segments[5] === 0xffff;

  if (isUnspecified || isLoopback || isUniqueLocal || isLinkLocal) {
    return true;
  }

  if (isIpv4Mapped) {
    const thirdToLast = segments[6] ?? 0;
    const secondToLast = segments[7] ?? 0;
    const mappedIpv4 = `${thirdToLast >> 8}.${thirdToLast & 0xff}.${secondToLast >> 8}.${secondToLast & 0xff}`;
    return isDisallowedIpv4(mappedIpv4);
  }

  return first === 0x2001 && second === 0x0db8;
}

export function getUrlPolicyViolation(
  candidate: URL,
  options?: { readonly allowNonNetworkProtocols?: boolean },
): string | undefined {
  const allowNonNetworkProtocols = options?.allowNonNetworkProtocols ?? false;

  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") {
    return allowNonNetworkProtocols
      ? undefined
      : `URL protocol "${candidate.protocol}" is not allowed; use http or https`;
  }

  if (candidate.username.length > 0 || candidate.password.length > 0) {
    return "credentialed URLs are not allowed";
  }

  const normalizedHost = candidate.hostname.toLowerCase();
  if (normalizedHost === "localhost" || normalizedHost.endsWith(".localhost")) {
    return `host "${candidate.hostname}" is not allowed`;
  }

  const ipVersion = isIP(normalizedHost);
  if (ipVersion === 4 && isDisallowedIpv4(normalizedHost)) {
    return `host "${candidate.hostname}" resolves to a private or reserved IPv4 range`;
  }

  if (ipVersion === 6 && isDisallowedIpv6(normalizedHost)) {
    return `host "${candidate.hostname}" resolves to a private, loopback, or reserved IPv6 range`;
  }

  return undefined;
}

export function parseUserFacingUrl(rawUrl: string): Effect.Effect<string, InvalidInputError> {
  return Effect.try({
    try: () => new URL(rawUrl),
    catch: (error) =>
      new InvalidInputError({
        message: "URL must be a valid absolute HTTP(S) URL",
        details: formatUnknownError(error),
      }),
  }).pipe(
    Effect.flatMap((candidate) => {
      const violation = getUrlPolicyViolation(candidate);
      return violation
        ? Effect.fail(
            new InvalidInputError({
              message: "URL failed security policy",
              details: violation,
            }),
          )
        : Effect.succeed(candidate.toString());
    }),
  );
}

export function resolveValidatedUrl(candidate: string, currentUrl?: URL): URL {
  const parsed = currentUrl ? new URL(candidate, currentUrl) : new URL(candidate);
  const violation = getUrlPolicyViolation(parsed);
  if (violation) {
    throw new Error(violation);
  }

  return parsed;
}
