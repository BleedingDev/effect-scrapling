import * as cheerio from "cheerio";
import { Effect, Schema } from "effect";
import {
  AccessPreviewRequestSchema,
  AccessPreviewResponseSchema,
  type AccessPreviewRequest,
  type AccessPreviewResponse,
  ExtractRunRequestSchema,
  ExtractRunResponseSchema,
  type ExtractRunRequest,
  type ExtractRunResponse,
} from "./schemas";
import { ExtractionError, InvalidInputError, NetworkError } from "./errors";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SELECTOR = "title";
const DEFAULT_LIMIT = 20;
const DEFAULT_USER_AGENT = "effect-scrapling/0.0.1";

function decodeRequest<A, I>(
  schema: Schema.Schema<A, I, never>,
  payload: unknown,
  operation: string
): Effect.Effect<A, InvalidInputError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(payload),
    catch: (error) =>
      new InvalidInputError({
        message: `Invalid ${operation} payload`,
        details: String(error),
      }),
  });
}

function resolveTimeout(timeoutMs?: number): number {
  if (typeof timeoutMs === "number" && timeoutMs > 0) {
    return timeoutMs;
  }
  return DEFAULT_TIMEOUT_MS;
}

function resolveHeaders(userAgent?: string): Record<string, string> {
  return {
    "user-agent": userAgent ?? DEFAULT_USER_AGENT,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
}

type FetchPageResult = {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly contentLength: number;
  readonly html: string;
  readonly durationMs: number;
};

function fetchPage(
  url: string,
  timeoutMs: number,
  userAgent?: string
): Effect.Effect<FetchPageResult, NetworkError> {
  return Effect.tryPromise({
    try: async () => {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort("request-timeout"), timeoutMs);
      const startedAt = Date.now();

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: resolveHeaders(userAgent),
          redirect: "follow",
          signal: abortController.signal,
        });

        const html = await response.text();
        const endedAt = Date.now();

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        return {
          url,
          finalUrl: response.url,
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          contentLength: html.length,
          html,
          durationMs: Math.max(1, endedAt - startedAt),
        };
      } finally {
        clearTimeout(timeout);
      }
    },
    catch: (error) =>
      new NetworkError({
        message: `Access failed for ${url}`,
        details: String(error),
      }),
  });
}

export function accessPreview(rawPayload: unknown): Effect.Effect<AccessPreviewResponse, InvalidInputError | NetworkError> {
  return Effect.gen(function* () {
    const request = yield* decodeRequest(AccessPreviewRequestSchema, rawPayload, "access preview");
    const timeoutMs = resolveTimeout(request.timeoutMs);
    const page = yield* fetchPage(request.url, timeoutMs, request.userAgent);

    const response: AccessPreviewResponse = {
      ok: true,
      command: "access preview",
      data: {
        url: page.url,
        status: page.status,
        finalUrl: page.finalUrl,
        contentType: page.contentType,
        contentLength: Math.max(1, page.contentLength),
        durationMs: page.durationMs,
      },
      warnings: [],
    };

    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(AccessPreviewResponseSchema)(response),
      catch: (error) =>
        new ExtractionError({
          message: "Access preview response schema validation failed",
          details: String(error),
        }),
    });
  });
}

function extractValues(
  html: string,
  selector: string,
  attr: string | undefined,
  all: boolean,
  limit: number
): string[] {
  const $ = cheerio.load(html);
  const nodes = $(selector).toArray();
  const max = all ? limit : 1;
  const values: string[] = [];

  for (const node of nodes) {
    if (values.length >= max) break;
    const raw = attr ? $(node).attr(attr) : $(node).text();
    const value = (raw ?? "").trim();
    if (value.length > 0) {
      values.push(value);
    }
  }

  return values;
}

export function extractRun(rawPayload: unknown): Effect.Effect<ExtractRunResponse, InvalidInputError | NetworkError | ExtractionError> {
  return Effect.gen(function* () {
    const request: ExtractRunRequest = yield* decodeRequest(ExtractRunRequestSchema, rawPayload, "extract run");

    const selector = request.selector ?? DEFAULT_SELECTOR;
    const limit = request.limit ?? DEFAULT_LIMIT;
    const all = request.all ?? false;
    const timeoutMs = resolveTimeout(request.timeoutMs);

    const page = yield* fetchPage(request.url, timeoutMs, request.userAgent);

    const values = yield* Effect.try({
      try: () => extractValues(page.html, selector, request.attr, all, limit),
      catch: (error) =>
        new ExtractionError({
          message: `Failed to extract with selector "${selector}"`,
          details: String(error),
        }),
    });

    const response: ExtractRunResponse = {
      ok: true,
      command: "extract run",
      data: {
        url: page.url,
        selector,
        attr: request.attr ?? null,
        count: values.length,
        values,
        durationMs: page.durationMs,
      },
      warnings: values.length === 0 ? [`No values matched selector "${selector}"`] : [],
    };

    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(ExtractRunResponseSchema)(response),
      catch: (error) =>
        new ExtractionError({
          message: "Extract response schema validation failed",
          details: String(error),
        }),
    });
  });
}

export function runDoctor(): Effect.Effect<{
  readonly ok: boolean;
  readonly runtime: {
    readonly bun: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly ok: boolean;
    readonly details: string;
  }>;
}> {
  return Effect.sync(() => {
    const checks = [
      {
        name: "fetch",
        ok: typeof fetch === "function",
        details: "Global fetch is available",
      },
      {
        name: "cheerio",
        ok: typeof cheerio.load === "function",
        details: "Cheerio parser is available",
      },
      {
        name: "effect",
        ok: typeof Effect.gen === "function",
        details: "Effect runtime is available",
      },
    ] as const;

    return {
      ok: checks.every((check) => check.ok),
      runtime: {
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
      },
      checks,
    };
  });
}
