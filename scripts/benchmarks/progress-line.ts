const escapeCharacter = String.fromCodePoint(0x1b);
const bellCharacter = String.fromCodePoint(0x7);

const oscEscapePattern = new RegExp(
  `${escapeCharacter}\\][\\s\\S]*?(?:${bellCharacter}|${escapeCharacter}\\\\)`,
  "gu",
);
const ansiEscapePattern = new RegExp(
  `${escapeCharacter}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`,
  "gu",
);
const whitespacePattern = /\s+/gu;

function replaceControlCharacters(value: string) {
  let normalized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    normalized += codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
  }

  return normalized;
}

export function sanitizeProgressText(value: string) {
  return replaceControlCharacters(
    value.replace(oscEscapePattern, " ").replace(ansiEscapePattern, " "),
  )
    .replace(whitespacePattern, " ")
    .trim();
}

function codePointWidth(codePoint: number) {
  if (codePoint === 0 || codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }

  if (codePoint === 0x2026) {
    return 1;
  }

  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff))
  ) {
    return 2;
  }

  return 1;
}

export function visibleProgressWidth(value: string) {
  let width = 0;
  for (const character of sanitizeProgressText(value)) {
    width += codePointWidth(character.codePointAt(0) ?? 0);
  }

  return width;
}

function takeWidthStart(value: string, maxWidth: number) {
  if (maxWidth <= 0) {
    return "";
  }

  let width = 0;
  let result = "";
  for (const character of sanitizeProgressText(value)) {
    const characterWidth = codePointWidth(character.codePointAt(0) ?? 0);
    if (width + characterWidth > maxWidth) {
      break;
    }

    result += character;
    width += characterWidth;
  }

  return result;
}

function takeWidthEnd(value: string, maxWidth: number) {
  if (maxWidth <= 0) {
    return "";
  }

  const characters = Array.from(sanitizeProgressText(value));
  let width = 0;
  let result = "";
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index] ?? "";
    const characterWidth = codePointWidth(character.codePointAt(0) ?? 0);
    if (width + characterWidth > maxWidth) {
      break;
    }

    result = `${character}${result}`;
    width += characterWidth;
  }

  return result;
}

export function truncateProgressMiddle(value: string, maxWidth: number) {
  const sanitized = sanitizeProgressText(value);
  if (maxWidth <= 0) {
    return "";
  }

  if (visibleProgressWidth(sanitized) <= maxWidth) {
    return sanitized;
  }

  if (maxWidth <= 3) {
    return takeWidthStart(sanitized, maxWidth);
  }

  const headWidth = Math.ceil((maxWidth - 1) / 2);
  const tailWidth = Math.floor((maxWidth - 1) / 2);
  return `${takeWidthStart(sanitized, headWidth)}…${takeWidthEnd(sanitized, tailWidth)}`;
}

export function joinProgressSegments(segments: readonly string[], maxWidth: number | undefined) {
  const normalized = segments
    .map((segment) => sanitizeProgressText(segment))
    .filter((segment) => segment.length > 0);
  const fullLine = normalized.join(" ");
  if (maxWidth === undefined || visibleProgressWidth(fullLine) <= maxWidth) {
    return fullLine;
  }

  if (normalized.length === 0) {
    return "";
  }

  if (normalized.length === 1) {
    return truncateProgressMiddle(normalized[0] ?? "", maxWidth);
  }

  const stable = normalized.slice(0, -1).join(" ");
  const stableWidth = visibleProgressWidth(stable);
  const stablePrefixWidth = stable.length === 0 ? 0 : stableWidth + 1;
  const tailBudget = maxWidth - stablePrefixWidth;

  if (tailBudget <= 0) {
    return truncateProgressMiddle(stable, maxWidth);
  }

  return `${stable} ${truncateProgressMiddle(normalized.at(-1) ?? "", tailBudget)}`;
}
