#!/usr/bin/env bun

import { Effect } from "effect";
import { ExtractionError, InvalidInputError, NetworkError } from "./sdk/errors";
import { accessPreview, extractRun, runDoctor } from "./sdk/scraper";

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
      400
    );
  }

  if (error instanceof NetworkError) {
    return json(
      {
        ok: false,
        code: error._tag,
        message: error.message,
        details: error.details ?? null,
      },
      502
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
      422
    );
  }

  return json(
    {
      ok: false,
      code: "UnknownError",
      message: String(error),
    },
    500
  );
}

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
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
      const doctor = await Effect.runPromise(runDoctor());
      return json({
        ok: doctor.ok,
        command: "doctor",
        data: doctor,
        warnings: doctor.ok ? [] : ["One or more runtime checks failed"],
      });
    }

    if (req.method === "POST" && url.pathname === "/access/preview") {
      try {
        const payload = await readBody(req);
        const response = await Effect.runPromise(accessPreview(payload));
        return json(response);
      } catch (error) {
        return toErrorResponse(error);
      }
    }

    if (req.method === "POST" && url.pathname === "/extract/run") {
      try {
        const payload = await readBody(req);
        const response = await Effect.runPromise(extractRun(payload));
        return json(response);
      } catch (error) {
        return toErrorResponse(error);
      }
    }

    return json(
      {
        ok: false,
        message: "Not found",
        routes: [
          "GET /health",
          "GET /doctor",
          "POST /access/preview",
          "POST /extract/run",
        ],
      },
      404
    );
  },
});

console.log(`effect-scrapling api listening on :${port}`);
