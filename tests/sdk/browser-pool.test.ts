import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Fiber } from "effect";
import {
  type BrowserPoolSnapshot,
  getBrowserPoolSnapshot,
  resetBrowserPoolForTests,
  setBrowserPoolTestConfig,
  type PlaywrightModule,
  type PlaywrightResponse,
  withPooledBrowserPage,
} from "../../src/sdk/browser-pool.ts";
import { FetchService, type FetchClient, accessPreview } from "../../src/sdk/scraper.ts";

const unusedFetch: FetchClient = async (_input, _init) =>
  new Response("<html><head><title>unused</title></head><body></body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

type BrowserHarness = {
  readonly launches: { current: number };
  readonly browserCloses: { current: number };
  readonly openContexts: { current: number };
  readonly openPages: { current: number };
  readonly maxOpenContexts: { current: number };
  readonly maxOpenPages: { current: number };
  readonly contextCloses: { current: number };
  readonly pageCloses: { current: number };
  readonly firstPageEntered: PromiseGate;
  readonly releaseFirstPage: PromiseGate;
  readonly pageControls: ReadonlyMap<number, PageControl>;
  readonly playwright: PlaywrightModule;
};

type PromiseGate = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

type PageControl = {
  readonly entered: PromiseGate;
  readonly release: PromiseGate;
};

type BrowserHarnessOptions = {
  readonly blockFirstPage?: boolean;
  readonly blockedPageIds?: ReadonlyArray<number>;
  readonly failContextAttempts?: ReadonlyArray<number>;
  readonly failPageAttempts?: ReadonlyArray<number>;
};

function makePromiseGate(): PromiseGate {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });

  return {
    promise,
    resolve,
  };
}

function makePageControl(): PageControl {
  return {
    entered: makePromiseGate(),
    release: makePromiseGate(),
  };
}

function makeBrowserHarness(options?: BrowserHarnessOptions): Effect.Effect<BrowserHarness> {
  return Effect.sync(() => {
    const blockFirstPage = options?.blockFirstPage ?? true;
    const blockedPageIds = new Set(options?.blockedPageIds ?? (blockFirstPage ? [1] : []));
    const failContextAttempts = new Set(options?.failContextAttempts ?? []);
    const failPageAttempts = new Set(options?.failPageAttempts ?? []);
    const launches = { current: 0 };
    const browserCloses = { current: 0 };
    const openContexts = { current: 0 };
    const openPages = { current: 0 };
    const maxOpenContexts = { current: 0 };
    const maxOpenPages = { current: 0 };
    const contextCloses = { current: 0 };
    const pageCloses = { current: 0 };
    const firstPageEntered = makePromiseGate();
    const releaseFirstPage = makePromiseGate();
    const pageControls = new Map<number, PageControl>();
    if (blockedPageIds.has(1)) {
      pageControls.set(1, {
        entered: firstPageEntered,
        release: releaseFirstPage,
      });
    }
    for (const blockedPageId of blockedPageIds) {
      if (blockedPageId !== 1) {
        pageControls.set(blockedPageId, makePageControl());
      }
    }
    let contextSequence = 0;
    let pageSequence = 0;

    const makeResponse = (): PlaywrightResponse => ({
      status: () => 200,
      allHeaders: async () => ({
        "content-type": "text/html; charset=utf-8",
      }),
    });

    const playwright: PlaywrightModule = {
      chromium: {
        launch: async () => {
          launches.current += 1;

          return {
            newContext: async () => {
              contextSequence += 1;
              if (failContextAttempts.has(contextSequence)) {
                throw new Error(`context-${contextSequence}-failed`);
              }

              openContexts.current += 1;
              maxOpenContexts.current = Math.max(maxOpenContexts.current, openContexts.current);

              return {
                newPage: async () => {
                  pageSequence += 1;
                  const pageId = pageSequence;
                  if (failPageAttempts.has(pageId)) {
                    throw new Error(`page-${pageId}-failed`);
                  }

                  openPages.current += 1;
                  maxOpenPages.current = Math.max(maxOpenPages.current, openPages.current);

                  return {
                    goto: async () => makeResponse(),
                    content: async () => {
                      const pageControl = pageControls.get(pageId);
                      if (pageControl) {
                        pageControl.entered.resolve();
                        await pageControl.release.promise;
                      }

                      return `<html><head><title>queued-${pageId}</title></head><body><h1>queued-${pageId}</h1></body></html>`;
                    },
                    url: () => `https://example.com/browser/${pageId}`,
                    waitForLoadState: async () => undefined,
                    route: async () => undefined,
                    close: async () => {
                      pageCloses.current += 1;
                      openPages.current -= 1;
                    },
                  };
                },
                close: async () => {
                  contextCloses.current += 1;
                  openContexts.current -= 1;
                },
              };
            },
            close: async () => {
              browserCloses.current += 1;
            },
          };
        },
      },
    };

    return {
      launches,
      browserCloses,
      openContexts,
      openPages,
      maxOpenContexts,
      maxOpenPages,
      contextCloses,
      pageCloses,
      firstPageEntered,
      releaseFirstPage,
      pageControls,
      playwright,
    };
  });
}

