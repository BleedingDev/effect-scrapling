import { Schema } from "effect";
import { InvalidInputError } from "./sdk/errors.ts";

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

function normalizeExecutionPayload(payload: JsonObject): JsonObject | undefined {
  const executionPayload =
    payload.execution === undefined
      ? undefined
      : decodeJsonObject('"execution"', payload.execution);
  const httpPayload =
    executionPayload?.http === undefined
      ? undefined
      : decodeJsonObject('"execution.http"', executionPayload.http);
  const browserPayload =
    executionPayload?.browser === undefined
      ? undefined
      : decodeJsonObject('"execution.browser"', executionPayload.browser);
  const sharedUserAgent =
    pickAlias(payload, "userAgent", "user-agent") ??
    (executionPayload ? pickAlias(executionPayload, "userAgent", "user-agent") : undefined);
  const httpUserAgent =
    sharedUserAgent ??
    pickAlias(payload, "httpUserAgent", "http-user-agent") ??
    (executionPayload
      ? pickAlias(executionPayload, "httpUserAgent", "http-user-agent")
      : undefined) ??
    (httpPayload ? pickAlias(httpPayload, "userAgent", "user-agent") : undefined);
  const browserWaitUntil =
    pickAlias(payload, "browserWaitUntil", "browser-wait-until", "waitUntil", "wait-until") ??
    (browserPayload ? pickAlias(browserPayload, "waitUntil", "wait-until") : undefined);
  const browserTimeoutMs =
    pickAlias(payload, "browserTimeoutMs", "browser-timeout-ms", "waitMs", "wait-ms") ??
    (executionPayload ? pickAlias(executionPayload, "timeoutMs", "timeout-ms") : undefined) ??
    (browserPayload ? pickAlias(browserPayload, "timeoutMs", "timeout-ms") : undefined);
  const browserUserAgent =
    sharedUserAgent ??
    pickAlias(payload, "browserUserAgent", "browser-user-agent") ??
    pickAlias(browserPayload ?? {}, "userAgent", "user-agent");

  const execution = {
    providerId:
      pickAlias(payload, "providerId", "provider-id", "provider") ??
      pickAlias(executionPayload ?? {}, "providerId", "provider-id"),
    egressProfileId:
      pickAlias(payload, "egressProfileId", "egress-profile", "egressProfile") ??
      pickAlias(executionPayload ?? {}, "egressProfileId", "egress-profile"),
    identityProfileId:
      pickAlias(payload, "identityProfileId", "identity-profile", "identityProfile") ??
      pickAlias(executionPayload ?? {}, "identityProfileId", "identity-profile"),
    browserRuntimeProfileId:
      pickAlias(
        payload,
        "browserRuntimeProfileId",
        "browser-runtime-profile",
        "browserRuntimeProfile",
      ) ?? pickAlias(executionPayload ?? {}, "browserRuntimeProfileId", "browser-runtime-profile"),
    ...(httpUserAgent === undefined
      ? {}
      : {
          http: {
            userAgent: httpUserAgent,
          },
        }),
    ...(browserWaitUntil === undefined &&
    browserTimeoutMs === undefined &&
    browserUserAgent === undefined
      ? {}
      : {
          browser: {
            ...(browserWaitUntil === undefined ? {} : { waitUntil: browserWaitUntil }),
            ...(browserTimeoutMs === undefined ? {} : { timeoutMs: browserTimeoutMs }),
            ...(browserUserAgent === undefined ? {} : { userAgent: browserUserAgent }),
          },
        }),
  };

  return Object.keys(execution).length === 0 ? undefined : execution;
}

export function normalizePayload(
  kind: "access" | "extract" | "render",
  rawPayload: unknown,
): JsonObject {
  const payload = decodeJsonObject("Request body", rawPayload);
  const execution = normalizeExecutionPayload(payload);
  const timeoutMs = pickAlias(payload, "timeoutMs", "timeout-ms");

  if (kind === "access") {
    return {
      url: pickAlias(payload, "url"),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(execution === undefined ? {} : { execution }),
    };
  }

  if (kind === "render") {
    return {
      url: pickAlias(payload, "url"),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(execution === undefined ? {} : { execution }),
    };
  }

  return {
    url: pickAlias(payload, "url"),
    selector: pickAlias(payload, "selector"),
    attr: pickAlias(payload, "attr"),
    all: pickAlias(payload, "all"),
    limit: pickAlias(payload, "limit"),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(execution === undefined ? {} : { execution }),
  };
}
