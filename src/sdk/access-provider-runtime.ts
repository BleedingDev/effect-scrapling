import { performance } from "node:perf_hooks";
import { Effect, Exit, Layer, ServiceMap } from "effect";
import {
  DEFAULT_BROWSER_PROVIDER_ID,
  DEFAULT_STEALTH_BROWSER_PROVIDER_ID,
} from "./access-provider-ids.ts";
import { toExecutionMetadata } from "./access-execution-metadata.ts";
import { type AccessExecutionContext } from "./access-execution-context.ts";
import {
  describeUnsupportedProxyExecution,
  resolveTransportBinding,
  toBrowserTransportProxyConfig,
  toFetchTransportProxyConfig,
} from "./access-transport-binding.ts";
import { BrowserRuntime, type PatchrightPage } from "./browser-pool.ts";
import { detectCloudflareChallengeType } from "./browser-challenge-runtime.ts";
import {
  type BrowserMediationOutcome,
  type BrowserNavigationSnapshot,
  makeEmptyBrowserMediationOutcome,
} from "./browser-mediation-model.ts";
import {
  BrowserMediationRuntime,
  BrowserMediationRuntimeLive,
  type BrowserMediationService,
  resolveBrowserMediationPolicy,
} from "./browser-mediation-runtime.ts";
import {
  detectAccessWall,
  extractHtmlTitle,
  toAccessWallWarnings,
} from "./access-wall-detection.ts";
import {
  DEFAULT_PATCHRIGHT_BROWSER_RUNTIME_PROFILE_ID,
  DEFAULT_PATCHRIGHT_STEALTH_RUNTIME_PROFILE_ID,
} from "./access-profile-runtime.ts";
import { formatUnknownError } from "./error-guards.ts";
import { BrowserError, InvalidInputError, NetworkError } from "./errors.ts";
import { FetchService } from "./fetch-service.ts";
import {
  type AccessMode,
  type AccessProviderId,
  type BrowserRuntimeProfileId,
  type BrowserWaitUntil,
} from "./schemas.ts";
import { getUrlPolicyViolation, resolveValidatedUrl } from "./url-policy.ts";

const MAX_REDIRECTS = 5;
const BROWSER_OPERATION_TIMEOUT_GRACE_MS = 1_000;
const DEFAULT_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const DEFAULT_USER_AGENT = "effect-scrapling/0.0.1";
const DEFAULT_BROWSER_REFERER = "https://www.google.com/";
const CLOUDFLARE_INTERSTITIAL_TITLE = "Just a moment...";

type BrowserExecutionStage =
  | "route-registration"
  | "navigation"
  | "load-state"
  | "post-navigation-wait"
  | "challenge-resolution"
  | "dom-read"
  | "header-read";

