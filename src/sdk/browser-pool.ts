import { Deferred, Effect, Exit, Layer, Option, ServiceMap, SynchronizedRef } from "effect";
import { formatUnknownError } from "./error-guards.ts";
import { type BrowserLaunchProxyConfig } from "./egress-route-config.ts";
import { BrowserError } from "./errors.ts";

const DEFAULT_MAX_CONTEXTS = 4;
const DEFAULT_MAX_PAGES = 4;
const DEFAULT_MAX_QUEUE = 16;
const DEFAULT_BROWSER_POOL_KEY = "patchright-default";
const MAX_CONTEXTS_ENV = "EFFECT_SCRAPLING_BROWSER_POOL_MAX_CONTEXTS";
const MAX_PAGES_ENV = "EFFECT_SCRAPLING_BROWSER_POOL_MAX_PAGES";
const MAX_QUEUE_ENV = "EFFECT_SCRAPLING_BROWSER_POOL_MAX_QUEUE";

export const RECOVERED_BROWSER_ALLOCATION_WARNING_PREFIX =
  "Recovered browser allocation after retryable protocol error:";

export type PatchrightResponse = {
  readonly status: () => number;
  readonly allHeaders: () => Promise<Record<string, string>>;
  readonly request?: () => PatchrightRequest;
};

type PatchrightBoundingBox = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

type PatchrightElementHandle = {
  readonly boundingBox: () => Promise<PatchrightBoundingBox | null>;
  readonly isVisible: () => Promise<boolean>;
};

type PatchrightLocator = {
  readonly boundingBox: () => Promise<PatchrightBoundingBox | null>;
  readonly isVisible?: () => Promise<boolean>;
  readonly last?: () => PatchrightLocator;
};

type PatchrightFrame = {
  readonly frameElement: () => Promise<PatchrightElementHandle>;
};

export type PatchrightPage = {
  readonly goto: (
    url: string,
    options: {
      readonly waitUntil: "load" | "domcontentloaded" | "networkidle" | "commit";
      readonly timeout: number;
    },
  ) => Promise<PatchrightResponse | null>;
  readonly content: () => Promise<string>;
  readonly url: () => string;
  readonly waitForLoadState: (
    state: "load" | "domcontentloaded" | "networkidle",
    options?: { readonly timeout?: number },
  ) => Promise<void>;
  readonly waitForTimeout?: (timeoutMs: number) => Promise<void>;
  readonly frame?: (selector: { readonly url: RegExp }) => PatchrightFrame | null;
  readonly locator?: (selector: string) => PatchrightLocator;
  readonly mouse?: {
    readonly click: (
      x: number,
      y: number,
      options?: {
        readonly delay?: number;
        readonly button?: "left" | "middle" | "right";
      },
    ) => Promise<void>;
  };
  readonly route: (
    matcher: string,
    handler: (route: PatchrightRoute) => Promise<void> | void,
  ) => Promise<void>;
  readonly close: () => Promise<void>;
};

export type PatchrightRequest = {
  readonly url: () => string;
  readonly redirectedFrom?: () => PatchrightRequest | null;
};

type PatchrightRoute = {
  readonly request: () => PatchrightRequest;
  readonly continue: () => Promise<void>;
  readonly abort: (errorCode?: string) => Promise<void>;
};

type PatchrightBrowserContext = {
  readonly newPage: () => Promise<PatchrightPage>;
  readonly close: () => Promise<void>;
};

type PatchrightBrowser = {
  readonly newContext: (options: {
    readonly userAgent: string;
    readonly locale?: string;
    readonly timezoneId?: string;
  }) => Promise<PatchrightBrowserContext>;
  readonly close: () => Promise<void>;
};

export type PatchrightModule = {
  readonly chromium: {
    readonly launch: (options: {
      readonly headless: boolean;
      readonly proxy?: BrowserLaunchProxyConfig | undefined;
    }) => Promise<PatchrightBrowser>;
  };
};

type BrowserPoolLimits = {
  readonly maxContexts: number;
  readonly maxPages: number;
  readonly maxQueue: number;
};

export type BrowserPoolLimitsSnapshot = BrowserPoolLimits;

export type BrowserPoolSnapshot = {
  readonly limits: BrowserPoolLimits;
  readonly activeContexts: number;
  readonly activePages: number;
  readonly queuedRequests: number;
  readonly maxObservedActiveContexts: number;
  readonly maxObservedActivePages: number;
  readonly maxObservedQueuedRequests: number;
};

type BrowserPoolWaiter = {
  readonly gate: Deferred.Deferred<void>;
};

type BrowserPoolAllocationWaiter = {
  readonly gate: Deferred.Deferred<void>;
};

type BrowserPoolAllocationState = {
  readonly active: boolean;
  readonly acceptingRequests: boolean;
  readonly waiters: ReadonlyArray<BrowserPoolAllocationWaiter>;
};

