#!/usr/bin/env bun

import { Cause, Effect, Exit, Option } from "effect";
import { normalizePayload } from "./api-request-payload.ts";
import {
  isBrowserError,
  isExtractionError,
  isInvalidInputError,
  isNetworkError,
} from "./sdk/error-guards.ts";
import {
  InvalidInputError,
  type BrowserError,
  type ExtractionError,
  type NetworkError,
} from "./sdk/errors.ts";
import {
  accessPreview,
  extractRun,
  FetchService,
  FetchServiceLive,
  type FetchClient,
  runDoctor,
} from "./sdk/scraper.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function toErrorResponse(error: unknown): Response {
  if (isInvalidInputError(error)) {
    return json(
      {
        ok: false,
        code: "InvalidInputError",
        message: error.message,
        details: error.details ?? null,
      },
      400,
    );
  }

  if (isNetworkError(error)) {
    return json(
      {
        ok: false,
        code: "NetworkError",
        message: error.message,
        details: error.details ?? null,
      },
      502,
    );
  }

  if (isBrowserError(error)) {
    return json(
      {
        ok: false,
        code: "BrowserError",
        message: error.message,
        details: error.details ?? null,
      },
      502,
    );
  }

  if (isExtractionError(error)) {
    return json(
      {
        ok: false,
        code: "ExtractionError",
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

function knownRoutes(): string[] {
  return ["GET /health", "GET /doctor", "POST /access/preview", "POST /extract/run"];
}

function provideFetchService<A, E>(
  effect: Effect.Effect<A, E, FetchService>,
  fetchClient?: FetchClient,
): Effect.Effect<A, E, never> {
  if (fetchClient) {
    return effect.pipe(
      Effect.provideService(FetchService, {
        fetch: fetchClient,
      }),
    );
  }

  return effect.pipe(Effect.provide(FetchServiceLive));
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
  fetchClient?: FetchClient,
): Promise<Response> {
  try {
    const rawPayload = await readBody(req);
    const payload = normalizePayload(kind, rawPayload);
    const response = await runEffect(provideFetchService(runner(payload), fetchClient));
    return json(response);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function handleApiRequest(req: Request, fetchClient?: FetchClient): Promise<Response> {
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
    return runRouteEffect(req, "access", accessPreview, fetchClient);
  }

  if (req.method === "POST" && url.pathname === "/extract/run") {
    return runRouteEffect(req, "extract", extractRun, fetchClient);
  }

  return json(
    {
      ok: false,
      message: "Not found",
      routes: knownRoutes(),
    },
    404,
  );
}

export function startApiServer(port = Number(process.env.PORT || "3000")) {
  const server = Bun.serve({
    port,
    fetch(req) {
      return handleApiRequest(req);
    },
  });

  console.log(`effect-scrapling api listening on :${port}`);
  return server;
}

if (import.meta.main) {
  startApiServer();
}
