import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Fiber } from "effect";
import {
  type BrowserPoolSnapshot,
  getBrowserPoolSnapshot,
  resetBrowserPoolForTests,
  setBrowserPoolTestConfig,
  type PatchrightModule,
  type PatchrightResponse,
  withPooledBrowserPage,
} from "../../src/sdk/browser-pool.ts";
import { resetAccessBrokerStateForTests } from "../../src/sdk/access-broker-runtime.ts";
import { resetAccessHealthGatewayForTests } from "../../src/sdk/access-health-gateway.ts";
import { BrowserError } from "../../src/sdk/errors.ts";
import { provideSdkRuntime } from "../../src/sdk/runtime-layer.ts";
import { FetchService, type FetchClient, accessPreview } from "../../src/sdk/scraper.ts";

const unusedFetch: FetchClient = async (_input, _init) =>
  new Response("<html><head><title>unused</title></head><body></body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

type BrowserHarness = {
  readonly launches: { current: number };
  readonly launchOptions: {
    current: ReadonlyArray<{
      readonly headless: boolean;
      readonly proxy?:
        | {
            readonly server: string;
            readonly bypass?: string | undefined;
            readonly username?: string | undefined;
            readonly password?: string | undefined;
          }
        | undefined;
    }>;
  };
  readonly browserCloses: { current: number };
  readonly openContexts: { current: number };
  readonly openPages: { current: number };
  readonly maxOpenContexts: { current: number };
  readonly maxOpenPages: { current: number };
  readonly contextCloses: { current: number };
  readonly pageCloses: { current: number };
  readonly contextOptions: {
    current: ReadonlyArray<{
      readonly userAgent: string;
      readonly locale?: string;
      readonly timezoneId?: string;
    }>;
  };
  readonly concurrentPageAllocationAttempts: { current: number };
  readonly firstPageAllocationEntered: PromiseGate;
  readonly releaseFirstPageAllocation: PromiseGate;
  readonly firstPageEntered: PromiseGate;
  readonly releaseFirstPage: PromiseGate;
  readonly pageControls: ReadonlyMap<number, PageControl>;
  readonly patchright: PatchrightModule;
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
  readonly failOverlappingPageAllocations?: boolean;
  readonly holdFirstPageAllocation?: boolean;
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
    const failOverlappingPageAllocations = options?.failOverlappingPageAllocations ?? false;
    const holdFirstPageAllocation = options?.holdFirstPageAllocation ?? false;
    const launches = { current: 0 };
    const launchOptions = {
      current: [] as ReadonlyArray<{
        readonly headless: boolean;
        readonly proxy?:
          | {
              readonly server: string;
              readonly bypass?: string | undefined;
              readonly username?: string | undefined;
              readonly password?: string | undefined;
            }
          | undefined;
      }>,
    };
    const browserCloses = { current: 0 };
    const openContexts = { current: 0 };
    const openPages = { current: 0 };
    const maxOpenContexts = { current: 0 };
    const maxOpenPages = { current: 0 };
    const contextCloses = { current: 0 };
    const pageCloses = { current: 0 };
    const contextOptions = {
      current: [] as ReadonlyArray<{
        readonly userAgent: string;
        readonly locale?: string;
        readonly timezoneId?: string;
      }>,
    };
    const concurrentPageAllocationAttempts = { current: 0 };
    const firstPageAllocationEntered = makePromiseGate();
    const releaseFirstPageAllocation = makePromiseGate();
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
    let inFlightPageAllocations = 0;

    const makeResponse = (): PatchrightResponse => ({
      status: () => 200,
      allHeaders: async () => ({
        "content-type": "text/html; charset=utf-8",
      }),
    });

    const patchright: PatchrightModule = {
      chromium: {
        launch: async (options) => {
          launches.current += 1;
          launchOptions.current = [...launchOptions.current, options];

          return {
            newContext: async (options) => {
              contextSequence += 1;
              if (failContextAttempts.has(contextSequence)) {
                throw new Error(`context-${contextSequence}-failed`);
              }

              contextOptions.current = [...contextOptions.current, options];

              openContexts.current += 1;
              maxOpenContexts.current = Math.max(maxOpenContexts.current, openContexts.current);

              return {
                newPage: async () => {
                  pageSequence += 1;
                  const pageId = pageSequence;
                  const shouldHoldAllocation = holdFirstPageAllocation && pageId === 1;
                  if (shouldHoldAllocation) {
                    firstPageAllocationEntered.resolve();
                  }
                  if (failOverlappingPageAllocations && inFlightPageAllocations > 0) {
                    concurrentPageAllocationAttempts.current += 1;
                    throw new Error("page-allocation-overlap");
                  }
                  inFlightPageAllocations += 1;

                  try {
                    if (shouldHoldAllocation) {
                      await releaseFirstPageAllocation.promise;
                    }
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
                  } finally {
                    inFlightPageAllocations -= 1;
                  }
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
      launchOptions,
      browserCloses,
      openContexts,
      openPages,
      maxOpenContexts,
      maxOpenPages,
      contextCloses,
      pageCloses,
      contextOptions,
      concurrentPageAllocationAttempts,
      firstPageAllocationEntered,
      releaseFirstPageAllocation,
      firstPageEntered,
      releaseFirstPage,
      pageControls,
      patchright,
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
      runtimeProfileId: "patchright-default",
      userAgent: "browser-pool-test",
    },
    (page) =>
      Effect.tryPromise({
        try: () => page.content(),
        catch: (error) =>
          new BrowserError({
            message: "Browser pool test page read failed",
            details: String(error),
          }),
      }),
  );
}

function usePooledBrowserPageWithProxy() {
  return withPooledBrowserPage(
    {
      runtimeProfileId: "patchright-default",
      poolKey: "browser-basic::proxy-route::identity-a",
      userAgent: "browser-pool-test",
      proxy: {
        server: "http://proxy.example.test:8080",
        username: "alice",
        password: "secret",
        bypass: "localhost,127.0.0.1",
      },
    },
    (page) =>
      Effect.tryPromise({
        try: () => page.content(),
        catch: (error) =>
          new BrowserError({
            message: "Browser pool test page read failed",
            details: String(error),
          }),
      }),
  );
}

describe("sdk browser pool", () => {
  it.effect("uses browser pool defaults sized for the fast benchmark preset", () =>
    Effect.ensuring(
      Effect.gen(function* () {
        yield* resetAccessHealthGatewayForTests();
        yield* resetAccessBrokerStateForTests();
        yield* resetBrowserPoolForTests();

        const snapshot = yield* getBrowserPoolSnapshot();

        expect(snapshot.limits).toEqual({
          maxContexts: 4,
          maxPages: 4,
          maxQueue: 16,
        });
      }),
      Effect.all(
        [
          resetBrowserPoolForTests(),
          resetAccessHealthGatewayForTests(),
          resetAccessBrokerStateForTests(),
        ],
        { concurrency: "unbounded", discard: true },
      ),
    ),
  );

  it.effect(
    "launches a dedicated browser with proxy settings when the pool request carries one",
    () =>
      Effect.ensuring(
        Effect.gen(function* () {
          const harness = yield* makeBrowserHarness({ blockFirstPage: false });

          yield* setBrowserPoolTestConfig({
            maxContexts: 1,
            maxPages: 1,
            maxQueue: 1,
            loadPatchright: () => Effect.succeed(harness.patchright),
          });

          const result = yield* usePooledBrowserPageWithProxy();

          expect(result.value).toContain("queued-1");
          expect(harness.launches.current).toBe(1);
          expect(harness.launchOptions.current).toEqual([
            {
              headless: true,
              proxy: {
                server: "http://proxy.example.test:8080",
                username: "alice",
                password: "secret",
                bypass: "localhost,127.0.0.1",
              },
            },
          ]);
        }),
        resetBrowserPoolForTests(),
      ),
  );

  it.effect("isolates browser runtimes when the proxy route changes under the same pool key", () =>
    Effect.ensuring(
      Effect.gen(function* () {
        const harness = yield* makeBrowserHarness({ blockFirstPage: false });

        yield* setBrowserPoolTestConfig({
          maxContexts: 1,
          maxPages: 1,
          maxQueue: 1,
          loadPatchright: () => Effect.succeed(harness.patchright),
        });

        yield* withPooledBrowserPage(
          {
            poolKey: "browser-basic::shared::persona-a",
            runtimeProfileId: "patchright-default",
            userAgent: "Agent A",
            proxy: {
              server: "http://proxy-a.example.test:8080",
              username: "alice",
              password: "secret-a",
            },
          },
          (page) =>
            Effect.tryPromise({
              try: () => page.content(),
              catch: (error) =>
                new BrowserError({
                  message: "Browser pool test page read failed",
                  details: String(error),
                }),
            }),
        );

        yield* withPooledBrowserPage(
          {
            poolKey: "browser-basic::shared::persona-a",
            runtimeProfileId: "patchright-default",
            userAgent: "Agent A",
            proxy: {
              server: "http://proxy-b.example.test:8080",
              username: "bob",
              password: "secret-b",
            },
          },
          (page) =>
            Effect.tryPromise({
              try: () => page.content(),
              catch: (error) =>
                new BrowserError({
                  message: "Browser pool test page read failed",
                  details: String(error),
                }),
            }),
        );

        expect(harness.launches.current).toBe(2);
        expect(harness.launchOptions.current).toEqual([
          {
            headless: true,
            proxy: {
              server: "http://proxy-a.example.test:8080",
              username: "alice",
              password: "secret-a",
            },
          },
          {
            headless: true,
            proxy: {
              server: "http://proxy-b.example.test:8080",
              username: "bob",
              password: "secret-b",
            },
          },
        ]);
      }),
      resetBrowserPoolForTests(),
    ),
  );

  it.effect("bounds browser concurrency and exposes queue backpressure warnings", () =>
    Effect.ensuring(
      Effect.gen(function* () {
        yield* resetAccessHealthGatewayForTests();
        yield* resetAccessBrokerStateForTests();
        const harness = yield* makeBrowserHarness();

        yield* setBrowserPoolTestConfig({
          maxContexts: 1,
          maxPages: 1,
          maxQueue: 1,
          loadPatchright: () => Effect.succeed(harness.patchright),
        });

        const firstFiber = yield* accessPreview({
          url: "https://example.com/first",
          execution: {
            mode: "browser",
            providerId: "browser-basic",
          },
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: unusedFetch,
          }),
          provideSdkRuntime,
          Effect.forkChild({ startImmediately: true }),
        );

        yield* waitForPromiseGate(harness.firstPageEntered);

        const secondFiber = yield* accessPreview({
          url: "https://example.com/second",
          execution: {
            mode: "browser",
            providerId: "browser-basic",
          },
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: unusedFetch,
          }),
          provideSdkRuntime,
          Effect.forkChild({ startImmediately: true }),
        );

        const snapshotWhileQueued = yield* waitForQueuedRequests(1);

        expect(snapshotWhileQueued.activeContexts).toBe(1);
        expect(snapshotWhileQueued.activePages).toBe(1);
        expect(snapshotWhileQueued.queuedRequests).toBe(1);
        expect(snapshotWhileQueued.maxObservedQueuedRequests).toBe(1);

        const overflowDetails = yield* accessPreview({
          url: "https://example.com/third",
          execution: {
            mode: "browser",
            providerId: "browser-basic",
          },
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: unusedFetch,
          }),
          provideSdkRuntime,
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
      Effect.all(
        [
          resetBrowserPoolForTests(),
          resetAccessHealthGatewayForTests(),
          resetAccessBrokerStateForTests(),
        ],
        { discard: true },
      ),
    ),
  );

  it.effect("fails queued work deterministically when the pool is reset mid-flight", () =>
    Effect.ensuring(
      Effect.gen(function* () {
        const harness = yield* makeBrowserHarness({
          blockedPageIds: [1],
        });

        yield* setBrowserPoolTestConfig({
          maxContexts: 1,
          maxPages: 1,
          maxQueue: 1,
          loadPatchright: () => Effect.succeed(harness.patchright),
        });

        const firstFiber = yield* usePooledBrowserPage().pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* waitForPromiseGate(harness.firstPageEntered);

        const secondFiber = yield* usePooledBrowserPage().pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: "Left" as const, left: error }),
            onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
          }),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* waitForQueuedRequests(1);

        yield* resetBrowserPoolForTests();
        harness.releaseFirstPage.resolve();

        const firstResult = yield* Fiber.join(firstFiber);
        const secondResult = yield* Fiber.join(secondFiber);

        expect(firstResult.value).toContain("queued-1");
        expect(secondResult._tag).toBe("Left");
        if (secondResult._tag === "Left") {
          expect(secondResult.left).toBeInstanceOf(BrowserError);
          expect(secondResult.left.message).toBe("Browser pool is closed");
        }
        expect(harness.launches.current).toBe(1);
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
          loadPatchright: () => Effect.succeed(harness.patchright),
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
          loadPatchright: () => Effect.succeed(harness.patchright),
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
          loadPatchright: () => Effect.succeed(harness.patchright),
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

  it.effect(
    "relaunches the shared browser and retries allocation after a retryable protocol error",
    () =>
      Effect.ensuring(
        Effect.gen(function* () {
          const launches = { current: 0 };
          const browserCloses = { current: 0 };
          const contextCloses = { current: 0 };
          const pageCloses = { current: 0 };

          yield* setBrowserPoolTestConfig({
            maxContexts: 1,
            maxPages: 1,
            maxQueue: 1,
            loadPatchright: () =>
              Effect.succeed({
                chromium: {
                  launch: async () => {
                    launches.current += 1;
                    const launchOrdinal = launches.current;

                    return {
                      newContext: async () => ({
                        newPage: async () => {
                          if (launchOrdinal === 1) {
                            throw new Error(
                              "Protocol error (Page.enable): Internal server error, session closed.",
                            );
                          }

                          return {
                            goto: async () => ({
                              status: () => 200,
                              allHeaders: async () => ({
                                "content-type": "text/html; charset=utf-8",
                              }),
                            }),
                            content: async () =>
                              "<html><head><title>retry-success</title></head><body>retry-success</body></html>",
                            url: () => "https://example.com/browser/retry-success",
                            waitForLoadState: async () => undefined,
                            route: async () => undefined,
                            close: async () => {
                              pageCloses.current += 1;
                            },
                          };
                        },
                        close: async () => {
                          contextCloses.current += 1;
                        },
                      }),
                      close: async () => {
                        browserCloses.current += 1;
                      },
                    };
                  },
                },
              }),
          });

          const result = yield* usePooledBrowserPage();

          expect(result.value).toContain("retry-success");
          expect(result.warnings).toContainEqual(
            expect.stringContaining("Recovered browser allocation after retryable protocol error:"),
          );
          expect(result.warnings.join(" ")).toContain("Protocol error (Page.enable)");
          expect(launches.current).toBe(2);
          expect(browserCloses.current).toBe(1);
          expect(contextCloses.current).toBe(2);
          expect(pageCloses.current).toBe(1);

          const finalSnapshot = yield* getBrowserPoolSnapshot();
          expect(finalSnapshot.activeContexts).toBe(0);
          expect(finalSnapshot.activePages).toBe(0);
          expect(finalSnapshot.queuedRequests).toBe(0);

          yield* resetBrowserPoolForTests();
          expect(browserCloses.current).toBe(2);
        }),
        resetBrowserPoolForTests(),
      ),
  );

  it.effect(
    "preserves recovered allocation warnings when page usage fails after a retryable protocol error",
    () =>
      Effect.ensuring(
        Effect.gen(function* () {
          let recovered = false;
          yield* setBrowserPoolTestConfig({
            maxContexts: 1,
            maxPages: 1,
            maxQueue: 1,
            loadPatchright: () =>
              Effect.succeed({
                chromium: {
                  launch: async () => {
                    return {
                      newContext: async () => ({
                        newPage: async () => {
                          if (!recovered) {
                            recovered = true;
                            throw new Error(
                              "Protocol error (Page.enable): Internal server error, session closed.",
                            );
                          }

                          return {
                            goto: async () => ({
                              status: () => 200,
                              allHeaders: async () => ({
                                "content-type": "text/html; charset=utf-8",
                              }),
                            }),
                            content: async () =>
                              "<html><head><title>unused</title></head><body>unused</body></html>",
                            url: () => "https://example.com/browser/recovered-then-fail",
                            waitForLoadState: async () => undefined,
                            route: async () => undefined,
                            close: async () => undefined,
                          };
                        },
                        close: async () => undefined,
                      }),
                      close: async () => undefined,
                    };
                  },
                },
              }),
          });

          const failure = yield* Effect.flip(
            withPooledBrowserPage(
              {
                runtimeProfileId: "test-browser",
                userAgent: "test-agent",
              },
              () =>
                Effect.fail(
                  new BrowserError({
                    message: "Browser access failed for https://example.com/fail",
                    details: "navigation: net::ERR_CONNECTION_RESET",
                  }),
                ),
            ),
          );

          expect(failure).toBeInstanceOf(BrowserError);
          expect(failure.warnings?.[0]).toContain(
            "Protocol error (Page.enable): Internal server error, session closed.",
          );
        }),
        resetBrowserPoolForTests(),
      ),
  );

  it.effect("serializes fragile page allocation across concurrent slots", () =>
    Effect.ensuring(
      Effect.gen(function* () {
        const launches = { current: 0 };
        const overlappingAllocationAttempts = { current: 0 };
        let pageSequence = 0;
        let inFlightPageAllocations = 0;

        yield* setBrowserPoolTestConfig({
          maxContexts: 2,
          maxPages: 2,
          maxQueue: 2,
          loadPatchright: () =>
            Effect.succeed({
              chromium: {
                launch: async () => {
                  launches.current += 1;

                  return {
                    newContext: async () => ({
                      newPage: async () => {
                        pageSequence += 1;
                        const pageId = pageSequence;

                        if (inFlightPageAllocations > 0) {
                          overlappingAllocationAttempts.current += 1;
                          throw new Error("page-allocation-overlap");
                        }

                        inFlightPageAllocations += 1;
                        try {
                          if (pageId === 1) {
                            await new Promise((resolve) => setTimeout(resolve, 50));
                          }

                          return {
                            goto: async () => ({
                              status: () => 200,
                              allHeaders: async () => ({
                                "content-type": "text/html; charset=utf-8",
                              }),
                            }),
                            content: async () =>
                              `<html><head><title>queued-${pageId}</title></head><body><h1>queued-${pageId}</h1></body></html>`,
                            url: () => `https://example.com/browser/${pageId}`,
                            waitForLoadState: async () => undefined,
                            route: async () => undefined,
                            close: async () => undefined,
                          };
                        } finally {
                          inFlightPageAllocations -= 1;
                        }
                      },
                      close: async () => undefined,
                    }),
                    close: async () => undefined,
                  };
                },
              },
            }),
        });

        const [firstResult, secondResult] = yield* Effect.raceFirst(
          Effect.all([usePooledBrowserPage(), usePooledBrowserPage()], {
            concurrency: "unbounded",
          }),
          Effect.sleep("500 millis").pipe(
            Effect.flatMap(() => getBrowserPoolSnapshot()),
            Effect.flatMap((snapshot) =>
              Effect.die(
                new Error(
                  `Timed out waiting for concurrent page allocation results: ${JSON.stringify({
                    overlappingAllocationAttempts: overlappingAllocationAttempts.current,
                    launches: launches.current,
                    snapshot,
                  })}`,
                ),
              ),
            ),
          ),
        );

        expect(overlappingAllocationAttempts.current).toBe(0);
        expect(firstResult.value).toContain("queued-1");
        expect(secondResult.value).toContain("queued-2");
        expect(launches.current).toBe(1);
      }),
      resetBrowserPoolForTests(),
    ),
  );

  it.effect(
    "relaunches allocation on a fresh browser without closing active pages on the previous browser",
    () =>
      Effect.ensuring(
        Effect.gen(function* () {
          const launches = { current: 0 };
          const browserCloses = { current: 0 };
          const firstPageEntered = makePromiseGate();
          const releaseFirstPage = makePromiseGate();
          const firstBrowserPageAttempts = { current: 0 };

          yield* setBrowserPoolTestConfig({
            maxContexts: 2,
            maxPages: 2,
            maxQueue: 2,
            loadPatchright: () =>
              Effect.succeed({
                chromium: {
                  launch: async () => {
                    launches.current += 1;
                    const launchOrdinal = launches.current;

                    return {
                      newContext: async () => ({
                        newPage: async () => {
                          if (launchOrdinal === 1) {
                            firstBrowserPageAttempts.current += 1;
                            if (firstBrowserPageAttempts.current === 1) {
                              return {
                                goto: async () => ({
                                  status: () => 200,
                                  allHeaders: async () => ({
                                    "content-type": "text/html; charset=utf-8",
                                  }),
                                }),
                                content: async () => {
                                  firstPageEntered.resolve();
                                  await releaseFirstPage.promise;
                                  return "<html><head><title>active-page</title></head><body>active-page</body></html>";
                                },
                                url: () => "https://example.com/browser/active-page",
                                waitForLoadState: async () => undefined,
                                route: async () => undefined,
                                close: async () => undefined,
                              };
                            }

                            throw new Error(
                              "Protocol error (Page.enable): Internal server error, session closed.",
                            );
                          }

                          return {
                            goto: async () => ({
                              status: () => 200,
                              allHeaders: async () => ({
                                "content-type": "text/html; charset=utf-8",
                              }),
                            }),
                            content: async () =>
                              "<html><head><title>retry-success</title></head><body>retry-success</body></html>",
                            url: () => "https://example.com/browser/retry-success",
                            waitForLoadState: async () => undefined,
                            route: async () => undefined,
                            close: async () => undefined,
                          };
                        },
                        close: async () => undefined,
                      }),
                      close: async () => {
                        browserCloses.current += 1;
                      },
                    };
                  },
                },
              }),
          });

          const firstFiber = yield* usePooledBrowserPage().pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* waitForPromiseGate(firstPageEntered);

          const secondResult = yield* usePooledBrowserPage();

          expect(secondResult.value).toContain("retry-success");
          expect(secondResult.warnings).toContainEqual(
            expect.stringContaining("Recovered browser allocation after retryable protocol error:"),
          );
          expect(secondResult.warnings.join(" ")).toContain("Protocol error (Page.enable)");
          expect(launches.current).toBe(2);
          expect(browserCloses.current).toBe(0);

          releaseFirstPage.resolve();
          const firstResult = yield* Fiber.join(firstFiber);

          expect(firstResult.value).toContain("active-page");
          expect(firstResult.warnings).toEqual([]);
          expect(browserCloses.current).toBe(1);
        }),
        resetBrowserPoolForTests(),
      ),
  );

  it.effect("resets pool diagnostics and shared browser between test runs", () =>
    Effect.ensuring(
      Effect.gen(function* () {
        yield* resetAccessHealthGatewayForTests();
        yield* resetAccessBrokerStateForTests();
        const harness = yield* makeBrowserHarness({ blockFirstPage: false });

        yield* setBrowserPoolTestConfig({
          maxContexts: 1,
          maxPages: 1,
          maxQueue: 1,
          loadPatchright: () => Effect.succeed(harness.patchright),
        });

        const snapshotBeforeUse = yield* getBrowserPoolSnapshot();
        expect(snapshotBeforeUse.maxObservedQueuedRequests).toBe(0);

        const preview = yield* accessPreview({
          url: "https://example.com/fourth",
          execution: {
            mode: "browser",
            providerId: "browser-basic",
          },
        }).pipe(
          Effect.provideService(FetchService, {
            fetch: unusedFetch,
          }),
          provideSdkRuntime,
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
      Effect.all(
        [
          resetBrowserPoolForTests(),
          resetAccessHealthGatewayForTests(),
          resetAccessBrokerStateForTests(),
        ],
        { discard: true },
      ),
    ),
  );

  it.effect("isolates browser runtimes by poolKey and preserves context overrides", () =>
    Effect.ensuring(
      Effect.gen(function* () {
        const harness = yield* makeBrowserHarness({ blockFirstPage: false });

        yield* setBrowserPoolTestConfig({
          maxContexts: 1,
          maxPages: 1,
          maxQueue: 1,
          loadPatchright: () => Effect.succeed(harness.patchright),
        });

        const first = yield* withPooledBrowserPage(
          {
            poolKey: "browser-basic::direct::persona-a",
            runtimeProfileId: "patchright-default",
            userAgent: "Agent A",
            locale: "cs-CZ",
            timezoneId: "Europe/Prague",
          },
          (page) =>
            Effect.tryPromise({
              try: () => page.content(),
              catch: (error) =>
                new BrowserError({
                  message: "Browser pool test page read failed",
                  details: String(error),
                }),
            }),
        );
        const second = yield* withPooledBrowserPage(
          {
            poolKey: "browser-basic::direct::persona-a",
            runtimeProfileId: "patchright-default",
            userAgent: "Agent B",
            locale: "en-US",
            timezoneId: "America/New_York",
          },
          (page) =>
            Effect.tryPromise({
              try: () => page.content(),
              catch: (error) =>
                new BrowserError({
                  message: "Browser pool test page read failed",
                  details: String(error),
                }),
            }),
        );
        const third = yield* withPooledBrowserPage(
          {
            poolKey: "browser-stealth::wireguard-prague::persona-b",
            runtimeProfileId: "patchright-stealth",
            userAgent: "Agent C",
            locale: "de-DE",
            timezoneId: "Europe/Berlin",
          },
          (page) =>
            Effect.tryPromise({
              try: () => page.content(),
              catch: (error) =>
                new BrowserError({
                  message: "Browser pool test page read failed",
                  details: String(error),
                }),
            }),
        );

        expect(first.value).toContain("queued-1");
        expect(second.value).toContain("queued-2");
        expect(third.value).toContain("queued-3");
        expect(harness.launches.current).toBe(2);
        expect(harness.contextOptions.current).toEqual([
          {
            userAgent: "Agent A",
            locale: "cs-CZ",
            timezoneId: "Europe/Prague",
          },
          {
            userAgent: "Agent B",
            locale: "en-US",
            timezoneId: "America/New_York",
          },
          {
            userAgent: "Agent C",
            locale: "de-DE",
            timezoneId: "Europe/Berlin",
          },
        ]);

        const snapshot = yield* getBrowserPoolSnapshot();
        expect(snapshot.limits).toEqual({
          maxContexts: 2,
          maxPages: 2,
          maxQueue: 2,
        });
      }),
      resetBrowserPoolForTests(),
    ),
  );

  it.effect("aggregates peak diagnostics across multiple pool keys", () =>
    Effect.ensuring(
      Effect.gen(function* () {
        const harness = yield* makeBrowserHarness({
          blockedPageIds: [1, 2],
        });

        yield* setBrowserPoolTestConfig({
          maxContexts: 1,
          maxPages: 1,
          maxQueue: 1,
          loadPatchright: () => Effect.succeed(harness.patchright),
        });

        const firstFiber = yield* withPooledBrowserPage(
          {
            poolKey: "browser-basic::direct::persona-a",
            runtimeProfileId: "patchright-default",
            userAgent: "Agent A",
          },
          (page) =>
            Effect.tryPromise({
              try: () => page.content(),
              catch: (error) =>
                new BrowserError({
                  message: "Browser pool test page read failed",
                  details: String(error),
                }),
            }),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* waitForPromiseGate(harness.firstPageEntered);

        const secondPageControl = getPageControl(harness, 2);
        const secondFiber = yield* withPooledBrowserPage(
          {
            poolKey: "browser-stealth::wireguard-prague::persona-b",
            runtimeProfileId: "patchright-stealth",
            userAgent: "Agent B",
          },
          (page) =>
            Effect.tryPromise({
              try: () => page.content(),
              catch: (error) =>
                new BrowserError({
                  message: "Browser pool test page read failed",
                  details: String(error),
                }),
            }),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* waitForPromiseGate(secondPageControl.entered);

        const snapshot = yield* getBrowserPoolSnapshot();

        expect(snapshot.limits).toEqual({
          maxContexts: 2,
          maxPages: 2,
          maxQueue: 2,
        });
        expect(snapshot.activeContexts).toBe(2);
        expect(snapshot.activePages).toBe(2);
        expect(snapshot.maxObservedActiveContexts).toBe(2);
        expect(snapshot.maxObservedActivePages).toBe(2);

        harness.releaseFirstPage.resolve();
        secondPageControl.release.resolve();

        yield* Fiber.join(firstFiber);
        yield* Fiber.join(secondFiber);
      }),
      resetBrowserPoolForTests(),
    ),
  );

  it.effect("does not overstate peak diagnostics across sequential pool keys", () =>
    Effect.ensuring(
      Effect.gen(function* () {
        const harness = yield* makeBrowserHarness({ blockFirstPage: false });

        yield* setBrowserPoolTestConfig({
          maxContexts: 1,
          maxPages: 1,
          maxQueue: 1,
          loadPatchright: () => Effect.succeed(harness.patchright),
        });

        const first = yield* withPooledBrowserPage(
          {
            poolKey: "browser-basic::direct::persona-a",
            runtimeProfileId: "patchright-default",
            userAgent: "Agent A",
          },
          (page) =>
            Effect.tryPromise({
              try: () => page.content(),
              catch: (error) =>
                new BrowserError({
                  message: "Browser pool test page read failed",
                  details: String(error),
                }),
            }),
        );
        const second = yield* withPooledBrowserPage(
          {
            poolKey: "browser-stealth::wireguard-prague::persona-b",
            runtimeProfileId: "patchright-stealth",
            userAgent: "Agent B",
          },
          (page) =>
            Effect.tryPromise({
              try: () => page.content(),
              catch: (error) =>
                new BrowserError({
                  message: "Browser pool test page read failed",
                  details: String(error),
                }),
            }),
        );

        expect(first.value).toContain("queued-1");
        expect(second.value).toContain("queued-2");

        const snapshot = yield* getBrowserPoolSnapshot();
        expect(snapshot.limits).toEqual({
          maxContexts: 2,
          maxPages: 2,
          maxQueue: 2,
        });
        expect(snapshot.activeContexts).toBe(0);
        expect(snapshot.activePages).toBe(0);
        expect(snapshot.queuedRequests).toBe(0);
        expect(snapshot.maxObservedActiveContexts).toBe(1);
        expect(snapshot.maxObservedActivePages).toBe(1);
        expect(snapshot.maxObservedQueuedRequests).toBe(0);
      }),
      resetBrowserPoolForTests(),
    ),
  );
});
