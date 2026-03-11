#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Schema } from "effect";
import {
  E9CommerceDiscoveryArtifactSchema,
  type E9CommerceDiscoveryProgressEvent,
  runE9CommerceDiscoveryBenchmark,
} from "../../src/e9-commerce-benchmark.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const PositiveIntFromStringSchema = Schema.FiniteFromString.check(Schema.isInt()).check(
  Schema.isGreaterThan(0),
);

export const E9CommerceDiscoveryCliOptionsSchema = Schema.Struct({
  artifactPath: Schema.optional(NonEmptyStringSchema),
  targetPagesPerSite: Schema.optional(PositiveIntSchema),
  siteCatalogPath: Schema.optional(NonEmptyStringSchema),
  siteConcurrency: Schema.optional(PositiveIntSchema),
  httpOnly: Schema.optional(Schema.Boolean),
});

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

export function parseOptions(args: readonly string[]) {
  let artifactPath: string | undefined;
  let targetPagesPerSite: number | undefined;
  let siteCatalogPath: string | undefined;
  let siteConcurrency: number | undefined;
  let httpOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      argument === "--artifact" ||
      argument === "--pages-per-site" ||
      argument === "--site-catalog" ||
      argument === "--site-concurrency"
    ) {
      const rawValue = args[index + 1];
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error(`Missing value for argument: ${argument}`);
      }

      if (argument === "--artifact") {
        artifactPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(rawValue);
      } else if (argument === "--pages-per-site") {
        targetPagesPerSite = Schema.decodeUnknownSync(PositiveIntFromStringSchema)(rawValue);
      } else if (argument === "--site-concurrency") {
        siteConcurrency = Schema.decodeUnknownSync(PositiveIntFromStringSchema)(rawValue);
      } else {
        siteCatalogPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(rawValue);
      }

      index += 1;
      continue;
    }

    if (argument === "--http-only") {
      httpOnly = true;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return Schema.decodeUnknownSync(E9CommerceDiscoveryCliOptionsSchema)({
    artifactPath,
    targetPagesPerSite,
    siteCatalogPath,
    siteConcurrency,
    httpOnly,
  });
}