type BrowserPoolState = BrowserPoolSnapshot & {
  readonly acceptingRequests: boolean;
  readonly waiters: ReadonlyArray<BrowserPoolWaiter>;
};

type BrowserPoolConfig = BrowserPoolLimits & {
  readonly loadPatchright: () => Effect.Effect<PatchrightModule, BrowserError>;
  readonly proxy?: BrowserLaunchProxyConfig | undefined;
};

type BrowserRuntimeState = {
  readonly runtimes: Map<string, BrowserPoolRuntime>;
  testConfig?: BrowserPoolTestConfig | undefined;
};

type BrowserSlotAcquisition = {
  readonly queuePosition?: number;
  readonly waitedMs: number;
};

type QueueReservationResult = number | "closed" | "full";

type BrowserPoolRuntime = {
  readonly config: BrowserPoolConfig;
  readonly browserRef: SynchronizedRef.SynchronizedRef<Option.Option<PatchrightBrowser>>;
  readonly retiredBrowsersRef: SynchronizedRef.SynchronizedRef<ReadonlyArray<PatchrightBrowser>>;
  readonly stateRef: SynchronizedRef.SynchronizedRef<BrowserPoolState>;
  readonly allocationRef: SynchronizedRef.SynchronizedRef<BrowserPoolAllocationState>;
};

export type BrowserRuntimeService = {
  readonly readPoolLimits: () => BrowserPoolLimitsSnapshot;
  readonly withPage: <A, E>(
    options: {
      readonly poolKey?: string;
      readonly runtimeProfileId: string;
      readonly userAgent: string;
      readonly locale?: string;
      readonly timezoneId?: string;
      readonly proxy?: BrowserLaunchProxyConfig | undefined;
    },
    use: (page: PatchrightPage, warnings?: ReadonlyArray<string>) => Effect.Effect<A, E>,
  ) => Effect.Effect<
    {
      readonly value: A;
      readonly warnings: ReadonlyArray<string>;
    },
    BrowserError | E
  >;
  readonly getSnapshot: () => Effect.Effect<BrowserPoolSnapshot>;
  readonly setTestConfig: (config: BrowserPoolTestConfig) => Effect.Effect<void, never, never>;
  readonly close: () => Effect.Effect<void, never, never>;
  readonly resetForTests: () => Effect.Effect<void, never, never>;
};

export type BrowserPoolTestConfig = {
  readonly maxContexts?: number;
  readonly maxPages?: number;
  readonly maxQueue?: number;
  readonly loadPatchright?: () => Effect.Effect<PatchrightModule, BrowserError>;
};

function isPatchrightModule(module: unknown): module is PatchrightModule {
  if (typeof module !== "object" || module === null) {
    return false;
  }

  const chromium = Reflect.get(module, "chromium");
  if (typeof chromium !== "object" || chromium === null) {
    return false;
  }

  return typeof Reflect.get(chromium, "launch") === "function";
}

function loadPatchright(): Effect.Effect<PatchrightModule, BrowserError> {
  return Effect.tryPromise({
    try: async () => {
      const patchrightModuleName = "patchright";
      const loaded = await import(patchrightModuleName);
      if (!isPatchrightModule(loaded)) {
        throw new Error("Patchright module is installed but has an unexpected shape");
      }
      return loaded;
    },
    catch: (error) =>
      new BrowserError({
        message: "Browser mode requires Patchright to be installed and resolvable",
        details: formatUnknownError(error),
      }),
  });
}

function initialBrowserPoolState(limits: BrowserPoolLimits): BrowserPoolState {
  return {
    limits,
    activeContexts: 0,
    activePages: 0,
    queuedRequests: 0,
    maxObservedActiveContexts: 0,
    maxObservedActivePages: 0,
    maxObservedQueuedRequests: 0,
    acceptingRequests: true,
    waiters: [],
  };
}

function initialBrowserPoolAllocationState(): BrowserPoolAllocationState {
  return {
    active: false,
    acceptingRequests: true,
    waiters: [],
  };
}

function resolveBrowserPoolConfig(state: BrowserRuntimeState): BrowserPoolConfig {
  const configuredMaxContexts = readPositiveIntFromEnvironment(MAX_CONTEXTS_ENV);
  const configuredMaxPages = readPositiveIntFromEnvironment(MAX_PAGES_ENV);
  const configuredMaxQueue = readPositiveIntFromEnvironment(MAX_QUEUE_ENV);

  return {
    maxContexts: state.testConfig?.maxContexts ?? configuredMaxContexts ?? DEFAULT_MAX_CONTEXTS,
    maxPages: state.testConfig?.maxPages ?? configuredMaxPages ?? DEFAULT_MAX_PAGES,
    maxQueue: state.testConfig?.maxQueue ?? configuredMaxQueue ?? DEFAULT_MAX_QUEUE,
    loadPatchright: state.testConfig?.loadPatchright ?? loadPatchright,
  };
}

