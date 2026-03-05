import * as cheerio from "cheerio";
import { Context, Effect, Layer, Schema } from "effect";
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
import { BrowserError, ExtractionError, InvalidInputError, NetworkError } from "./errors";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SELECTOR = "title";
const DEFAULT_LIMIT = 20;
const DEFAULT_USER_AGENT = "effect-scrapling/0.0.1";
const DEFAULT_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const DEFAULT_BROWSER_WAIT_UNTIL: BrowserWaitUntil = "networkidle";

type FetchServiceShape = {
  readonly fetch: typeof fetch;
};

export class FetchService extends Context.Tag("@effect-scrapling/FetchService")<
  FetchService,
  FetchServiceShape
>() {}

const globalFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export const FetchServiceLive = Layer.succeed(FetchService, {
  fetch: globalFetch,
});

function decodeRequest<A, I>(
  schema: Schema.Schema<A, I, never>,
  payload: unknown,
  operation: string,
): Effect.Effect<A, InvalidInputError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(payload),
    catch: (error) =>
      new InvalidInputError({
        message: `Invalid ${operation} payload`,
        details: String(error),
      }),
  });
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
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

        try {
          const response = await fetchService.fetch(url, {
            method: "GET",
            headers: resolveHeaders(userAgent),
            redirect: "follow",
            signal: abortController.signal,
          });

          const html = await response.text();
          const endedAt = Date.now();

          if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
          }

          return {
            url,
            finalUrl: response.url,
            status: response.status,
            contentType: response.headers.get("content-type") ?? "",
            contentLength: html.length,
            html,
            durationMs: Math.max(1, endedAt - startedAt),
          };
        } finally {
          clearTimeout(timeout);
        }
      },
      catch: (error) =>
        new NetworkError({
          message: `Access failed for ${url}`,
          details: stringifyError(error),
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
  readonly close: () => Promise<void>;
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
        details: stringifyError(error),
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

        try {
          browser = await playwright.chromium.launch({ headless: true });
          context = await browser.newContext({
            userAgent: options.userAgent ?? DEFAULT_BROWSER_USER_AGENT,
          });
          page = await context.newPage();

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

          const html = await page.content();
          const endedAt = Date.now();
          const status = response.status();

          if (status >= 400) {
            throw new Error(`HTTP ${status}`);
          }

          const headers = await response.allHeaders();

          return {
            url,
            finalUrl: page.url(),
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
          details: stringifyError(error),
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
    const options = resolveFetchOptions(request);
    const page = yield* fetchPage(request.url, options);

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
          details: stringifyError(error),
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

    const selector = request.selector ?? DEFAULT_SELECTOR;
    const limit = request.limit ?? DEFAULT_LIMIT;
    const all = request.all ?? false;
    const options = resolveFetchOptions(request);

    const page = yield* fetchPage(request.url, options);

    const values = yield* Effect.try({
      try: () => extractValues(page.html, selector, request.attr, all, limit),
      catch: (error) =>
        new ExtractionError({
          message: `Failed to extract with selector "${selector}"`,
          details: stringifyError(error),
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
          details: stringifyError(error),
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