export type AccessProviderCapabilities = {
  readonly mode: AccessMode;
  readonly rendersDom: boolean;
  readonly selectionPriority?: number | undefined;
  readonly browserDefaults?:
    | {
        readonly runtimeProfileId?: BrowserRuntimeProfileId | undefined;
        readonly waitUntil?: BrowserWaitUntil | undefined;
      }
    | undefined;
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
  readonly postNavigationWaitDurationMs?: number | undefined;
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
  readonly mediation?: BrowserMediationOutcome | undefined;
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

function resolveBrowserReferer(extraHeaders?: Readonly<Record<string, string>>) {
  const referer = extraHeaders?.referer ?? extraHeaders?.Referer;
  if (referer !== undefined && referer.trim().length > 0) {
    return referer;
  }

  return DEFAULT_BROWSER_REFERER;
}

function resolveBrowserPageUrl(candidate: string, fallbackUrl: string) {
  try {
    return resolveValidatedUrl(candidate).toString();
  } catch {
    return fallbackUrl;
  }
}

function resolveBrowserErrorPageCode(html: string) {
  if (
    !/This page has been blocked by Chromium/iu.test(html) &&
    !/\bERR_BLOCKED_BY_CLIENT\b/u.test(html)
  ) {
    return undefined;
  }

  const codeMatch = html.match(/\b(ERR_[A-Z_]+)\b/u);
  return codeMatch?.[1] ?? "ERR_BLOCKED_BY_CLIENT";
}

function roundTiming(value: number) {
  return Math.round(Math.max(0, value) * 1_000) / 1_000;
}

function shouldAttemptPostClearanceNetworkSettle(waitUntil: BrowserWaitUntil) {
  return waitUntil !== "networkidle";
}

const POST_CLEARANCE_CONFIRMATION_RETRY_WAIT_MS = 750;
const PRE_FOLLOW_UP_CLEARANCE_SETTLE_TIMEOUT_MS = 10_000;
const PRE_FOLLOW_UP_CLEARANCE_SETTLE_POLL_INTERVAL_MS = 250;
const POST_CLEARANCE_BROWSER_ERROR_RECOVERY_ATTEMPTS = Math.max(
  1,
  Math.ceil(
    PRE_FOLLOW_UP_CLEARANCE_SETTLE_TIMEOUT_MS / PRE_FOLLOW_UP_CLEARANCE_SETTLE_POLL_INTERVAL_MS,
  ),
);

async function waitForBrowserTimeout(page: PatchrightPage, timeoutMs: number) {
  if (timeoutMs <= 0) {
    return;
  }

  if (page.waitForTimeout !== undefined) {
    await page.waitForTimeout(timeoutMs);
    return;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

async function readBrowserPageContent(page: PatchrightPage) {
  let lastError: unknown;
  for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
    try {
      return await page.content();
    } catch (error) {
      lastError = error;
      const details =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : typeof error === "string"
            ? error
            : "";
      const isTransientNavigationRace =
        details.includes("page is navigating") || details.includes("changing the content");
      if (!isTransientNavigationRace || attemptIndex + 1 >= 3) {
        throw error;
      }
      await waitForBrowserTimeout(page, PRE_FOLLOW_UP_CLEARANCE_SETTLE_POLL_INTERVAL_MS);
    }
  }

  throw lastError;
}

function isCloudflareChallengeHtml(html: string) {
  return (
    extractHtmlTitle(html) === CLOUDFLARE_INTERSTITIAL_TITLE ||
    detectCloudflareChallengeType(html) !== undefined
  );
}

async function waitForCloudflarePostClearanceSettle(input: {
  readonly page: PatchrightPage;
  readonly timeoutMs: number;
}) {
  const deadlineAt =
    Date.now() + Math.max(1, Math.min(input.timeoutMs, PRE_FOLLOW_UP_CLEARANCE_SETTLE_TIMEOUT_MS));
  while (Date.now() < deadlineAt) {
    const html = await readBrowserPageContent(input.page);
    if (!isCloudflareChallengeHtml(html)) {
      return true;
    }
    await waitForBrowserTimeout(input.page, PRE_FOLLOW_UP_CLEARANCE_SETTLE_POLL_INTERVAL_MS);
  }

  return !isCloudflareChallengeHtml(await readBrowserPageContent(input.page));
}

async function recoverPostClearanceBrowserErrorPage(input: {
  readonly page: PatchrightPage;
  readonly currentHtml: string;
  readonly timeoutMs: number;
}) {
  let html = input.currentHtml;
  let remainingBudgetMs = Math.max(
    1,
    Math.min(
      input.timeoutMs,
      POST_CLEARANCE_BROWSER_ERROR_RECOVERY_ATTEMPTS *
        PRE_FOLLOW_UP_CLEARANCE_SETTLE_POLL_INTERVAL_MS,
    ),
  );

  while (remainingBudgetMs > 0) {
    if (resolveBrowserErrorPageCode(html) === undefined) {
      return html;
    }

    const waitMs = Math.min(PRE_FOLLOW_UP_CLEARANCE_SETTLE_POLL_INTERVAL_MS, remainingBudgetMs);
    await waitForBrowserTimeout(input.page, waitMs);
    remainingBudgetMs -= waitMs;
    html = await readBrowserPageContent(input.page);
  }

  return html;
}

async function isLocatorReady(
  locator: NonNullable<ReturnType<NonNullable<PatchrightPage["locator"]>>>,
) {
  if (locator.isVisible !== undefined) {
    return locator.isVisible();
  }

  return (await locator.boundingBox()) !== null;
}

async function isSelectorReady(page: PatchrightPage, selector: string) {
  const locator = page.locator?.(selector);
  if (locator === undefined) {
    return false;
  }

  if (locator.count !== undefined && locator.nth !== undefined) {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      if (await isLocatorReady(locator.nth(index))) {
        return true;
      }
    }

    return false;
  }

  if (await isLocatorReady(locator)) {
    return true;
  }

  if (locator.first !== undefined && (await isLocatorReady(locator.first()))) {
    return true;
  }

  if (locator.last !== undefined && (await isLocatorReady(locator.last()))) {
    return true;
  }

  return false;
}

async function waitForBrowserSelector(input: {
  readonly page: PatchrightPage;
  readonly selector: string;
  readonly timeoutMs: number;
}) {
  const deadlineAt = Date.now() + Math.max(1, input.timeoutMs);
  while (Date.now() < deadlineAt) {
    if (await isSelectorReady(input.page, input.selector)) {
      return;
    }

    await waitForBrowserTimeout(input.page, 100);
  }

  throw new Error(`selector-wait-timeout:${input.selector}`);
}

async function applyBrowserPostNavigationWait(input: {
  readonly page: PatchrightPage;
  readonly waitMs?: number | undefined;
  readonly waitSelector?: string | undefined;
  readonly timeoutMs: number;
}) {
  const startedAt = performance.now();

  if (input.waitMs !== undefined) {
    await waitForBrowserTimeout(input.page, input.waitMs);
  }

  if (input.waitSelector !== undefined) {
    await waitForBrowserSelector({
      page: input.page,
      selector: input.waitSelector,
      timeoutMs: input.timeoutMs,
    });
  }

  return performance.now() - startedAt;
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

function formatBrowserOperationTimeoutDetails(input: {
  readonly url: string;
  readonly providerId: AccessProviderId;
  readonly waitUntil: BrowserWaitUntil;
  readonly browserTimeoutMs: number;
  readonly hardTimeoutMs: number;
  readonly stage?: string | undefined;
}) {
  return `Browser access exceeded the hard timeout for ${input.url} (provider=${input.providerId}, waitUntil=${input.waitUntil}, browserTimeoutMs=${input.browserTimeoutMs}, hardTimeoutMs=${input.hardTimeoutMs}, stage=${input.stage ?? "unknown"}). The browser runtime likely stopped resolving or rejecting an in-flight promise.`;
}

export function resolveBrowserHardTimeoutMs(input: {
  readonly browserTimeoutMs: number;
  readonly challengeHandling?:
    | NonNullable<AccessExecutionContext["browser"]>["challengeHandling"]
    | undefined;
}) {
  const mediationPolicy = resolveBrowserMediationPolicy({
    timeoutMs: input.browserTimeoutMs,
    challengeHandling: input.challengeHandling,
  });
  if (mediationPolicy.mode !== "solve") {
    return input.browserTimeoutMs + BROWSER_OPERATION_TIMEOUT_GRACE_MS;
  }

  const mediationBudgetMs = Math.max(input.browserTimeoutMs, mediationPolicy.timeBudgetMs);

  return mediationBudgetMs + BROWSER_OPERATION_TIMEOUT_GRACE_MS;
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

function withResettableHardTimeout<A, E>(input: {
  readonly effect: (resetTimeoutMs: (timeoutMs: number) => void) => Effect.Effect<A, E>;
  readonly timeoutMs: number;
  readonly onTimeout: () => E;
}): Effect.Effect<A, E> {
  return Effect.callback((resume) => {
    let settled = false;
    let activeTimeoutMs = input.timeoutMs;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const scheduleTimeout = (timeoutMs: number) => {
      activeTimeoutMs = timeoutMs;
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        removeObserver();
        fiber.interruptUnsafe();
        resume(Effect.fail(input.onTimeout()));
      }, activeTimeoutMs);
    };

    const fiber = Effect.runFork(input.effect(scheduleTimeout));
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

    scheduleTimeout(activeTimeoutMs);

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
    const transportBinding = resolveTransportBinding({
      binding: context.transportBinding ?? context.egress.transportBinding,
      routeKind: context.egress.routeKind,
      routeConfig: context.egress.routeConfig,
    });
    const proxy = toFetchTransportProxyConfig(transportBinding);
    const unsupportedTransportDetails = describeUnsupportedProxyExecution(transportBinding, url);
    if (unsupportedTransportDetails !== undefined) {
      return yield* Effect.fail(
        new NetworkError({
          message: `Access failed for ${url}`,
          details: unsupportedTransportDetails,
        }),
      );
    }

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
  mediationRuntime: BrowserMediationService,
): Effect.Effect<AccessExecutionResult, BrowserError, BrowserRuntime> {
  return Effect.gen(function* () {
    const browserRuntime = yield* BrowserRuntime;
    let currentBrowserStage: BrowserExecutionStage | undefined;
    let currentBrowserHardTimeoutMs =
      context.browser.timeoutMs + BROWSER_OPERATION_TIMEOUT_GRACE_MS;
    let runtimeWarnings: ReadonlyArray<string> = [];
    const pageStageHardTimeoutMs = context.browser.timeoutMs + BROWSER_OPERATION_TIMEOUT_GRACE_MS;
    const mediationHardTimeoutMs =
      Math.max(
        context.browser.timeoutMs,
        resolveBrowserMediationPolicy({
          timeoutMs: context.browser.timeoutMs,
          challengeHandling: context.browser.challengeHandling,
        }).timeBudgetMs,
      ) + BROWSER_OPERATION_TIMEOUT_GRACE_MS;
    const transportBinding = resolveTransportBinding({
      binding: context.transportBinding ?? context.egress.transportBinding,
      routeKind: context.egress.routeKind,
      routeConfig: context.egress.routeConfig,
    });
    const unsupportedTransportDetails = describeUnsupportedProxyExecution(transportBinding, url);
    if (unsupportedTransportDetails !== undefined) {
      return yield* Effect.fail(
        new BrowserError({
          message: `Browser access failed for ${url}`,
          details: unsupportedTransportDetails,
        }),
      );
    }
    const proxy = yield* Effect.try({
      try: () => toBrowserTransportProxyConfig(transportBinding),
      catch: (error) =>
        new BrowserError({
          message: `Browser access failed for ${url}`,
          details: formatUnknownError(error),
        }),
    });
    const browserAccessEffect = (resetOuterHardTimeoutMs: (timeoutMs: number) => void) =>
      browserRuntime
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
            const navigationReferer = resolveBrowserReferer(context.egress.requestHeaders);
            let stage: BrowserExecutionStage | undefined;

            const runPageStage = <A>(
              nextStage: Exclude<BrowserExecutionStage, "challenge-resolution">,
              operation: () => Promise<A>,
            ) =>
              withHardTimeout({
                effect: Effect.tryPromise({
                  try: async () => {
                    currentBrowserHardTimeoutMs = pageStageHardTimeoutMs;
                    resetOuterHardTimeoutMs(pageStageHardTimeoutMs);
                    stage = nextStage;
                    currentBrowserStage = nextStage;
                    return await operation();
                  },
                  catch: (error) => error,
                }),
                timeoutMs: pageStageHardTimeoutMs,
                onTimeout: () =>
                  new Error(
                    formatBrowserOperationTimeoutDetails({
                      url,
                      providerId: context.providerId,
                      waitUntil: context.browser.waitUntil,
                      browserTimeoutMs: context.browser.timeoutMs,
                      hardTimeoutMs: pageStageHardTimeoutMs,
                      stage: nextStage,
                    }),
                  ),
              });

            return Effect.gen(function* () {
              const startedAt = performance.now();
              let blockedRequestReason: string | undefined;
              let blockedRequestCount = 0;
              let challengeWarnings: ReadonlyArray<string> = [];
              const shouldDeferRouteRegistration =
                context.browser.challengeHandling?.solveCloudflare === true;
              let routeRegistrationDurationMs = 0;
              let routeGuardRegistered = false;

              const ensureRouteGuardRegistered = () =>
                Effect.gen(function* () {
                  if (routeGuardRegistered) {
                    return;
                  }

                  const routeRegistrationStartedAt = performance.now();
                  yield* runPageStage("route-registration", async () => {
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
                  });
                  routeRegistrationDurationMs += performance.now() - routeRegistrationStartedAt;
                  routeGuardRegistered = true;
                });

              if (!shouldDeferRouteRegistration) {
                yield* ensureRouteGuardRegistered();
              }

              const gotoStartedAt = performance.now();
              let response = yield* runPageStage("navigation", () =>
                page.goto(url, {
                  referer: navigationReferer,
                  waitUntil: context.browser.waitUntil,
                  timeout: context.browser.timeoutMs,
                }),
              );
              let gotoDurationMs = performance.now() - gotoStartedAt;
              let loadStateDurationMs = 0;
              let postNavigationWaitDurationMs = 0;
              let loadStateMeasured = false;

              if (!response) {
                return yield* Effect.fail(new Error("navigation-response-missing"));
              }
              const initialResponse = response;

              if (blockedRequestReason) {
                return yield* Effect.fail(new Error(blockedRequestReason));
              }

              const initialDomReadStartedAt = performance.now();
              let html = yield* runPageStage("dom-read", () => page.content());
              let domReadDurationMs = performance.now() - initialDomReadStartedAt;
              const initialHtml = html;
              const initialHeaderReadStartedAt = performance.now();
              let headers = yield* runPageStage("header-read", () => initialResponse.allHeaders());
              let headerReadDurationMs = performance.now() - initialHeaderReadStartedAt;
              const initialStatus = initialResponse.status();
              const initialFinalUrl = resolveBrowserPageUrl(page.url(), url);
              const initialRequestGetter = Reflect.get(initialResponse, "request");
              const initialRedirectCount =
                typeof initialRequestGetter === "function"
                  ? countRedirectChain(initialRequestGetter.call(initialResponse))
                  : 0;
              const initialSnapshot = {
                requestedUrl: url,
                finalUrl: initialFinalUrl,
                status: initialStatus,
                title: extractHtmlTitle(html) ?? null,
                contentType: headers["content-type"] ?? headers["Content-Type"] ?? "",
                htmlLength: html.length,
                redirectCount: initialRedirectCount,
              } satisfies BrowserNavigationSnapshot;

              const mediationStartedAt = performance.now();
              currentBrowserHardTimeoutMs = mediationHardTimeoutMs;
              resetOuterHardTimeoutMs(mediationHardTimeoutMs);
              stage = "challenge-resolution";
              currentBrowserStage = stage;
              const mediationResolution = yield* withHardTimeout({
                effect: mediationRuntime.mediate({
                  page,
                  pageContent: html,
                  initialSnapshot,
                  timeoutMs: context.browser.timeoutMs,
                  challengeHandling: context.browser.challengeHandling,
                }),
                timeoutMs: mediationHardTimeoutMs,
                onTimeout: () =>
                  new Error(
                    formatBrowserOperationTimeoutDetails({
                      url,
                      providerId: context.providerId,
                      waitUntil: context.browser.waitUntil,
                      browserTimeoutMs: context.browser.timeoutMs,
                      hardTimeoutMs: mediationHardTimeoutMs,
                      stage: "challenge-resolution",
                    }),
                  ),
              });
              const mediationDurationMs = performance.now() - mediationStartedAt;
              let mediationOutcome: BrowserMediationOutcome =
                mediationResolution.outcome.status === "none"
                  ? makeEmptyBrowserMediationOutcome()
                  : {
                      ...mediationResolution.outcome,
                      timings: {
                        ...mediationResolution.outcome.timings,
                        resolutionMs: roundTiming(mediationDurationMs),
                      },
                    };
              challengeWarnings = [...mediationResolution.warnings];
              const effectivePostClearanceStrategy =
                mediationResolution.currentPageRefreshRequired &&
                mediationResolution.postClearanceStrategy === "reuse-current"
                  ? "reload-target"
                  : mediationResolution.postClearanceStrategy;
              const shouldFollowUpNavigation =
                mediationResolution.followUpNavigationRequired ||
                (mediationResolution.currentPageRefreshRequired &&
                  effectivePostClearanceStrategy === "reload-target");
              const shouldRefreshCurrentPage =
                mediationResolution.currentPageRefreshRequired && !shouldFollowUpNavigation;
              const requiresConfiguredPostNavigationWait =
                context.browser.waitMs !== undefined || context.browser.waitSelector !== undefined;
              let followUpNavigationCount = 0;
              let followUpNavigationDurationMs = 0;
              let followUpRedirectCount = 0;
              let reusedSettledCurrentPage = false;
              let currentPageStatusOverride: number | undefined;

              if (shouldRefreshCurrentPage || shouldFollowUpNavigation) {
                challengeWarnings =
                  effectivePostClearanceStrategy === mediationResolution.postClearanceStrategy
                    ? [
                        ...challengeWarnings,
                        `cloudflare-solver:challenge-resolution-ms:${roundTiming(mediationDurationMs)}`,
                        `cloudflare-solver:post-clearance-strategy:${effectivePostClearanceStrategy}`,
                      ]
                    : [
                        ...challengeWarnings,
                        "cloudflare-solver:post-clearance-strategy-fallback:reload-target",
                        `cloudflare-solver:challenge-resolution-ms:${roundTiming(mediationDurationMs)}`,
                        `cloudflare-solver:post-clearance-strategy:${effectivePostClearanceStrategy}`,
                      ];
                if (shouldRefreshCurrentPage) {
                  const mediatedDomReadStartedAt = performance.now();
                  html = yield* runPageStage("dom-read", () => page.content());
                  domReadDurationMs += performance.now() - mediatedDomReadStartedAt;
                }
              }

              if (shouldFollowUpNavigation) {
                let clearedBeforeFollowUp = false;
                const shouldAttemptCloudflarePreFollowUpSettle =
                  mediationOutcome.kind === "challenge" &&
                  mediationOutcome.status === "cleared" &&
                  challengeWarnings.some(
                    (warning) =>
                      warning === "cloudflare-solver:clearance-observed:managed" ||
                      warning === "cloudflare-solver:clearance-observed:interactive",
                  );
                if (shouldAttemptCloudflarePreFollowUpSettle) {
                  challengeWarnings = [
                    ...challengeWarnings,
                    "cloudflare-solver:post-clearance-settle-before-follow-up",
                  ];
                  const settleWaitStartedAt = performance.now();
                  clearedBeforeFollowUp = yield* runPageStage("post-navigation-wait", () =>
                    waitForCloudflarePostClearanceSettle({
                      page,
                      timeoutMs: context.browser.timeoutMs,
                    }),
                  );
                  postNavigationWaitDurationMs += performance.now() - settleWaitStartedAt;
                  challengeWarnings = [
                    ...challengeWarnings,
                    clearedBeforeFollowUp
                      ? "cloudflare-solver:post-clearance-settled-before-follow-up"
                      : "cloudflare-solver:post-clearance-still-blocked-before-follow-up",
                  ];
                }
                if (clearedBeforeFollowUp) {
                  if (requiresConfiguredPostNavigationWait) {
                    const settledCurrentPageWaitStartedAt = performance.now();
                    const settledCurrentPageWaitDurationMs = yield* runPageStage(
                      "post-navigation-wait",
                      () =>
                        applyBrowserPostNavigationWait({
                          page,
                          waitMs: context.browser.waitMs,
                          waitSelector: context.browser.waitSelector,
                          timeoutMs: context.browser.timeoutMs,
                        }),
                    );
                    postNavigationWaitDurationMs +=
                      settledCurrentPageWaitDurationMs > 0
                        ? settledCurrentPageWaitDurationMs
                        : performance.now() - settledCurrentPageWaitStartedAt;
                  }
                  const settledCurrentPageDomReadStartedAt = performance.now();
                  html = yield* runPageStage("dom-read", () => page.content());
                  domReadDurationMs += performance.now() - settledCurrentPageDomReadStartedAt;
                  let settledCurrentPageBrowserErrorCode = resolveBrowserErrorPageCode(html);
                  if (settledCurrentPageBrowserErrorCode !== undefined) {
                    challengeWarnings = [
                      ...challengeWarnings,
                      "cloudflare-solver:post-clearance-browser-error-recovery",
                    ];
                    const browserErrorRecoveryStartedAt = performance.now();
                    html = yield* runPageStage("dom-read", () =>
                      recoverPostClearanceBrowserErrorPage({
                        page,
                        currentHtml: html,
                        timeoutMs: context.browser.timeoutMs,
                      }),
                    );
                    domReadDurationMs += performance.now() - browserErrorRecoveryStartedAt;
                    settledCurrentPageBrowserErrorCode = resolveBrowserErrorPageCode(html);
                    challengeWarnings = [
                      ...challengeWarnings,
                      settledCurrentPageBrowserErrorCode === undefined
                        ? "cloudflare-solver:post-clearance-browser-error-recovered"
                        : `cloudflare-solver:post-clearance-browser-error-persisted:${settledCurrentPageBrowserErrorCode}`,
                    ];
                  }
                  const settledCurrentPageFinalUrl = resolveBrowserPageUrl(
                    page.url(),
                    initialSnapshot.finalUrl,
                  );
                  const settledCurrentPageTitle = extractHtmlTitle(html);
                  const settledCurrentPageWallAnalysis = detectAccessWall({
                    statusCode: 200,
                    requestedUrl: url,
                    finalUrl: settledCurrentPageFinalUrl,
                    title: settledCurrentPageTitle,
                    text: html,
                  });
                  const settledCurrentPageShowsProgress =
                    settledCurrentPageFinalUrl !== initialSnapshot.finalUrl ||
                    settledCurrentPageTitle !== initialSnapshot.title ||
                    html !== initialHtml ||
                    html.length !== initialSnapshot.htmlLength;
                  if (
                    settledCurrentPageBrowserErrorCode === undefined &&
                    !settledCurrentPageWallAnalysis.likelyAccessWall &&
                    settledCurrentPageShowsProgress
                  ) {
                    reusedSettledCurrentPage = true;
                    currentPageStatusOverride = 200;
                    challengeWarnings = [
                      ...challengeWarnings,
                      "cloudflare-solver:post-clearance-strategy-override:reuse-current",
                    ];
                  } else if (settledCurrentPageBrowserErrorCode !== undefined) {
                    challengeWarnings = [
                      ...challengeWarnings,
                      `cloudflare-solver:post-clearance-strategy-override-skipped:browser-error:${settledCurrentPageBrowserErrorCode}`,
                    ];
                  } else if (!settledCurrentPageShowsProgress) {
                    challengeWarnings = [
                      ...challengeWarnings,
                      "cloudflare-solver:post-clearance-strategy-override-skipped:no-progress",
                    ];
                  }
                }
                if (!reusedSettledCurrentPage) {
                  if (shouldDeferRouteRegistration) {
                    yield* ensureRouteGuardRegistered();
                  }
                  const followUpNavigationStartedAt = performance.now();
                  response = yield* runPageStage("navigation", () =>
                    page.goto(url, {
                      referer: navigationReferer,
                      waitUntil: context.browser.waitUntil,
                      timeout: context.browser.timeoutMs,
                    }),
                  );
                  if (!response) {
                    return yield* Effect.fail(new Error("challenge-follow-up-response-missing"));
                  }
                  const followUpResponse = response;
                  if (blockedRequestReason) {
                    return yield* Effect.fail(new Error(blockedRequestReason));
                  }
                  const currentFollowUpNavigationDurationMs =
                    performance.now() - followUpNavigationStartedAt;
                  gotoDurationMs += currentFollowUpNavigationDurationMs;
                  followUpNavigationCount += 1;
                  followUpNavigationDurationMs += currentFollowUpNavigationDurationMs;
                  if (shouldAttemptPostClearanceNetworkSettle(context.browser.waitUntil)) {
                    loadStateMeasured = true;
                    const postClearanceLoadStateStartedAt = performance.now();
                    const postClearanceLoadStateReached = yield* runPageStage("load-state", () =>
                      page.waitForLoadState("networkidle", {
                        timeout: context.browser.timeoutMs,
                      }),
                    ).pipe(
                      Effect.match({
                        onFailure: () => false,
                        onSuccess: () => true,
                      }),
                    );
                    loadStateDurationMs += performance.now() - postClearanceLoadStateStartedAt;
                    if (!postClearanceLoadStateReached) {
                      challengeWarnings = [
                        ...challengeWarnings,
                        "cloudflare-solver:post-clearance-networkidle-unreached",
                      ];
                    }
                  }
                  const followUpDomReadStartedAt = performance.now();
                  html = yield* runPageStage("dom-read", () => page.content());
                  domReadDurationMs += performance.now() - followUpDomReadStartedAt;
                  if (blockedRequestReason) {
                    return yield* Effect.fail(new Error(blockedRequestReason));
                  }
                  const followUpHeaderReadStartedAt = performance.now();
                  headers = yield* runPageStage("header-read", () => followUpResponse.allHeaders());
                  headerReadDurationMs += performance.now() - followUpHeaderReadStartedAt;
                  const followUpRequestGetter = Reflect.get(followUpResponse, "request");
                  followUpRedirectCount +=
                    typeof followUpRequestGetter === "function"
                      ? countRedirectChain(followUpRequestGetter.call(followUpResponse))
                      : 0;
                }
              }
              if (requiresConfiguredPostNavigationWait) {
                const finalizationWaitStartedAt = performance.now();
                const finalizationWaitDurationMs = yield* runPageStage("post-navigation-wait", () =>
                  applyBrowserPostNavigationWait({
                    page,
                    waitMs: context.browser.waitMs,
                    waitSelector: context.browser.waitSelector,
                    timeoutMs: context.browser.timeoutMs,
                  }),
                );
                postNavigationWaitDurationMs +=
                  finalizationWaitDurationMs > 0
                    ? finalizationWaitDurationMs
                    : performance.now() - finalizationWaitStartedAt;
                const finalDomReadStartedAt = performance.now();
                html = yield* runPageStage("dom-read", () => page.content());
                domReadDurationMs += performance.now() - finalDomReadStartedAt;
              }
              let status = currentPageStatusOverride ?? response.status();
              let finalUrl = resolveBrowserPageUrl(page.url(), initialFinalUrl);
              const browserErrorPageCode = resolveBrowserErrorPageCode(html);
              if (browserErrorPageCode !== undefined) {
                return yield* Effect.fail(new Error(browserErrorPageCode));
              }
              let wallAnalysis = detectAccessWall({
                statusCode: status,
                requestedUrl: url,
                finalUrl,
                title: extractHtmlTitle(html),
                text: html,
              });
              if (status >= 400 && !wallAnalysis.likelyAccessWall) {
                return yield* Effect.fail(new Error(`HTTP ${status}`));
              }
              if (
                mediationOutcome.status === "cleared" &&
                shouldFollowUpNavigation &&
                wallAnalysis.likelyAccessWall
              ) {
                challengeWarnings = [
                  ...challengeWarnings,
                  "cloudflare-solver:clearance-confirmation-retry",
                ];
                const confirmationWaitStartedAt = performance.now();
                yield* runPageStage("post-navigation-wait", () =>
                  waitForBrowserTimeout(
                    page,
                    Math.min(POST_CLEARANCE_CONFIRMATION_RETRY_WAIT_MS, context.browser.timeoutMs),
                  ),
                );
                postNavigationWaitDurationMs += performance.now() - confirmationWaitStartedAt;

                const confirmationNavigationStartedAt = performance.now();
                response = yield* runPageStage("navigation", () =>
                  page.goto(url, {
                    referer: navigationReferer,
                    waitUntil: context.browser.waitUntil,
                    timeout: context.browser.timeoutMs,
                  }),
                );
                if (!response) {
                  return yield* Effect.fail(new Error("challenge-confirmation-response-missing"));
                }
                const confirmationResponse = response;
                if (blockedRequestReason) {
                  return yield* Effect.fail(new Error(blockedRequestReason));
                }
                const confirmationNavigationDurationMs =
                  performance.now() - confirmationNavigationStartedAt;
                gotoDurationMs += confirmationNavigationDurationMs;
                followUpNavigationCount += 1;
                followUpNavigationDurationMs += confirmationNavigationDurationMs;

                if (shouldAttemptPostClearanceNetworkSettle(context.browser.waitUntil)) {
                  loadStateMeasured = true;
                  const confirmationLoadStateStartedAt = performance.now();
                  const confirmationLoadStateReached = yield* runPageStage("load-state", () =>
                    page.waitForLoadState("networkidle", {
                      timeout: context.browser.timeoutMs,
                    }),
                  ).pipe(
                    Effect.match({
                      onFailure: () => false,
                      onSuccess: () => true,
                    }),
                  );
                  loadStateDurationMs += performance.now() - confirmationLoadStateStartedAt;
                  if (!confirmationLoadStateReached) {
                    challengeWarnings = [
                      ...challengeWarnings,
                      "cloudflare-solver:post-clearance-networkidle-unreached",
                    ];
                  }
                }

                const confirmationDomReadStartedAt = performance.now();
                html = yield* runPageStage("dom-read", () => page.content());
                domReadDurationMs += performance.now() - confirmationDomReadStartedAt;
                if (blockedRequestReason) {
                  return yield* Effect.fail(new Error(blockedRequestReason));
                }

                const confirmationHeaderReadStartedAt = performance.now();
                headers = yield* runPageStage("header-read", () =>
                  confirmationResponse.allHeaders(),
                );
                headerReadDurationMs += performance.now() - confirmationHeaderReadStartedAt;

                const confirmationRequestGetter = Reflect.get(confirmationResponse, "request");
                followUpRedirectCount +=
                  typeof confirmationRequestGetter === "function"
                    ? countRedirectChain(confirmationRequestGetter.call(confirmationResponse))
                    : 0;

                if (requiresConfiguredPostNavigationWait) {
                  const confirmationFinalizationWaitStartedAt = performance.now();
                  const confirmationFinalizationWaitDurationMs = yield* runPageStage(
                    "post-navigation-wait",
                    () =>
                      applyBrowserPostNavigationWait({
                        page,
                        waitMs: context.browser.waitMs,
                        waitSelector: context.browser.waitSelector,
                        timeoutMs: context.browser.timeoutMs,
                      }),
                  );
                  postNavigationWaitDurationMs +=
                    confirmationFinalizationWaitDurationMs > 0
                      ? confirmationFinalizationWaitDurationMs
                      : performance.now() - confirmationFinalizationWaitStartedAt;
                  const confirmationFinalDomReadStartedAt = performance.now();
                  html = yield* runPageStage("dom-read", () => page.content());
                  domReadDurationMs += performance.now() - confirmationFinalDomReadStartedAt;
                }

                status = response.status();
                finalUrl = resolveBrowserPageUrl(page.url(), finalUrl);
                const confirmationBrowserErrorPageCode = resolveBrowserErrorPageCode(html);
                if (confirmationBrowserErrorPageCode !== undefined) {
                  return yield* Effect.fail(new Error(confirmationBrowserErrorPageCode));
                }
                wallAnalysis = detectAccessWall({
                  statusCode: status,
                  requestedUrl: url,
                  finalUrl,
                  title: extractHtmlTitle(html),
                  text: html,
                });
                if (!wallAnalysis.likelyAccessWall) {
                  challengeWarnings = [
                    ...challengeWarnings,
                    "cloudflare-solver:clearance-confirmed-on-retry",
                  ];
                }
              }
              if (mediationResolution.outcome.status !== "none" && followUpNavigationCount > 0) {
                challengeWarnings = [
                  ...challengeWarnings,
                  `cloudflare-solver:follow-up-navigation-ms:${roundTiming(
                    followUpNavigationDurationMs,
                  )}`,
                ];
                mediationOutcome = {
                  ...mediationOutcome,
                  timings: {
                    ...mediationOutcome.timings,
                    followUpNavigationMs: roundTiming(followUpNavigationDurationMs),
                  },
                };
              }
              if (mediationOutcome.status === "cleared" && wallAnalysis.likelyAccessWall) {
                mediationOutcome = {
                  ...mediationOutcome,
                  status: "unresolved",
                  failureReason: "no-progress",
                };
                challengeWarnings = [
                  ...challengeWarnings,
                  "cloudflare-solver:clearance-unconfirmed",
                ];
              }
              const requestGetter = Reflect.get(response, "request");
              const finalRedirectCount =
                typeof requestGetter === "function"
                  ? countRedirectChain(requestGetter.call(response))
                  : 0;
              const redirectCount = shouldFollowUpNavigation
                ? initialRedirectCount + followUpRedirectCount
                : finalRedirectCount;
              const finalSnapshot = {
                requestedUrl: url,
                finalUrl,
                status,
                title: extractHtmlTitle(html) ?? null,
                contentType: headers["content-type"] ?? headers["Content-Type"] ?? "",
                htmlLength: html.length,
                redirectCount: finalRedirectCount,
              } satisfies BrowserNavigationSnapshot;
              stage = undefined;
              currentBrowserStage = undefined;
              currentBrowserHardTimeoutMs = pageStageHardTimeoutMs;
              resetOuterHardTimeoutMs(pageStageHardTimeoutMs);

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
                  requestCount: redirectCount + 1 + followUpNavigationCount,
                  redirectCount,
                  blockedRequestCount,
                  routeRegistrationDurationMs: roundTiming(routeRegistrationDurationMs),
                  gotoDurationMs: roundTiming(gotoDurationMs),
                  ...(loadStateMeasured
                    ? { loadStateDurationMs: roundTiming(loadStateDurationMs) }
                    : {}),
                  ...(postNavigationWaitDurationMs > 0
                    ? { postNavigationWaitDurationMs: roundTiming(postNavigationWaitDurationMs) }
                    : {}),
                  domReadDurationMs: roundTiming(domReadDurationMs),
                  headerReadDurationMs: roundTiming(headerReadDurationMs),
                },
                mediation:
                  mediationOutcome.status === "none"
                    ? mediationOutcome
                    : {
                        ...mediationOutcome,
                        evidence: {
                          ...mediationOutcome.evidence,
                          postNavigation: finalSnapshot,
                        },
                      },
                warnings: wallAnalysis.likelyAccessWall
                  ? [...toAccessWallWarnings(wallAnalysis.signals), ...challengeWarnings]
                  : challengeWarnings,
              } satisfies AccessExecutionResult;
            }).pipe(
              Effect.mapError(
                (error) =>
                  new BrowserError({
                    message: `Browser access failed for ${url}`,
                    details:
                      stage === undefined
                        ? formatUnknownError(error)
                        : `${stage}: ${formatUnknownError(error)}`,
                    ...(runtimeWarnings.length === 0 ? {} : { warnings: runtimeWarnings }),
                  }),
              ),
            );
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

    currentBrowserHardTimeoutMs = pageStageHardTimeoutMs;
    return yield* withResettableHardTimeout({
      effect: browserAccessEffect,
      timeoutMs: currentBrowserHardTimeoutMs,
      onTimeout: () =>
        new BrowserError({
          message: `Browser access failed for ${url}`,
          details: formatBrowserOperationTimeoutDetails({
            url,
            providerId: context.providerId,
            waitUntil: context.browser.waitUntil,
            browserTimeoutMs: context.browser.timeoutMs,
            hardTimeoutMs: currentBrowserHardTimeoutMs,
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
      selectionPriority: id === "http-basic" ? 100 : 50,
    },
    execute: ({ url, context }) => executeHttpProvider(url, context),
  };
}

export function makeBrowserAccessProvider(
  id: typeof DEFAULT_BROWSER_PROVIDER_ID | typeof DEFAULT_STEALTH_BROWSER_PROVIDER_ID,
  mediationRuntime: BrowserMediationService,
): AccessProvider {
  return {
    id,
    capabilities: {
      mode: "browser",
      rendersDom: true,
      selectionPriority: id === DEFAULT_BROWSER_PROVIDER_ID ? 100 : 50,
      browserDefaults: {
        runtimeProfileId:
          id === DEFAULT_STEALTH_BROWSER_PROVIDER_ID
            ? DEFAULT_PATCHRIGHT_STEALTH_RUNTIME_PROFILE_ID
            : DEFAULT_PATCHRIGHT_BROWSER_RUNTIME_PROFILE_ID,
        waitUntil: "domcontentloaded",
      },
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

      return executeBrowserProvider(
        url,
        { ...context, browser: context.browser },
        mediationRuntime,
      );
    },
  };
}

export const BuiltinAccessProviderDescriptors = Object.freeze([
  {
    id: "http-basic",
    capabilities: {
      mode: "http",
      rendersDom: false,
      selectionPriority: 100,
    },
  },
  {
    id: "http-impersonated",
    capabilities: {
      mode: "http",
      rendersDom: false,
      selectionPriority: 50,
    },
  },
  {
    id: "browser-basic",
    capabilities: {
      mode: "browser",
      rendersDom: true,
      selectionPriority: 100,
      browserDefaults: {
        runtimeProfileId: DEFAULT_PATCHRIGHT_BROWSER_RUNTIME_PROFILE_ID,
        waitUntil: "domcontentloaded",
      },
    },
  },
  {
    id: "browser-stealth",
    capabilities: {
      mode: "browser",
      rendersDom: true,
      selectionPriority: 50,
      browserDefaults: {
        runtimeProfileId: DEFAULT_PATCHRIGHT_STEALTH_RUNTIME_PROFILE_ID,
        waitUntil: "domcontentloaded",
      },
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
    Effect.gen(function* () {
      const mediationRuntime = yield* BrowserMediationRuntime;
      return makeStaticAccessProviderRegistry({
        "http-basic": makeHttpAccessProvider("http-basic"),
        "http-impersonated": makeHttpAccessProvider("http-impersonated"),
        "browser-basic": makeBrowserAccessProvider("browser-basic", mediationRuntime),
        "browser-stealth": makeBrowserAccessProvider("browser-stealth", mediationRuntime),
      } satisfies Readonly<Record<AccessProviderId, AccessProvider>>);
    }),
  );
}

export const AccessProviderRegistryLive = makeAccessProviderRegistryLive().pipe(
  Layer.provide(BrowserMediationRuntimeLive),
);