function readPositiveIntFromEnvironment(variableName: string): number | undefined {
  const raw = process.env[variableName];
  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readBrowserPoolLimitsFromState(state: BrowserRuntimeState): BrowserPoolLimitsSnapshot {
  const config = resolveBrowserPoolConfig(state);

  return {
    maxContexts: config.maxContexts,
    maxPages: config.maxPages,
    maxQueue: config.maxQueue,
  };
}

function makeBrowserPoolRuntime(config: BrowserPoolConfig): BrowserPoolRuntime {
  return {
    config,
    browserRef: SynchronizedRef.makeUnsafe(Option.none()),
    retiredBrowsersRef: SynchronizedRef.makeUnsafe<ReadonlyArray<PatchrightBrowser>>([]),
    allocationRef: SynchronizedRef.makeUnsafe(initialBrowserPoolAllocationState()),
    stateRef: SynchronizedRef.makeUnsafe(
      initialBrowserPoolState({
        maxContexts: config.maxContexts,
        maxPages: config.maxPages,
        maxQueue: config.maxQueue,
      }),
    ),
  };
}

function serializeProxyConfig(proxy?: BrowserLaunchProxyConfig | undefined) {
  if (proxy === undefined) {
    return "direct";
  }

  return JSON.stringify({
    server: proxy.server,
    ...(proxy.bypass === undefined ? {} : { bypass: proxy.bypass }),
    ...(proxy.username === undefined ? {} : { username: proxy.username }),
    ...(proxy.password === undefined ? {} : { password: proxy.password }),
  });
}

function toBrowserRuntimeCacheKey(poolKey: string, proxy?: BrowserLaunchProxyConfig | undefined) {
  return `${poolKey}::${serializeProxyConfig(proxy)}`;
}

function getBrowserPoolRuntime(
  state: BrowserRuntimeState,
  poolKey: string = DEFAULT_BROWSER_POOL_KEY,
  proxy?: BrowserLaunchProxyConfig | undefined,
): BrowserPoolRuntime {
  const runtimeCacheKey = toBrowserRuntimeCacheKey(poolKey, proxy);
  const existingRuntime = state.runtimes.get(runtimeCacheKey);
  if (existingRuntime !== undefined) {
    return existingRuntime;
  }

  const nextRuntime = makeBrowserPoolRuntime({
    ...resolveBrowserPoolConfig(state),
    ...(proxy === undefined ? {} : { proxy }),
  });
  state.runtimes.set(runtimeCacheKey, nextRuntime);
  return nextRuntime;
}

function projectSnapshot(state: BrowserPoolState): BrowserPoolSnapshot {
  return {
    limits: state.limits,
    activeContexts: state.activeContexts,
    activePages: state.activePages,
    queuedRequests: state.queuedRequests,
    maxObservedActiveContexts: state.maxObservedActiveContexts,
    maxObservedActivePages: state.maxObservedActivePages,
    maxObservedQueuedRequests: state.maxObservedQueuedRequests,
  };
}

function browserPoolClosedError(details: string) {
  return new BrowserError({
    message: "Browser pool is closed",
    details,
  });
}

function closeQuietly(closeable: { readonly close: () => Promise<void> }): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => closeable.close(),
    catch: () => "close-ignored",
  }).pipe(Effect.ignore);
}

function acquireBrowser(pool: BrowserPoolRuntime): Effect.Effect<PatchrightBrowser, BrowserError> {
  return SynchronizedRef.modifyEffect(pool.browserRef, (currentBrowser) =>
    Option.match(currentBrowser, {
      onNone: () =>
        pool.config.loadPatchright().pipe(
          Effect.flatMap((patchright) =>
            Effect.tryPromise({
              try: () =>
                patchright.chromium.launch({
                  headless: true,
                  ...(pool.config.proxy === undefined ? {} : { proxy: pool.config.proxy }),
                }),
              catch: (error) =>
                new BrowserError({
                  message: "Browser mode failed to launch Chromium",
                  details: formatUnknownError(error),
                }),
            }),
          ),
          Effect.map((browser) => [browser, Option.some(browser)] as const),
        ),
      onSome: (browser) => Effect.succeed([browser, currentBrowser] as const),
    }),
  );
}

