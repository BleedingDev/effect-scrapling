#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const DEFAULT_PARITY_REPORT_PATH = join("docs", "guardrail-parity.md");

const IMPLEMENTED_SECTION_HEADING = "Implemented in this repository";
const TRACKED_DIFFERENCES_SECTION_HEADING = "Tracked differences with rationale";

const REQUIRED_IMPLEMENTED_GUARDRAILS = [
  "Nx workspace graph",
  "Module boundary enforcement",
  "Oxlint policy",
  "Oxfmt policy",
  "Ultracite checks",
  "Type-safety bypass ban",
  "Effect v4 dependency policy",
  "Strict TS posture",
  "CI guardrail enforcement",
  "Semver release policy",
] as const;

const IMPLEMENTED_TABLE_HEADER = ["Guardrail", "Status", "Implementation"] as const;
const TRACKED_DIFFERENCES_TABLE_HEADER = ["Upstream pattern", "Status", "Rationale"] as const;

type ParsedTable = {
  headers: readonly string[];
  rows: ReadonlyArray<readonly string[]>;
};

type TableParseResult = { ok: true; table: ParsedTable } | { ok: false; error: string };

function normalizeNewlines(markdown: string): string {
  return markdown.replace(/\r\n?/gu, "\n");
}

function extractSection(markdown: string, heading: string): string | null {
  const normalized = normalizeNewlines(markdown);
  const lines = normalized.split("\n");
  const expectedHeading = `## ${heading}`;

  const sectionStart = lines.findIndex((line) => line.trim() === expectedHeading);
  if (sectionStart === -1) {
    return null;
  }

  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && line.trim().startsWith("## ")) {
      sectionEnd = index;
      break;
    }
  }

  return lines.slice(sectionStart + 1, sectionEnd).join("\n");
}

function parseMarkdownRow(line: string): readonly string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return null;
  }

  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function parseFirstTableInSection(sectionName: string, sectionContent: string): TableParseResult {
  const lines = normalizeNewlines(sectionContent).split("\n");

  const tableStart = lines.findIndex((line) => line.trim().startsWith("|"));
  if (tableStart === -1) {
    return {
      ok: false,
      error: `Section "${sectionName}" must include a markdown table.`,
    };
  }

  const tableLines: string[] = [];
  for (let index = tableStart; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !line.trim().startsWith("|")) {
      break;
    }
    tableLines.push(line);
  }

  if (tableLines.length < 2) {
    return {
      ok: false,
      error: `Section "${sectionName}" table is malformed (missing header or separator row).`,
    };
  }

  const headers = parseMarkdownRow(tableLines[0]);
  const separator = parseMarkdownRow(tableLines[1]);
  if (headers === null || separator === null) {
    return {
      ok: false,
      error: `Section "${sectionName}" table is malformed (invalid table row syntax).`,
    };
  }

  if (separator.length !== headers.length || !isSeparatorRow(separator)) {
    return {
      ok: false,
      error: `Section "${sectionName}" table is malformed (separator row must contain dashes for each column).`,
    };
  }

  const rows: string[][] = [];
  for (const [rowIndex, line] of tableLines.slice(2).entries()) {
    const row = parseMarkdownRow(line);
    if (row === null) {
      return {
        ok: false,
        error: `Section "${sectionName}" table row ${rowIndex + 1} is malformed.`,
      };
    }
    if (row.length !== headers.length) {
      return {
        ok: false,
        error: `Section "${sectionName}" table row ${rowIndex + 1} has ${row.length} column(s); expected ${headers.length}.`,
      };
    }
    rows.push(row);
  }

  return {
    ok: true,
    table: {
      headers,
      rows,
    },
  };
}

function validateExpectedHeader(
  sectionName: string,
  actual: readonly string[],
  expected: readonly string[],
): string | null {
  const matches =
    actual.length === expected.length && actual.every((cell, index) => cell === expected[index]);

  if (matches) {
    return null;
  }

  return `Section "${sectionName}" table header must be "${expected.join(" | ")}".`;
}

