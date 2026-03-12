import * as cheerio from "cheerio";
import { Effect, Schema } from "effect";
import { sanitizeUrlForExport } from "@effect-scrapling/foundation-core/secret-sanitization";
import { type BrowserRuntime } from "./browser-pool.ts";
import {
  AccessExecutionRuntime,
  DEFAULT_BROWSER_PROVIDER_ID,
  DEFAULT_HTTP_PROVIDER_ID,
  toExecutionMetadata,
  type AccessExecutionInput,
  type ResolvedExecutionIntent,
} from "./access-runtime.ts";
import { AccessExecutionCoordinator } from "./access-execution-coordinator.ts";
import { type AccessExecutionResult } from "./access-provider-runtime.ts";
import { formatUnknownError } from "./error-guards.ts";
import {
  AccessQuarantinedError,
  AccessResourceError,
  BrowserError,
  ExtractionError,
  InvalidInputError,
  NetworkError,
} from "./errors.ts";
export {
  FetchService,
  FetchServiceLive,
  type FetchClient,
  type FetchRequestInit,
} from "./fetch-service.ts";
import {
  AccessPreviewRequestSchema,
  AccessPreviewResponseSchema,
  type AccessPreviewRequest,
  type AccessPreviewResponse,
  ExtractRunRequestSchema,
  ExtractRunResponseSchema,
  type ExtractRunRequest,
  type ExtractRunResponse,
  RenderPreviewRequestSchema,
  RenderPreviewResponseSchema,
  type RenderPreviewRequest,
  type RenderPreviewResponse,
} from "./schemas.ts";
import { getUrlPolicyViolation, parseUserFacingUrl } from "./url-policy.ts";

const RENDER_PREVIEW_LINK_LIMIT = 8;
const RENDER_PREVIEW_TEXT_LIMIT = 280;

interface ExactShapeRecord {
  readonly [key: string]: ExactShape;
}

type ExactShape = true | ExactShapeRecord;

const EXECUTION_PROFILE_SHAPE = {
  mode: true,
  providerId: true,
  egress: {
    profileId: true,
    pluginConfig: true,
  },
  identity: {
    profileId: true,
    pluginConfig: true,
  },
  browserRuntimeProfileId: true,
  http: {
    userAgent: true,
  },
  browser: {
    waitUntil: true,
    timeoutMs: true,
    userAgent: true,
  },
  fallback: {
    browserOnAccessWall: true,
  },
} satisfies ExactShape;

const ACCESS_PREVIEW_REQUEST_SHAPE = {
  url: true,
  timeoutMs: true,
  execution: EXECUTION_PROFILE_SHAPE,
} satisfies ExactShape;

const RENDER_PREVIEW_REQUEST_SHAPE = {
  url: true,
  timeoutMs: true,
  execution: EXECUTION_PROFILE_SHAPE,
} satisfies ExactShape;

const EXTRACT_RUN_REQUEST_SHAPE = {
  url: true,
  selector: true,
  attr: true,
  all: true,
  limit: true,
  timeoutMs: true,
  execution: EXECUTION_PROFILE_SHAPE,
} satisfies ExactShape;

function findUnknownProperty(
  payload: unknown,
  shape: ExactShape,
  path: ReadonlyArray<string> = [],
): string | undefined {
  if (shape === true || payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const payloadRecord = payload as Record<string, unknown>;
  const shapeRecord = shape as ExactShapeRecord;

  for (const key of Object.keys(payloadRecord)) {
    if (!Object.prototype.hasOwnProperty.call(shapeRecord, key)) {
      return [...path, key].join(".");
    }

    const nestedUnknown = findUnknownProperty(payloadRecord[key], shapeRecord[key] ?? true, [
      ...path,
      key,
    ]);
    if (nestedUnknown !== undefined) {
      return nestedUnknown;
    }
  }

  return undefined;
}

function decodeRequest<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  payload: unknown,
  operation: string,
  exactShape: ExactShape,
): Effect.Effect<S["Type"], InvalidInputError> {
  return Effect.try({
    try: () => {
      const unknownProperty = findUnknownProperty(payload, exactShape);
      if (unknownProperty !== undefined) {
        throw new Error(`Unknown property "${unknownProperty}"`);
      }

      return Schema.decodeUnknownSync(schema)(payload);
    },
    catch: (error) =>
      new InvalidInputError({
        message: `Invalid ${operation} payload`,
        details: String(error),
      }),
  });
}

function collapsePreviewText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function toPreviewText(value: string): string {
  return collapsePreviewText(value).slice(0, RENDER_PREVIEW_TEXT_LIMIT);
}

function sanitizePreviewLink(rawHref: string | undefined, finalUrl: string): string | undefined {
  if (rawHref === undefined) {
    return undefined;
  }

  try {
    const candidate = new URL(rawHref, finalUrl);
    const violation = getUrlPolicyViolation(candidate);
    if (violation !== undefined) {
      return undefined;
    }

    return sanitizeUrlForExport(candidate.toString());
  } catch {
    return undefined;
  }
}