function reserveQueuedSlot(
  pool: BrowserPoolRuntime,
  waiter: BrowserPoolWaiter,
): Effect.Effect<number, BrowserError> {
  return SynchronizedRef.modify(
    pool.stateRef,
    (state): readonly [QueueReservationResult, BrowserPoolState] => {
      if (!state.acceptingRequests) {
        return ["closed", state] as const;
      }

      if (state.waiters.length >= state.limits.maxQueue) {
        return ["full", state] as const;
      }

      const waiters = [...state.waiters, waiter];
      const queuedRequests = waiters.length;

      return [
        waiters.length,
        {
          ...state,
          waiters,
          queuedRequests,
          maxObservedQueuedRequests: Math.max(state.maxObservedQueuedRequests, queuedRequests),
        },
      ] as const;
    },
  ).pipe(
    Effect.flatMap((result) =>
      result === "closed"
        ? Effect.fail(
            browserPoolClosedError(
              "Pool was closed or reset while waiting to enqueue browser work",
            ),
          )
        : result === "full"
          ? Effect.fail(
              new BrowserError({
                message: "Browser pool queue is full",
                details: `Queue limit ${pool.config.maxQueue} was reached while waiting for a browser context/page slot`,
              }),
            )
          : Effect.succeed(result),
    ),
  );
}

function removeQueuedWaiter(
  pool: BrowserPoolRuntime,
  waiter: BrowserPoolWaiter,
): Effect.Effect<void> {
  return SynchronizedRef.update(pool.stateRef, (state) => {
    const waiters = state.waiters.filter((candidate) => candidate !== waiter);
    if (waiters.length === state.waiters.length) {
      return state;
    }

    return {
      ...state,
      waiters,
      queuedRequests: waiters.length,
    };
  });
}

function removeAllocationWaiter(
  pool: BrowserPoolRuntime,
  waiter: BrowserPoolAllocationWaiter,
): Effect.Effect<void> {
  return SynchronizedRef.update(pool.allocationRef, (state) => {
    const waiters = state.waiters.filter((candidate) => candidate !== waiter);
    if (waiters.length === state.waiters.length) {
      return state;
    }

    return {
      ...state,
      waiters,
    };
  });
}

function grantBrowserSlots(
  state: BrowserPoolState,
): readonly [ReadonlyArray<BrowserPoolWaiter>, BrowserPoolState] {
  let nextState = state;
  const granted: BrowserPoolWaiter[] = [];

  while (
    nextState.acceptingRequests &&
    nextState.waiters.length > 0 &&
    nextState.activeContexts < nextState.limits.maxContexts &&
    nextState.activePages < nextState.limits.maxPages
  ) {
    const [nextWaiter, ...remainingWaiters] = nextState.waiters;
    if (!nextWaiter) {
      break;
    }

    const activeContexts = nextState.activeContexts + 1;
    const activePages = nextState.activePages + 1;

    nextState = {
      ...nextState,
      waiters: remainingWaiters,
      queuedRequests: remainingWaiters.length,
      activeContexts,
      activePages,
      maxObservedActiveContexts: Math.max(nextState.maxObservedActiveContexts, activeContexts),
      maxObservedActivePages: Math.max(nextState.maxObservedActivePages, activePages),
    };
    granted.push(nextWaiter);
  }

  return [granted, nextState] as const;
}

function acquireBrowserSlot(
  pool: BrowserPoolRuntime,
): Effect.Effect<BrowserSlotAcquisition, BrowserError> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const immediate = yield* SynchronizedRef.modify(pool.stateRef, (state) => {
        if (!state.acceptingRequests) {
          return ["closed" as const, state] as const;
        }

        const canAcquireImmediately =
          state.waiters.length === 0 &&
          state.activeContexts < state.limits.maxContexts &&
          state.activePages < state.limits.maxPages;

        if (!canAcquireImmediately) {
          return ["queued" as const, state] as const;
        }

        const activeContexts = state.activeContexts + 1;
        const activePages = state.activePages + 1;

        return [
          "acquired" as const,
          {
            ...state,
            activeContexts,
            activePages,
            maxObservedActiveContexts: Math.max(state.maxObservedActiveContexts, activeContexts),
            maxObservedActivePages: Math.max(state.maxObservedActivePages, activePages),
          },
        ] as const;
      });

      if (immediate === "closed") {
        return yield* Effect.fail(
          browserPoolClosedError("Pool was closed or reset before acquiring browser capacity"),
        );
      }

      if (immediate === "acquired") {
        return {
          waitedMs: 0,
        } satisfies BrowserSlotAcquisition;
      }

      const waiter = {
        gate: yield* Deferred.make<void>(),
      } satisfies BrowserPoolWaiter;
      const queuePosition = yield* reserveQueuedSlot(pool, waiter);
      const queuedAt = Date.now();
      const awaitedGate = yield* Effect.exit(
        restore(Deferred.await(waiter.gate)).pipe(
          Effect.ensuring(removeQueuedWaiter(pool, waiter)),
        ),
      );

      if (Exit.isFailure(awaitedGate)) {
        return yield* Effect.failCause(awaitedGate.cause);
      }

      const acceptingRequests = yield* SynchronizedRef.get(pool.stateRef).pipe(
        Effect.map((state) => state.acceptingRequests),
      );
      if (!acceptingRequests) {
        return yield* Effect.fail(
          browserPoolClosedError("Pool was closed or reset while waiting for browser capacity"),
        );
      }

      return {
        queuePosition,
        waitedMs: Math.max(1, Date.now() - queuedAt),
      } satisfies BrowserSlotAcquisition;
    }),
  );
}

