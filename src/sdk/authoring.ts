import { Schema } from "effect";
import { InvalidInputError } from "./errors.ts";

const JSON_OBJECT_SCHEMA = Schema.Record(Schema.String, Schema.Unknown);
export type JsonObject = Schema.Schema.Type<typeof JSON_OBJECT_SCHEMA>;
export type AccessAuthoringCommandKind = "access" | "extract" | "render";
export type CliOptionValue = string | boolean;
export type CliOptions = Record<string, CliOptionValue>;
type MutableJsonObject = Record<string, unknown>;

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

function assertAllowedKeys(
  field: string,
  payload: JsonObject,
  allowedKeys: ReadonlyArray<string>,
): void {
  const disallowedKeys = Object.keys(payload).filter((key) => !allowedKeys.includes(key));
  if (disallowedKeys.length === 0) {
    return;
  }

  throw new InvalidInputError({
    message: `${field} contains unsupported fields`,
    details: `${field} only accepts ${allowedKeys.join(", ")}; received ${disallowedKeys.join(", ")}`,
  });
}

function normalizeExecutionPayload(payload: JsonObject): JsonObject | undefined {
  if (payload.execution === undefined) {
    return undefined;
  }

  const executionPayload = decodeJsonObject('"execution"', payload.execution);
  assertAllowedKeys('"execution"', executionPayload, [
    "mode",
    "providerId",
    "egress",
    "identity",
    "browserRuntimeProfileId",
    "http",
    "browser",
    "fallback",
  ]);

  const egressPayload =
    executionPayload.egress === undefined
      ? undefined
      : decodeJsonObject('"execution.egress"', executionPayload.egress);
  if (egressPayload !== undefined) {
    assertAllowedKeys('"execution.egress"', egressPayload, ["profileId", "pluginConfig"]);
  }

  const identityPayload =
    executionPayload.identity === undefined
      ? undefined
      : decodeJsonObject('"execution.identity"', executionPayload.identity);
  if (identityPayload !== undefined) {
    assertAllowedKeys('"execution.identity"', identityPayload, ["profileId", "pluginConfig"]);
  }

  const httpPayload =
    executionPayload.http === undefined
      ? undefined
      : decodeJsonObject('"execution.http"', executionPayload.http);
  if (httpPayload !== undefined) {
    assertAllowedKeys('"execution.http"', httpPayload, ["userAgent"]);
  }

  const browserPayload =
    executionPayload.browser === undefined
      ? undefined
      : decodeJsonObject('"execution.browser"', executionPayload.browser);
  if (browserPayload !== undefined) {
    assertAllowedKeys('"execution.browser"', browserPayload, [
      "waitUntil",
      "timeoutMs",
      "userAgent",
    ]);
  }

  const fallbackPayload =
    executionPayload.fallback === undefined
      ? undefined
      : decodeJsonObject('"execution.fallback"', executionPayload.fallback);
  if (fallbackPayload !== undefined) {
    assertAllowedKeys('"execution.fallback"', fallbackPayload, ["browserOnAccessWall"]);
  }

  return {
    ...(executionPayload.mode === undefined ? {} : { mode: executionPayload.mode }),
    ...(executionPayload.providerId === undefined
      ? {}
      : { providerId: executionPayload.providerId }),
    ...(egressPayload === undefined ? {} : { egress: egressPayload }),
    ...(identityPayload === undefined ? {} : { identity: identityPayload }),
    ...(executionPayload.browserRuntimeProfileId === undefined
      ? {}
      : { browserRuntimeProfileId: executionPayload.browserRuntimeProfileId }),
    ...(httpPayload === undefined ? {} : { http: httpPayload }),
    ...(browserPayload === undefined ? {} : { browser: browserPayload }),
    ...(fallbackPayload === undefined ? {} : { fallback: fallbackPayload }),
  };
}

export function normalizeAuthoringPayload(
  kind: AccessAuthoringCommandKind,
  rawPayload: unknown,
): JsonObject {
  const payload = decodeJsonObject("Request body", rawPayload);
  const allowedTopLevelKeys =
    kind === "extract"
      ? ["url", "selector", "attr", "all", "limit", "timeoutMs", "execution"]
      : ["url", "timeoutMs", "execution"];
  assertAllowedKeys("Request body", payload, allowedTopLevelKeys);

  const execution = normalizeExecutionPayload(payload);

  if (kind === "access" || kind === "render") {
    return {
      ...(payload.url === undefined ? {} : { url: payload.url }),
      ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }),
      ...(execution === undefined ? {} : { execution }),
    };
  }

  return {
    ...(payload.url === undefined ? {} : { url: payload.url }),
    ...(payload.selector === undefined ? {} : { selector: payload.selector }),
    ...(payload.attr === undefined ? {} : { attr: payload.attr }),
    ...(payload.all === undefined ? {} : { all: payload.all }),
    ...(payload.limit === undefined ? {} : { limit: payload.limit }),
    ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }),
    ...(execution === undefined ? {} : { execution }),
  };
}

export const normalizeAccessPreviewPayload = (rawPayload: unknown) =>
  normalizeAuthoringPayload("access", rawPayload);