function validateImplementedSection(markdown: string, errors: string[]): void {
  const sectionContent = extractSection(markdown, IMPLEMENTED_SECTION_HEADING);
  if (sectionContent === null) {
    errors.push(`Missing section: "${IMPLEMENTED_SECTION_HEADING}".`);
    return;
  }

  const tableResult = parseFirstTableInSection(IMPLEMENTED_SECTION_HEADING, sectionContent);
  if (!tableResult.ok) {
    errors.push(tableResult.error);
    return;
  }

  const headerError = validateExpectedHeader(
    IMPLEMENTED_SECTION_HEADING,
    tableResult.table.headers,
    IMPLEMENTED_TABLE_HEADER,
  );
  if (headerError !== null) {
    errors.push(headerError);
    return;
  }

  const guardrailRows = new Map<string, { status: string; implementation: string }>();

  for (const [rowIndex, row] of tableResult.table.rows.entries()) {
    const [guardrail, status, implementation] = row;
    const displayRow = rowIndex + 1;

    if (guardrail.length === 0) {
      errors.push(`${IMPLEMENTED_SECTION_HEADING} row ${displayRow} is missing a guardrail name.`);
      continue;
    }

    if (guardrailRows.has(guardrail)) {
      errors.push(`Duplicate implemented guardrail row: "${guardrail}".`);
      continue;
    }

    guardrailRows.set(guardrail, { status, implementation });

    if (status !== "Implemented") {
      errors.push(
        `Guardrail "${guardrail}" must have status "Implemented" (found "${status || "<empty>"}").`,
      );
    }

    if (implementation.length === 0) {
      errors.push(`Guardrail "${guardrail}" is missing implementation evidence.`);
    }
  }

  for (const requiredGuardrail of REQUIRED_IMPLEMENTED_GUARDRAILS) {
    if (!guardrailRows.has(requiredGuardrail)) {
      errors.push(`Missing required implemented guardrail row: "${requiredGuardrail}".`);
    }
  }
}

function validateTrackedDifferencesSection(markdown: string, errors: string[]): void {
  const sectionContent = extractSection(markdown, TRACKED_DIFFERENCES_SECTION_HEADING);
  if (sectionContent === null) {
    errors.push(`Missing section: "${TRACKED_DIFFERENCES_SECTION_HEADING}".`);
    return;
  }

  const tableResult = parseFirstTableInSection(TRACKED_DIFFERENCES_SECTION_HEADING, sectionContent);
  if (!tableResult.ok) {
    errors.push(tableResult.error);
    return;
  }

  const headerError = validateExpectedHeader(
    TRACKED_DIFFERENCES_SECTION_HEADING,
    tableResult.table.headers,
    TRACKED_DIFFERENCES_TABLE_HEADER,
  );
  if (headerError !== null) {
    errors.push(headerError);
    return;
  }

  if (tableResult.table.rows.length === 0) {
    errors.push(`Section "${TRACKED_DIFFERENCES_SECTION_HEADING}" must include at least one row.`);
    return;
  }

  for (const [rowIndex, row] of tableResult.table.rows.entries()) {
    const [upstreamPattern, status, rationale] = row;
    const displayRow = rowIndex + 1;

    if (upstreamPattern.length === 0) {
      errors.push(
        `${TRACKED_DIFFERENCES_SECTION_HEADING} row ${displayRow} is missing an upstream pattern.`,
      );
    }
    if (status.length === 0) {
      errors.push(`${TRACKED_DIFFERENCES_SECTION_HEADING} row ${displayRow} is missing a status.`);
    }
    if (rationale.length === 0) {
      errors.push(
        `${TRACKED_DIFFERENCES_SECTION_HEADING} row ${displayRow} is missing rationale text.`,
      );
    }
  }
}

function validateGuardrailParityMarkdown(markdown: string): readonly string[] {
  const errors: string[] = [];
  validateImplementedSection(markdown, errors);
  validateTrackedDifferencesSection(markdown, errors);
  return errors;
}

function resolveTargetPath(argumentPath: string | undefined): string {
  if (argumentPath === undefined || argumentPath.length === 0) {
    return resolve(process.cwd(), DEFAULT_PARITY_REPORT_PATH);
  }
  return resolve(process.cwd(), argumentPath);
}

function formatDisplayPath(absolutePath: string): string {
  const relativePath = relative(process.cwd(), absolutePath).replace(/\\/gu, "/");
  if (relativePath.length === 0) {
    return ".";
  }
  return relativePath.startsWith("..") ? absolutePath : relativePath;
}

async function main(): Promise<void> {
  const targetPath = resolveTargetPath(process.argv[2]);
  const displayPath = formatDisplayPath(targetPath);

  let markdown: string;
  try {
    markdown = await readFile(targetPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `Guardrail parity verification failed for ${displayPath}: unable to read file (${reason}).`,
    );
    process.exit(1);
    return;
  }

  const errors = validateGuardrailParityMarkdown(markdown);
  if (errors.length > 0) {
    console.error(`Guardrail parity verification failed for ${displayPath}:`);
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
    return;
  }

  console.log(`Guardrail parity verification passed for ${displayPath}.`);
}

await main();
