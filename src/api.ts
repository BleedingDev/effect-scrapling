#!/usr/bin/env bun

import { Cause, Effect, Exit, Option } from "effect";
import { BrowserError, ExtractionError, InvalidInputError, NetworkError } from "./sdk/errors";
import {
  accessPreview,
  extractRun,
  FetchService,
  FetchServiceLive,
  runDoctor,
} from "./sdk/scraper";

const ACCESS_MODES = new Set(["http", "browser"]);
const BROWSER_WAIT_UNTIL_VALUES = new Set(["load", "domcontentloaded", "networkidle", "commit"]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function toErrorResponse(error: unknown): Response {
  if (error instanceof InvalidInputError) {
    return json(
      {
        ok: false,
        code: error._tag,
        message: error.message,
        details: error.details ?? null,
      },
      400,
    );
  }

  if (error instanceof NetworkError || error instanceof BrowserError) {
    return json(
      {
        ok: false,
        code: error._tag,
        message: error.message,
        details: error.details ?? null,
      },
      502,
    );
  }

  if (error instanceof ExtractionError) {
    return json(
      {
        ok: false,
        code: error._tag,
        message: error.message,
        details: error.details ?? null,
      },
      422,
    );
  }

  return json(
    {
      ok: false,
      code: "UnknownError",
      message: String(error),
    },
    500,
  );
}

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch (error) {
    throw new InvalidInputError({
      message: "Request body must be valid JSON",
      details: String(error),
    });
  }
}

function unwrapFailure(cause: Cause.Cause<unknown>): unknown {
  return Option.getOrElse(Cause.findErrorOption(cause), () => new Error(Cause.pretty(cause)));
}

async function runEffect<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw unwrapFailure(exit.cause);
}

function asRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new InvalidInputError({
      message: "Request body must be a JSON object",
      details: `received type: ${Array.isArray(payload) ? "array" : typeof payload}`,
    });
  }
  return payload as Record<string, unknown>;
}

function asOptionalRecord(field: string, payload: unknown): Record<string, unknown> | undefined {
  if (payload === undefined) {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new InvalidInputError({
      message: `"${field}" must be an object`,
      details: `received type: ${Array.isArray(payload) ? "array" : typeof payload}`,
    });
  }
  return payload as Record<string, unknown>;
}

function getField(payload: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(payload, key)) {
      return payload[key];
    }
  }
  return undefined;
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function parseOptionalNonEmptyString(field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new InvalidInputError({
      message: `"${field}" must be a string`,
      details: `received type: ${typeof value}`,
    });
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidInputError({
      message: `"${field}" cannot be empty`,
    });
  }

  return trimmed;
}

function parseOptionalPositiveInt(field: string, value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number.parseInt(value, 10)
        : Number.NaN;

  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new InvalidInputError({
      message: `"${field}" must be a positive integer`,
      details: `received: ${String(value)}`,
    });
  }

  return numeric;
}

function parseOptionalBoolean(field: string, value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  throw new InvalidInputError({
    message: `"${field}" must be a boolean`,
    details: `received: ${String(value)}`,
  });
}

function parseOptionalMode(value: unknown): string | undefined {
  const mode = parseOptionalNonEmptyString("mode", value);
  if (mode === undefined) {
    return undefined;
  }

  if (!ACCESS_MODES.has(mode)) {
    throw new InvalidInputError({
      message: `"mode" must be one of: ${Array.from(ACCESS_MODES).join(", ")}`,
      details: `received: ${mode}`,
    });
  }

  return mode;
}

function parseOptionalWaitUntil(value: unknown): string | undefined {
  const waitUntil = parseOptionalNonEmptyString("waitUntil", value);
  if (waitUntil === undefined) {
    return undefined;
  }

  if (!BROWSER_WAIT_UNTIL_VALUES.has(waitUntil)) {
    throw new InvalidInputError({
      message: `"waitUntil" must be one of: ${Array.from(BROWSER_WAIT_UNTIL_VALUES).join(", ")}`,
      details: `received: ${waitUntil}`,
    });
  }

  return waitUntil;
}

