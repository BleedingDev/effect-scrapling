import { Deferred, Effect, Exit, Option, SynchronizedRef } from "effect";
import { formatUnknownError } from "./error-guards.ts";
import { BrowserError } from "./errors.ts";

const DEFAULT_MAX_CONTEXTS = 2;
const DEFAULT_MAX_PAGES = 2;
const DEFAULT_MAX_QUEUE = 8;

export type PlaywrightResponse = {
  readonly status: () => number;
  readonly allHeaders: () => Promise<Record<string, string>>;
};

export type PlaywrightPage = {
  readonly goto: (
    url: string,
    options: {
      readonly waitUntil: "load" | "domcontentloaded" | "networkidle" | "commit";
      readonly timeout: number;
    },
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

export type PlaywrightModule = {
  readonly chromium: {
    readonly launch: (options: { readonly headless: boolean }) => Promise<PlaywrightBrowser>;
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

type BrowserPoolState = BrowserPoolSnapshot & {
  readonly waiters: ReadonlyArray<BrowserPoolWaiter>;
};

type BrowserPoolConfig = BrowserPoolLimits & {
  readonly loadPlaywright: () => Effect.Effect<PlaywrightModule, BrowserError>;
};

type BrowserSlotAcquisition = {
  readonly queuePosition?: number;
  readonly waitedMs: number;
};

type BrowserPoolRuntime = {
  readonly config: BrowserPoolConfig;
  readonly browserRef: SynchronizedRef.SynchronizedRef<Option.Option<PlaywrightBrowser>>;
  readonly stateRef: SynchronizedRef.SynchronizedRef<BrowserPoolState>;
};

export type BrowserPoolTestConfig = {
  readonly maxContexts?: number;
  readonly maxPages?: number;
  readonly maxQueue?: number;
  readonly loadPlaywright?: () => Effect.Effect<PlaywrightModule, BrowserError>;
};

function isPlaywrightModule(module: unknown): module is PlaywrightModule {
  if (typeof module !== "object" || module === null) {
    return false;
  }

  const chromium = Reflect.get(module, "chromium");
  if (typeof chromium !== "object" || chromium === null) {
    return false;
  }

  return typeof Reflect.get(chromium, "launch") === "function";
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

function initialBrowserPoolState(limits: BrowserPoolLimits): BrowserPoolState {
  return {
    limits,
    activeContexts: 0,
    activePages: 0,
    queuedRequests: 0,
    maxObservedActiveContexts: 0,
    maxObservedActivePages: 0,
    maxObservedQueuedRequests: 0,
    waiters: [],
  };
}

function resolveBrowserPoolConfig(): BrowserPoolConfig {
  return {
    maxContexts: browserPoolTestConfig?.maxContexts ?? DEFAULT_MAX_CONTEXTS,
    maxPages: browserPoolTestConfig?.maxPages ?? DEFAULT_MAX_PAGES,
    maxQueue: browserPoolTestConfig?.maxQueue ?? DEFAULT_MAX_QUEUE,
    loadPlaywright: browserPoolTestConfig?.loadPlaywright ?? loadPlaywright,
  };
}

export function readBrowserPoolLimits(): BrowserPoolLimitsSnapshot {
  const config = resolveBrowserPoolConfig();

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
    stateRef: SynchronizedRef.makeUnsafe(
      initialBrowserPoolState({
        maxContexts: config.maxContexts,
        maxPages: config.maxPages,
        maxQueue: config.maxQueue,
      }),
    ),
  };
}

let browserPoolRuntime: BrowserPoolRuntime | undefined;
let browserPoolTestConfig: BrowserPoolTestConfig | undefined;

function getBrowserPoolRuntime(): BrowserPoolRuntime {
  browserPoolRuntime ??= makeBrowserPoolRuntime(resolveBrowserPoolConfig());
  return browserPoolRuntime;
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

function closeQuietly(closeable: { readonly close: () => Promise<void> }): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => closeable.close(),
    catch: () => "close-ignored",
  }).pipe(Effect.ignore);
}

function acquireBrowser(pool: BrowserPoolRuntime): Effect.Effect<PlaywrightBrowser, BrowserError> {
  return SynchronizedRef.modifyEffect(pool.browserRef, (currentBrowser) =>
    Option.match(currentBrowser, {
      onNone: () =>
        pool.config.loadPlaywright().pipe(
          Effect.flatMap((playwright) =>
            Effect.tryPromise({
              try: () => playwright.chromium.launch({ headless: true }),
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
  return SynchronizedRef.modify(pool.stateRef, (state) => {
    if (state.waiters.length >= state.limits.maxQueue) {
      return [Option.none<number>(), state] as const;
    }

    const waiters = [...state.waiters, waiter];
    const queuedRequests = waiters.length;

    return [
      Option.some(waiters.length),
      {
        ...state,
        waiters,
        queuedRequests,
        maxObservedQueuedRequests: Math.max(state.maxObservedQueuedRequests, queuedRequests),
      },
    ] as const;
  }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new BrowserError({
              message: "Browser pool queue is full",
              details: `Queue limit ${pool.config.maxQueue} was reached while waiting for a browser context/page slot`,
            }),
          ),
        onSome: Effect.succeed,
      }),
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

function grantBrowserSlots(
  state: BrowserPoolState,
): readonly [ReadonlyArray<BrowserPoolWaiter>, BrowserPoolState] {
  let nextState = state;
  const granted: BrowserPoolWaiter[] = [];

  while (
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
        const canAcquireImmediately =
          state.waiters.length === 0 &&
          state.activeContexts < state.limits.maxContexts &&
          state.activePages < state.limits.maxPages;

        if (!canAcquireImmediately) {
          return [false, state] as const;
        }

        const activeContexts = state.activeContexts + 1;
        const activePages = state.activePages + 1;

        return [
          true,
          {
            ...state,
            activeContexts,
            activePages,
            maxObservedActiveContexts: Math.max(state.maxObservedActiveContexts, activeContexts),
            maxObservedActivePages: Math.max(state.maxObservedActivePages, activePages),
          },
        ] as const;
      });

      if (immediate) {
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

function createContext(
  pool: BrowserPoolRuntime,
  userAgent: string,
): Effect.Effect<PlaywrightBrowserContext, BrowserError> {
  return acquireBrowser(pool).pipe(
    Effect.flatMap((browser) =>
      Effect.tryPromise({
        try: () => browser.newContext({ userAgent }),
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
  context: PlaywrightBrowserContext,
): Effect.Effect<PlaywrightPage, BrowserError> {
  return Effect.tryPromise({
    try: () => context.newPage(),
    catch: (error) =>
      new BrowserError({
        message: "Browser pool failed to allocate a browsing page",
        details: formatUnknownError(error),
      }),
  });
}

function releaseContext(context: PlaywrightBrowserContext): Effect.Effect<void> {
  return closeQuietly(context);
}

function releasePage(page: PlaywrightPage): Effect.Effect<void> {
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

export function withPooledBrowserPage<A, E>(
  options: {
    readonly userAgent: string;
  },
  use: (page: PlaywrightPage) => Effect.Effect<A, E>,
): Effect.Effect<
  {
    readonly value: A;
    readonly warnings: ReadonlyArray<string>;
  },
  BrowserError | E
> {
  return Effect.gen(function* () {
    const pool = getBrowserPoolRuntime();

    return yield* Effect.acquireUseRelease(
      acquireBrowserSlot(pool),
      (acquisition) =>
        Effect.acquireUseRelease(
          createContext(pool, options.userAgent),
          (context) =>
            Effect.acquireUseRelease(
              createPage(context),
              (page) =>
                use(page).pipe(
                  Effect.map((value) => {
                    const queueWarning = formatQueueWarning(acquisition, pool.config);
                    return {
                      value,
                      warnings: queueWarning ? [queueWarning] : [],
                    } as const;
                  }),
                ),
              (page) => releasePage(page),
            ),
          (context) => releaseContext(context),
        ),
      () => releaseBrowserSlot(pool),
    );
  });
}

function closeSharedBrowser(pool: BrowserPoolRuntime): Effect.Effect<void> {
  return SynchronizedRef.modifyEffect(pool.browserRef, (currentBrowser) =>
    Option.match(currentBrowser, {
      onNone: () => Effect.succeed([undefined, Option.none()] as const),
      onSome: (browser) =>
        closeQuietly(browser).pipe(Effect.as([undefined, Option.none()] as const)),
    }),
  ).pipe(Effect.asVoid);
}

export function getBrowserPoolSnapshot(): Effect.Effect<BrowserPoolSnapshot> {
  if (!browserPoolRuntime) {
    return Effect.succeed(
      projectSnapshot(
        initialBrowserPoolState({
          maxContexts: resolveBrowserPoolConfig().maxContexts,
          maxPages: resolveBrowserPoolConfig().maxPages,
          maxQueue: resolveBrowserPoolConfig().maxQueue,
        }),
      ),
    );
  }

  return SynchronizedRef.get(browserPoolRuntime.stateRef).pipe(Effect.map(projectSnapshot));
}

export function setBrowserPoolTestConfig(config: BrowserPoolTestConfig): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (browserPoolRuntime) {
      yield* closeSharedBrowser(browserPoolRuntime);
      browserPoolRuntime = undefined;
    }
    browserPoolTestConfig = config;
  });
}

export function resetBrowserPoolForTests(): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (browserPoolRuntime) {
      yield* closeSharedBrowser(browserPoolRuntime);
    }
    browserPoolRuntime = undefined;
    browserPoolTestConfig = undefined;
  });
}
