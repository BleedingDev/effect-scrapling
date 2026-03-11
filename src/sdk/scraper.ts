import * as cheerio from "cheerio";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { Effect, Layer, Schema, ServiceMap } from "effect";
import {
  AccessExecutionRuntime,
  AccessExecutionRuntimeLive,
  DEFAULT_BROWSER_PROVIDER_ID,
  DEFAULT_HTTP_PROVIDER_ID,
  toExecutionMetadata,
  type AccessExecutionInput,
  type ResolvedExecutionPlan,
} from "./access-runtime.ts";
import {
  AccessPreviewRequestSchema,
  AccessPreviewResponseSchema,
  type AccessPreviewRequest,
  type AccessPreviewResponse,
  type BrowserWaitUntil,
  ExtractRunRequestSchema,
  ExtractRunResponseSchema,
  type ExtractRunRequest,
  type ExtractRunResponse,
  RenderPreviewRequestSchema,
  RenderPreviewResponseSchema,
  type RenderPreviewRequest,
  type RenderPreviewResponse,
} from "./schemas.ts";
import { type PlaywrightPage, withPooledBrowserPage } from "./browser-pool.ts";
import { formatUnknownError } from "./error-guards.ts";
import { BrowserError, ExtractionError, InvalidInputError, NetworkError } from "./errors.ts";

const MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT = "effect-scrapling/0.0.1";
const RENDER_PREVIEW_LINK_LIMIT = 8;
const RENDER_PREVIEW_TEXT_LIMIT = 280;
const IPV4_SEGMENT_TEXT_SCHEMA = Schema.String.check(Schema.isPattern(/^(?:0|[1-9]\d{0,2})$/u));
const IPV4_SEGMENT_SCHEMA = Schema.FiniteFromString.check(Schema.isInt())
  .check(Schema.isGreaterThanOrEqualTo(0))
  .check(Schema.isLessThanOrEqualTo(255));
const IPV6_SEGMENT_TEXT_SCHEMA = Schema.String.check(Schema.isPattern(/^[0-9a-f]{1,4}$/iu));
const IPV6_SEGMENT_SCHEMA = Schema.NumberFromString.check(Schema.isInt())
  .check(Schema.isGreaterThanOrEqualTo(0))
  .check(Schema.isLessThanOrEqualTo(0xffff));
const decodeIpv4SegmentText = Schema.decodeUnknownSync(IPV4_SEGMENT_TEXT_SCHEMA);
const decodeIpv4Segment = Schema.decodeUnknownSync(IPV4_SEGMENT_SCHEMA);
const decodeIpv6SegmentText = Schema.decodeUnknownSync(IPV6_SEGMENT_TEXT_SCHEMA);
const decodeIpv6Segment = Schema.decodeUnknownSync(IPV6_SEGMENT_SCHEMA);

type FetchServiceShape = {
  readonly fetch: FetchClient;
};

export type FetchClient = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

export class FetchService extends ServiceMap.Service<FetchService, FetchServiceShape>()(
  "@effect-scrapling/FetchService",
) {}

export const FetchServiceLive = Layer.succeed(FetchService)({
  fetch: globalThis.fetch,
});

function decodeRequest<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  payload: unknown,
  operation: string,
): Effect.Effect<S["Type"], InvalidInputError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(payload),
    catch: (error) =>
      new InvalidInputError({
        message: `Invalid ${operation} payload`,
        details: String(error),
      }),
  });
}