function releaseBrowserSlot(pool: BrowserPoolRuntime): Effect.Effect<void> {
  return Effect.gen(function* () {
    const grantedWaiters = yield* SynchronizedRef.modify(pool.stateRef, (state) => {
      const releasedState: BrowserPoolState = {
        ...state,
        activeContexts: Math.max(0, state.activeContexts - 1),
        activePages: Math.max(0, state.activePages - 1),
      };

      return grantBrowserSlots(releasedState);
    });

    for (const waiter of grantedWaiters) {
      yield* Deferred.succeed(waiter.gate, undefined);
    }
  });
}

function acquireAllocationLock(pool: BrowserPoolRuntime): Effect.Effect<void, BrowserError> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const immediate = yield* SynchronizedRef.modify(pool.allocationRef, (state) => {
        if (!state.acceptingRequests) {
          return ["closed" as const, state] as const;
        }

        if (!state.active) {
          return ["acquired" as const, { ...state, active: true }] as const;
        }

        return ["queued" as const, state] as const;
      });

      if (immediate === "closed") {
        return yield* Effect.fail(
          browserPoolClosedError("Pool was closed or reset before browser allocation started"),
        );
      }

      if (immediate === "acquired") {
        return;
      }

      const waiter = {
        gate: yield* Deferred.make<void>(),
      } satisfies BrowserPoolAllocationWaiter;
      const queued = yield* SynchronizedRef.modify(pool.allocationRef, (state) => {
        if (!state.acceptingRequests) {
          return ["closed" as const, state] as const;
        }

        return ["queued" as const, { ...state, waiters: [...state.waiters, waiter] }] as const;
      });

      if (queued === "closed") {
        return yield* Effect.fail(
          browserPoolClosedError("Pool was closed or reset while waiting for browser allocation"),
        );
      }

      const awaitedGate = yield* Effect.exit(
        restore(Deferred.await(waiter.gate)).pipe(
          Effect.ensuring(removeAllocationWaiter(pool, waiter)),
        ),
      );
      if (Exit.isFailure(awaitedGate)) {
        return yield* Effect.failCause(awaitedGate.cause);
      }

      const acceptingRequests = yield* SynchronizedRef.get(pool.allocationRef).pipe(
        Effect.map((state) => state.acceptingRequests),
      );
      if (!acceptingRequests) {
        return yield* Effect.fail(
          browserPoolClosedError("Pool was closed or reset while waiting for browser allocation"),
        );
      }
    }),
  );
}

function releaseAllocationLock(pool: BrowserPoolRuntime): Effect.Effect<void> {
  return Effect.gen(function* () {
    const nextWaiter = yield* SynchronizedRef.modify(pool.allocationRef, (state) => {
      const [waiter, ...remainingWaiters] = state.waiters;
      if (waiter === undefined) {
        return [undefined, { ...state, active: false }] as const;
      }

      return [waiter, { ...state, waiters: remainingWaiters, active: true }] as const;
    });

    if (nextWaiter !== undefined) {
      yield* Deferred.succeed(nextWaiter.gate, undefined);
    }
  });
}

function createContext(
  pool: BrowserPoolRuntime,
  options: {
    readonly userAgent: string;
    readonly locale?: string;
    readonly timezoneId?: string;
  },
): Effect.Effect<PatchrightBrowserContext, BrowserError> {
  return acquireBrowser(pool).pipe(
    Effect.flatMap((browser) =>
      Effect.tryPromise({
        try: () => browser.newContext(options),
        catch: (error) =>
          new BrowserError({
            message: "Browser pool failed to allocate a browsing context",
            details: formatUnknownError(error),
          }),
      }),
    ),
  );
}

function createPage(
  context: PatchrightBrowserContext,
): Effect.Effect<PatchrightPage, BrowserError> {
  return Effect.tryPromise({
    try: () => context.newPage(),
    catch: (error) =>
      new BrowserError({
        message: "Browser pool failed to allocate a browsing page",
        details: formatUnknownError(error),
      }),
  });
}

function isRetryableBrowserAllocationError(error: BrowserError): boolean {
  const details = (error.details ?? error.message).toLowerCase();

  return (
    (details.includes("protocol error") &&
      (details.includes("session closed") ||
        details.includes("browser has been closed") ||
        details.includes("target closed") ||
        details.includes("target page, context or browser has been closed") ||
        details.includes("crashed"))) ||
    details.includes("session closed") ||
    details.includes("browser has been closed") ||
    details.includes("target closed") ||
    details.includes("target page, context or browser has been closed") ||
    details.includes("crashed")
  );
}

