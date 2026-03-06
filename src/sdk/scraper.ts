import * as cheerio from "cheerio";
import { isIP } from "node:net";
import { Effect, Layer, Schema, ServiceMap } from "effect";
import {
  AccessPreviewRequestSchema,
  AccessPreviewResponseSchema,
  type AccessMode,
  type AccessPreviewRequest,
  type AccessPreviewResponse,
  type BrowserOptions,
  type BrowserWaitUntil,
  ExtractRunRequestSchema,
  ExtractRunResponseSchema,
  type ExtractRunRequest,
  type ExtractRunResponse,
} from "./schemas";
import { formatUnknownError } from "./error-guards";
import { BrowserError, ExtractionError, InvalidInputError, NetworkError } from "./errors";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SELECTOR = "title";
const DEFAULT_LIMIT = 20;
const MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT = "effect-scrapling/0.0.1";
const DEFAULT_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const DEFAULT_BROWSER_WAIT_UNTIL: BrowserWaitUntil = "networkidle";

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

function resolveTimeout(timeoutMs?: number): number {
  if (typeof timeoutMs === "number" && timeoutMs > 0) {
    return timeoutMs;
  }
  return DEFAULT_TIMEOUT_MS;
}

function resolveBrowserWaitUntil(waitUntil?: BrowserWaitUntil): BrowserWaitUntil {
  return waitUntil ?? DEFAULT_BROWSER_WAIT_UNTIL;
}

