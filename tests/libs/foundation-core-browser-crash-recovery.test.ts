import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  type BrowserAccessEngine,
  BrowserAccessLive,
} from "../../libs/foundation/core/src/browser-access-runtime.ts";
import {
  BrowserCrashTelemetrySchema,
  BrowserLeakSnapshotSchema,
  makeInMemoryBrowserLeakDetector,
} from "../../libs/foundation/core/src/browser-leak-detection.ts";
import { RunPlanSchema } from "../../libs/foundation/core/src/run-state.ts";
import { BrowserAccess } from "../../libs/foundation/core/src/service-topology.ts";

const browserPlan = Schema.decodeUnknownSync(RunPlanSchema)({
  id: "plan-browser-crash-recovery-001",
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

const captureKinds = ["renderedDom", "screenshot", "networkSummary", "timings"] as const;
const leakPolicy = {
  maxOpenBrowsers: 1,
  maxOpenContexts: 1,
  maxOpenPages: 1,
  consecutiveViolationThreshold: 2,
  sampleIntervalMs: 100,
} as const;
const encodeCrashTelemetry = Schema.encodeSync(BrowserCrashTelemetrySchema);
const encodeLeakSnapshot = Schema.encodeSync(BrowserLeakSnapshotSchema);

type BrowserLifecycleState = {
  readonly launches: { current: number };
  readonly contentCalls: { current: number };
  readonly launchedBrowsers: Array<string>;
  readonly closedBrowsers: Array<string>;
  readonly openedContexts: Array<string>;
  readonly closedContexts: Array<string>;
  readonly openedPages: Array<string>;
  readonly closedPages: Array<string>;
};

function makeLifecycleState(): BrowserLifecycleState {
  return {
    launches: { current: 0 },
    contentCalls: { current: 0 },
    launchedBrowsers: [],
    closedBrowsers: [],
    openedContexts: [],
    closedContexts: [],
    openedPages: [],
    closedPages: [],
  };
}

function makeCrashRecoveryEngine(options: {
  readonly state: BrowserLifecycleState;
  readonly crashOnContentCallNumbers?: ReadonlyArray<number>;
}): BrowserAccessEngine {
  let contextSequence = 0;
  let pageSequence = 0;
  const crashOnContentCallNumbers = new Set(options.crashOnContentCallNumbers ?? []);

  return {
    chromium: {
      launch: async () => {
        options.state.launches.current += 1;
        const browserId = `browser-${options.state.launches.current}`;
        options.state.launchedBrowsers.push(browserId);

        return {
          newContext: async () => {
            contextSequence += 1;
            const contextId = `${browserId}/context-${contextSequence}`;
            options.state.openedContexts.push(contextId);

            return {
              newPage: async () => {
                pageSequence += 1;
                const pageId = `${contextId}/page-${pageSequence}`;
                options.state.openedPages.push(pageId);

                return {
                  goto: async () => undefined,
                  content: async () => {
                    options.state.contentCalls.current += 1;

                    if (crashOnContentCallNumbers.has(options.state.contentCalls.current)) {
                      throw new Error(`page crashed in ${browserId}`);
                    }

                    return `<html><body><main>${browserId}:${pageId}</main></body></html>`;
                  },
                  screenshot: async () => Uint8Array.from([options.state.launches.current, 7, 9]),
                  evaluate: async () => ({
                    navigation: [],
                    resources: [],
                  }),
                  close: async () => {
                    options.state.closedPages.push(pageId);
                  },
                };
              },
              close: async () => {
                options.state.closedContexts.push(contextId);
              },
            };
          },
          close: async () => {
            options.state.closedBrowsers.push(browserId);
          },
        };
      },
    },
  };
}

describe("foundation-core browser crash recovery", () => {
  it.effect("recycles crashed browser generations and stores typed crash telemetry", () =>
    Effect.gen(function* () {
      const state = makeLifecycleState();
      const detector = yield* makeInMemoryBrowserLeakDetector(
        leakPolicy,
        () => new Date("2026-03-06T10:00:06.000Z"),
      );
      const engine = makeCrashRecoveryEngine({
        state,
        crashOnContentCallNumbers: [1],
      });

      const [failure, recoveredArtifacts] = yield* Effect.scoped(
        Effect.gen(function* () {
          const access = yield* BrowserAccess;
          const firstFailure = yield* access.capture(browserPlan).pipe(Effect.flip);
          const secondArtifacts = yield* access.capture(browserPlan);
          return [firstFailure, secondArtifacts] as const;
        }).pipe(
          Effect.provide(
            BrowserAccessLive({
              engine,
              detector,
              now: () => new Date("2026-03-06T10:00:05.000Z"),
            }),
          ),
        ),
      );
      const telemetry = yield* detector.readCrashTelemetry;
      const inspection = yield* detector.inspect;
      const alarms = yield* detector.readAlarms;

      expect(failure.name).toBe("RenderCrashError");
      expect(failure.message).toContain("failed to capture rendered DOM");
      expect(recoveredArtifacts.map(({ kind }) => kind)).toEqual([...captureKinds]);
      expect(telemetry.map((entry) => encodeCrashTelemetry(entry))).toEqual([
        {
          planId: browserPlan.id,
          browserGeneration: 0,
          recycledToGeneration: 1,
          recovered: true,
          failure: {
            code: "render_crash",
            retryable: true,
            message: "Browser access failed to capture rendered DOM: page crashed in browser-1",
          },
          recordedAt: "2026-03-06T10:00:05.000Z",
        },
      ]);
      expect(encodeLeakSnapshot(inspection)).toEqual({
        openBrowsers: 0,
        openContexts: 0,
        openPages: 0,
        consecutiveViolationCount: 0,
        sampleCount: 12,
        lastPlanId: browserPlan.id,
        recordedAt: "2026-03-06T10:00:06.000Z",
      });
      expect(alarms).toEqual([]);
      expect(state.launches.current).toBe(2);
      expect(state.contentCalls.current).toBe(2);
      expect(state.launchedBrowsers).toEqual(["browser-1", "browser-2"]);
      expect(state.closedBrowsers).toEqual(["browser-1", "browser-2"]);
      expect(state.openedContexts).toEqual(["browser-1/context-1", "browser-2/context-2"]);
      expect(state.closedContexts).toEqual(state.openedContexts);
      expect(state.openedPages).toEqual([
        "browser-1/context-1/page-1",
        "browser-2/context-2/page-2",
      ]);
      expect(state.closedPages).toEqual(state.openedPages);
    }),
  );

  it.effect("reports zero dangling browser resources after a passing soak run", () =>
    Effect.gen(function* () {
      const state = makeLifecycleState();
      const detector = yield* makeInMemoryBrowserLeakDetector(
        leakPolicy,
        () => new Date("2026-03-06T11:00:06.000Z"),
      );
      const engine = makeCrashRecoveryEngine({ state });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const access = yield* BrowserAccess;

          for (let attempt = 0; attempt < 5; attempt += 1) {
            const artifacts = yield* access.capture(browserPlan);
            expect(artifacts.map(({ kind }) => kind)).toEqual([...captureKinds]);
          }
        }).pipe(
          Effect.provide(
            BrowserAccessLive({
              engine,
              detector,
              now: () => new Date("2026-03-06T11:00:05.000Z"),
            }),
          ),
        ),
      );

      const inspection = yield* detector.inspect;
      const alarms = yield* detector.readAlarms;
      const telemetry = yield* detector.readCrashTelemetry;

      expect(encodeLeakSnapshot(inspection)).toEqual({
        openBrowsers: 0,
        openContexts: 0,
        openPages: 0,
        consecutiveViolationCount: 0,
        sampleCount: 22,
        lastPlanId: browserPlan.id,
        recordedAt: "2026-03-06T11:00:06.000Z",
      });
      expect(alarms).toEqual([]);
      expect(telemetry).toEqual([]);
      expect(state.launches.current).toBe(1);
      expect(state.contentCalls.current).toBe(5);
      expect(state.launchedBrowsers).toEqual(["browser-1"]);
      expect(state.closedBrowsers).toEqual(["browser-1"]);
      expect(state.openedContexts).toEqual([
        "browser-1/context-1",
        "browser-1/context-2",
        "browser-1/context-3",
        "browser-1/context-4",
        "browser-1/context-5",
      ]);
      expect(state.closedContexts).toEqual(state.openedContexts);
      expect(state.openedPages).toEqual([
        "browser-1/context-1/page-1",
        "browser-1/context-2/page-2",
        "browser-1/context-3/page-3",
        "browser-1/context-4/page-4",
        "browser-1/context-5/page-5",
      ]);
      expect(state.closedPages).toEqual(state.openedPages);
    }),
  );
});
