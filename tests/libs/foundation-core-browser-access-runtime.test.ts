import { describe, expect, it } from "@effect-native/bun-test";
import { Deferred, Effect, Fiber, Schema } from "effect";
import {
  type BrowserAccessEngine,
  BrowserAccessLive,
  type BrowserAccessRuntimeHandle,
} from "../../libs/foundation/core/src/browser-access-runtime.ts";
import { ArtifactMetadataRecordSchema } from "../../libs/foundation/core/src/config-storage.ts";
import { RunPlanSchema } from "../../libs/foundation/core/src/run-state.ts";
import { BrowserAccess } from "../../libs/foundation/core/src/service-topology.ts";
import { ProviderUnavailable } from "../../libs/foundation/core/src/tagged-errors.ts";

const browserPlan = Schema.decodeUnknownSync(RunPlanSchema)({
  id: "plan-browser-001",
  targetId: "target-product-001",
  packId: "pack-example-com",
  accessPolicyId: "policy-browser",
  concurrencyBudgetId: "budget-browser-001",
  entryUrl: "https://example.com/products/001",
  maxAttempts: 2,
  timeoutMs: 30_000,
  checkpointInterval: 2,
  steps: [
    {
      id: "step-capture-001",
      stage: "capture",
      requiresBrowser: true,
      artifactKind: "renderedDom",
    },
    {
      id: "step-extract-001",
      stage: "extract",
      requiresBrowser: false,
    },
  ],
  createdAt: "2026-03-06T10:00:00.000Z",
});

const httpPlan = Schema.decodeUnknownSync(RunPlanSchema)({
  ...Schema.encodeSync(RunPlanSchema)(browserPlan),
  id: "plan-http-001",
  steps: [
    {
      id: "step-capture-001",
      stage: "capture",
      requiresBrowser: false,
      artifactKind: "html",
    },
    {
      id: "step-extract-001",
      stage: "extract",
      requiresBrowser: false,
    },
  ],
});

const renderedDomArtifact = Schema.decodeUnknownSync(ArtifactMetadataRecordSchema)({
  id: "artifact-rendered-dom-001",
  runId: browserPlan.id,
  artifactId: "artifact-rendered-dom-001",
  kind: "renderedDom",
  visibility: "raw",
  locator: {
    namespace: "captures/example-com",
    key: `${browserPlan.id}/rendered-dom.html`,
  },
  sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  sizeBytes: 2048,
  mediaType: "text/html",
  storedAt: "2026-03-06T10:00:05.000Z",
});

function makeRuntime(state: {
  readonly captures: { current: number };
  readonly shutdowns: { current: number };
}): BrowserAccessRuntimeHandle {
  return {
    capture: Effect.fn("TestBrowserAccessRuntime.capture")(() =>
      Effect.sync(() => {
        state.captures.current += 1;
        return [renderedDomArtifact];
      }),
    ),
    shutdown: Effect.sync(() => {
      state.shutdowns.current += 1;
    }),
  };
}

