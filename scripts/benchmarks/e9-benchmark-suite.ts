#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { Schema } from "effect";
import {
  joinProgressSegments,
  sanitizeProgressText,
  truncateProgressMiddle,
  visibleProgressWidth,
} from "./progress-line.ts";
import {
  E9BenchmarkSuiteArtifactSchema,
  type E9BenchmarkSuiteProgressEvent,
  mergeE9BenchmarkArtifacts,
  runE9BenchmarkSuite,
} from "../../src/e9-benchmark-suite.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const ProgressModeSchema = Schema.Literals(["full", "compact"] as const);
const CliPhaseSchema = Schema.Literals(["http", "browser", "scrapling", "canary"] as const);
const BenchmarkPresetSchema = Schema.Literals([
  "fast-regression",
  "scale-study",
  "full-corpus",
  "competitor-calibration",
] as const);
const HttpProfileSchema = Schema.Literals(["effect-http", "native-fetch"] as const);
const BrowserProfileSchema = Schema.Literals(["effect-browser", "patchright-browser"] as const);

export const E9BenchmarkSuiteCliOptionsSchema = Schema.Struct({
  artifactPath: Schema.optional(NonEmptyStringSchema),
  artifactJsonlPath: Schema.optional(NonEmptyStringSchema),
  artifactJsonlEnabled: Schema.optional(Schema.Boolean),
  corpusArtifactPath: Schema.optional(NonEmptyStringSchema),
  mergeArtifactPaths: Schema.optional(Schema.Array(NonEmptyStringSchema)),
  preset: Schema.optional(BenchmarkPresetSchema),
  phases: Schema.optional(Schema.Array(CliPhaseSchema)),
  httpProfiles: Schema.optional(Schema.Array(HttpProfileSchema)),
  browserProfiles: Schema.optional(Schema.Array(BrowserProfileSchema)),
  httpConcurrency: Schema.optional(Schema.Array(PositiveIntSchema)),
  browserConcurrency: Schema.optional(Schema.Array(PositiveIntSchema)),
  httpTimeoutMs: Schema.optional(PositiveIntSchema),
  browserTimeoutMs: Schema.optional(PositiveIntSchema),
  samplePageCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  sampleSeed: Schema.optional(NonEmptyStringSchema),
  shardCount: Schema.optional(PositiveIntSchema),
  shardIndex: Schema.optional(PositiveIntSchema),
  adaptiveStop: Schema.optional(Schema.Boolean),
  progressMode: Schema.optional(ProgressModeSchema),
  progressWidth: Schema.optional(PositiveIntSchema),
  forceColor: Schema.optional(Schema.Boolean),
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

function summarizeCliArtifactOutput(
  artifact: Partial<Schema.Schema.Type<typeof E9BenchmarkSuiteArtifactSchema>>,
  input: {
    readonly artifactPath?: string | undefined;
    readonly artifactJsonlPath?: string | undefined;
  },
) {
  return {
    benchmark: artifact.benchmark,
    benchmarkId: artifact.benchmarkId,
    status: artifact.status,
    generatedAt: artifact.generatedAt,
    artifactPath: input.artifactPath,
    artifactJsonlPath: input.artifactJsonlPath,
    ...(artifact.corpus?.preset === undefined ? {} : { preset: artifact.corpus.preset }),
    selectedPageCount: artifact.corpus?.selectedPageCount ?? 0,
    selectedSiteCount: artifact.corpus?.selectedSiteCount ?? 0,
    highFrictionPageCount: artifact.corpus?.highFrictionPageCount ?? 0,
    httpAttemptCount: artifact.httpCorpus?.attempts.length ?? 0,
    httpSweepCount: artifact.httpCorpus?.sweeps.length ?? 0,
    browserAttemptCount: artifact.browserCorpus?.attempts.length ?? 0,
    browserSweepCount: artifact.browserCorpus?.sweeps.length ?? 0,
    ...(artifact.summary === undefined ? {} : { summary: artifact.summary }),
    ...(artifact.warnings === undefined ? {} : { warnings: artifact.warnings }),
    ...(artifact.recommendations === undefined
      ? {}
      : { recommendations: artifact.recommendations }),
  };
}

function parseConcurrencyList(rawValue: string) {
  return Schema.decodeUnknownSync(Schema.Array(PositiveIntSchema))(
    rawValue.split(",").map((value) => Number(value.trim())),
  );
}

function parseNonEmptyStringList(rawValue: string) {
  return Schema.decodeUnknownSync(Schema.Array(NonEmptyStringSchema))(
    rawValue
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

function parsePhaseList(rawValue: string) {
  return Schema.decodeUnknownSync(Schema.Array(CliPhaseSchema))(
    rawValue
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

function parseHttpProfileList(rawValue: string) {
  return Schema.decodeUnknownSync(Schema.Array(HttpProfileSchema))(
    rawValue
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

function parseBrowserProfileList(rawValue: string) {
  return Schema.decodeUnknownSync(Schema.Array(BrowserProfileSchema))(
    rawValue
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

export function parseOptions(args: readonly string[]) {
  let artifactPath: string | undefined;
  let artifactJsonlPath: string | undefined;
  let artifactJsonlEnabled: boolean | undefined;
  let corpusArtifactPath: string | undefined;
  let mergeArtifactPaths: readonly string[] | undefined;
  let preset:
    | "fast-regression"
    | "scale-study"
    | "full-corpus"
    | "competitor-calibration"
    | undefined;
  let phases: readonly ("http" | "browser" | "scrapling" | "canary")[] | undefined;
  let httpProfiles: readonly ("effect-http" | "native-fetch")[] | undefined;
  let browserProfiles: readonly ("effect-browser" | "patchright-browser")[] | undefined;
  let httpConcurrency: readonly number[] | undefined;
  let browserConcurrency: readonly number[] | undefined;
  let httpTimeoutMs: number | undefined;
  let browserTimeoutMs: number | undefined;
  let samplePageCount: number | undefined;
  let sampleSeed: string | undefined;
  let shardCount: number | undefined;
  let shardIndex: number | undefined;
  let adaptiveStop: boolean | undefined;
  let progressMode: "full" | "compact" | undefined;
  let progressWidth: number | undefined;
  let forceColor: boolean | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const rawValue = args[index + 1];

    const expectValue = () => {
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error(`Missing value for argument: ${argument}`);
      }
      return rawValue;
    };

    switch (argument) {
      case "--no-artifact-jsonl":
        artifactJsonlEnabled = false;
        break;
      case "--force-color":
        forceColor = true;
        break;
      case "--adaptive-stop":
        adaptiveStop = true;
        break;
      case "--no-adaptive-stop":
        adaptiveStop = false;
        break;
      case "--artifact":
        artifactPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(expectValue());
        index += 1;
        break;
      case "--artifact-jsonl":
        artifactJsonlPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(expectValue());
        artifactJsonlEnabled = true;
        index += 1;
        break;
      case "--corpus":
        corpusArtifactPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(expectValue());
        index += 1;
        break;
      case "--merge":
        mergeArtifactPaths = parseNonEmptyStringList(expectValue());
        index += 1;
        break;
      case "--preset":
        preset = Schema.decodeUnknownSync(BenchmarkPresetSchema)(expectValue());
        index += 1;
        break;
      case "--phases":
        phases = parsePhaseList(expectValue());
        index += 1;
        break;
      case "--http-profiles":
        httpProfiles = parseHttpProfileList(expectValue());
        index += 1;
        break;
      case "--browser-profiles":
        browserProfiles = parseBrowserProfileList(expectValue());
        index += 1;
        break;
      case "--http-concurrency":
        httpConcurrency = parseConcurrencyList(expectValue());
        index += 1;
        break;
      case "--browser-concurrency":
        browserConcurrency = parseConcurrencyList(expectValue());
        index += 1;
        break;
      case "--http-timeout":
        httpTimeoutMs = Schema.decodeUnknownSync(PositiveIntSchema)(Number(expectValue()));
        index += 1;
        break;
      case "--browser-timeout":
        browserTimeoutMs = Schema.decodeUnknownSync(PositiveIntSchema)(Number(expectValue()));
        index += 1;
        break;
      case "--sample-size":
        samplePageCount = Schema.decodeUnknownSync(
          Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        )(Number(expectValue()));
        index += 1;
        break;
      case "--sample-seed":
        sampleSeed = Schema.decodeUnknownSync(NonEmptyStringSchema)(expectValue());
        index += 1;
        break;
      case "--shard-count":
        shardCount = Schema.decodeUnknownSync(PositiveIntSchema)(Number(expectValue()));
        index += 1;
        break;
      case "--shard-index":
        shardIndex = Schema.decodeUnknownSync(PositiveIntSchema)(Number(expectValue()));
        index += 1;
        break;
      case "--progress":
        progressMode = Schema.decodeUnknownSync(ProgressModeSchema)(expectValue());
        index += 1;
        break;
      case "--progress-width":
        progressWidth = Schema.decodeUnknownSync(PositiveIntSchema)(Number(expectValue()));
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return Schema.decodeUnknownSync(E9BenchmarkSuiteCliOptionsSchema)({
    artifactPath,
    artifactJsonlPath,
    artifactJsonlEnabled,
    corpusArtifactPath,
    mergeArtifactPaths,
    preset,
    phases,
    httpProfiles,
    browserProfiles,
    httpConcurrency,
    browserConcurrency,
    httpTimeoutMs,
    browserTimeoutMs,
    samplePageCount,
    sampleSeed,
    shardCount,
    shardIndex,
    adaptiveStop,
    progressMode,
    progressWidth,
    forceColor,
  });
}

async function persistArtifact(artifactPath: string, artifact: unknown) {
  const resolvedPath = resolve(artifactPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return resolvedPath;
}

function deriveArtifactJsonlPath(artifactPath: string) {
  const resolvedPath = resolve(artifactPath);
  const extension = extname(resolvedPath);
  if (extension === ".json") {
    return `${resolvedPath.slice(0, -extension.length)}.jsonl`;
  }

  return `${resolvedPath}.jsonl`;
}

function formatArtifactJsonlFailure(message: string) {
  return `Failed to persist benchmark JSONL sidecar. ${message}`;
}

function extractArtifactJsonlPathFromArgs(args: readonly string[]) {
  let artifactPath: string | undefined;
  let artifactJsonlPath: string | undefined;
  let artifactJsonlEnabled = true;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const rawValue = args[index + 1];

    if (argument === "--no-artifact-jsonl") {
      artifactJsonlEnabled = false;
      continue;
    }

    if (argument !== "--artifact" && argument !== "--artifact-jsonl") {
      continue;
    }

    if (rawValue === undefined || rawValue.startsWith("--")) {
      continue;
    }

    if (argument === "--artifact") {
      artifactPath = rawValue;
    } else {
      artifactJsonlPath = rawValue;
      artifactJsonlEnabled = true;
    }

    index += 1;
  }

  if (!artifactJsonlEnabled) {
    return undefined;
  }

  return (
    artifactJsonlPath ??
    (artifactPath === undefined ? undefined : deriveArtifactJsonlPath(artifactPath))
  );
}

type E9BenchmarkSuiteArtifactJsonlEntry =
  | {
      readonly recordType: "run-start";
      readonly runId: string;
      readonly recordedAt: string;
      readonly artifactPath?: string | undefined;
      readonly artifactJsonlPath: string;
    }
  | {
      readonly recordType: "progress-event";
      readonly runId: string;
      readonly recordedAt: string;
      readonly event: E9BenchmarkSuiteProgressEvent;
    }
  | {
      readonly recordType: "run-error";
      readonly runId: string;
      readonly recordedAt: string;
      readonly message: string;
    }
  | {
      readonly recordType: "final-artifact";
      readonly runId: string;
      readonly recordedAt: string;
      readonly artifactPath?: string | undefined;
      readonly artifact: Schema.Schema.Type<typeof E9BenchmarkSuiteArtifactSchema>;
    };

function createArtifactJsonlWriter(path: string | undefined) {
  if (path === undefined) {
    return {
      runId: undefined,
      path: undefined,
      append: (_entry: E9BenchmarkSuiteArtifactJsonlEntry) => undefined,
      flush: async () => undefined as string | undefined,
    };
  }

  const resolvedPath = resolve(path);
  const runId = randomUUID();
  let queue: Promise<void> = mkdir(dirname(resolvedPath), { recursive: true }).then(
    () => undefined,
  );
  let firstFailureMessage: string | undefined;
  const ensureParentDir = () => mkdir(dirname(resolvedPath), { recursive: true });

  const appendEntry = async (entry: E9BenchmarkSuiteArtifactJsonlEntry) => {
    await ensureParentDir();

    try {
      await appendFile(resolvedPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      await ensureParentDir();
      await appendFile(resolvedPath, `${JSON.stringify(entry)}\n`, "utf8");
    }
  };

  const append = (entry: E9BenchmarkSuiteArtifactJsonlEntry) => {
    queue = queue
      .then(() => appendEntry(entry))
      .then(() => undefined)
      .catch((cause) => {
        firstFailureMessage ??= readCauseMessage(
          cause,
          `Failed to append benchmark JSONL sidecar at ${resolvedPath}.`,
        );
      });
  };

  const flush = async () => {
    await queue;
    return firstFailureMessage;
  };

  return { append, flush, runId, path: resolvedPath };
}

async function loadArtifact(path: string) {
  const raw = await readFile(resolve(path), "utf8");
  return Schema.decodeUnknownSync(E9BenchmarkSuiteArtifactSchema)(JSON.parse(raw));
}

function formatField(
  key: string,
  value: boolean | number | string | readonly number[] | readonly string[],
) {
  if (Array.isArray(value)) {
    return `${key}=${JSON.stringify(
      value.map((entry) => (typeof entry === "string" ? sanitizeProgressText(entry) : entry)),
    )}`;
  }

  if (typeof value === "string") {
    return `${key}=${JSON.stringify(sanitizeProgressText(value))}`;
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

function progressTone(event: E9BenchmarkSuiteProgressEvent): ProgressTone {
  switch (event.kind) {
    case "attempt-complete":
      if (
        event.blocked ||
        event.error !== undefined ||
        (event.statusCode !== undefined && event.statusCode >= 400)
      ) {
        return "failure";
      }

      if (event.success) {
        return event.redirected ? "warning" : "success";
      }

      return "warning";
    case "sweep-complete":
      if (
        event.successCount === event.pageCount &&
        event.blockedCount === 0 &&
        event.challengeCount === 0
      ) {
        return "success";
      }

      if (event.successCount === 0 || event.blockedCount === event.pageCount) {
        return "failure";
      }

      return "warning";
    case "subbenchmark-complete":
      return event.status === "pass" ? "success" : "failure";
    case "suite-complete":
      return event.status === "pass" ? "success" : event.status === "warn" ? "warning" : "failure";
    default:
      return "info";
  }
}

function attemptOutcome(
  event: Extract<E9BenchmarkSuiteProgressEvent, { kind: "attempt-complete" }>,
) {
  if (
    event.blocked ||
    event.error !== undefined ||
    (event.statusCode !== undefined && event.statusCode >= 400)
  ) {
    return "failure";
  }

  if (event.redirected || event.challengeDetected || !event.success) {
    return "warning";
  }

  return "success";
}

function attemptReason(
  event: Extract<E9BenchmarkSuiteProgressEvent, { kind: "attempt-complete" }>,
) {
  if (event.failureCategory !== undefined) {
    return event.failureCategory;
  }

  if (event.error !== undefined) {
    return sanitizeProgressText(event.error);
  }

  if (event.blocked) {
    return "blocked";
  }

  if (event.challengeDetected) {
    return "challenge";
  }

  if (event.redirected) {
    return "redirect";
  }

  if (event.statusCode !== undefined && event.statusCode >= 400) {
    return `http-${event.statusCode}`;
  }

  if (!event.success) {
    return "incomplete";
  }

  return "ok";
}

function decorateProgressLine(line: string, tone: ProgressTone, color: boolean) {
  const text = `${progressIcon(tone)} ${line}`;
  if (!color) {
    return text;
  }

  return `${progressColor(tone)}${text}\u001B[0m`;
}

function decorateCompactProgressLine(
  line: string,
  tone: ProgressTone,
  color: boolean,
  maxWidth: number | undefined,
) {
  const icon = progressIcon(tone);
  const iconWidth = visibleProgressWidth(icon);

  if (maxWidth !== undefined && maxWidth <= iconWidth) {
    const truncatedIcon = truncateProgressMiddle(icon, maxWidth);
    if (!color) {
      return truncatedIcon;
    }

    return `${progressColor(tone)}${truncatedIcon}\u001B[0m`;
  }

  const suffixWidth = maxWidth === undefined ? undefined : Math.max(0, maxWidth - iconWidth - 1);
  const suffix = suffixWidth === undefined ? line : truncateProgressMiddle(line, suffixWidth);
  return decorateProgressLine(suffix, tone, color);
}

function abbreviatePhase(phase: string) {
  switch (phase) {
    case "live-http-corpus":
      return "h";
    case "live-browser-corpus":
      return "b";
    case "extraction-parity":
      return "s";
    case "high-friction-canary":
      return "c";
    default:
      return phase;
  }
}

function abbreviateProfile(profile: string) {
  switch (profile) {
    case "effect-http":
      return "fxh";
    case "native-fetch":
      return "nat";
    case "effect-browser":
      return "fxb";
    case "patchright-browser":
      return "ptb";
    default:
      return profile
        .replace(/^effect-/u, "fx-")
        .replace(/^patchright-/u, "pt-")
        .replace(/^native-/u, "nat-");
  }
}

function pushCompactSegmentsWithinWidth(
  segments: string[],
  additions: readonly string[],
  maxWidth: number | undefined,
  tail: string | undefined,
  tailReserve: number,
) {
  if (maxWidth === undefined) {
    segments.push(...additions);
    return;
  }

  for (const addition of additions) {
    const nextWidth = visibleProgressWidth([...segments, addition].join(" "));
    if (tail === undefined) {
      if (nextWidth > maxWidth) {
        return;
      }

      segments.push(addition);
      continue;
    }

    const minimumTailWidth = Math.min(visibleProgressWidth(tail), tailReserve);
    if (nextWidth + 1 + minimumTailWidth > maxWidth) {
      return;
    }

    segments.push(addition);
  }
}

function formatCompactProgressEvent(event: E9BenchmarkSuiteProgressEvent, maxWidth?: number) {
  const prefix = "[e9]";
  const line = (() => {
    switch (event.kind) {
      case "suite-start":
        return joinProgressSegments(
          [
            prefix,
            "suite:start",
            `pages=${event.pageCount}`,
            `sites=${event.siteCount}`,
            `sweeps=${event.expectedSweepCount}`,
            `phases=${event.selectedPhases.join(",")}`,
            `http=${event.httpProfiles.join(",") || "-"}`,
            `browser=${event.browserProfiles.join(",") || "-"}`,
            `corpus=${event.corpusPath}`,
          ],
          maxWidth,
        );
      case "phase-start":
        return joinProgressSegments(
          [
            prefix,
            "phase:start",
            abbreviatePhase(event.phase),
            `pages=${event.pageCount}`,
            `profiles=${event.profileCount}`,
            `cc=${event.concurrencyLevels.join(",")}`,
            `sweeps=${event.expectedSweepCount}`,
          ],
          maxWidth,
        );
      case "profile-start":
        return joinProgressSegments(
          [
            prefix,
            "profile:start",
            `${abbreviatePhase(event.phase)}/${abbreviateProfile(event.profile)}`,
            `pages=${event.pageCount}`,
            `sweeps=${event.sweepCount}`,
            `cc=${event.concurrencyLevels.join(",")}`,
          ],
          maxWidth,
        );
      case "sweep-start":
        return joinProgressSegments(
          [
            prefix,
            "sweep:start",
            `${abbreviatePhase(event.phase)}/${abbreviateProfile(event.profile)}`,
            `c=${event.concurrency}`,
            `s=${event.sweepOrdinal}/${event.sweepCount}`,
            `pages=${event.pageCount}`,
          ],
          maxWidth,
        );
      case "attempt-complete": {
        const tail =
          event.error !== undefined
            ? `err=${event.error}`
            : event.redirected && event.finalUrl !== undefined && event.finalUrl !== event.url
              ? `final=${event.finalUrl}`
              : `url=${event.url}`;
        const trailSegments =
          event.error !== undefined
            ? [
                `url=${event.url}`,
                `site=${event.siteId}`,
                `type=${event.pageType}/${event.frictionClass}`,
              ]
            : event.redirected && event.finalUrl !== undefined && event.finalUrl !== event.url
              ? [
                  `url=${event.url}`,
                  `site=${event.siteId}`,
                  `type=${event.pageType}/${event.frictionClass}`,
                ]
              : [`site=${event.siteId}`, `type=${event.pageType}/${event.frictionClass}`];

        const segments = [
          prefix,
          "a",
          `${abbreviatePhase(event.phase)}/${abbreviateProfile(event.profile)}`,
          `c${event.concurrency}`,
          `n${event.completedCount}/${event.totalCount}`,
          ...(event.blocked ? ["blk1"] : []),
          ...(event.challengeDetected ? ["chl1"] : []),
          ...(event.redirected ? ["rdr1"] : []),
          ...(event.statusCode === undefined ? [] : [String(event.statusCode)]),
          `d=${event.durationMs}`,
          ...(event.reportedDurationMs === undefined ? [] : [`r=${event.reportedDurationMs}`]),
          `o=${event.overheadDurationMs}`,
        ];

        pushCompactSegmentsWithinWidth(
          segments,
          [
            ...(event.requestCount === undefined ? [] : [`rq=${event.requestCount}`]),
            ...(event.redirectCount === undefined ? [] : [`rd=${event.redirectCount}`]),
            ...(event.blockedRequestCount === undefined ? [] : [`br=${event.blockedRequestCount}`]),
            `b=${event.contentBytes}`,
            `el=${event.elapsedMs}`,
            `eta=${event.etaMs}`,
            ...trailSegments,
          ],
          maxWidth,
          tail,
          24,
        );

        return joinProgressSegments(segments.concat(tail), maxWidth);
      }
      case "sweep-complete":
        return joinProgressSegments(
          [
            prefix,
            "sweep:done",
            `${abbreviatePhase(event.phase)}/${abbreviateProfile(event.profile)}`,
            `c=${event.concurrency}`,
            `s=${event.sweepOrdinal}/${event.sweepCount}`,
            `ok=${event.successCount}/${event.pageCount}`,
            `blk=${event.blockedCount}`,
            `chl=${event.challengeCount}`,
            `wall=${event.totalWallMs}`,
            `ppm=${event.throughputPagesPerMinute}`,
            `eff=${event.parallelEfficiency}`,
            `rss=${event.rssPeakMb}`,
            `cpu=${event.cpuUserMs}/${event.cpuSystemMs}`,
          ],
          maxWidth,
        );
      case "profile-complete":
        return joinProgressSegments(
          [
            prefix,
            "profile:done",
            `${abbreviatePhase(event.phase)}/${abbreviateProfile(event.profile)}`,
            `attempts=${event.attemptCount}`,
            `sweeps=${event.sweepCount}`,
            `wall=${event.totalWallMs}`,
          ],
          maxWidth,
        );
      case "phase-complete":
        return joinProgressSegments(
          [
            prefix,
            "phase:done",
            abbreviatePhase(event.phase),
            `attempts=${event.attemptCount}`,
            `sweeps=${event.sweepCount}`,
            `wall=${event.totalWallMs}`,
          ],
          maxWidth,
        );
      case "subbenchmark-start":
        return joinProgressSegments([prefix, "sub:start", `task=${event.task}`], maxWidth);
      case "subbenchmark-complete":
        return joinProgressSegments(
          [
            prefix,
            "sub:done",
            `task=${event.task}`,
            `status=${event.status}`,
            `wall=${event.totalWallMs}`,
          ],
          maxWidth,
        );
      case "suite-complete":
        return joinProgressSegments(
          [
            prefix,
            "suite:done",
            `status=${event.status}`,
            `wall=${event.totalWallMs}`,
            `attempts=${event.totalAttemptCount}`,
            `sweeps=${event.totalSweepCount}`,
          ],
          maxWidth,
        );
    }
  })();
  return line;
}

function resolveProgressColor(forceColor: boolean | undefined, tty: boolean) {
  if (forceColor === true) {
    return true;
  }

  const envForceColor = process.env.FORCE_COLOR;
  if (envForceColor !== undefined) {
    return envForceColor !== "0";
  }

  if (process.env.NO_COLOR !== undefined) {
    return false;
  }

  return tty;
}

export function formatE9BenchmarkSuiteProgressEvent(
  event: E9BenchmarkSuiteProgressEvent,
  options: {
    readonly color?: boolean;
    readonly progressMode?: "full" | "compact";
    readonly maxWidth?: number;
  } = {},
) {
  if (options.progressMode === "compact") {
    const tone = progressTone(event);
    const iconWidth = visibleProgressWidth(progressIcon(tone));
    const compactBudget =
      options.maxWidth === undefined ? undefined : Math.max(0, options.maxWidth - iconWidth - 1);
    return decorateCompactProgressLine(
      formatCompactProgressEvent(event, compactBudget),
      tone,
      options.color ?? false,
      options.maxWidth,
    );
  }

  const prefix = "[progress:e9-benchmark-suite]";
  const line = (() => {
    switch (event.kind) {
      case "suite-start":
        return [
          prefix,
          "suite",
          "start",
          formatField("benchmark_id", event.benchmarkId),
          formatField("generated_at", event.generatedAt),
          formatField("phases", event.selectedPhases),
          formatField("corpus_path", event.corpusPath),
          formatField("page_count", event.pageCount),
          formatField("site_count", event.siteCount),
          formatField("http_profiles", event.httpProfiles),
          formatField("browser_profiles", event.browserProfiles),
          formatField("http_concurrency", event.httpConcurrency),
          formatField("browser_concurrency", event.browserConcurrency),
          formatField("expected_sweeps", event.expectedSweepCount),
        ].join(" ");
      case "phase-start":
        return [
          prefix,
          "phase",
          "start",
          formatField("phase", event.phase),
          formatField("page_count", event.pageCount),
          formatField("profile_count", event.profileCount),
          formatField("concurrency", event.concurrencyLevels),
          formatField("expected_sweeps", event.expectedSweepCount),
        ].join(" ");
      case "profile-start":
        return [
          prefix,
          "profile",
          "start",
          formatField("phase", event.phase),
          formatField("profile", event.profile),
          formatField("page_count", event.pageCount),
          formatField("sweep_count", event.sweepCount),
          formatField("concurrency", event.concurrencyLevels),
        ].join(" ");
      case "sweep-start":
        return [
          prefix,
          "sweep",
          "start",
          formatField("phase", event.phase),
          formatField("profile", event.profile),
          formatField("concurrency", event.concurrency),
          formatField("page_count", event.pageCount),
          formatField("sweep", `${event.sweepOrdinal}/${event.sweepCount}`),
        ].join(" ");
      case "attempt-complete":
        return [
          prefix,
          "attempt",
          "complete",
          formatField("phase", event.phase),
          formatField("profile", event.profile),
          formatField("concurrency", event.concurrency),
          formatField("completed", `${event.completedCount}/${event.totalCount}`),
          formatField("input_page", `${event.pageOrdinal}/${event.totalCount}`),
          formatField("outcome", attemptOutcome(event)),
          formatField("reason", attemptReason(event)),
          ...(event.statusCode === undefined ? [] : [formatField("status_code", event.statusCode)]),
          formatField("url", event.url),
          ...(event.finalUrl === undefined ? [] : [formatField("final_url", event.finalUrl)]),
          formatField("site_id", event.siteId),
          formatField("domain", event.domain),
          formatField("page_type", event.pageType),
          formatField("friction", event.frictionClass),
          formatField("success", event.success),
          formatField("blocked", event.blocked),
          formatField("challenge", event.challengeDetected),
          formatField("redirected", event.redirected),
          formatField("duration_ms", event.durationMs),
          ...(event.failureCategory === undefined
            ? []
            : [formatField("failure_category", event.failureCategory)]),
          ...(event.executionMetadata === undefined
            ? []
            : [
                formatField("provider_id", event.executionMetadata.providerId),
                formatField("egress_profile", event.executionMetadata.egressProfileId),
                formatField("egress_plugin", event.executionMetadata.egressPluginId),
                formatField("egress_route_kind", event.executionMetadata.egressRouteKind),
                formatField("identity_profile", event.executionMetadata.identityProfileId),
                formatField("identity_plugin", event.executionMetadata.identityPluginId),
              ]),
          ...(event.reportedDurationMs === undefined
            ? []
            : [formatField("reported_duration_ms", event.reportedDurationMs)]),
          formatField("overhead_ms", event.overheadDurationMs),
          ...(event.requestCount === undefined
            ? []
            : [formatField("request_count", event.requestCount)]),
          ...(event.redirectCount === undefined
            ? []
            : [formatField("redirect_count", event.redirectCount)]),
          ...(event.blockedRequestCount === undefined
            ? []
            : [formatField("blocked_request_count", event.blockedRequestCount)]),
          formatField("content_bytes", event.contentBytes),
          formatField("elapsed_ms", event.elapsedMs),
          formatField("eta_ms", event.etaMs),
          ...(event.warnings === undefined || event.warnings.length === 0
            ? []
            : [formatField("warnings", event.warnings)]),
          ...(event.error === undefined ? [] : [formatField("error", event.error)]),
        ].join(" ");
      case "sweep-complete":
        return [
          prefix,
          "sweep",
          "complete",
          formatField("phase", event.phase),
          formatField("profile", event.profile),
          formatField("concurrency", event.concurrency),
          formatField("sweep", `${event.sweepOrdinal}/${event.sweepCount}`),
          formatField("page_count", event.pageCount),
          formatField("total_wall_ms", event.totalWallMs),
          formatField("throughput_ppm", event.throughputPagesPerMinute),
          formatField("parallel_efficiency", event.parallelEfficiency),
          formatField("success_count", event.successCount),
          formatField("blocked_count", event.blockedCount),
          formatField("challenge_count", event.challengeCount),
          formatField("recovered_browser_allocations", event.recoveredBrowserAllocationCount),
          formatField("rss_peak_mb", event.rssPeakMb),
          formatField("cpu_user_ms", event.cpuUserMs),
          formatField("cpu_system_ms", event.cpuSystemMs),
        ].join(" ");
      case "profile-complete":
        return [
          prefix,
          "profile",
          "complete",
          formatField("phase", event.phase),
          formatField("profile", event.profile),
          formatField("attempt_count", event.attemptCount),
          formatField("sweep_count", event.sweepCount),
          formatField("total_wall_ms", event.totalWallMs),
        ].join(" ");
      case "phase-complete":
        return [
          prefix,
          "phase",
          "complete",
          formatField("phase", event.phase),
          formatField("attempt_count", event.attemptCount),
          formatField("sweep_count", event.sweepCount),
          formatField("total_wall_ms", event.totalWallMs),
        ].join(" ");
      case "subbenchmark-start":
        return [prefix, "subbenchmark", "start", formatField("task", event.task)].join(" ");
      case "subbenchmark-complete":
        return [
          prefix,
          "subbenchmark",
          "complete",
          formatField("task", event.task),
          formatField("status", event.status),
          formatField("total_wall_ms", event.totalWallMs),
        ].join(" ");
      case "suite-complete":
        return [
          prefix,
          "suite",
          "complete",
          formatField("benchmark_id", event.benchmarkId),
          formatField("status", event.status),
          formatField("total_wall_ms", event.totalWallMs),
          formatField("total_attempt_count", event.totalAttemptCount),
          formatField("total_sweep_count", event.totalSweepCount),
        ].join(" ");
    }
  })();

  return decorateProgressLine(line, progressTone(event), options.color ?? false);
}

export async function runDefaultE9BenchmarkSuite(
  options: {
    readonly artifactPath?: string | undefined;
    readonly corpusArtifactPath?: string | undefined;
    readonly mergeArtifactPaths?: ReadonlyArray<string> | undefined;
    readonly preset?:
      | "fast-regression"
      | "scale-study"
      | "full-corpus"
      | "competitor-calibration"
      | undefined;
    readonly phases?: ReadonlyArray<"http" | "browser" | "scrapling" | "canary"> | undefined;
    readonly httpProfiles?: ReadonlyArray<"effect-http" | "native-fetch"> | undefined;
    readonly browserProfiles?: ReadonlyArray<"effect-browser" | "patchright-browser"> | undefined;
    readonly httpConcurrency?: ReadonlyArray<number> | undefined;
    readonly browserConcurrency?: ReadonlyArray<number> | undefined;
    readonly httpTimeoutMs?: number | undefined;
    readonly browserTimeoutMs?: number | undefined;
    readonly samplePageCount?: number | undefined;
    readonly sampleSeed?: string | undefined;
    readonly shardCount?: number | undefined;
    readonly shardIndex?: number | undefined;
    readonly adaptiveStop?: boolean | undefined;
    readonly progressMode?: "full" | "compact" | undefined;
    readonly progressWidth?: number | undefined;
    readonly forceColor?: boolean | undefined;
  } = {},
  dependencies: {
    readonly onProgress?: (event: E9BenchmarkSuiteProgressEvent) => void;
  } = {},
) {
  const artifact =
    options.mergeArtifactPaths === undefined
      ? await runE9BenchmarkSuite(
          {
            ...(options.corpusArtifactPath === undefined
              ? {}
              : { corpusArtifactPath: options.corpusArtifactPath }),
            ...(options.preset === undefined ? {} : { preset: options.preset }),
            ...(options.phases === undefined ? {} : { phases: options.phases }),
            ...(options.httpProfiles === undefined ? {} : { httpProfiles: options.httpProfiles }),
            ...(options.browserProfiles === undefined
              ? {}
              : { browserProfiles: options.browserProfiles }),
            ...(options.httpConcurrency === undefined
              ? {}
              : { httpConcurrency: options.httpConcurrency }),
            ...(options.browserConcurrency === undefined
              ? {}
              : { browserConcurrency: options.browserConcurrency }),
            ...(options.httpTimeoutMs === undefined
              ? {}
              : { httpTimeoutMs: options.httpTimeoutMs }),
            ...(options.browserTimeoutMs === undefined
              ? {}
              : { browserTimeoutMs: options.browserTimeoutMs }),
            ...(options.samplePageCount === undefined
              ? {}
              : { samplePageCount: options.samplePageCount }),
            ...(options.sampleSeed === undefined ? {} : { sampleSeed: options.sampleSeed }),
            ...(options.shardCount === undefined ? {} : { shardCount: options.shardCount }),
            ...(options.shardIndex === undefined ? {} : { shardIndex: options.shardIndex }),
            ...(options.adaptiveStop === undefined ? {} : { adaptiveStop: options.adaptiveStop }),
          },
          dependencies.onProgress === undefined ? {} : { onProgress: dependencies.onProgress },
        )
      : mergeE9BenchmarkArtifacts(
          await Promise.all(options.mergeArtifactPaths.map((path) => loadArtifact(path))),
        );
  if (options.artifactPath !== undefined) {
    await persistArtifact(options.artifactPath, artifact);
  }

  return Schema.decodeUnknownSync(E9BenchmarkSuiteArtifactSchema)(artifact);
}

export async function runE9BenchmarkSuiteCli(
  args: readonly string[],
  dependencies: {
    readonly setExitCode?: (code: number) => void;
    readonly writeLine?: (line: string) => void;
    readonly writeProgressLine?: (line: string) => void;
    readonly runBenchmarkSuite?: typeof runDefaultE9BenchmarkSuite;
    readonly isProgressTTY?: boolean;
    readonly progressColumns?: number | undefined;
  } = {},
) {
  const setExitCode = dependencies.setExitCode ?? ((_code: number) => undefined);
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));
  const writeProgressLine =
    dependencies.writeProgressLine ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });
  const runBenchmarkSuite = dependencies.runBenchmarkSuite ?? runDefaultE9BenchmarkSuite;
  const isProgressTTY = dependencies.isProgressTTY ?? process.stderr.isTTY ?? false;
  const progressColumns = dependencies.progressColumns ?? process.stderr.columns;
  let artifactJsonlWriter = createArtifactJsonlWriter(undefined);

  try {
    artifactJsonlWriter = createArtifactJsonlWriter(extractArtifactJsonlPathFromArgs(args));
    const options = parseOptions(args);
    const color = resolveProgressColor(options.forceColor, isProgressTTY);
    const progressMode = options.progressMode ?? "full";
    const maxWidth =
      progressMode === "compact"
        ? Math.max(1, options.progressWidth ?? progressColumns ?? 140)
        : undefined;
    const artifactJsonlPath =
      options.artifactJsonlEnabled === false
        ? undefined
        : (options.artifactJsonlPath ??
          (options.artifactPath === undefined
            ? undefined
            : deriveArtifactJsonlPath(options.artifactPath)));
    artifactJsonlWriter = createArtifactJsonlWriter(artifactJsonlPath);
    if (artifactJsonlWriter.runId !== undefined && artifactJsonlWriter.path !== undefined) {
      artifactJsonlWriter.append({
        recordType: "run-start",
        runId: artifactJsonlWriter.runId,
        recordedAt: new Date().toISOString(),
        artifactPath: options.artifactPath,
        artifactJsonlPath: artifactJsonlWriter.path,
      });
    }
    const artifact = await runBenchmarkSuite(options, {
      onProgress: (event) => {
        if (artifactJsonlWriter.runId !== undefined) {
          artifactJsonlWriter.append({
            recordType: "progress-event",
            runId: artifactJsonlWriter.runId,
            recordedAt: new Date().toISOString(),
            event,
          });
        }
        writeProgressLine(
          formatE9BenchmarkSuiteProgressEvent(event, {
            color,
            progressMode,
            ...(maxWidth === undefined ? {} : { maxWidth }),
          }),
        );
      },
    });
    if (artifactJsonlWriter.runId !== undefined) {
      artifactJsonlWriter.append({
        recordType: "final-artifact",
        runId: artifactJsonlWriter.runId,
        recordedAt: new Date().toISOString(),
        artifactPath: options.artifactPath,
        artifact,
      });
    }
    const artifactJsonlFlushError = await artifactJsonlWriter.flush();
    if (artifactJsonlFlushError !== undefined) {
      setExitCode(1);
      throw new Error(formatArtifactJsonlFailure(artifactJsonlFlushError));
    }
    writeLine(
      JSON.stringify(
        summarizeCliArtifactOutput(artifact, {
          artifactPath: options.artifactPath,
          artifactJsonlPath,
        }),
      ),
    );
    return artifact;
  } catch (cause) {
    const message = readCauseMessage(cause, "Failed to run the E9 benchmark suite.");
    if (artifactJsonlWriter.runId !== undefined) {
      artifactJsonlWriter.append({
        recordType: "run-error",
        runId: artifactJsonlWriter.runId,
        recordedAt: new Date().toISOString(),
        message,
      });
    }
    const artifactJsonlFlushError = await artifactJsonlWriter.flush();
    setExitCode(1);
    throw new Error(
      artifactJsonlFlushError === undefined
        ? message
        : `${message} (${formatArtifactJsonlFailure(artifactJsonlFlushError)})`,
    );
  }
}

if (import.meta.main) {
  await runE9BenchmarkSuiteCli(process.argv.slice(2));
  // Bun can keep HTTP sockets alive after the artifact is fully persisted.
  // Exit explicitly so the CLI does not hang after a completed benchmark run.
  process.exit(process.exitCode ?? 0);
}