export const normalizeRenderPreviewPayload = (rawPayload: unknown) =>
  normalizeAuthoringPayload("render", rawPayload);

export const normalizeExtractRunPayload = (rawPayload: unknown) =>
  normalizeAuthoringPayload("extract", rawPayload);

function parseNonEmptyString(name: string, value: CliOptionValue | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "boolean") {
    throw new InvalidInputError({
      message: `Option --${name} requires a value`,
    });
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidInputError({
      message: `Option --${name} cannot be empty`,
    });
  }

  return trimmed;
}

function parseFlagOrValue(
  name: string,
  value: CliOptionValue | undefined,
): string | boolean | undefined {
  if (value === undefined || typeof value === "boolean") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidInputError({
      message: `Option --${name} cannot be empty`,
    });
  }

  return trimmed;
}

function parseJsonObjectOption(
  name: string,
  value: CliOptionValue | undefined,
): MutableJsonObject | undefined {
  const input = parseNonEmptyString(name, value);
  if (input === undefined) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new InvalidInputError({
      message: `Option --${name} must be valid JSON`,
      details: String(error),
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidInputError({
      message: `Option --${name} must be a JSON object`,
    });
  }

  return parsed as MutableJsonObject;
}

function buildCliExecutionPayload(options: CliOptions): JsonObject | undefined {
  const mode = parseNonEmptyString("mode", options["mode"]);
  const providerId = parseNonEmptyString("provider", options["provider"]);
  const egressProfileId = parseNonEmptyString("egress-profile", options["egress-profile"]);
  const identityProfileId = parseNonEmptyString("identity-profile", options["identity-profile"]);
  const egressConfig = parseJsonObjectOption("egress-config", options["egress-config"]);
  const identityConfig = parseJsonObjectOption("identity-config", options["identity-config"]);
  const browserRuntimeProfileId = parseNonEmptyString(
    "browser-runtime-profile",
    options["browser-runtime-profile"],
  );
  const httpUserAgent = parseNonEmptyString("http-user-agent", options["http-user-agent"]);
  const browserWaitUntil = parseNonEmptyString("browser-wait-until", options["browser-wait-until"]);
  const browserTimeoutMs = parseNonEmptyString("browser-timeout-ms", options["browser-timeout-ms"]);
  const browserUserAgent = parseNonEmptyString("browser-user-agent", options["browser-user-agent"]);

  const http: MutableJsonObject = {};
  if (httpUserAgent !== undefined) {
    http.userAgent = httpUserAgent;
  }

  const browser: MutableJsonObject = {};
  if (browserWaitUntil !== undefined) {
    browser.waitUntil = browserWaitUntil;
  }
  if (browserTimeoutMs !== undefined) {
    browser.timeoutMs = browserTimeoutMs;
  }
  if (browserUserAgent !== undefined) {
    browser.userAgent = browserUserAgent;
  }

  const execution: MutableJsonObject = {};
  if (mode !== undefined) {
    execution.mode = mode;
  }
  if (providerId !== undefined) {
    execution.providerId = providerId;
  }
  if (egressProfileId !== undefined || egressConfig !== undefined) {
    execution.egress = {
      ...(egressProfileId === undefined ? {} : { profileId: egressProfileId }),
      ...(egressConfig === undefined ? {} : { pluginConfig: egressConfig }),
    };
  }
  if (identityProfileId !== undefined || identityConfig !== undefined) {
    execution.identity = {
      ...(identityProfileId === undefined ? {} : { profileId: identityProfileId }),
      ...(identityConfig === undefined ? {} : { pluginConfig: identityConfig }),
    };
  }
  if (browserRuntimeProfileId !== undefined) {
    execution.browserRuntimeProfileId = browserRuntimeProfileId;
  }
  if (Object.keys(http).length > 0) {
    execution.http = http;
  }
  if (Object.keys(browser).length > 0) {
    execution.browser = browser;
  }

  return Object.keys(execution).length === 0 ? undefined : execution;
}

export function normalizeCliPayload(
  kind: AccessAuthoringCommandKind,
  options: CliOptions,
): JsonObject {
  const execution = buildCliExecutionPayload(options);
  const url = parseNonEmptyString("url", options["url"]);
  const timeoutMs = parseNonEmptyString("timeout-ms", options["timeout-ms"]);

  if (url === undefined) {
    throw new InvalidInputError({
      message: "Missing required option: --url",
    });
  }

  const payload: MutableJsonObject = { url };
  if (timeoutMs !== undefined) {
    payload.timeoutMs = timeoutMs;
  }
  if (kind === "extract") {
    const selector = parseNonEmptyString("selector", options["selector"]);
    const attr = parseNonEmptyString("attr", options["attr"]);
    const all = parseFlagOrValue("all", options["all"]);
    const limit = parseNonEmptyString("limit", options["limit"]);

    if (selector !== undefined) {
      payload.selector = selector;
    }
    if (attr !== undefined) {
      payload.attr = attr;
    }
    if (all !== undefined) {
      payload.all = all;
    }
    if (limit !== undefined) {
      payload.limit = limit;
    }
  }
  if (execution !== undefined) {
    payload.execution = execution;
  }

  return normalizeAuthoringPayload(kind, payload);
}
