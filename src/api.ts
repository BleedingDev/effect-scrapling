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
import {
  AccessEngineClosedError,
  createEngine,
  type AccessEngine,
  type CreateAccessEngineOptions,
  type FetchClient,
} from "./sdk/host.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function toErrorResponse(error: unknown): Response {
  if (error instanceof AccessEngineClosedError) {
    return json(
      {
        ok: false,
        code: "AccessEngineClosedError",
        message: error.message,
        details: error.details ?? null,
      },
      503,
    );
  }

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
export type ApiRequestHandler = ((req: Request) => Promise<Response>) & {
  readonly close: () => Promise<void>;
};

function hasCustomEngineAssembly(options: ApiHostEngineOptions | undefined) {
  return options !== undefined && Object.keys(options).length > 0;
}

function getSharedApiEngine() {
  sharedApiEnginePromise ??= Effect.runPromise(createEngine()).catch((error) => {
    sharedApiEnginePromise = undefined;
    throw error;
  });
  return sharedApiEnginePromise;
}

type AccessEngineRunner = {
  readonly use: <A>(run: (engine: AccessEngine) => Effect.Effect<A, unknown, never>) => Promise<A>;
  readonly close: () => Promise<void>;
};

function createClosedHandlerError() {
  return new AccessEngineClosedError({
    message: "API request handler is closed",
    details: "Create a new API request handler before processing additional requests.",
  });
}

function createAccessEngineRunner(
  fetchClient?: FetchClient,
  engineOptions?: ApiHostEngineOptions,
): AccessEngineRunner {
  let closed = false;
  let activeUses = 0;
  let waitForDrainResolve: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;

  const ensureOpen = () => {
    if (closed) {
      throw createClosedHandlerError();
    }
  };

  const releaseUse = () => {
    activeUses -= 1;
    if (activeUses === 0) {
      waitForDrainResolve?.();
      waitForDrainResolve = undefined;
    }
  };

  if (fetchClient === undefined && !hasCustomEngineAssembly(engineOptions)) {
    return {
      use: async (run) => {
        ensureOpen();
        activeUses += 1;
        try {
          return await getSharedApiEngine().then((engine) => runEffect(run(engine)));
        } finally {
          releaseUse();
        }
      },
      close: async () => {
        closed = true;
        if (activeUses > 0) {
          closePromise ??= new Promise<void>((resolve) => {
            waitForDrainResolve = resolve;
          });
          await closePromise;
        }
      },
    };
  }

  let enginePromise: Promise<AccessEngine> | undefined;

  const getEngine = () => {
    ensureOpen();
    enginePromise ??= Effect.runPromise(
      createEngine({
        ...engineOptions,
        ...(fetchClient === undefined ? {} : { fetchClient }),
      }),
    ).catch((error) => {
      enginePromise = undefined;
      throw error;
    });
    return enginePromise;
  };

  return {
    use: async (run) => {
      ensureOpen();
      activeUses += 1;
      try {
        return await getEngine().then((engine) => runEffect(run(engine)));
      } finally {
        releaseUse();
      }
    },
    close: async () => {
      closed = true;
      closePromise ??= (async () => {
        if (activeUses > 0) {
          await new Promise<void>((resolve) => {
            waitForDrainResolve = resolve;
          });
        }

        const activeEngine = await enginePromise?.catch(() => undefined);
        enginePromise = undefined;
        if (activeEngine !== undefined) {
          await Effect.runPromise(activeEngine.close);
        }
      })();
      await closePromise;
    },
  };
}

async function runRouteEffect(
  req: Request,
  kind: "access" | "extract" | "render",
  engineRunner: AccessEngineRunner,
): Promise<Response> {
  try {
    const rawPayload = await readBody(req);
    const payload = normalizePayload(kind, rawPayload);
    const response =
      kind === "access"
        ? await engineRunner.use((engine) => engine.accessPreview(payload))
        : kind === "render"
          ? await engineRunner.use((engine) => engine.renderPreview(payload))
          : await engineRunner.use((engine) => engine.extractRun(payload));
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
): ApiRequestHandler {
  const engineRunner = createAccessEngineRunner(options.fetchClient, options.engine);
  let closed = false;
  let activeRequests = 0;
  let waitForDrainResolve: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;

  const releaseRequest = () => {
    activeRequests -= 1;
    if (activeRequests === 0) {
      waitForDrainResolve?.();
      waitForDrainResolve = undefined;
    }
  };

  const handler = (async (req: Request) => {
    if (closed) {
      return toErrorResponse(createClosedHandlerError());
    }

    activeRequests += 1;
    try {
      return await handleApiRequestWithRunner(req, engineRunner);
    } finally {
      releaseRequest();
    }
  }) as ApiRequestHandler;
  Object.defineProperty(handler, "close", {
    value: async () => {
      closed = true;
      closePromise ??= (async () => {
        if (activeRequests > 0) {
          await new Promise<void>((resolve) => {
            waitForDrainResolve = resolve;
          });
        }
        await engineRunner.close();
      })();
      await closePromise;
    },
    enumerable: true,
  });
  return handler;
}

async function handleApiRequestWithRunner(
  req: Request,
  engineRunner: AccessEngineRunner,
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
    try {
      return json(await engineRunner.use((engine) => engine.runDoctor()));
    } catch (error) {
      return toErrorResponse(error);
    }
  }

  if (req.method === "POST" && url.pathname === "/access/preview") {
    return runRouteEffect(req, "access", engineRunner);
  }

  if (req.method === "POST" && url.pathname === "/render/preview") {
    return runRouteEffect(req, "render", engineRunner);
  }

  if (req.method === "POST" && url.pathname === "/extract/run") {
    return runRouteEffect(req, "extract", engineRunner);
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

export async function handleApiRequest(
  req: Request,
  fetchClient?: FetchClient,
  engineOptions?: ApiHostEngineOptions,
): Promise<Response> {
  const engineRunner = createAccessEngineRunner(fetchClient, engineOptions);

  try {
    return await handleApiRequestWithRunner(req, engineRunner);
  } finally {
    await engineRunner.close();
  }
}

export function startApiServer(port = Number(process.env.PORT || "3000")) {
  const handler = createApiRequestHandler();
  const server = Bun.serve({
    port,
    fetch: handler,
  });
  const stop = server.stop.bind(server);
  let stopPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const close = async (closeActiveConnections?: boolean) => {
    stopPromise ??= Promise.resolve(stop(closeActiveConnections));
    await stopPromise;
    closePromise ??= handler.close();
    await closePromise;
  };

  Object.defineProperty(server, "stop", {
    value: close,
    configurable: true,
    enumerable: true,
    writable: true,
  });
  Object.defineProperty(server, "close", {
    value: close,
    configurable: true,
    enumerable: true,
  });

  console.log(`effect-scrapling api listening on :${port}`);
  return server as typeof server & {
    readonly stop: (closeActiveConnections?: boolean) => Promise<void>;
    readonly close: (closeActiveConnections?: boolean) => Promise<void>;
  };
}

if (import.meta.main) {
  startApiServer();
}