async function persistArtifact(artifactPath: string, artifact: unknown) {
  const resolvedPath = resolve(artifactPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

function formatField(key: string, value: boolean | number | string) {
  if (typeof value === "string") {
    return `${key}=${JSON.stringify(value)}`;
  }

  return `${key}=${String(value)}`;
}

type ProgressTone = "info" | "success" | "warning" | "failure";

function progressIcon(tone: ProgressTone) {
  switch (tone) {
    case "success":
      return "✅";
    case "warning":
      return "⚠️";
    case "failure":
      return "❌";
    case "info":
      return "ℹ️";
  }
}

function progressColor(tone: ProgressTone) {
  switch (tone) {
    case "success":
      return "\u001B[32m";
    case "warning":
      return "\u001B[33m";
    case "failure":
      return "\u001B[31m";
    case "info":
      return "\u001B[36m";
  }
}

function progressTone(event: E9CommerceDiscoveryProgressEvent): ProgressTone {
  switch (event.kind) {
    case "site-complete":
      return event.state === "healthy"
        ? "success"
        : event.state === "unreachable"
          ? "failure"
          : "warning";
    case "suite-complete":
      if (event.unreachableSiteCount > 0) {
        return "failure";
      }

      if (event.degradedSiteCount > 0 || event.selectionCoverage < 1) {
        return "warning";
      }

      return "success";
    default:
      return "info";
  }
}

function decorateProgressLine(line: string, tone: ProgressTone, color: boolean) {
  const text = `${progressIcon(tone)} ${line}`;
  if (!color) {
    return text;
  }

  return `${progressColor(tone)}${text}\u001B[0m`;
}

export function formatE9CommerceDiscoveryProgressEvent(
  event: E9CommerceDiscoveryProgressEvent,
  options: {
    readonly color?: boolean;
  } = {},
) {
  const prefix = "[progress:e9-commerce-discovery]";
  const line = (() => {
    switch (event.kind) {
      case "suite-start":
        return [
          prefix,
          "suite",
          "start",
          formatField("generated_at", event.generatedAt),
          formatField("total_sites", event.totalSites),
          formatField("target_pages_per_site", event.targetPagesPerSite),
          formatField("site_concurrency", event.siteConcurrency),
          formatField("http_only", event.httpOnly),
          formatField("site_catalog_path", event.siteCatalogPath),
        ].join(" ");
      case "site-start":
        return [
          prefix,
          "site",
          "start",
          formatField("input_site", `${event.siteOrdinal}/${event.totalSites}`),
          formatField("site_id", event.siteId),
          formatField("domain", event.domain),
          formatField("target_pages_per_site", event.targetPagesPerSite),
          formatField("http_only", event.httpOnly),
        ].join(" ");
      case "site-complete":
        return [
          prefix,
          "site",
          "complete",
          formatField("input_site", `${event.siteOrdinal}/${event.totalSites}`),
          formatField("completed_sites", `${event.completedSites}/${event.totalSites}`),
          formatField("site_id", event.siteId),
          formatField("domain", event.domain),
          formatField("state", event.state),
          formatField("discovered_url_count", event.discoveredUrlCount),
          formatField("selected_page_count", event.selectedPageCount),
          formatField("homepage_http_ok", event.homepageHttpOk),
          formatField("homepage_browser_ok", event.homepageBrowserOk),
          formatField("elapsed_ms", event.elapsedMs),
          formatField("eta_ms", event.etaMs),
        ].join(" ");
      case "suite-complete":
        return [
          prefix,
          "suite",
          "complete",
          formatField("generated_at", event.generatedAt),
          formatField("total_sites", event.totalSites),
          formatField("selected_page_count", event.selectedPageCount),
          formatField("selection_coverage", event.selectionCoverage),
          formatField("degraded_site_count", event.degradedSiteCount),
          formatField("unreachable_site_count", event.unreachableSiteCount),
          formatField("total_wall_ms", event.totalWallMs),
        ].join(" ");
    }
  })();

  return decorateProgressLine(line, progressTone(event), options.color ?? false);
}

export async function runDefaultE9CommerceDiscovery(
  options: Schema.Schema.Type<typeof E9CommerceDiscoveryCliOptionsSchema> = {},
  dependencies: {
    readonly onProgress?: (event: E9CommerceDiscoveryProgressEvent) => void;
  } = {},
) {
  const artifact = await runE9CommerceDiscoveryBenchmark({
    ...(options.targetPagesPerSite === undefined
      ? {}
      : { targetPagesPerSite: options.targetPagesPerSite }),
    ...(options.siteCatalogPath === undefined ? {} : { siteCatalogPath: options.siteCatalogPath }),
    ...(options.siteConcurrency === undefined ? {} : { siteConcurrency: options.siteConcurrency }),
    ...(options.httpOnly ? { httpOnly: true } : {}),
    ...(dependencies.onProgress === undefined ? {} : { onProgress: dependencies.onProgress }),
  });

  if (options.artifactPath !== undefined) {
    await persistArtifact(options.artifactPath, artifact);
  }

  return Schema.decodeUnknownSync(E9CommerceDiscoveryArtifactSchema)(artifact);
}

export async function runE9CommerceDiscoveryCli(
  args: readonly string[],
  dependencies: {
    readonly setExitCode?: (code: number) => void;
    readonly writeLine?: (line: string) => void;
    readonly writeProgressLine?: (line: string) => void;
    readonly runDiscovery?: typeof runDefaultE9CommerceDiscovery;
  } = {},
) {
  const setExitCode = dependencies.setExitCode ?? ((_code: number) => undefined);
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));
  const writeProgressLine =
    dependencies.writeProgressLine ?? ((line: string) => console.error(line));
  const runDiscovery = dependencies.runDiscovery ?? runDefaultE9CommerceDiscovery;

  try {
    const options = parseOptions(args);
    const artifact = await runDiscovery(options, {
      onProgress: (event) =>
        writeProgressLine(
          formatE9CommerceDiscoveryProgressEvent(event, {
            color: process.stderr.isTTY ?? false,
          }),
        ),
    });
    writeLine(JSON.stringify(artifact, null, 2));
    return artifact;
  } catch (cause) {
    setExitCode(1);
    throw new Error(readCauseMessage(cause, "Failed to run the E9 commerce discovery benchmark."));
  }
}

if (import.meta.main) {
  await runE9CommerceDiscoveryCli(process.argv.slice(2));
}
