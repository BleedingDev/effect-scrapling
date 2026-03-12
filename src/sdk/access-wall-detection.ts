const ACCESS_WALL_TEXT_LIMIT = 4_000;
export const ACCESS_WALL_WARNING_PREFIX = "access-wall:";

type AccessWallPattern = {
  readonly signal: string;
  readonly pattern: RegExp;
};

const STRONG_FINAL_URL_PATTERNS: ReadonlyArray<AccessWallPattern> = [
  {
    signal: "url-trap",
    pattern:
      /(?:^|[/?#&=_])tspd(?:$|[/?#&=_])|(?:^|[/?#&=_-])(?:_incapsula_resource|distil_r_captcha|botmanager)(?:$|[/?#&=_-])|(?:^|[/?#&=_-])akam[-_/](?:bm|challenge|s?bot)(?:$|[/?#&=_-])/iu,
  },
  {
    signal: "url-challenge",
    pattern: /(?:[?&])__cf_chl_[a-z0-9_]+=|\/cdn-cgi\/challenge-platform(?:\/|$)/iu,
  },
  {
    signal: "url-challenge",
    pattern:
      /\b(captcha|challenge|verify|verification|human-check|security-check|bot-check|access-denied|attention-required|blocked|forbidden)\b/iu,
  },
  {
    signal: "url-consent",
    pattern:
      /(?:^|[/?#&=_-])(consent|gdpr|optanon|onetrust|trustarc|cookie[-_/](?:settings|preferences|consent|policy)|privacy[-_/](?:choices|center|preferences|settings)|consent[-_/](?:preferences|settings|choices|manager)|preferences?[-_/](?:center|settings|choices))(?:$|[/?#&=_-])/iu,
  },
];

const FINAL_URL_TRAP_PATTERNS = STRONG_FINAL_URL_PATTERNS.filter(
  (pattern) => pattern.signal === "url-trap",
);
const DIRECT_TRAP_URL_PATTERNS: ReadonlyArray<AccessWallPattern> = [
  {
    signal: "url-trap",
    pattern: /(?:^|[/?#&=_])(?:tspd|_incapsula_resource|distil_r_captcha)(?:$|[/?#&=_])/iu,
  },
];
const REDIRECT_ONLY_FINAL_URL_PATTERNS = STRONG_FINAL_URL_PATTERNS.filter(
  (pattern) => pattern.signal !== "url-trap",
);

const STRONG_TITLE_PATTERNS: ReadonlyArray<AccessWallPattern> = [
  {
    signal: "title-challenge",
    pattern:
      /(captcha|robot check|access denied|attention required|security check|human verification|verify (that )?(you are|you're) human|checking your browser|unusual traffic|suspicious activity)/iu,
  },
  {
    signal: "title-consent",
    pattern:
      /(cookie settings|cookie preferences|cookie consent|privacy settings|consent preferences|your privacy choices|manage your privacy choices|we value your privacy|before you continue|privacy preference center|nastaven[íi] souhlasu|spr[aá]va souhlasu|souhlas s cookies)/iu,
  },
];

const STRONG_TEXT_PATTERNS: ReadonlyArray<AccessWallPattern> = [
  {
    signal: "text-challenge",
    pattern:
      /(captcha|robot check|access denied|attention required|security check|human verification|verify (that )?(you are|you're) human|checking your browser|unusual traffic|suspicious activity|prove you are human|automated requests)/iu,
  },
  {
    signal: "text-consent",
    pattern:
      /(cookie settings|cookie preferences|cookie consent|privacy settings|consent preferences|your privacy choices|manage your privacy choices|we value your privacy|before you continue|privacy preference center|nastaven[íi] souhlasu|spr[aá]va souhlasu|souhlas s cookies)/iu,
  },
];

const WEAK_TITLE_PATTERNS: ReadonlyArray<AccessWallPattern> = [
  {
    signal: "title-cookies",
    pattern: /\bcookies?\b/iu,
  },
  {
    signal: "title-privacy",
    pattern: /\bprivacy\b/iu,
  },
  {
    signal: "title-consent-hint",
    pattern: /\bconsent\b/iu,
  },
  {
    signal: "title-challenge-hint",
    pattern: /\b(challenge|captcha|verify|human|robot)\b/iu,
  },
];

const WEAK_TEXT_PATTERNS: ReadonlyArray<AccessWallPattern> = [
  {
    signal: "text-cookies",
    pattern: /\bcookies?\b/iu,
  },
  {
    signal: "text-privacy",
    pattern: /\bprivacy\b/iu,
  },
  {
    signal: "text-consent-hint",
    pattern: /\bconsent\b/iu,
  },
  {
    signal: "text-gdpr",
    pattern: /\bgdpr\b/iu,
  },
];

export type AccessWallAnalysis = {
  readonly signals: ReadonlyArray<string>;
  readonly likelyAccessWall: boolean;
};

export type AccessWallKind = "challenge" | "consent" | "forbidden" | "rate-limit" | "trap";

const TRAP_SIGNALS = new Set(["url-trap"]);
const RATE_LIMIT_SIGNALS = new Set(["status-429"]);
const FORBIDDEN_SIGNALS = new Set(["status-401", "status-403"]);
const EXPLICIT_CHALLENGE_SIGNALS = new Set(["text-challenge", "title-challenge", "url-challenge"]);
const STRONG_CONSENT_SIGNALS = new Set(["text-consent", "title-consent", "url-consent"]);
const CONSENT_HINT_SIGNALS = new Set(["text-consent-hint", "title-consent-hint"]);
const WEAK_CONSENT_SIGNALS = new Set([
  "text-cookies",
  "text-gdpr",
  "text-privacy",
  "title-cookies",
  "title-privacy",
]);
const WEAK_CHALLENGE_HINT_SIGNALS = new Set(["title-challenge-hint"]);

function dedupeAndSortSignals(signals: ReadonlyArray<string>) {
  return [...new Set(signals)].sort(compareStrings);
}

function compareStrings(left: string, right: string) {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function stripHtmlLikeMarkup(value: string) {
  return value.replace(/<[^>]+>/gu, " ");
}

function toSearchText(value?: string) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = normalizeWhitespace(stripHtmlLikeMarkup(value));
  return normalized.slice(0, ACCESS_WALL_TEXT_LIMIT);
}

function collectSignals(
  target: Set<string>,
  value: string,
  patterns: ReadonlyArray<AccessWallPattern>,
) {
  for (const pattern of patterns) {
    if (pattern.pattern.test(value)) {
      target.add(pattern.signal);
    }
  }
}

function normalizeComparableUrl(value?: string) {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value;
  }
}

function matchesFinalUrlPatterns(value: string, patterns: ReadonlyArray<AccessWallPattern>) {
  return patterns.some((pattern) => pattern.pattern.test(value));
}

export function detectAccessWall(input: {
  readonly statusCode?: number | undefined;
  readonly requestedUrl?: string | undefined;
  readonly finalUrl?: string | undefined;
  readonly title?: string | undefined;
  readonly text?: string | undefined;
}): AccessWallAnalysis {
  const strongSignals = new Set<string>();
  const weakSignals = new Set<string>();
  const normalizedRequestedUrl = normalizeComparableUrl(input.requestedUrl);
  const normalizedFinalUrl =
    typeof input.finalUrl === "string" && input.finalUrl.length > 0 ? input.finalUrl : "";
  const normalizedTitle = toSearchText(input.title);
  const normalizedText = toSearchText(input.text);
  const finalUrlChanged =
    normalizedRequestedUrl === undefined
      ? normalizedFinalUrl.length > 0
      : normalizedFinalUrl.length > 0 &&
        normalizedRequestedUrl !== normalizeComparableUrl(input.finalUrl);
  const directTrapEndpointRequested =
    normalizedRequestedUrl !== undefined &&
    normalizedFinalUrl.length > 0 &&
    normalizedRequestedUrl === normalizeComparableUrl(input.finalUrl) &&
    matchesFinalUrlPatterns(normalizedFinalUrl, DIRECT_TRAP_URL_PATTERNS);

  if (input.statusCode === 401) {
    strongSignals.add("status-401");
  }
  if (input.statusCode === 403) {
    strongSignals.add("status-403");
  }
  if (input.statusCode === 429) {
    strongSignals.add("status-429");
  }

  if (finalUrlChanged) {
    collectSignals(strongSignals, normalizedFinalUrl, REDIRECT_ONLY_FINAL_URL_PATTERNS);
  }
  if (normalizedFinalUrl.length > 0 && (finalUrlChanged || directTrapEndpointRequested)) {
    collectSignals(strongSignals, normalizedFinalUrl, FINAL_URL_TRAP_PATTERNS);
  }
  collectSignals(strongSignals, normalizedTitle, STRONG_TITLE_PATTERNS);
  collectSignals(strongSignals, normalizedText, STRONG_TEXT_PATTERNS);

  collectSignals(weakSignals, normalizedTitle, WEAK_TITLE_PATTERNS);
  collectSignals(weakSignals, normalizedText, WEAK_TEXT_PATTERNS);

  const likelyAccessWall = strongSignals.size > 0 || (finalUrlChanged && weakSignals.size >= 2);
  return {
    signals: dedupeAndSortSignals([...strongSignals, ...weakSignals]),
    likelyAccessWall,
  };
}

function hasAnySignal(observedSignals: ReadonlySet<string>, expectedSignals: ReadonlySet<string>) {
  for (const signal of expectedSignals) {
    if (observedSignals.has(signal)) {
      return true;
    }
  }

  return false;
}

function countSignals(observedSignals: ReadonlySet<string>, expectedSignals: ReadonlySet<string>) {
  let count = 0;

  for (const signal of expectedSignals) {
    if (observedSignals.has(signal)) {
      count += 1;
    }
  }

  return count;
}

export function classifyAccessWallKind(signals: ReadonlyArray<string>): AccessWallKind | undefined {
  const observedSignals = new Set(signals);
  if (observedSignals.size === 0) {
    return undefined;
  }

  if (hasAnySignal(observedSignals, TRAP_SIGNALS)) {
    return "trap";
  }

  if (hasAnySignal(observedSignals, EXPLICIT_CHALLENGE_SIGNALS)) {
    return "challenge";
  }

  if (hasAnySignal(observedSignals, RATE_LIMIT_SIGNALS)) {
    return "rate-limit";
  }

  if (hasAnySignal(observedSignals, STRONG_CONSENT_SIGNALS)) {
    return "consent";
  }

  const consentHintCount = countSignals(observedSignals, CONSENT_HINT_SIGNALS);
  const weakConsentCount = countSignals(observedSignals, WEAK_CONSENT_SIGNALS);
  const weakChallengeHintCount = countSignals(observedSignals, WEAK_CHALLENGE_HINT_SIGNALS);
  if (
    (consentHintCount >= 1 && weakConsentCount >= 2) ||
    (consentHintCount >= 1 && weakConsentCount + consentHintCount >= 3)
  ) {
    return "consent";
  }

  if (weakConsentCount > 0 || consentHintCount > 0 || weakChallengeHintCount > 0) {
    return undefined;
  }

  if (hasAnySignal(observedSignals, FORBIDDEN_SIGNALS)) {
    return "forbidden";
  }

  return undefined;
}

export function extractHtmlTitle(html: string) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu);
  return match?.[1] === undefined ? undefined : normalizeWhitespace(match[1]);
}

export function toAccessWallWarnings(signals: ReadonlyArray<string>) {
  return [...new Set(signals)]
    .sort(compareStrings)
    .map((signal) => `${ACCESS_WALL_WARNING_PREFIX}${signal}`);
}

export function readAccessWallSignalsFromWarnings(warnings: ReadonlyArray<string>) {
  return dedupeAndSortSignals(
    warnings
      .filter((warning) => warning.startsWith(ACCESS_WALL_WARNING_PREFIX))
      .map((warning) => warning.slice(ACCESS_WALL_WARNING_PREFIX.length))
      .filter((signal) => signal.length > 0),
  );
}

export function readAccessWallSignalsFromText(text: string) {
  return dedupeAndSortSignals(
    Array.from(
      text.matchAll(new RegExp(`${ACCESS_WALL_WARNING_PREFIX}([a-z0-9-]+)`, "giu")),
      (match) => match[1] ?? "",
    ).filter((signal) => signal.length > 0),
  );
}