function resolveHeaders(userAgent?: string): Record<string, string> {
  return {
    "user-agent": userAgent ?? DEFAULT_USER_AGENT,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
}

function parseIpv4Segments(
  hostname: string,
): readonly [number, number, number, number] | undefined {
  const segments = hostname.split(".");
  if (segments.length !== 4) {
    return undefined;
  }

  const parsed = segments.map((segment) => Number.parseInt(segment, 10));
  if (
    parsed.some(
      (segment, index) =>
        !Number.isInteger(segment) ||
        segment < 0 ||
        segment > 255 ||
        String(segment) !== segments[index],
    )
  ) {
    return undefined;
  }

  return parsed as [number, number, number, number];
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

    if (!/^[0-9a-f]{1,4}$/iu.test(segment)) {
      return undefined;
    }

    parsed.push(Number.parseInt(segment, 16));
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

type RequestFetchOptions = {
  readonly mode?: AccessMode | undefined;
  readonly timeoutMs?: number | undefined;
  readonly userAgent?: string | undefined;
  readonly browser?: BrowserOptions | undefined;
};

type HttpFetchOptions = {
  readonly mode: "http";
  readonly timeoutMs: number;
  readonly userAgent?: string;
};

type BrowserFetchOptions = {
  readonly mode: "browser";
  readonly timeoutMs: number;
  readonly userAgent?: string;
  readonly waitUntil: BrowserWaitUntil;
};

type ResolvedFetchOptions = HttpFetchOptions | BrowserFetchOptions;

function resolveFetchOptions(request: RequestFetchOptions): ResolvedFetchOptions {
  const mode: AccessMode = request.mode ?? "http";
  if (mode === "browser") {
    const userAgent = request.browser?.userAgent ?? request.userAgent;
    return {
      mode,
      timeoutMs: resolveTimeout(request.browser?.timeoutMs ?? request.timeoutMs),
      waitUntil: resolveBrowserWaitUntil(request.browser?.waitUntil),
      ...(userAgent !== undefined ? { userAgent } : {}),
    };
  }

  const userAgent = request.userAgent;
  return {
    mode: "http",
    timeoutMs: resolveTimeout(request.timeoutMs),
    ...(userAgent !== undefined ? { userAgent } : {}),
  };
}

type FetchPageResult = {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly contentLength: number;
  readonly html: string;
  readonly durationMs: number;
};

function fetchPageHttp(
  url: string,
  timeoutMs: number,
  userAgent?: string,
): Effect.Effect<FetchPageResult, NetworkError, FetchService> {
  return Effect.gen(function* () {
    const fetchService = yield* FetchService;
    return yield* Effect.tryPromise({
      try: async () => {
        const abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort("request-timeout"), timeoutMs);
        const startedAt = Date.now();
        let currentUrl = resolveValidatedUrl(url);

        try {
          for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
            const response = await fetchService.fetch(currentUrl.toString(), {
              method: "GET",
              headers: resolveHeaders(userAgent),
              redirect: "manual",
              signal: abortController.signal,
            });

            if (response.status >= 300 && response.status < 400) {
              if (redirectCount === MAX_REDIRECTS) {
                throw new Error(`Redirect limit exceeded after ${MAX_REDIRECTS} hops`);
              }

              const location = response.headers.get("location");
              if (!location) {
                throw new Error(`HTTP ${response.status} redirect missing location header`);
              }

              currentUrl = resolveValidatedUrl(location, currentUrl);
              continue;
            }

            const html = await response.text();
            const endedAt = Date.now();

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
              durationMs: Math.max(1, endedAt - startedAt),
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

type PlaywrightResponse = {
  readonly status: () => number;
  readonly allHeaders: () => Promise<Record<string, string>>;
};

type PlaywrightPage = {
  readonly goto: (
    url: string,
    options: { readonly waitUntil: BrowserWaitUntil; readonly timeout: number },
  ) => Promise<PlaywrightResponse | null>;
  readonly content: () => Promise<string>;
  readonly url: () => string;
  readonly waitForLoadState: (
    state: "load" | "domcontentloaded" | "networkidle",
    options?: { readonly timeout?: number },
  ) => Promise<void>;
  readonly route: (
    matcher: string,
    handler: (route: PlaywrightRoute) => Promise<void> | void,
  ) => Promise<void>;
  readonly close: () => Promise<void>;
};

type PlaywrightRequest = {
  readonly url: () => string;
};

type PlaywrightRoute = {
  readonly request: () => PlaywrightRequest;
  readonly continue: () => Promise<void>;
  readonly abort: (errorCode?: string) => Promise<void>;
};

type PlaywrightBrowserContext = {
  readonly newPage: () => Promise<PlaywrightPage>;
  readonly close: () => Promise<void>;
};

type PlaywrightBrowser = {
  readonly newContext: (options: {
    readonly userAgent: string;
  }) => Promise<PlaywrightBrowserContext>;
  readonly close: () => Promise<void>;
};

type PlaywrightModule = {
  readonly chromium: {
    readonly launch: (options: { readonly headless: boolean }) => Promise<PlaywrightBrowser>;
  };
};

function isPlaywrightModule(module: unknown): module is PlaywrightModule {
  if (typeof module !== "object" || module === null) {
    return false;
  }

  const chromium = (module as { readonly chromium?: unknown }).chromium;
  if (typeof chromium !== "object" || chromium === null) {
    return false;
  }

  return typeof (chromium as { readonly launch?: unknown }).launch === "function";
}

function loadPlaywright(): Effect.Effect<PlaywrightModule, BrowserError> {
  return Effect.tryPromise({
    try: async () => {
      const playwrightModuleName = "playwright";
      const loaded = await import(playwrightModuleName);
      if (!isPlaywrightModule(loaded)) {
        throw new Error("Playwright module is installed but has an unexpected shape");
      }
      return loaded;
    },
    catch: (error) =>
      new BrowserError({
        message: "Browser mode requires Playwright to be installed and resolvable",
        details: formatUnknownError(error),
      }),
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

async function closeQuietly(closeable?: { readonly close: () => Promise<void> }): Promise<void> {
  if (!closeable) {
    return;
  }
  try {
    await closeable.close();
  } catch {}
}

function fetchPageBrowser(
  url: string,
  options: BrowserFetchOptions,
): Effect.Effect<FetchPageResult, BrowserError> {
  return Effect.gen(function* () {
    const playwright = yield* loadPlaywright();

    return yield* Effect.tryPromise({
      try: async () => {
        const startedAt = Date.now();
        let browser: PlaywrightBrowser | undefined;
        let context: PlaywrightBrowserContext | undefined;
        let page: PlaywrightPage | undefined;
        let blockedRequestReason: string | undefined;

        try {
          browser = await playwright.chromium.launch({ headless: true });
          context = await browser.newContext({
            userAgent: options.userAgent ?? DEFAULT_BROWSER_USER_AGENT,
          });
          page = await context.newPage();
          await page.route("**/*", async (route) => {
            const requestUrl = route.request().url();
            const violation = getUrlPolicyViolation(new URL(requestUrl), {
              allowNonNetworkProtocols: true,
            });

            if (violation) {
              blockedRequestReason ??= `Blocked browser request to ${requestUrl}: ${violation}`;
              await route.abort("blockedbyclient");
              return;
            }

            await route.continue();
          });

          const response = await page.goto(url, {
            waitUntil: options.waitUntil,
            timeout: options.timeoutMs,
          });

          if (!response) {
            throw new Error("Navigation completed without an HTTP response");
          }

          await page.waitForLoadState(resolveBrowserLoadState(options.waitUntil), {
            timeout: options.timeoutMs,
          });

          if (blockedRequestReason) {
            throw new Error(blockedRequestReason);
          }

          const html = await page.content();
          const endedAt = Date.now();
          const status = response.status();
          const finalUrl = resolveValidatedUrl(page.url()).toString();

          if (status >= 400) {
            throw new Error(`HTTP ${status}`);
          }

          const headers = await response.allHeaders();

          return {
            url,
            finalUrl,
            status,
            contentType: headers["content-type"] ?? headers["Content-Type"] ?? "",
            contentLength: html.length,
            html,
            durationMs: Math.max(1, endedAt - startedAt),
          };
        } finally {
          await closeQuietly(page);
          await closeQuietly(context);
          await closeQuietly(browser);
        }
      },
      catch: (error) =>
        new BrowserError({
          message: `Browser access failed for ${url}`,
          details: formatUnknownError(error),
        }),
    });
  });
}

function fetchPage(
  url: string,
  options: ResolvedFetchOptions,
): Effect.Effect<FetchPageResult, NetworkError | BrowserError, FetchService> {
  if (options.mode === "browser") {
    return fetchPageBrowser(url, options);
  }
  return fetchPageHttp(url, options.timeoutMs, options.userAgent);
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
    const options = resolveFetchOptions(request);
    const page = yield* fetchPage(validatedUrl, options);

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
      },
      warnings: [],
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

    const selector = request.selector ?? DEFAULT_SELECTOR;
    const limit = request.limit ?? DEFAULT_LIMIT;
    const all = request.all ?? false;
    const options = resolveFetchOptions(request);

    const page = yield* fetchPage(validatedUrl, options);

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
      },
      warnings: values.length === 0 ? [`No values matched selector "${selector}"`] : [],
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
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
      },
      checks,
    };
  });
}
