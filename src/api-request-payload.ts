import { Schema } from "effect";
import { InvalidInputError } from "./sdk/errors";

const JSON_OBJECT_SCHEMA = Schema.Record(Schema.String, Schema.Unknown);
type JsonObject = Schema.Schema.Type<typeof JSON_OBJECT_SCHEMA>;

function decodeJsonObject(field: string, payload: unknown): JsonObject {
  try {
    return Schema.decodeUnknownSync(JSON_OBJECT_SCHEMA)(payload);
  } catch {
    throw new InvalidInputError({
      message: `${field} must be a JSON object`,
      details: `received type: ${Array.isArray(payload) ? "array" : typeof payload}`,
    });
  }
}

function pickAlias(payload: JsonObject, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(payload, key)) {
      return payload[key];
    }
  }
  return undefined;
}

function normalizeSharedPayload(payload: JsonObject): JsonObject {
  const browserPayload =
    payload.browser === undefined ? undefined : decodeJsonObject('"browser"', payload.browser);
  const waitUntil =
    pickAlias(payload, "waitUntil", "wait-until") ??
    (browserPayload ? pickAlias(browserPayload, "waitUntil", "wait-until") : undefined);
  const waitMs =
    pickAlias(payload, "waitMs", "wait-ms", "browserTimeoutMs", "browser-timeout-ms") ??
    (browserPayload ? pickAlias(browserPayload, "timeoutMs", "timeout-ms") : undefined);
  const browserUserAgent =
    pickAlias(payload, "browserUserAgent", "browser-user-agent") ??
    (browserPayload ? pickAlias(browserPayload, "userAgent", "user-agent") : undefined);

  return {
    url: pickAlias(payload, "url"),
    timeoutMs: pickAlias(payload, "timeoutMs", "timeout-ms"),
    userAgent: pickAlias(payload, "userAgent", "user-agent"),
    mode: pickAlias(payload, "mode"),
    browser:
      browserPayload !== undefined ||
      waitUntil !== undefined ||
      waitMs !== undefined ||
      browserUserAgent !== undefined
        ? {
            waitUntil,
            timeoutMs: waitMs,
            userAgent: browserUserAgent,
          }
        : undefined,
  };
}

export function normalizePayload(kind: "access" | "extract", rawPayload: unknown): JsonObject {
  const payload = decodeJsonObject("Request body", rawPayload);
  const sharedPayload = normalizeSharedPayload(payload);

  if (kind === "access") {
    return sharedPayload;
  }

  return {
    ...sharedPayload,
    selector: pickAlias(payload, "selector"),
    attr: pickAlias(payload, "attr"),
    all: pickAlias(payload, "all"),
    limit: pickAlias(payload, "limit"),
  };
}