describe("foundation-core browser access runtime", () => {
  it.effect("does not launch or shutdown a browser runtime when the service stays unused", () =>
    Effect.gen(function* () {
      const launches = { current: 0 };
      const captures = { current: 0 };
      const shutdowns = { current: 0 };

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* BrowserAccess;
          expect(launches.current).toBe(0);
          expect(captures.current).toBe(0);
          expect(shutdowns.current).toBe(0);
        }).pipe(
          Effect.provide(
            BrowserAccessLive({
              launch: Effect.sync(() => {
                launches.current += 1;
                return makeRuntime({ captures, shutdowns });
              }),
            }),
          ),
        ),
      );

      expect(launches.current).toBe(0);
      expect(captures.current).toBe(0);
      expect(shutdowns.current).toBe(0);
    }),
  );

  it.effect("rejects non-browser capture plans without launching a browser runtime", () =>
    Effect.gen(function* () {
      const launches = { current: 0 };
      const shutdowns = { current: 0 };

      const message = yield* Effect.scoped(
        Effect.gen(function* () {
          const access = yield* BrowserAccess;
          return yield* access.capture(httpPlan).pipe(
            Effect.match({
              onFailure: ({ message }) => message,
              onSuccess: () => "unexpected-success",
            }),
          );
        }).pipe(
          Effect.provide(
            BrowserAccessLive({
              launch: Effect.sync(() => {
                launches.current += 1;
                return makeRuntime({ captures: { current: 0 }, shutdowns });
              }),
            }),
          ),
        ),
      );

      expect(message).toContain("does not require browser resources");
      expect(launches.current).toBe(0);
      expect(shutdowns.current).toBe(0);
    }),
  );

  it.effect("launches once per scope under concurrent capture and shuts down exactly once", () =>
    Effect.gen(function* () {
      const launches = { current: 0 };
      const captures = { current: 0 };
      const shutdowns = { current: 0 };
      const launchStarted = yield* Deferred.make<void>();
      const launchGate = yield* Deferred.make<void>();

      const results = yield* Effect.scoped(
        Effect.gen(function* () {
          const access = yield* BrowserAccess;
          const firstFiber = yield* access.capture(browserPlan).pipe(Effect.forkScoped);
          const secondFiber = yield* access.capture(browserPlan).pipe(Effect.forkScoped);

          yield* Deferred.await(launchStarted);

          expect(launches.current).toBe(1);
          expect(captures.current).toBe(0);

          yield* Deferred.succeed(launchGate, undefined);

          return yield* Effect.all([Fiber.join(firstFiber), Fiber.join(secondFiber)]);
        }).pipe(
          Effect.provide(
            BrowserAccessLive({
              launch: Effect.gen(function* () {
                launches.current += 1;
                yield* Deferred.succeed(launchStarted, undefined);
                yield* Deferred.await(launchGate);
                return makeRuntime({ captures, shutdowns });
              }),
            }),
          ),
        ),
      );

      expect(results).toEqual([[renderedDomArtifact], [renderedDomArtifact]]);
      expect(launches.current).toBe(1);
      expect(captures.current).toBe(2);
      expect(shutdowns.current).toBe(1);
    }),
  );

  it.effect("does not orphan a failed startup and retries launch on the next capture", () =>
    Effect.gen(function* () {
      const launches = { current: 0 };
      const captures = { current: 0 };
      const shutdowns = { current: 0 };

      const artifacts = yield* Effect.scoped(
        Effect.gen(function* () {
          const access = yield* BrowserAccess;

          const firstMessage = yield* access.capture(browserPlan).pipe(
            Effect.match({
              onFailure: ({ message }) => message,
              onSuccess: () => "unexpected-success",
            }),
          );

          expect(firstMessage).toContain("browser launch failed");
          expect(launches.current).toBe(1);
          expect(captures.current).toBe(0);
          expect(shutdowns.current).toBe(0);

          return yield* access.capture(browserPlan);
        }).pipe(
          Effect.provide(
            BrowserAccessLive({
              launch: Effect.gen(function* () {
                launches.current += 1;

                if (launches.current === 1) {
                  return yield* Effect.fail(
                    new ProviderUnavailable({
                      message: "browser launch failed",
                    }),
                  );
                }

                return makeRuntime({ captures, shutdowns });
              }),
            }),
          ),
        ),
      );

      expect(artifacts).toEqual([renderedDomArtifact]);
      expect(launches.current).toBe(2);
      expect(captures.current).toBe(1);
      expect(shutdowns.current).toBe(1);
    }),
  );

  it.effect("captures rendered DOM and timings through the default launcher path", () =>
    Effect.gen(function* () {
      const closed = {
        browser: 0,
        context: 0,
        page: 0,
      };
      const engine: BrowserAccessEngine = {
        chromium: {
          launch: async () => ({
            newContext: async () => ({
              newPage: async () => ({
                goto: async () => undefined,
                content: async () => "<html><body><h1>Effect Scrapling</h1></body></html>",
                close: async () => {
                  closed.page += 1;
                },
              }),
              close: async () => {
                closed.context += 1;
              },
            }),
            close: async () => {
              closed.browser += 1;
            },
          }),
        },
      };

      const artifacts = yield* Effect.scoped(
        Effect.gen(function* () {
          const access = yield* BrowserAccess;
          return yield* access.capture(browserPlan);
        }).pipe(
          Effect.provide(
            BrowserAccessLive({
              engine,
              now: () => new Date("2026-03-06T10:00:05.000Z"),
            }),
          ),
        ),
      );

      expect(artifacts).toHaveLength(2);
      expect(artifacts.map(({ kind }) => kind)).toEqual(["renderedDom", "timings"]);
      expect(artifacts[0]?.runId).toBe(browserPlan.id);
      expect(artifacts[1]?.mediaType).toBe("application/json");
      expect(closed.page).toBe(1);
      expect(closed.context).toBe(1);
      expect(closed.browser).toBe(1);
    }),
  );
});