function formatRecoveredBrowserAllocationWarning(error: BrowserError) {
  const detail = (error.details ?? error.message).replaceAll(/\s+/g, " ").trim();
  const compactDetail = detail.length <= 220 ? detail : `${detail.slice(0, 217)}...`;
  return `${RECOVERED_BROWSER_ALLOCATION_WARNING_PREFIX} ${compactDetail}`;
}

function dedupeWarnings(warnings: ReadonlyArray<string>) {
  return [...new Set(warnings.filter((warning) => warning.trim().length > 0))];
}

function appendWarningsToBrowserError<E>(
  error: E,
  warnings: ReadonlyArray<string>,
): BrowserError | E {
  if (warnings.length === 0 || !(error instanceof BrowserError)) {
    return error;
  }

  return new BrowserError({
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
    warnings: dedupeWarnings([...(error.warnings ?? []), ...warnings]),
  });
}

function evictSharedBrowser(pool: BrowserPoolRuntime): Effect.Effect<void, never, never> {
  return SynchronizedRef.modifyEffect(pool.browserRef, (currentBrowser) =>
    Option.match(currentBrowser, {
      onNone: () => Effect.succeed([undefined, Option.none()] as const),
      onSome: (browser) =>
        SynchronizedRef.update(pool.retiredBrowsersRef, (retiredBrowsers) => [
          ...retiredBrowsers,
          browser,
        ]).pipe(Effect.as([undefined, Option.none()] as const)),
    }),
  ).pipe(Effect.asVoid);
}

function closeRetiredBrowsersIfIdle(pool: BrowserPoolRuntime): Effect.Effect<void, never, never> {
  return SynchronizedRef.get(pool.stateRef).pipe(
    Effect.flatMap((state) => {
      if (state.activeContexts > 0 || state.activePages > 0) {
        return Effect.void;
      }

      return SynchronizedRef.modify(pool.retiredBrowsersRef, (browsers) => [
        browsers,
        [] as ReadonlyArray<PatchrightBrowser>,
      ]).pipe(
        Effect.flatMap((browsers) =>
          Effect.forEach(browsers, (browser) => closeQuietly(browser), {
            discard: true,
            concurrency: "unbounded",
          }),
        ),
      );
    }),
  );
}

function allocateBrowserPage(
  pool: BrowserPoolRuntime,
  options: {
    readonly userAgent: string;
    readonly locale?: string;
    readonly timezoneId?: string;
  },
): Effect.Effect<
  {
    readonly context: PatchrightBrowserContext;
    readonly page: PatchrightPage;
    readonly warnings: ReadonlyArray<string>;
  },
  BrowserError
> {
  const allocateOnce = Effect.gen(function* () {
    const context = yield* createContext(pool, options);
    const pageExit = yield* Effect.exit(createPage(context));
    if (Exit.isFailure(pageExit)) {
      yield* releaseContext(context);
      return yield* Effect.failCause(pageExit.cause);
    }

    return {
      context,
      page: pageExit.value,
      warnings: [] as const,
    } as const;
  });

  return Effect.acquireUseRelease(
    acquireAllocationLock(pool),
    () =>
      allocateOnce.pipe(
        Effect.catchTag("BrowserError", (error) =>
          isRetryableBrowserAllocationError(error)
            ? evictSharedBrowser(pool).pipe(
                Effect.flatMap(() => closeRetiredBrowsersIfIdle(pool)),
                Effect.flatMap(() => allocateOnce),
                Effect.map((allocation) => ({
                  ...allocation,
                  warnings: [formatRecoveredBrowserAllocationWarning(error)],
                })),
              )
            : Effect.fail(error),
        ),
      ),
    () => releaseAllocationLock(pool),
  );
}

function releaseContext(context: PatchrightBrowserContext): Effect.Effect<void> {
  return closeQuietly(context);
}

function releasePage(page: PatchrightPage): Effect.Effect<void> {
  return closeQuietly(page);
}

function formatQueueWarning(
  acquisition: BrowserSlotAcquisition,
  limits: BrowserPoolLimits,
): string | undefined {
  if (acquisition.waitedMs === 0) {
    return undefined;
  }

  return `Browser pool backpressure: waited ${acquisition.waitedMs}ms at queue position ${acquisition.queuePosition ?? 1} (contexts=${limits.maxContexts}, pages=${limits.maxPages}, queue=${limits.maxQueue})`;
}

