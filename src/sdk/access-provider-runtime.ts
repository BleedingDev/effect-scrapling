import { performance } from "node:perf_hooks";
import { Effect, Exit, Layer, ServiceMap } from "effect";
import {
  DEFAULT_BROWSER_PROVIDER_ID,
  DEFAULT_STEALTH_BROWSER_PROVIDER_ID,
} from "./access-provider-ids.ts";
import { toExecutionMetadata } from "./access-execution-metadata.ts";
import { type AccessExecutionContext } from "./access-execution-context.ts";
import { BrowserRuntime, type PatchrightPage } from "./browser-pool.ts";
import {
  detectAccessWall,
  extractHtmlTitle,
  toAccessWallWarnings,
} from "./access-wall-detection.ts";
import { toBrowserLaunchProxyConfig, toBunFetchProxyConfig } from "./egress-route-config.ts";
import { formatUnknownError } from "./error-guards.ts";
import { BrowserError, InvalidInputError, NetworkError } from "./errors.ts";
import { FetchService } from "./fetch-service.ts";
import { type AccessMode, type AccessProviderId, type BrowserWaitUntil } from "./schemas.ts";
import { getUrlPolicyViolation, resolveValidatedUrl } from "./url-policy.ts";

const MAX_REDIRECTS = 5;
const BROWSER_OPERATION_TIMEOUT_GRACE_MS = 1_000;
const DEFAULT_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const DEFAULT_USER_AGENT = "effect-scrapling/0.0.1";

export type AccessProviderCapabilities = {
  readonly mode: AccessMode;
  readonly rendersDom: boolean;
};

export type AccessProviderDescriptor = {
  readonly id: AccessProviderId;
  readonly capabilities: AccessProviderCapabilities;
};

export type AccessExecutionTimings = {
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

export type AccessExecutionResult = {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly contentLength: number;
  readonly html: string;
  readonly durationMs: number;
  readonly execution: ReturnType<typeof toExecutionMetadata>;
  readonly timings: AccessExecutionTimings;
  readonly warnings: ReadonlyArray<string>;
};

export type AccessProvider = {
  readonly id: AccessProviderId;
  readonly capabilities: AccessProviderCapabilities;
  readonly execute: (input: {
    readonly url: string;
    readonly context: AccessExecutionContext;
  }) => Effect.Effect<
    AccessExecutionResult,
    NetworkError | BrowserError,
    FetchService | BrowserRuntime
  >;
};

function invalidProvider(message: string, details?: string) {
  return new InvalidInputError({
    message,
    ...(details === undefined ? {} : { details }),
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

function resolveBrowserLoadState(
  waitUntil: BrowserWaitUntil,
): "load" | "domcontentloaded" | "networkidle" | undefined {
  if (waitUntil === "commit") {
    return undefined;
  }
  return waitUntil;
}

function formatBrowserOperationTimeoutDetails(input: {
  readonly url: string;
  readonly providerId: AccessProviderId;
  readonly waitUntil: BrowserWaitUntil;
  readonly browserTimeoutMs: number;
  readonly stage?: string | undefined;
}) {
  const hardTimeoutMs = input.browserTimeoutMs + BROWSER_OPERATION_TIMEOUT_GRACE_MS;
  return `Browser access exceeded the hard timeout for ${input.url} (provider=${input.providerId}, waitUntil=${input.waitUntil}, browserTimeoutMs=${input.browserTimeoutMs}, hardTimeoutMs=${hardTimeoutMs}, stage=${input.stage ?? "unknown"}). The browser runtime likely stopped resolving or rejecting an in-flight promise.`;
}

function withHardTimeout<A, E>(input: {
  readonly effect: Effect.Effect<A, E>;
  readonly timeoutMs: number;
  readonly onTimeout: () => E;
}): Effect.Effect<A, E> {
  return Effect.callback((resume) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const fiber = Effect.runFork(input.effect);
    const removeObserver = fiber.addObserver((exit) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      if (Exit.isSuccess(exit)) {
        resume(Effect.succeed(exit.value));
        return;
      }
      resume(Effect.failCause(exit.cause));
    });
    timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      removeObserver();
      fiber.interruptUnsafe();
      resume(Effect.fail(input.onTimeout()));
    }, input.timeoutMs);

    return Effect.sync(() => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      removeObserver();
      fiber.interruptUnsafe();
    });
  });
}

