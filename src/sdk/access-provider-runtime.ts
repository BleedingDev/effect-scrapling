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
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const DEFAULT_USER_AGENT = "effect-scrapling/0.0.1";

type BrowserExecutionStage =
  | "route-registration"
  | "navigation"
  | "load-state"
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

function roundTiming(value: number) {
  return Math.round(Math.max(0, value) * 1_000) / 1_000;
}

function shouldAttemptPostClearanceNetworkSettle(waitUntil: BrowserWaitUntil) {
  return waitUntil !== "networkidle";
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

  return input.browserTimeoutMs + mediationBudgetMs + BROWSER_OPERATION_TIMEOUT_GRACE_MS;
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

function withHardTimeoutUntilDisarmed<A, E>(input: {
  readonly effect: (disarmTimeout: () => void) => Effect.Effect<A, E>;
  readonly timeoutMs: number;
  readonly onTimeout: () => E;
}): Effect.Effect<A, E> {
  return Effect.callback((resume) => {
    let settled = false;
    let timeoutDisarmed = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const disarmTimeout = () => {
      if (settled || timeoutDisarmed) {
        return;
      }
      timeoutDisarmed = true;
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    };

    const fiber = Effect.runFork(input.effect(disarmTimeout));
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
      if (settled || timeoutDisarmed) {
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
    let runtimeWarnings: ReadonlyArray<string> = [];
    const pageStageHardTimeoutMs =
      context.browser.timeoutMs + BROWSER_OPERATION_TIMEOUT_GRACE_MS;
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
    const browserAccessEffect = (disarmOuterHardTimeout: () => void) =>
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
            disarmOuterHardTimeout();
            runtimeWarnings = poolWarnings ?? [];
            let stage: BrowserExecutionStage | undefined;

            const runPageStage = <A>(
              nextStage: Exclude<BrowserExecutionStage, "challenge-resolution">,
              operation: () => Promise<A>,
            ) =>
              withHardTimeout({
                effect: Effect.tryPromise({
                  try: async () => {
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
            const routeRegistrationDurationMs = performance.now() - routeRegistrationStartedAt;

            const gotoStartedAt = performance.now();
            let response = yield* runPageStage("navigation", () =>
              page.goto(url, {
                waitUntil: context.browser.waitUntil,
                timeout: context.browser.timeoutMs,
              }),
            );
            let gotoDurationMs = performance.now() - gotoStartedAt;
            let loadStateDurationMs = 0;
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
            const initialHeaderReadStartedAt = performance.now();
            let headers = yield* runPageStage("header-read", () => initialResponse.allHeaders());
            let headerReadDurationMs = performance.now() - initialHeaderReadStartedAt;
            const initialStatus = initialResponse.status();
            const initialFinalUrl = resolveValidatedUrl(page.url()).toString();
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
              const followUpNavigationStartedAt = performance.now();
              response = yield* runPageStage("navigation", () =>
                page.goto(url, {
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
              const followUpNavigationDurationMs = performance.now() - followUpNavigationStartedAt;
              gotoDurationMs += followUpNavigationDurationMs;
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
              if (mediationResolution.outcome.status !== "none") {
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
              const followUpHeaderReadStartedAt = performance.now();
              headers = yield* runPageStage("header-read", () => followUpResponse.allHeaders());
              headerReadDurationMs += performance.now() - followUpHeaderReadStartedAt;
            }
            const status = response.status();
            const finalUrl = resolveValidatedUrl(page.url()).toString();
            const wallAnalysis = detectAccessWall({
              statusCode: status,
              requestedUrl: url,
              finalUrl,
              title: extractHtmlTitle(html),
              text: html,
            });
            if (status >= 400 && !wallAnalysis.likelyAccessWall) {
              return yield* Effect.fail(new Error(`HTTP ${status}`));
            }
            if (mediationOutcome.status === "cleared" && wallAnalysis.likelyAccessWall) {
              mediationOutcome = {
                ...mediationOutcome,
                status: "unresolved",
                failureReason: "no-progress",
              };
              challengeWarnings = [...challengeWarnings, "cloudflare-solver:clearance-unconfirmed"];
            }
            const requestGetter = Reflect.get(response, "request");
            const finalRedirectCount =
              typeof requestGetter === "function"
                ? countRedirectChain(requestGetter.call(response))
                : 0;
            const redirectCount = shouldFollowUpNavigation
              ? initialRedirectCount + finalRedirectCount
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
                requestCount: redirectCount + 1 + (shouldFollowUpNavigation ? 1 : 0),
                redirectCount,
                blockedRequestCount,
                routeRegistrationDurationMs: roundTiming(routeRegistrationDurationMs),
                gotoDurationMs: roundTiming(gotoDurationMs),
                ...(loadStateMeasured
                  ? { loadStateDurationMs: roundTiming(loadStateDurationMs) }
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

    const hardTimeoutMs = resolveBrowserHardTimeoutMs({
      browserTimeoutMs: context.browser.timeoutMs,
      challengeHandling: context.browser.challengeHandling,
    });
    return yield* withHardTimeoutUntilDisarmed({
      effect: browserAccessEffect,
      timeoutMs: hardTimeoutMs,
      onTimeout: () =>
        new BrowserError({
          message: `Browser access failed for ${url}`,
          details: formatBrowserOperationTimeoutDetails({
            url,
            providerId: context.providerId,
            waitUntil: context.browser.waitUntil,
            browserTimeoutMs: context.browser.timeoutMs,
            hardTimeoutMs,
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