function resolveHeaders(
  userAgent?: string,
  extraHeaders?: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...extraHeaders,
    "user-agent": userAgent ?? DEFAULT_USER_AGENT,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
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
    if (candidate.protocol !== "http:" && candidate.protocol !== "https:") {
      return undefined;
    }

    candidate.username = "";
    candidate.password = "";
    candidate.hash = "";
    return candidate.toString();
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

function buildRenderPreviewArtifacts(page: FetchPageResult) {
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
      contentLength: Math.max(1, page.contentLength),
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

function parseIpv4Segments(
  hostname: string,
): readonly [number, number, number, number] | undefined {
  const segments = hostname.split(".");
  if (segments.length !== 4) {
    return undefined;
  }

  const [firstSegment, secondSegment, thirdSegment, fourthSegment] = segments;

  try {
    return [
      decodeIpv4Segment(decodeIpv4SegmentText(firstSegment)),
      decodeIpv4Segment(decodeIpv4SegmentText(secondSegment)),
      decodeIpv4Segment(decodeIpv4SegmentText(thirdSegment)),
      decodeIpv4Segment(decodeIpv4SegmentText(fourthSegment)),
    ];
  } catch {
    return undefined;
  }
}

function parseIpv6SegmentsPart(part: string): number[] | undefined {
  if (part.length === 0) {
    return [];
  }

  const segments = part.split(":");
  const parsed: number[] = [];

  for (const segment of segments) {
    if (segment.includes(".")) {
      const ipv4 = parseIpv4Segments(segment);
      if (!ipv4) {
        return undefined;
      }

      parsed.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      continue;
    }

    try {
      parsed.push(decodeIpv6Segment(`0x${decodeIpv6SegmentText(segment)}`));
    } catch {
      return undefined;
    }
  }

  return parsed;
}

function parseIpv6Segments(hostname: string): readonly number[] | undefined {
  const normalized = hostname.toLowerCase().replace(/%.+$/u, "");
  const hasCompression = normalized.includes("::");

  if (!hasCompression) {
    const parsed = parseIpv6SegmentsPart(normalized);
    return parsed?.length === 8 ? parsed : undefined;
  }

  if (normalized.indexOf("::") !== normalized.lastIndexOf("::")) {
    return undefined;
  }

  const [leftRaw = "", rightRaw = ""] = normalized.split("::", 2);
  const left = parseIpv6SegmentsPart(leftRaw);
  const right = parseIpv6SegmentsPart(rightRaw);

  if (!left || !right) {
    return undefined;
  }

  const zerosToInsert = 8 - (left.length + right.length);
  if (zerosToInsert < 1) {
    return undefined;
  }

  return [...left, ...Array.from({ length: zerosToInsert }, () => 0), ...right];
}

function isDisallowedIpv4(hostname: string): boolean {
  const segments = parseIpv4Segments(hostname);
  if (!segments) {
    return false;
  }

  const [first, second] = segments;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isDisallowedIpv6(hostname: string): boolean {
  const segments = parseIpv6Segments(hostname);
  if (!segments || segments.length !== 8) {
    return false;
  }

  const isUnspecified = segments.every((segment) => segment === 0);
  const isLoopback = segments.slice(0, 7).every((segment) => segment === 0) && segments[7] === 1;
  const first = segments[0] ?? 0;
  const second = segments[1] ?? 0;
  const isUniqueLocal = (first & 0xfe00) === 0xfc00;
  const isLinkLocal = (first & 0xffc0) === 0xfe80;
  const isIpv4Mapped =
    segments.slice(0, 5).every((segment) => segment === 0) && segments[5] === 0xffff;

  if (isUnspecified || isLoopback || isUniqueLocal || isLinkLocal) {
    return true;
  }

  if (isIpv4Mapped) {
    const thirdToLast = segments[6] ?? 0;
    const secondToLast = segments[7] ?? 0;
    const mappedIpv4 = `${thirdToLast >> 8}.${thirdToLast & 0xff}.${secondToLast >> 8}.${secondToLast & 0xff}`;
    return isDisallowedIpv4(mappedIpv4);
  }

  return first === 0x2001 && second === 0x0db8;
}

function getUrlPolicyViolation(
  candidate: URL,
  options?: { readonly allowNonNetworkProtocols?: boolean },
): string | undefined {
  const allowNonNetworkProtocols = options?.allowNonNetworkProtocols ?? false;

  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") {
    return allowNonNetworkProtocols
      ? undefined
      : `URL protocol "${candidate.protocol}" is not allowed; use http or https`;
  }

  if (candidate.username.length > 0 || candidate.password.length > 0) {
    return "credentialed URLs are not allowed";
  }

  const normalizedHost = candidate.hostname.toLowerCase();
  if (normalizedHost === "localhost" || normalizedHost.endsWith(".localhost")) {
    return `host "${candidate.hostname}" is not allowed`;
  }

  const ipVersion = isIP(normalizedHost);
  if (ipVersion === 4 && isDisallowedIpv4(normalizedHost)) {
    return `host "${candidate.hostname}" resolves to a private or reserved IPv4 range`;
  }

  if (ipVersion === 6 && isDisallowedIpv6(normalizedHost)) {
    return `host "${candidate.hostname}" resolves to a private, loopback, or reserved IPv6 range`;
  }

  return undefined;
}

function parseUserFacingUrl(rawUrl: string): Effect.Effect<string, InvalidInputError> {
  return Effect.try({
    try: () => new URL(rawUrl),
    catch: (error) =>
      new InvalidInputError({
        message: "URL must be a valid absolute HTTP(S) URL",
        details: formatUnknownError(error),
      }),
  }).pipe(
    Effect.flatMap((candidate) => {
      const violation = getUrlPolicyViolation(candidate);
      return violation
        ? Effect.fail(
            new InvalidInputError({
              message: "URL failed security policy",
              details: violation,
            }),
          )
        : Effect.succeed(candidate.toString());
    }),
  );
}

function resolveValidatedUrl(candidate: string, currentUrl?: URL): URL {
  const parsed = currentUrl ? new URL(candidate, currentUrl) : new URL(candidate);
  const violation = getUrlPolicyViolation(parsed);
  if (violation) {
    throw new Error(violation);
  }

  return parsed;
}

type FetchPageResult = {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly contentLength: number;
  readonly html: string;
  readonly durationMs: number;
  readonly timings: {
    readonly requestCount: number;
    readonly redirectCount: number;
    readonly blockedRequestCount: number;
    readonly responseHeadersDurationMs?: number | undefined;
    readonly bodyReadDurationMs?: number | undefined;
    readonly routeRegistrationDurationMs?: number | undefined;
    readonly gotoDurationMs?: number | undefined;
    readonly loadStateDurationMs?: number | undefined;
    readonly domReadDurationMs?: number | undefined;
    readonly headerReadDurationMs?: number | undefined;
  };
  readonly warnings: ReadonlyArray<string>;
};

function roundTiming(value: number) {
  return Math.round(Math.max(0, value) * 1_000) / 1_000;
}

function countRedirectChain(request: unknown) {
  if (!request || typeof request !== "object") {
    return 0;
  }

  let redirectCount = 0;
  let current: unknown = request;

  while (current && typeof current === "object") {
    const redirectedFrom = Reflect.get(current, "redirectedFrom");
    if (typeof redirectedFrom !== "function") {
      break;
    }

    current = redirectedFrom.call(current);
    if (current === undefined || current === null) {
      break;
    }

    redirectCount += 1;
  }

  return redirectCount;
}

function fetchPageHttp(
  url: string,
  plan: ResolvedExecutionPlan,
): Effect.Effect<FetchPageResult, NetworkError, FetchService> {
  return Effect.gen(function* () {
    const fetchService = yield* FetchService;
    return yield* Effect.tryPromise({
      try: async () => {
        const abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort("request-timeout"), plan.timeoutMs);
        const startedAt = performance.now();
        let currentUrl = resolveValidatedUrl(url);
        let requestCount = 0;
        let redirectCount = 0;
        let responseHeadersDurationMs = 0;

        try {
          for (let redirectHop = 0; redirectHop <= MAX_REDIRECTS; redirectHop += 1) {
            requestCount += 1;
            const responseStartedAt = performance.now();
            const response = await fetchService.fetch(currentUrl.toString(), {
              method: "GET",
              headers: resolveHeaders(plan.http?.userAgent, plan.egress.requestHeaders),
              redirect: "manual",
              signal: abortController.signal,
            });
            responseHeadersDurationMs += performance.now() - responseStartedAt;

            if (response.status >= 300 && response.status < 400) {
              if (redirectHop === MAX_REDIRECTS) {
                throw new Error(`Redirect limit exceeded after ${MAX_REDIRECTS} hops`);
              }
              redirectCount += 1;

              const location = response.headers.get("location");
              if (!location) {
                throw new Error(`HTTP ${response.status} redirect missing location header`);
              }

              currentUrl = resolveValidatedUrl(location, currentUrl);
              continue;
            }

            const bodyStartedAt = performance.now();
            const html = await response.text();
            const bodyReadDurationMs = performance.now() - bodyStartedAt;

            if (!response.ok) {
              throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }

            return {
              url,
              finalUrl: currentUrl.toString(),
              status: response.status,
              contentType: response.headers.get("content-type") ?? "",
              contentLength: html.length,
              html,
              durationMs: Math.max(0.001, roundTiming(performance.now() - startedAt)),
              timings: {
                requestCount,
                redirectCount,
                blockedRequestCount: 0,
                responseHeadersDurationMs: roundTiming(responseHeadersDurationMs),
                bodyReadDurationMs: roundTiming(bodyReadDurationMs),
              },
              warnings: [...plan.warnings],
            };
          }

          throw new Error("Unreachable redirect state");
        } finally {
          clearTimeout(timeout);
        }
      },
      catch: (error) =>
        new NetworkError({
          message: `Access failed for ${url}`,
          details: formatUnknownError(error),
        }),
    });
  });
}

function resolveBrowserLoadState(
  waitUntil: BrowserWaitUntil,
): "load" | "domcontentloaded" | "networkidle" {
  if (waitUntil === "commit") {
    return "domcontentloaded";
  }
  return waitUntil;
}

function fetchPageBrowser(
  url: string,
  plan: ResolvedExecutionPlan & { readonly browser: NonNullable<ResolvedExecutionPlan["browser"]> },
): Effect.Effect<FetchPageResult, BrowserError> {
  return withPooledBrowserPage(
    {
      runtimeProfileId: plan.browser.runtimeProfileId,
      poolKey: plan.browser.poolKey,
      userAgent:
        plan.browser.userAgent ??
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      ...(plan.identity.locale === undefined ? {} : { locale: plan.identity.locale }),
      ...(plan.identity.timezoneId === undefined ? {} : { timezoneId: plan.identity.timezoneId }),
    },
    (page: PlaywrightPage) =>
      Effect.tryPromise({
        try: async () => {
          const startedAt = performance.now();
          let blockedRequestReason: string | undefined;
          let blockedRequestCount = 0;

          const routeRegistrationStartedAt = performance.now();
          await page.route("**/*", async (route) => {
            const requestUrl = route.request().url();
            const violation = getUrlPolicyViolation(new URL(requestUrl), {
              allowNonNetworkProtocols: true,
            });

            if (violation) {
              blockedRequestReason ??= `Blocked browser request to ${requestUrl}: ${violation}`;
              blockedRequestCount += 1;
              await route.abort("blockedbyclient");
              return;
            }

            await route.continue();
          });
          const routeRegistrationDurationMs = performance.now() - routeRegistrationStartedAt;

          const gotoStartedAt = performance.now();
          const response = await page.goto(url, {
            waitUntil: plan.browser.waitUntil,
            timeout: plan.browser.timeoutMs,
          });
          const gotoDurationMs = performance.now() - gotoStartedAt;

          if (!response) {
            throw new Error("Navigation completed without an HTTP response");
          }

          const loadStateStartedAt = performance.now();
          await page.waitForLoadState(resolveBrowserLoadState(plan.browser.waitUntil), {
            timeout: plan.browser.timeoutMs,
          });
          const loadStateDurationMs = performance.now() - loadStateStartedAt;

          if (blockedRequestReason) {
            throw new Error(blockedRequestReason);
          }

          const domReadStartedAt = performance.now();
          const html = await page.content();
          const domReadDurationMs = performance.now() - domReadStartedAt;
          const status = response.status();
          const finalUrl = resolveValidatedUrl(page.url()).toString();

          if (status >= 400) {
            throw new Error(`HTTP ${status}`);
          }

          const headerReadStartedAt = performance.now();
          const headers = await response.allHeaders();
          const headerReadDurationMs = performance.now() - headerReadStartedAt;
          const requestGetter = Reflect.get(response, "request");
          const redirectCount =
            typeof requestGetter === "function"
              ? countRedirectChain(requestGetter.call(response))
              : 0;

          return {
            url,
            finalUrl,
            status,
            contentType: headers["content-type"] ?? headers["Content-Type"] ?? "",
            contentLength: html.length,
            html,
            durationMs: Math.max(0.001, roundTiming(performance.now() - startedAt)),
            timings: {
              requestCount: redirectCount + 1,
              redirectCount,
              blockedRequestCount,
              routeRegistrationDurationMs: roundTiming(routeRegistrationDurationMs),
              gotoDurationMs: roundTiming(gotoDurationMs),
              loadStateDurationMs: roundTiming(loadStateDurationMs),
              domReadDurationMs: roundTiming(domReadDurationMs),
              headerReadDurationMs: roundTiming(headerReadDurationMs),
            },
            warnings: [...plan.warnings],
          };
        },
        catch: (error) =>
          new BrowserError({
            message: `Browser access failed for ${url}`,
            details: formatUnknownError(error),
          }),
      }),
  ).pipe(
    Effect.map(({ value, warnings }) => ({
      ...value,
      warnings: [...plan.warnings, ...warnings],
    })),
    Effect.mapError(
      (error) =>
        new BrowserError({
          message: `Browser access failed for ${url}`,
          details: error.details ?? error.message,
        }),
    ),
  );
}

function fetchPage(
  url: string,
  plan: ResolvedExecutionPlan,
): Effect.Effect<FetchPageResult, NetworkError | BrowserError, FetchService> {
  if (plan.mode === "browser" && plan.browser !== undefined) {
    return fetchPageBrowser(url, { ...plan, browser: plan.browser });
  }
  return fetchPageHttp(url, plan);
}

function resolveExecutionPlan(
  input: AccessExecutionInput,
): Effect.Effect<ResolvedExecutionPlan, InvalidInputError> {
  return Effect.gen(function* () {
    const runtime = yield* AccessExecutionRuntime;
    return yield* runtime.resolve(input);
  }).pipe(Effect.provide(AccessExecutionRuntimeLive));
}

export function accessPreview(
  rawPayload: unknown,
): Effect.Effect<
  AccessPreviewResponse,
  InvalidInputError | NetworkError | BrowserError | ExtractionError,
  FetchService
> {
  return Effect.gen(function* () {
    const request: AccessPreviewRequest = yield* decodeRequest(
      AccessPreviewRequestSchema,
      rawPayload,
      "access preview",
    );
    const validatedUrl = yield* parseUserFacingUrl(request.url);
    const executionPlan = yield* resolveExecutionPlan({
      defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
      defaultTimeoutMs: request.timeoutMs,
      execution: request.execution,
    });
    const page = yield* fetchPage(validatedUrl, executionPlan);

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
        execution: toExecutionMetadata(executionPlan),
        timings: page.timings,
      },
      warnings: [...page.warnings],
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
  InvalidInputError | BrowserError | ExtractionError,
  FetchService
> {
  return Effect.gen(function* () {
    const request: RenderPreviewRequest = yield* decodeRequest(
      RenderPreviewRequestSchema,
      rawPayload,
      "render preview",
    );
    const validatedUrl = yield* parseUserFacingUrl(request.url);
    const executionPlan = yield* resolveExecutionPlan({
      defaultProviderId: DEFAULT_BROWSER_PROVIDER_ID,
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
    const page = yield* fetchPageBrowser(validatedUrl, {
      ...executionPlan,
      browser: executionPlan.browser,
    });

    const response: RenderPreviewResponse = {
      ok: true,
      command: "render preview",
      data: {
        url: page.url,
        execution: toExecutionMetadata(executionPlan),
        status: {
          code: page.status,
          ok: page.status < 400,
          redirected: page.finalUrl !== page.url,
          family: resolveStatusFamily(page.status),
        },
        artifacts: buildRenderPreviewArtifacts(page),
      },
      warnings: [...page.warnings],
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

export function extractRun(
  rawPayload: unknown,
): Effect.Effect<
  ExtractRunResponse,
  InvalidInputError | NetworkError | BrowserError | ExtractionError,
  FetchService
> {
  return Effect.gen(function* () {
    const request: ExtractRunRequest = yield* decodeRequest(
      ExtractRunRequestSchema,
      rawPayload,
      "extract run",
    );
    const validatedUrl = yield* parseUserFacingUrl(request.url);

    const selector = request.selector;
    const limit = request.limit;
    const all = request.all;
    const executionPlan = yield* resolveExecutionPlan({
      defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
      defaultTimeoutMs: request.timeoutMs,
      execution: request.execution,
    });

    const page = yield* fetchPage(validatedUrl, executionPlan);

    const values = yield* Effect.try({
      try: () => extractValues(page.html, selector, request.attr, all, limit),
      catch: (error) =>
        new ExtractionError({
          message: `Failed to extract with selector "${selector}"`,
          details: formatUnknownError(error),
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
        execution: toExecutionMetadata(executionPlan),
      },
      warnings:
        values.length === 0
          ? [...page.warnings, `No values matched selector "${selector}"`]
          : [...page.warnings],
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