function resolveStatusFamily(statusCode: number) {
  if (statusCode < 200) {
    return "informational" as const;
  }
  if (statusCode < 300) {
    return "success" as const;
  }
  if (statusCode < 400) {
    return "redirect" as const;
  }
  if (statusCode < 500) {
    return "clientError" as const;
  }
  return "serverError" as const;
}

function buildRenderPreviewArtifacts(page: AccessExecutionResult) {
  const $ = cheerio.load(page.html);
  const titleValue = collapsePreviewText($("title").first().text());
  const title = titleValue.length === 0 ? null : titleValue;
  const linkTargets: string[] = [];
  const seen = new Set<string>();

  for (const node of $("a[href]").toArray()) {
    const href = sanitizePreviewLink($(node).attr("href"), page.finalUrl);
    if (href === undefined || seen.has(href)) {
      continue;
    }

    seen.add(href);
    linkTargets.push(href);
    if (linkTargets.length >= RENDER_PREVIEW_LINK_LIMIT) {
      break;
    }
  }

  return [
    {
      kind: "navigation" as const,
      mediaType: "application/json" as const,
      finalUrl: page.finalUrl,
      contentType: page.contentType,
      contentLength: page.contentLength,
    },
    {
      kind: "renderedDom" as const,
      mediaType: "application/json" as const,
      title,
      textPreview: toPreviewText($("body").first().text() || $.root().text()),
      linkTargets,
      hiddenFieldCount: $("input[type='hidden']").length,
    },
    {
      kind: "timings" as const,
      mediaType: "application/json" as const,
      durationMs: page.durationMs,
      requestCount: page.timings.requestCount,
      redirectCount: page.timings.redirectCount,
      blockedRequestCount: page.timings.blockedRequestCount,
      ...(page.timings.responseHeadersDurationMs === undefined
        ? {}
        : { responseHeadersDurationMs: page.timings.responseHeadersDurationMs }),
      ...(page.timings.bodyReadDurationMs === undefined
        ? {}
        : { bodyReadDurationMs: page.timings.bodyReadDurationMs }),
      ...(page.timings.routeRegistrationDurationMs === undefined
        ? {}
        : { routeRegistrationDurationMs: page.timings.routeRegistrationDurationMs }),
      ...(page.timings.gotoDurationMs === undefined
        ? {}
        : { gotoDurationMs: page.timings.gotoDurationMs }),
      ...(page.timings.loadStateDurationMs === undefined
        ? {}
        : { loadStateDurationMs: page.timings.loadStateDurationMs }),
      ...(page.timings.domReadDurationMs === undefined
        ? {}
        : { domReadDurationMs: page.timings.domReadDurationMs }),
      ...(page.timings.headerReadDurationMs === undefined
        ? {}
        : { headerReadDurationMs: page.timings.headerReadDurationMs }),
    },
  ] as const;
}

function extractValues(
  html: string,
  selector: string,
  attr: string | undefined,
  all: boolean,
  limit: number,
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

function resolveExecutionPlan(
  input: AccessExecutionInput,
): Effect.Effect<ResolvedExecutionIntent, InvalidInputError, AccessExecutionRuntime> {
  return Effect.gen(function* () {
    const runtime = yield* AccessExecutionRuntime;
    return yield* runtime.resolve(input);
  });
}

function executePlan(url: string, intent: ResolvedExecutionIntent) {
  return Effect.gen(function* () {
    const coordinator = yield* AccessExecutionCoordinator;
    return yield* coordinator.execute({ url, intent });
  });
}

export function accessPreview(
  rawPayload: unknown,
): Effect.Effect<
  AccessPreviewResponse,
  | InvalidInputError
  | AccessResourceError
  | AccessQuarantinedError
  | NetworkError
  | BrowserError
  | ExtractionError,
  | import("./fetch-service.ts").FetchService
  | BrowserRuntime
  | AccessExecutionRuntime
  | AccessExecutionCoordinator
> {
  return Effect.gen(function* () {
    const request: AccessPreviewRequest = yield* decodeRequest(
      AccessPreviewRequestSchema,
      rawPayload,
      "access preview",
      ACCESS_PREVIEW_REQUEST_SHAPE,
    );
    const validatedUrl = yield* parseUserFacingUrl(request.url);
    const executionPlan = yield* resolveExecutionPlan({
      command: "access",
      url: validatedUrl,
      defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
      allowUnregisteredDefaultProviderFallback: true,
      defaultTimeoutMs: request.timeoutMs,
      execution: request.execution,
    });
    const executed = yield* executePlan(validatedUrl, executionPlan);
    const page = executed.result;

    const response: AccessPreviewResponse = {
      ok: true,
      command: "access preview",
      data: {
        url: page.url,
        status: page.status,
        finalUrl: page.finalUrl,
        contentType: page.contentType,
        contentLength: page.contentLength,
        durationMs: page.durationMs,
        execution: toExecutionMetadata(executed.context),
        timings: page.timings,
      },
      warnings: [...executed.warnings],
    };

    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(AccessPreviewResponseSchema)(response),
      catch: (error) =>
        new ExtractionError({
          message: "Access preview response schema validation failed",
          details: formatUnknownError(error),
        }),
    });
  });
}