function executeHttpProvider(
  url: string,
  context: AccessExecutionContext,
): Effect.Effect<AccessExecutionResult, NetworkError, FetchService> {
  return Effect.gen(function* () {
    const fetchService = yield* FetchService;
    return yield* Effect.tryPromise({
      try: async () => {
        const abortController = new AbortController();
        const timeout = setTimeout(
          () => abortController.abort("request-timeout"),
          context.timeoutMs,
        );
        const startedAt = performance.now();
        let currentUrl = resolveValidatedUrl(url);
        let requestCount = 0;
        let redirectCount = 0;
        let responseHeadersDurationMs = 0;
        const proxy = toBunFetchProxyConfig(context.egress.routeConfig);

        try {
          for (let redirectHop = 0; redirectHop <= MAX_REDIRECTS; redirectHop += 1) {
            requestCount += 1;
            const responseStartedAt = performance.now();
            const response = await fetchService.fetch(currentUrl.toString(), {
              method: "GET",
              headers: resolveHeaders(
                context.http?.userAgent ?? context.identity.httpUserAgent,
                context.egress.requestHeaders,
              ),
              redirect: "manual",
              signal: abortController.signal,
              ...(proxy === undefined ? {} : { proxy }),
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
            const wallAnalysis = detectAccessWall({
              statusCode: response.status,
              requestedUrl: url,
              finalUrl: currentUrl.toString(),
              title: extractHtmlTitle(html),
              text: html,
            });
            if (!response.ok && !wallAnalysis.likelyAccessWall) {
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
              execution: toExecutionMetadata(context),
              timings: {
                requestCount,
                redirectCount,
                blockedRequestCount: 0,
                responseHeadersDurationMs: roundTiming(responseHeadersDurationMs),
                bodyReadDurationMs: roundTiming(bodyReadDurationMs),
              },
              warnings: wallAnalysis.likelyAccessWall
                ? toAccessWallWarnings(wallAnalysis.signals)
                : [],
            } satisfies AccessExecutionResult;
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

function executeBrowserProvider(
  url: string,
  context: AccessExecutionContext & {
    readonly browser: NonNullable<AccessExecutionContext["browser"]>;
  },
): Effect.Effect<AccessExecutionResult, BrowserError, BrowserRuntime> {
  return Effect.gen(function* () {
    const browserRuntime = yield* BrowserRuntime;
    let currentBrowserStage:
      | "route-registration"
      | "navigation"
      | "dom-read"
      | "header-read"
      | undefined;
    let runtimeWarnings: ReadonlyArray<string> = [];
    const proxy = yield* Effect.try({
      try: () => toBrowserLaunchProxyConfig(context.egress.routeConfig),
      catch: (error) =>
        new BrowserError({
          message: `Browser access failed for ${url}`,
          details: formatUnknownError(error),
        }),
    });
    const browserAccessEffect = browserRuntime
      .withPage(
        {
          runtimeProfileId: context.browser.runtimeProfileId,
          poolKey: context.browser.poolKey ?? DEFAULT_BROWSER_PROVIDER_ID,
          userAgent:
            context.browser.userAgent ??
            context.identity.browserUserAgent ??
            DEFAULT_BROWSER_USER_AGENT,
          ...(context.identity.locale === undefined ? {} : { locale: context.identity.locale }),
          ...(context.identity.timezoneId === undefined
            ? {}
            : { timezoneId: context.identity.timezoneId }),
          ...(proxy === undefined ? {} : { proxy }),
        },
        (page: PatchrightPage, poolWarnings) => {
          runtimeWarnings = poolWarnings ?? [];
          let stage: "route-registration" | "navigation" | "dom-read" | "header-read" | undefined;

          return Effect.tryPromise({
            try: async () => {
              const startedAt = performance.now();
              let blockedRequestReason: string | undefined;
              let blockedRequestCount = 0;

              const routeRegistrationStartedAt = performance.now();
              stage = "route-registration";
              currentBrowserStage = stage;
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
              stage = "navigation";
              currentBrowserStage = stage;
              const response = await page.goto(url, {
                waitUntil: context.browser.waitUntil,
                timeout: context.browser.timeoutMs,
              });
              const gotoDurationMs = performance.now() - gotoStartedAt;

              if (!response) {
                throw new Error("navigation-response-missing");
              }

              const loadState = resolveBrowserLoadState(context.browser.waitUntil);
              const loadStateDurationMs = loadState === undefined ? undefined : 0;

              if (blockedRequestReason) {
                throw new Error(blockedRequestReason);
              }

              const domReadStartedAt = performance.now();
              stage = "dom-read";
              currentBrowserStage = stage;
              const html = await page.content();
              const domReadDurationMs = performance.now() - domReadStartedAt;
              const status = response.status();
              const finalUrl = resolveValidatedUrl(page.url()).toString();
              const headerReadStartedAt = performance.now();
              stage = "header-read";
              currentBrowserStage = stage;
              const headers = await response.allHeaders();
              const headerReadDurationMs = performance.now() - headerReadStartedAt;
              const wallAnalysis = detectAccessWall({
                statusCode: status,
                requestedUrl: url,
                finalUrl,
                title: extractHtmlTitle(html),
                text: html,
              });
              if (status >= 400 && !wallAnalysis.likelyAccessWall) {
                throw new Error(`HTTP ${status}`);
              }
              const requestGetter = Reflect.get(response, "request");
              const redirectCount =
                typeof requestGetter === "function"
                  ? countRedirectChain(requestGetter.call(response))
                  : 0;
              stage = undefined;
              currentBrowserStage = undefined;

              return {
                url,
                finalUrl,
                status,
                contentType: headers["content-type"] ?? headers["Content-Type"] ?? "",
                contentLength: html.length,
                html,
                durationMs: Math.max(0.001, roundTiming(performance.now() - startedAt)),
                execution: toExecutionMetadata(context),
                timings: {
                  requestCount: redirectCount + 1,
                  redirectCount,
                  blockedRequestCount,
                  routeRegistrationDurationMs: roundTiming(routeRegistrationDurationMs),
                  gotoDurationMs: roundTiming(gotoDurationMs),
                  ...(loadState === undefined
                    ? {}
                    : { loadStateDurationMs: roundTiming(loadStateDurationMs ?? 0) }),
                  domReadDurationMs: roundTiming(domReadDurationMs),
                  headerReadDurationMs: roundTiming(headerReadDurationMs),
                },
                warnings: wallAnalysis.likelyAccessWall
                  ? toAccessWallWarnings(wallAnalysis.signals)
                  : [],
              } satisfies AccessExecutionResult;
            },
            catch: (error) =>
              new BrowserError({
                message: `Browser access failed for ${url}`,
                details:
                  stage === undefined
                    ? formatUnknownError(error)
                    : `${stage}: ${formatUnknownError(error)}`,
              }),
          });
        },
      )
      .pipe(
        Effect.map(({ value, warnings }) => ({
          ...value,
          warnings: [...value.warnings, ...warnings],
        })),
        Effect.mapError(
          (error) =>
            new BrowserError({
              message: `Browser access failed for ${url}`,
              details: error.details ?? error.message,
              ...(error.warnings === undefined || error.warnings.length === 0
                ? {}
                : { warnings: error.warnings }),
            }),
        ),
      );

    return yield* withHardTimeout({
      effect: browserAccessEffect,
      timeoutMs: context.browser.timeoutMs + BROWSER_OPERATION_TIMEOUT_GRACE_MS,
      onTimeout: () =>
        new BrowserError({
          message: `Browser access failed for ${url}`,
          details: formatBrowserOperationTimeoutDetails({
            url,
            providerId: context.providerId,
            waitUntil: context.browser.waitUntil,
            browserTimeoutMs: context.browser.timeoutMs,
            stage: currentBrowserStage,
          }),
          ...(runtimeWarnings.length === 0 ? {} : { warnings: runtimeWarnings }),
        }),
    });
  });
}

export function makeHttpAccessProvider(id: "http-basic" | "http-impersonated"): AccessProvider {
  return {
    id,
    capabilities: {
      mode: "http",
      rendersDom: false,
    },
    execute: ({ url, context }) => executeHttpProvider(url, context),
  };
}

export function makeBrowserAccessProvider(
  id: typeof DEFAULT_BROWSER_PROVIDER_ID | typeof DEFAULT_STEALTH_BROWSER_PROVIDER_ID,
): AccessProvider {
  return {
    id,
    capabilities: {
      mode: "browser",
      rendersDom: true,
    },
    execute: ({ url, context }) => {
      if (context.browser === undefined) {
        return Effect.fail(
          new BrowserError({
            message: `Browser access failed for ${url}`,
            details: `Execution context for provider "${context.providerId}" did not resolve browser settings.`,
          }),
        );
      }

      return executeBrowserProvider(url, { ...context, browser: context.browser });
    },
  };
}

export const BuiltinAccessProviderDescriptors = Object.freeze([
  {
    id: "http-basic",
    capabilities: {
      mode: "http",
      rendersDom: false,
    },
  },
  {
    id: "http-impersonated",
    capabilities: {
      mode: "http",
      rendersDom: false,
    },
  },
  {
    id: "browser-basic",
    capabilities: {
      mode: "browser",
      rendersDom: true,
    },
  },
  {
    id: "browser-stealth",
    capabilities: {
      mode: "browser",
      rendersDom: true,
    },
  },
] satisfies ReadonlyArray<AccessProviderDescriptor>);

export class AccessProviderRegistry extends ServiceMap.Service<
  AccessProviderRegistry,
  {
    readonly resolve: (
      providerId: AccessProviderId,
    ) => Effect.Effect<AccessProvider, InvalidInputError>;
    readonly findDescriptor: (
      providerId: AccessProviderId,
    ) => Effect.Effect<AccessProviderDescriptor | undefined>;
    readonly listDescriptors: () => Effect.Effect<ReadonlyArray<AccessProviderDescriptor>>;
  }
>()("@effect-scrapling/sdk/AccessProviderRegistry") {}

export function makeStaticAccessProviderRegistry(
  providers: Readonly<Record<AccessProviderId, AccessProvider>>,
): {
  readonly resolve: (
    providerId: AccessProviderId,
  ) => Effect.Effect<AccessProvider, InvalidInputError>;
  readonly findDescriptor: (
    providerId: AccessProviderId,
  ) => Effect.Effect<AccessProviderDescriptor | undefined>;
  readonly listDescriptors: () => Effect.Effect<ReadonlyArray<AccessProviderDescriptor>>;
} {
  const descriptorEntries = Object.values(providers).map((provider) => ({
    id: provider.id,
    capabilities: provider.capabilities,
  })) satisfies ReadonlyArray<AccessProviderDescriptor>;
  const descriptors = Object.freeze([
    ...descriptorEntries,
  ]) as ReadonlyArray<AccessProviderDescriptor>;
  const descriptorsById = Object.fromEntries(
    descriptors.map((descriptor) => [descriptor.id, descriptor] as const),
  ) as Readonly<Record<AccessProviderId, AccessProviderDescriptor>>;

  return {
    resolve: (providerId) =>
      Effect.succeed(providers[providerId]).pipe(
        Effect.flatMap((provider) =>
          provider === undefined
            ? Effect.fail(
                invalidProvider(
                  "Unknown access provider",
                  `No access provider named "${providerId}" is registered.`,
                ),
              )
            : Effect.succeed(provider),
        ),
      ),
    findDescriptor: (providerId) => Effect.succeed(descriptorsById[providerId]),
    listDescriptors: () => Effect.succeed(descriptors),
  };
}

export function makeAccessProviderRegistryLive() {
  return Layer.effect(
    AccessProviderRegistry,
    Effect.succeed(
      makeStaticAccessProviderRegistry({
        "http-basic": makeHttpAccessProvider("http-basic"),
        "http-impersonated": makeHttpAccessProvider("http-impersonated"),
        "browser-basic": makeBrowserAccessProvider("browser-basic"),
        "browser-stealth": makeBrowserAccessProvider("browser-stealth"),
      } satisfies Readonly<Record<AccessProviderId, AccessProvider>>),
    ),
  );
}

export const AccessProviderRegistryLive = makeAccessProviderRegistryLive();