function withPooledBrowserPageFromState<A, E>(
  state: BrowserRuntimeState,
  options: {
    readonly poolKey?: string;
    readonly runtimeProfileId: string;
    readonly userAgent: string;
    readonly locale?: string;
    readonly timezoneId?: string;
    readonly proxy?: BrowserLaunchProxyConfig | undefined;
  },
  use: (page: PatchrightPage, warnings?: ReadonlyArray<string>) => Effect.Effect<A, E>,
): Effect.Effect<
  {
    readonly value: A;
    readonly warnings: ReadonlyArray<string>;
  },
  BrowserError | E
> {
  return Effect.gen(function* () {
    const pool = getBrowserPoolRuntime(
      state,
      options.poolKey ?? options.runtimeProfileId,
      options.proxy,
    );

    return yield* Effect.acquireUseRelease(
      acquireBrowserSlot(pool),
      (acquisition) =>
        Effect.acquireUseRelease(
          allocateBrowserPage(pool, {
            userAgent: options.userAgent,
            ...(options.locale === undefined ? {} : { locale: options.locale }),
            ...(options.timezoneId === undefined ? {} : { timezoneId: options.timezoneId }),
          }),
          ({ page, warnings: allocationWarnings }) =>
            Effect.gen(function* () {
              const queueWarning = formatQueueWarning(acquisition, pool.config);
              const combinedWarnings = dedupeWarnings([
                ...allocationWarnings,
                ...(queueWarning ? [queueWarning] : []),
              ]);
              const value = yield* use(page, combinedWarnings).pipe(
                Effect.mapError((error) => appendWarningsToBrowserError(error, combinedWarnings)),
              );

              return {
                value,
                warnings: combinedWarnings,
              } as const;
            }),
          ({ context, page }) =>
            releasePage(page).pipe(Effect.flatMap(() => releaseContext(context))),
        ),
      () => releaseBrowserSlot(pool).pipe(Effect.ensuring(closeRetiredBrowsersIfIdle(pool))),
    );
  });
}

function closeSharedBrowser(pool: BrowserPoolRuntime): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const currentBrowser = yield* SynchronizedRef.modify(pool.browserRef, (browser) => [
      browser,
      Option.none<PatchrightBrowser>(),
    ]);
    const retiredBrowsers = yield* SynchronizedRef.modify(pool.retiredBrowsersRef, (browsers) => [
      browsers,
      [],
    ]);

    yield* Option.match(currentBrowser, {
      onNone: () => Effect.void,
      onSome: (browser) => closeQuietly(browser),
    });
    for (const browser of retiredBrowsers) {
      yield* closeQuietly(browser);
    }
  });
}

function stopBrowserPoolRuntime(pool: BrowserPoolRuntime): Effect.Effect<void> {
  return Effect.gen(function* () {
    const waiters = yield* SynchronizedRef.modify(pool.stateRef, (state) => [
      state.waiters,
      {
        ...state,
        acceptingRequests: false,
        waiters: [],
        queuedRequests: 0,
      },
    ]);
    const allocationWaiters = yield* SynchronizedRef.modify(pool.allocationRef, (state) => [
      state.waiters,
      {
        ...state,
        active: false,
        acceptingRequests: false,
        waiters: [],
      },
    ]);

    for (const waiter of waiters) {
      yield* Deferred.succeed(waiter.gate, undefined);
    }
    for (const waiter of allocationWaiters) {
      yield* Deferred.succeed(waiter.gate, undefined);
    }

    yield* closeSharedBrowser(pool);
  });
}

function getBrowserPoolSnapshotFromState(
  state: BrowserRuntimeState,
): Effect.Effect<BrowserPoolSnapshot> {
  if (state.runtimes.size === 0) {
    return Effect.succeed(
      projectSnapshot(
        initialBrowserPoolState({
          maxContexts: resolveBrowserPoolConfig(state).maxContexts,
          maxPages: resolveBrowserPoolConfig(state).maxPages,
          maxQueue: resolveBrowserPoolConfig(state).maxQueue,
        }),
      ),
    );
  }

  return Effect.forEach([...state.runtimes.values()], (runtime) =>
    SynchronizedRef.get(runtime.stateRef).pipe(Effect.map(projectSnapshot)),
  ).pipe(
    Effect.map((snapshots) => {
      const [firstSnapshot] = snapshots;
      if (firstSnapshot === undefined) {
        return projectSnapshot(
          initialBrowserPoolState({
            maxContexts: resolveBrowserPoolConfig(state).maxContexts,
            maxPages: resolveBrowserPoolConfig(state).maxPages,
            maxQueue: resolveBrowserPoolConfig(state).maxQueue,
          }),
        );
      }

      return snapshots.slice(1).reduce(
        (aggregate, snapshot) => ({
          limits: {
            maxContexts: aggregate.limits.maxContexts + snapshot.limits.maxContexts,
            maxPages: aggregate.limits.maxPages + snapshot.limits.maxPages,
            maxQueue: aggregate.limits.maxQueue + snapshot.limits.maxQueue,
          },
          activeContexts: aggregate.activeContexts + snapshot.activeContexts,
          activePages: aggregate.activePages + snapshot.activePages,
          queuedRequests: aggregate.queuedRequests + snapshot.queuedRequests,
          maxObservedActiveContexts: Math.max(
            aggregate.maxObservedActiveContexts,
            snapshot.maxObservedActiveContexts,
            aggregate.activeContexts + snapshot.activeContexts,
          ),
          maxObservedActivePages: Math.max(
            aggregate.maxObservedActivePages,
            snapshot.maxObservedActivePages,
            aggregate.activePages + snapshot.activePages,
          ),
          maxObservedQueuedRequests: Math.max(
            aggregate.maxObservedQueuedRequests,
            snapshot.maxObservedQueuedRequests,
            aggregate.queuedRequests + snapshot.queuedRequests,
          ),
        }),
        firstSnapshot,
      );
    }),
  );
}

