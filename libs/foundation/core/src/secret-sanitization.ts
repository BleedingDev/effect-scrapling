import * as cheerio from "cheerio";

export const REDACTED_SECRET_VALUE = "[REDACTED]";

const explicitlySensitiveHeaderNames = new Set(["cookie2", "set-cookie2"]);
const sensitiveHeaderNamePattern =
  /(?:^|[-])(authorization|cookie|token|secret|session|api[-]?key)(?:$|[-])/;
const sensitiveArtifactNamePattern =
  /(?:authorization|cookie|token|secret|session|api[-_]?key|password|credential|csrf)/iu;
const sensitiveInlineValuePattern =
  /((?:authorization|cookie|token|secret|session|api[-_]?key|password|credential|csrf)[^:=\n]{0,32}\s*[:=]\s*)(\S+)/giu;
const bearerTokenPattern = /\bBearer\s+\S+/giu;

function normalizeText(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function sanitizeSearchParams(searchParams: URLSearchParams) {
  for (const [name] of searchParams.entries()) {
    if (sensitiveArtifactNamePattern.test(name)) {
      searchParams.set(name, REDACTED_SECRET_VALUE);
    }
  }
}

function sanitizeRelativeUrl(value: string) {
  const withoutFragment = value.split("#", 1)[0] ?? "";
  const queryIndex = withoutFragment.indexOf("?");
  if (queryIndex === -1) {
    return withoutFragment;
  }

  const path = withoutFragment.slice(0, queryIndex);
  const searchParams = new URLSearchParams(withoutFragment.slice(queryIndex + 1));
  sanitizeSearchParams(searchParams);

  const encodedQuery = searchParams.toString();
  return encodedQuery === "" ? path : `${path}?${encodedQuery}`;
}

export function sanitizeUrlForExport(value: string) {
  const trimmedValue = value.trim();
  if (trimmedValue === "") {
    return trimmedValue;
  }

  try {
    const parsed = new URL(trimmedValue);
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    sanitizeSearchParams(parsed.searchParams);

    return parsed.toString();
  } catch {
    return sanitizeRelativeUrl(trimmedValue);
  }
}

export function sanitizeInlineSecrets(value: string) {
  return value
    .replace(
      sensitiveInlineValuePattern,
      (_match, prefix: string) => `${prefix}${REDACTED_SECRET_VALUE}`,
    )
    .replace(bearerTokenPattern, `Bearer ${REDACTED_SECRET_VALUE}`);
}

export function shouldSanitizeHeader(name: string) {
  return explicitlySensitiveHeaderNames.has(name) || sensitiveHeaderNamePattern.test(name);
}

export function sanitizeHeaderEntries(headers: Iterable<readonly [string, string]>) {
  return Array.from(headers)
    .map(([name, value]) => {
      const normalizedName = name.toLowerCase();

      return {
        name: normalizedName,
        value: shouldSanitizeHeader(normalizedName) ? REDACTED_SECRET_VALUE : value,
      };
    })
    .sort((left, right) =>
      left.name === right.name
        ? left.value.localeCompare(right.value)
        : left.name.localeCompare(right.name),
    );
}

export function summarizeHtmlForRedactedExport(html: string) {
  const $ = cheerio.load(html);
  $("script, style, noscript, template").remove();

  const linkTargets: string[] = [];
  const seenTargets = new Set<string>();

  for (const node of $("a[href], link[href], img[src], form[action]").toArray()) {
    const target =
      $(node).attr("href") ?? $(node).attr("src") ?? $(node).attr("action") ?? undefined;

    if (target === undefined || target.trim() === "") {
      continue;
    }

    const sanitizedTarget = sanitizeUrlForExport(target.trim());
    if (sanitizedTarget === "" || seenTargets.has(sanitizedTarget)) {
      continue;
    }

    seenTargets.add(sanitizedTarget);
    linkTargets.push(sanitizedTarget);
  }

  const title = sanitizeInlineSecrets(normalizeText($("title").first().text()));
  const textPreview = sanitizeInlineSecrets(normalizeText($("body").text() || $.root().text()));
  const hiddenFieldCount = $("input[type='hidden'][value], meta[content]").length;

  return `${JSON.stringify(
    {
      title: title === "" ? null : title,
      textPreview: textPreview === "" ? null : textPreview.slice(0, 400),
      linkTargets,
      hiddenFieldCount,
    },
    null,
    2,
  )}\n`;
}
