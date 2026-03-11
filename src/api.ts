#!/usr/bin/env bun

import { Cause, Effect, Exit, Option } from "effect";
import { normalizePayload } from "./api-request-payload.ts";
import {
  isAccessQuarantinedError,
  isAccessResourceError,
  isBrowserError,
  isExtractionError,
  isInvalidInputError,
  isNetworkError,
} from "./sdk/error-guards.ts";
import { InvalidInputError } from "./sdk/errors.ts";
import { createEngine, type AccessEngine, type CreateAccessEngineOptions } from "./sdk/engine.ts";
import { type FetchClient } from "./sdk/scraper.ts";

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

  if (isAccessResourceError(error)) {
    return json(
      {
        ok: false,
        code: "AccessResourceError",
        message: error.message,
        details: error.details ?? null,
      },
      503,
    );
  }

  if (isAccessQuarantinedError(error)) {
    return json(
      {
        ok: false,
        code: "AccessQuarantinedError",
        message: error.message,
        details: error.details ?? null,
      },
      429,
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
  return [
    "GET /health",
    "GET /doctor",
    "POST /access/preview",
    "POST /render/preview",
    "POST /extract/run",
  ];
}

let sharedApiEnginePromise: Promise<AccessEngine> | undefined;
export type ApiHostEngineOptions = Omit<CreateAccessEngineOptions, "fetchClient">;

function hasCustomEngineAssembly(options: ApiHostEngineOptions | undefined) {
  return options !== undefined && Object.keys(options).length > 0;
}

function getSharedApiEngine() {
  sharedApiEnginePromise ??= Effect.runPromise(createEngine());
  return sharedApiEnginePromise;
}

async function withAccessEngine<A>(
  run: (engine: AccessEngine) => Effect.Effect<A, unknown, never>,
  fetchClient?: FetchClient,
  engineOptions?: ApiHostEngineOptions,
): Promise<A> {
  if (fetchClient === undefined && !hasCustomEngineAssembly(engineOptions)) {
    return runEffect(run(await getSharedApiEngine()));
  }

  const engine = await Effect.runPromise(
    createEngine({
      ...engineOptions,
      ...(fetchClient === undefined ? {} : { fetchClient }),
    }),
  );
  try {
    return await runEffect(run(engine));
  } finally {
    await Effect.runPromise(engine.close);
  }
}

async function runRouteEffect(
  req: Request,
  kind: "access" | "extract" | "render",
  fetchClient?: FetchClient,
  engineOptions?: ApiHostEngineOptions,
): Promise<Response> {
  try {
    const rawPayload = await readBody(req);
    const payload = normalizePayload(kind, rawPayload);
    const response =
      kind === "access"
        ? await withAccessEngine(
            (engine) => engine.accessPreview(payload),
            fetchClient,
            engineOptions,
          )
        : kind === "render"
          ? await withAccessEngine(
              (engine) => engine.renderPreview(payload),
              fetchClient,
              engineOptions,
            )
          : await withAccessEngine(
              (engine) => engine.extractRun(payload),
              fetchClient,
              engineOptions,
            );
    return json(response);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export function createApiRequestHandler(
  options: {
    readonly fetchClient?: FetchClient | undefined;
    readonly engine?: ApiHostEngineOptions | undefined;
  } = {},
) {
  return (req: Request) => handleApiRequest(req, options.fetchClient, options.engine);
}

export async function handleApiRequest(
  req: Request,
  fetchClient?: FetchClient,
  engineOptions?: ApiHostEngineOptions,
): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    return json({
      ok: true,
      service: "effect-scrapling-api",
      version: "0.0.1",
    });
  }

  if (req.method === "GET" && url.pathname === "/doctor") {
    return json(await withAccessEngine((engine) => engine.runDoctor(), fetchClient, engineOptions));
  }

  if (req.method === "POST" && url.pathname === "/access/preview") {
    return runRouteEffect(req, "access", fetchClient, engineOptions);
  }

  if (req.method === "POST" && url.pathname === "/render/preview") {
    return runRouteEffect(req, "render", fetchClient, engineOptions);
  }

  if (req.method === "POST" && url.pathname === "/extract/run") {
    return runRouteEffect(req, "extract", fetchClient, engineOptions);
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