function setBrowserPoolTestConfigForState(
  state: BrowserRuntimeState,
  config: BrowserPoolTestConfig,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    for (const runtime of state.runtimes.values()) {
      yield* stopBrowserPoolRuntime(runtime);
    }
    state.runtimes.clear();
    state.testConfig = config;
  });
}

function closeBrowserPoolForState(state: BrowserRuntimeState): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    for (const runtime of state.runtimes.values()) {
      yield* stopBrowserPoolRuntime(runtime);
    }
    state.runtimes.clear();
  });
}

function resetBrowserPoolForState(state: BrowserRuntimeState): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    for (const runtime of state.runtimes.values()) {
      yield* stopBrowserPoolRuntime(runtime);
    }
    state.runtimes.clear();
    state.testConfig = undefined;
  });
}

function makeBrowserRuntime(state: BrowserRuntimeState): BrowserRuntimeService {
  return {
    readPoolLimits: () => readBrowserPoolLimitsFromState(state),
    withPage: <A, E>(
      options: {
        readonly poolKey?: string;
        readonly runtimeProfileId: string;
        readonly userAgent: string;
        readonly locale?: string;
        readonly timezoneId?: string;
        readonly proxy?: BrowserLaunchProxyConfig | undefined;
      },
      use: (page: PatchrightPage, warnings?: ReadonlyArray<string>) => Effect.Effect<A, E>,
    ) => withPooledBrowserPageFromState(state, options, use),
    getSnapshot: () => getBrowserPoolSnapshotFromState(state),
    setTestConfig: (config: BrowserPoolTestConfig) =>
      setBrowserPoolTestConfigForState(state, config),
    close: () => closeBrowserPoolForState(state),
    resetForTests: () => resetBrowserPoolForState(state),
  } satisfies BrowserRuntimeService;
}

const sharedBrowserRuntimeState: BrowserRuntimeState = {
  runtimes: new Map<string, BrowserPoolRuntime>(),
  testConfig: undefined,
};

const sharedBrowserRuntime = makeBrowserRuntime(sharedBrowserRuntimeState);

export class BrowserRuntime extends ServiceMap.Service<BrowserRuntime, BrowserRuntimeService>()(
  "@effect-scrapling/sdk/BrowserRuntime",
) {}

export const BrowserRuntimeLive = Layer.succeed(BrowserRuntime, sharedBrowserRuntime);

export function readBrowserPoolLimits(): BrowserPoolLimitsSnapshot {
  return sharedBrowserRuntime.readPoolLimits();
}

export function withPooledBrowserPage<A, E>(
  options: {
    readonly poolKey?: string;
    readonly runtimeProfileId: string;
    readonly userAgent: string;
    readonly locale?: string;
    readonly timezoneId?: string;
    readonly proxy?: BrowserLaunchProxyConfig | undefined;
  },
  use: (page: PatchrightPage, warnings?: ReadonlyArray<string>) => Effect.Effect<A, E>,
): Effect.Effect<
  {
    readonly value: A;
    readonly warnings: ReadonlyArray<string>;
  },
  BrowserError | E
> {
  return sharedBrowserRuntime.withPage(options, use);
}

export function getBrowserPoolSnapshot(): Effect.Effect<BrowserPoolSnapshot> {
  return sharedBrowserRuntime.getSnapshot();
}

export function setBrowserPoolTestConfig(
  config: BrowserPoolTestConfig,
): Effect.Effect<void, never, never> {
  return sharedBrowserRuntime.setTestConfig(config);
}

export function closeBrowserPool(): Effect.Effect<void, never, never> {
  return sharedBrowserRuntime.close();
}

export function resetBrowserPoolForTests(): Effect.Effect<void, never, never> {
  return sharedBrowserRuntime.resetForTests();
}