function waitForSnapshot(
  description: string,
  predicate: (snapshot: BrowserPoolSnapshot) => boolean,
) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const snapshot = yield* getBrowserPoolSnapshot();
      if (predicate(snapshot)) {
        return snapshot;
      }
      yield* Effect.sleep("5 millis");
    }

    return yield* Effect.die(new Error(`Timed out waiting for ${description}`));
  });
}

function waitForQueuedRequests(count: number) {
  return waitForSnapshot(
    `queuedRequests=${count}`,
    (snapshot) => snapshot.queuedRequests === count,
  );
}

function waitForPromiseGate(gate: PromiseGate) {
  return Effect.tryPromise({
    try: () => gate.promise,
    catch: (error) => new Error(String(error)),
  });
}

function getPageControl(harness: BrowserHarness, pageId: number): PageControl {
  const pageControl = harness.pageControls.get(pageId);
  if (!pageControl) {
    throw new Error(`Missing control for page ${pageId}`);
  }
  return pageControl;
}

function usePooledBrowserPage() {
  return withPooledBrowserPage(
    {
      userAgent: "browser-pool-test",
    },
    (page) =>
      Effect.tryPromise({
        try: () => page.content(),
        catch: (error) => new Error(String(error)),
      }),
  );
}

describe("sdk browser pool", () => {
  it.effect("bounds browser concurrency and exposes queue backpressure warnings", () =>
    Effect.ensuring(
      Effect.gen(function* () {
        const harness = yield* makeBrowserHarness();

        yield* setBrowserPoolTestConfig({
          maxContexts: 1,
          maxPages: 1,
          maxQueue: 1,
          loadPlaywright: () => Effect.succeed(harness.playwright),
        });

        const firstFiber = yield* accessPreview({
          url: "https://example.com/first",
          mode: "browser",
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: unusedFetch,
          }),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* waitForPromiseGate(harness.firstPageEntered);

        const secondFiber = yield* accessPreview({
          url: "https://example.com/second",
          mode: "browser",
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: unusedFetch,
          }),
          Effect.forkChild({ startImmediately: true }),
        );

        const snapshotWhileQueued = yield* waitForQueuedRequests(1);

        expect(snapshotWhileQueued.activeContexts).toBe(1);
        expect(snapshotWhileQueued.activePages).toBe(1);
        expect(snapshotWhileQueued.queuedRequests).toBe(1);
        expect(snapshotWhileQueued.maxObservedQueuedRequests).toBe(1);

        const overflowDetails = yield* accessPreview({
          url: "https://example.com/third",
          mode: "browser",
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: unusedFetch,
          }),
          Effect.flatMap(() => Effect.die(new Error("Expected BrowserError"))),
          Effect.catchTag("BrowserError", ({ message, details }) =>
            Effect.succeed(`${message}: ${details ?? ""}`),
          ),
        );

        expect(overflowDetails).toContain("Browser access failed for https://example.com/third");
        expect(overflowDetails).toContain("Queue limit 1");

        harness.releaseFirstPage.resolve();

        const firstResult = yield* Fiber.join(firstFiber);
        const secondResult = yield* Fiber.join(secondFiber);

        expect(firstResult.warnings).toEqual([]);
        expect(secondResult.warnings).toHaveLength(1);
        expect(secondResult.warnings[0]).toContain("Browser pool backpressure");
        expect(secondResult.warnings[0]).toContain("queue position 1");

        expect(harness.launches.current).toBe(1);
        expect(harness.maxOpenContexts.current).toBe(1);
        expect(harness.maxOpenPages.current).toBe(1);
        expect(harness.openContexts.current).toBe(0);
        expect(harness.openPages.current).toBe(0);
        expect(harness.contextCloses.current).toBe(2);
        expect(harness.pageCloses.current).toBe(2);

        const finalSnapshot = yield* getBrowserPoolSnapshot();

        expect(finalSnapshot.activeContexts).toBe(0);
        expect(finalSnapshot.activePages).toBe(0);
        expect(finalSnapshot.queuedRequests).toBe(0);
      }),
      resetBrowserPoolForTests(),
    ),
  );

  it.effect("transitions queued work into the next active slot deterministically", () =>
    Effect.ensuring(
      Effect.gen(function* () {
        const harness = yield* makeBrowserHarness({
          blockedPageIds: [1, 2],
        });

        yield* setBrowserPoolTestConfig({
          maxContexts: 1,
          maxPages: 1,
          maxQueue: 1,
          loadPlaywright: () => Effect.succeed(harness.playwright),
        });

        const secondPage = getPageControl(harness, 2);
        const firstFiber = yield* usePooledBrowserPage().pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* waitForPromiseGate(harness.firstPageEntered);

        const secondFiber = yield* usePooledBrowserPage().pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        const snapshotWhileQueued = yield* waitForQueuedRequests(1);
        expect(snapshotWhileQueued.activeContexts).toBe(1);
        expect(snapshotWhileQueued.activePages).toBe(1);
        expect(snapshotWhileQueued.queuedRequests).toBe(1);

        harness.releaseFirstPage.resolve();

        yield* waitForPromiseGate(secondPage.entered);

        const snapshotAfterGrant = yield* waitForSnapshot(
          "queuedRequests=0 with one active slot",
          (snapshot) =>
            snapshot.activeContexts === 1 &&
            snapshot.activePages === 1 &&
            snapshot.queuedRequests === 0,
        );

        expect(snapshotAfterGrant.maxObservedQueuedRequests).toBe(1);

        secondPage.release.resolve();

        const firstResult = yield* Fiber.join(firstFiber);
        const secondResult = yield* Fiber.join(secondFiber);

        expect(firstResult.value).toContain("queued-1");
        expect(firstResult.warnings).toEqual([]);
        expect(secondResult.value).toContain("queued-2");
        expect(secondResult.warnings).toHaveLength(1);
        expect(secondResult.warnings[0]).toContain("queue position 1");

        const finalSnapshot = yield* getBrowserPoolSnapshot();
        expect(finalSnapshot.activeContexts).toBe(0);
        expect(finalSnapshot.activePages).toBe(0);
        expect(finalSnapshot.queuedRequests).toBe(0);
      }),
      resetBrowserPoolForTests(),
    ),
  );

  it.effect("releases the reserved slot when context allocation fails", () =>
    Effect.ensuring(
      Effect.gen(function* () {
        const harness = yield* makeBrowserHarness({
          blockFirstPage: false,
          failContextAttempts: [1],
        });

        yield* setBrowserPoolTestConfig({
          maxContexts: 1,
          maxPages: 1,
          maxQueue: 1,
          loadPlaywright: () => Effect.succeed(harness.playwright),
        });

        const failureDetails = yield* usePooledBrowserPage().pipe(
          Effect.flatMap(() => Effect.die(new Error("Expected BrowserError"))),
          Effect.catchTag("BrowserError", ({ message, details }) =>
            Effect.succeed(`${message}: ${details ?? ""}`),
          ),
        );

        expect(failureDetails).toContain("Browser pool failed to allocate a browsing context");
        expect(failureDetails).toContain("context-1-failed");
        expect(harness.launches.current).toBe(1);
        expect(harness.openContexts.current).toBe(0);
        expect(harness.openPages.current).toBe(0);
        expect(harness.contextCloses.current).toBe(0);
        expect(harness.pageCloses.current).toBe(0);

        const finalSnapshot = yield* getBrowserPoolSnapshot();
        expect(finalSnapshot.activeContexts).toBe(0);
        expect(finalSnapshot.activePages).toBe(0);
        expect(finalSnapshot.queuedRequests).toBe(0);
      }),
      resetBrowserPoolForTests(),
    ),
  );

  it.effect("releases the reserved slot and context when page allocation fails", () =>
    Effect.ensuring(
      Effect.gen(function* () {
        const harness = yield* makeBrowserHarness({
          blockFirstPage: false,
          failPageAttempts: [1],
        });

        yield* setBrowserPoolTestConfig({
          maxContexts: 1,
          maxPages: 1,
          maxQueue: 1,
          loadPlaywright: () => Effect.succeed(harness.playwright),
        });

        const failureDetails = yield* usePooledBrowserPage().pipe(
          Effect.flatMap(() => Effect.die(new Error("Expected BrowserError"))),
          Effect.catchTag("BrowserError", ({ message, details }) =>
            Effect.succeed(`${message}: ${details ?? ""}`),
          ),
        );

        expect(failureDetails).toContain("Browser pool failed to allocate a browsing page");
        expect(failureDetails).toContain("page-1-failed");
        expect(harness.launches.current).toBe(1);
        expect(harness.maxOpenContexts.current).toBe(1);
        expect(harness.maxOpenPages.current).toBe(0);
        expect(harness.openContexts.current).toBe(0);
        expect(harness.openPages.current).toBe(0);
        expect(harness.contextCloses.current).toBe(1);
        expect(harness.pageCloses.current).toBe(0);

        const finalSnapshot = yield* getBrowserPoolSnapshot();
        expect(finalSnapshot.activeContexts).toBe(0);
        expect(finalSnapshot.activePages).toBe(0);
        expect(finalSnapshot.queuedRequests).toBe(0);
      }),
      resetBrowserPoolForTests(),
    ),
  );

  it.effect("resets pool diagnostics and shared browser between test runs", () =>
    Effect.ensuring(
      Effect.gen(function* () {
        const harness = yield* makeBrowserHarness({ blockFirstPage: false });

        yield* setBrowserPoolTestConfig({
          maxContexts: 1,
          maxPages: 1,
          maxQueue: 1,
          loadPlaywright: () => Effect.succeed(harness.playwright),
        });

        const snapshotBeforeUse = yield* getBrowserPoolSnapshot();
        expect(snapshotBeforeUse.maxObservedQueuedRequests).toBe(0);

        const preview = yield* accessPreview({
          url: "https://example.com/fourth",
          mode: "browser",
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: unusedFetch,
          }),
        );

        expect(preview.warnings).toEqual([]);
        expect(harness.launches.current).toBe(1);

        yield* resetBrowserPoolForTests();

        const snapshotAfterReset = yield* getBrowserPoolSnapshot();
        expect(snapshotAfterReset.activeContexts).toBe(0);
        expect(snapshotAfterReset.activePages).toBe(0);
        expect(snapshotAfterReset.maxObservedQueuedRequests).toBe(0);
        expect(harness.browserCloses.current).toBe(1);
      }),
      resetBrowserPoolForTests(),
    ),
  );
});