function normalizeSharedPayload(rawPayload: unknown): Record<string, unknown> {
  const payload = asRecord(rawPayload);
  const normalized: Record<string, unknown> = {};
  const browserPayload = asOptionalRecord("browser", payload.browser);
  const url = parseOptionalNonEmptyString("url", getField(payload, "url"));

  const timeoutMs = parseOptionalPositiveInt(
    "timeoutMs",
    getField(payload, "timeoutMs", "timeout-ms"),
  );
  const userAgent = parseOptionalNonEmptyString(
    "userAgent",
    getField(payload, "userAgent", "user-agent"),
  );
  const mode = parseOptionalMode(getField(payload, "mode"));
  const waitUntil = parseOptionalWaitUntil(
    firstDefined(
      getField(payload, "waitUntil", "wait-until"),
      browserPayload ? getField(browserPayload, "waitUntil", "wait-until") : undefined,
    ),
  );
  const waitMs = parseOptionalPositiveInt(
    "waitMs",
    firstDefined(
      getField(payload, "waitMs", "wait-ms", "browserTimeoutMs", "browser-timeout-ms"),
      browserPayload ? getField(browserPayload, "timeoutMs", "timeout-ms") : undefined,
    ),
  );
  const browserUserAgent = parseOptionalNonEmptyString(
    "browserUserAgent",
    firstDefined(
      getField(payload, "browserUserAgent", "browser-user-agent"),
      browserPayload ? getField(browserPayload, "userAgent", "user-agent") : undefined,
    ),
  );

  if (url !== undefined) {
    normalized.url = url;
  }
  if (timeoutMs !== undefined) {
    normalized.timeoutMs = timeoutMs;
  }
  if (userAgent !== undefined) {
    normalized.userAgent = userAgent;
  }
  if (mode !== undefined) {
    normalized.mode = mode;
  }

  if (
    browserPayload ||
    waitUntil !== undefined ||
    waitMs !== undefined ||
    browserUserAgent !== undefined
  ) {
    const browser: Record<string, unknown> = browserPayload ? { ...browserPayload } : {};
    if (waitUntil !== undefined) {
      browser.waitUntil = waitUntil;
    }
    if (waitMs !== undefined) {
      browser.timeoutMs = waitMs;
    }
    if (browserUserAgent !== undefined) {
      browser.userAgent = browserUserAgent;
    }
    normalized.browser = browser;
  }

  return normalized;
}

function normalizeAccessPayload(rawPayload: unknown): Record<string, unknown> {
  const payload = normalizeSharedPayload(rawPayload);
  const url = parseOptionalNonEmptyString("url", payload.url);
  if (url === undefined) {
    throw new InvalidInputError({
      message: `"url" is required`,
    });
  }
  payload.url = url;
  return payload;
}

function normalizeExtractPayload(rawPayload: unknown): Record<string, unknown> {
  const payload = normalizeSharedPayload(rawPayload);

  const url = parseOptionalNonEmptyString("url", payload.url);
  if (url === undefined) {
    throw new InvalidInputError({
      message: `"url" is required`,
    });
  }

  const selector = parseOptionalNonEmptyString("selector", payload.selector);
  const attr = parseOptionalNonEmptyString("attr", payload.attr);
  const all = parseOptionalBoolean("all", payload.all);
  const limit = parseOptionalPositiveInt("limit", payload.limit);

  payload.url = url;
  if (selector !== undefined) payload.selector = selector;
  if (attr !== undefined) payload.attr = attr;
  if (all !== undefined) payload.all = all;
  if (limit !== undefined) payload.limit = limit;

  return payload;
}

function normalizePayload(
  kind: "access" | "extract",
  rawPayload: unknown,
): Record<string, unknown> {
  return kind === "access"
    ? normalizeAccessPayload(rawPayload)
    : normalizeExtractPayload(rawPayload);
}

function knownRoutes(): string[] {
  return ["GET /health", "GET /doctor", "POST /access/preview", "POST /extract/run"];
}

async function runRouteEffect<A>(
  req: Request,
  kind: "access" | "extract",
  runner: (
    payload: unknown,
  ) => Effect.Effect<
    A,
    InvalidInputError | NetworkError | BrowserError | ExtractionError,
    FetchService
  >,
): Promise<Response> {
  try {
    const rawPayload = await readBody(req);
    const payload = normalizePayload(kind, rawPayload);
    const response = await runEffect(runner(payload).pipe(Effect.provide(FetchServiceLive)));
    return json(response);
  } catch (error) {
    return toErrorResponse(error);
  }
}

const port = Number(process.env.PORT || "3000");

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "effect-scrapling-api",
        version: "0.0.1",
      });
    }

    if (req.method === "GET" && url.pathname === "/doctor") {
      const doctor = await runEffect(runDoctor());
      return json({
        ok: doctor.ok,
        command: "doctor",
        data: doctor,
        warnings: doctor.ok ? [] : ["One or more runtime checks failed"],
      });
    }

    if (req.method === "POST" && url.pathname === "/access/preview") {
      return runRouteEffect(req, "access", accessPreview);
    }

    if (req.method === "POST" && url.pathname === "/extract/run") {
      return runRouteEffect(req, "extract", extractRun);
    }

    return json(
      {
        ok: false,
        message: "Not found",
        routes: knownRoutes(),
      },
      404,
    );
  },
});

console.log(`effect-scrapling api listening on :${port}`);