export function renderPreview(
  rawPayload: unknown,
): Effect.Effect<
  RenderPreviewResponse,
  InvalidInputError | AccessResourceError | AccessQuarantinedError | BrowserError | ExtractionError,
  | import("./fetch-service.ts").FetchService
  | BrowserRuntime
  | AccessExecutionRuntime
  | AccessExecutionCoordinator
> {
  return Effect.gen(function* () {
    const request: RenderPreviewRequest = yield* decodeRequest(
      RenderPreviewRequestSchema,
      rawPayload,
      "render preview",
      RENDER_PREVIEW_REQUEST_SHAPE,
    );
    const validatedUrl = yield* parseUserFacingUrl(request.url);
    const executionPlan = yield* resolveExecutionPlan({
      command: "render",
      url: validatedUrl,
      defaultProviderId: DEFAULT_BROWSER_PROVIDER_ID,
      allowUnregisteredDefaultProviderFallback: true,
      defaultTimeoutMs: request.timeoutMs,
      execution: request.execution,
    });

    if (executionPlan.mode !== "browser" || executionPlan.browser === undefined) {
      return yield* Effect.fail(
        new InvalidInputError({
          message: "Render preview requires a browser execution provider",
          details: `Resolved provider "${executionPlan.providerId}" does not support rendered DOM preview.`,
        }),
      );
    }

    const executed = yield* executePlan(validatedUrl, executionPlan).pipe(
      Effect.mapError((error) =>
        error._tag === "InvalidInputError" ||
        error._tag === "NetworkError" ||
        error._tag === "AccessResourceError" ||
        error._tag === "AccessQuarantinedError"
          ? new BrowserError({
              message: `Browser access failed for ${validatedUrl}`,
              details: error.details ?? error.message,
            })
          : error,
      ),
    );
    const page = executed.result;

    const response: RenderPreviewResponse = {
      ok: true,
      command: "render preview",
      data: {
        url: page.url,
        execution: toExecutionMetadata(executed.context),
        status: {
          code: page.status,
          ok: page.status >= 200 && page.status < 300,
          redirected: page.finalUrl !== page.url,
          family: resolveStatusFamily(page.status),
        },
        artifacts: buildRenderPreviewArtifacts(page),
      },
      warnings: [...executed.warnings],
    };

    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(RenderPreviewResponseSchema)(response),
      catch: (error) =>
        new ExtractionError({
          message: "Render preview response schema validation failed",
          details: formatUnknownError(error),
        }),
    });
  });
}

export function extractRun(
  rawPayload: unknown,
): Effect.Effect<
  ExtractRunResponse,
  | InvalidInputError
  | AccessResourceError
  | AccessQuarantinedError
  | NetworkError
  | BrowserError
  | ExtractionError,
  | import("./fetch-service.ts").FetchService
  | BrowserRuntime
  | AccessExecutionRuntime
  | AccessExecutionCoordinator
> {
  return Effect.gen(function* () {
    const request: ExtractRunRequest = yield* decodeRequest(
      ExtractRunRequestSchema,
      rawPayload,
      "extract run",
      EXTRACT_RUN_REQUEST_SHAPE,
    );
    const validatedUrl = yield* parseUserFacingUrl(request.url);
    const executionPlan = yield* resolveExecutionPlan({
      command: "extract",
      url: validatedUrl,
      defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
      allowUnregisteredDefaultProviderFallback: true,
      defaultTimeoutMs: request.timeoutMs,
      execution: request.execution,
    });
    const executed = yield* executePlan(validatedUrl, executionPlan);
    const page = executed.result;

    const values = yield* Effect.try({
      try: () =>
        extractValues(page.html, request.selector, request.attr, request.all, request.limit),
      catch: (error) =>
        new ExtractionError({
          message: `Failed to extract with selector "${request.selector}"`,
          details: formatUnknownError(error),
        }),
    });

    const response: ExtractRunResponse = {
      ok: true,
      command: "extract run",
      data: {
        url: page.url,
        selector: request.selector,
        attr: request.attr ?? null,
        count: values.length,
        values,
        durationMs: page.durationMs,
        execution: toExecutionMetadata(executed.context),
      },
      warnings:
        values.length === 0
          ? [...executed.warnings, `No values matched selector "${request.selector}"`]
          : [...executed.warnings],
    };

    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(ExtractRunResponseSchema)(response),
      catch: (error) =>
        new ExtractionError({
          message: "Extract response schema validation failed",
          details: formatUnknownError(error),
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
    const bunRuntime = Reflect.get(globalThis, "Bun");
    const bunVersion =
      typeof bunRuntime === "object" &&
      bunRuntime !== null &&
      typeof Reflect.get(bunRuntime, "version") === "string"
        ? String(Reflect.get(bunRuntime, "version"))
        : "unavailable";
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
        bun: bunVersion,
        platform: process.platform,
        arch: process.arch,
      },
      checks,
    };
  });
}
