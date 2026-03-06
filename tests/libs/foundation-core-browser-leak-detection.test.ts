import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  BrowserCrashTelemetrySchema,
  BrowserLeakAlarmSchema,
  BrowserLeakSnapshotSchema,
  makeBrowserCrashTelemetry,
  makeInMemoryBrowserLeakDetector,
} from "../../libs/foundation/core/src/browser-leak-detection.ts";
import { RenderCrashError, TimeoutError } from "../../libs/foundation/core/src/tagged-errors.ts";

const encodeSnapshot = Schema.encodeSync(BrowserLeakSnapshotSchema);
const encodeAlarm = Schema.encodeSync(BrowserLeakAlarmSchema);
const encodeCrashTelemetry = Schema.encodeSync(BrowserCrashTelemetrySchema);

const BASE_POLICY = {
  maxOpenBrowsers: 1,
  maxOpenContexts: 1,
  maxOpenPages: 1,
  consecutiveViolationThreshold: 2,
  sampleIntervalMs: 100,
} as const;

function makeClock(timestamps: ReadonlyArray<string>) {
  let index = 0;
  const fallbackTimestamp = timestamps[timestamps.length - 1] ?? "2026-03-06T00:00:00.000Z";

  return () => new Date(timestamps[index++] ?? fallbackTimestamp);
}

describe("foundation-core browser leak detection", () => {
  it.effect("tracks a balanced browser lifecycle without dangling resources", () =>
    Effect.gen(function* () {
      const detector = yield* makeInMemoryBrowserLeakDetector(
        BASE_POLICY,
        makeClock([
          "2026-03-06T15:00:00.000Z",
          "2026-03-06T15:00:01.000Z",
          "2026-03-06T15:00:02.000Z",
          "2026-03-06T15:00:03.000Z",
          "2026-03-06T15:00:04.000Z",
          "2026-03-06T15:00:05.000Z",
          "2026-03-06T15:00:06.000Z",
        ]),
      );

      const snapshots = [
        yield* detector.recordBrowserOpened("plan-balanced-001"),
        yield* detector.recordContextOpened(),
        yield* detector.recordPageOpened(),
        yield* detector.recordPageClosed(),
        yield* detector.recordContextClosed(),
        yield* detector.recordBrowserClosed(),
      ];
      const inspection = yield* detector.inspect;
      const alarms = yield* detector.readAlarms;
      const crashTelemetry = yield* detector.readCrashTelemetry;

      expect(snapshots.map((snapshot) => encodeSnapshot(snapshot))).toEqual([
        {
          openBrowsers: 1,
          openContexts: 0,
          openPages: 0,
          consecutiveViolationCount: 0,
          sampleCount: 1,
          lastPlanId: "plan-balanced-001",
          recordedAt: "2026-03-06T15:00:00.000Z",
        },
        {
          openBrowsers: 1,
          openContexts: 1,
          openPages: 0,
          consecutiveViolationCount: 0,
          sampleCount: 2,
          lastPlanId: "plan-balanced-001",
          recordedAt: "2026-03-06T15:00:01.000Z",
        },
        {
          openBrowsers: 1,
          openContexts: 1,
          openPages: 1,
          consecutiveViolationCount: 0,
          sampleCount: 3,
          lastPlanId: "plan-balanced-001",
          recordedAt: "2026-03-06T15:00:02.000Z",
        },
        {
          openBrowsers: 1,
          openContexts: 1,
          openPages: 0,
          consecutiveViolationCount: 0,
          sampleCount: 4,
          lastPlanId: "plan-balanced-001",
          recordedAt: "2026-03-06T15:00:03.000Z",
        },
        {
          openBrowsers: 1,
          openContexts: 0,
          openPages: 0,
          consecutiveViolationCount: 0,
          sampleCount: 5,
          lastPlanId: "plan-balanced-001",
          recordedAt: "2026-03-06T15:00:04.000Z",
        },
        {
          openBrowsers: 0,
          openContexts: 0,
          openPages: 0,
          consecutiveViolationCount: 0,
          sampleCount: 6,
          lastPlanId: "plan-balanced-001",
          recordedAt: "2026-03-06T15:00:05.000Z",
        },
      ]);
      expect(encodeSnapshot(inspection)).toEqual({
        openBrowsers: 0,
        openContexts: 0,
        openPages: 0,
        consecutiveViolationCount: 0,
        sampleCount: 6,
        lastPlanId: "plan-balanced-001",
        recordedAt: "2026-03-06T15:00:06.000Z",
      });
      expect(alarms).toEqual([]);
      expect(crashTelemetry).toEqual([]);
    }),
  );

  it.effect("emits alarms only after consecutive over-limit samples reach the threshold", () =>
    Effect.gen(function* () {
      const detector = yield* makeInMemoryBrowserLeakDetector(
        {
          ...BASE_POLICY,
          maxOpenBrowsers: 4,
          maxOpenContexts: 4,
          maxOpenPages: 1,
        },
        makeClock([
          "2026-03-06T16:00:00.000Z",
          "2026-03-06T16:00:01.000Z",
          "2026-03-06T16:00:02.000Z",
          "2026-03-06T16:00:03.000Z",
          "2026-03-06T16:00:04.000Z",
        ]),
      );

      yield* detector.recordPageOpened("plan-alarm-001");
      const firstViolation = yield* detector.recordPageOpened();
      const alarmsBeforeThreshold = yield* detector.readAlarms;
      const thresholdViolation = yield* detector.recordPageOpened();
      const stillOverLimit = yield* detector.recordPageClosed();
      const recovered = yield* detector.recordPageClosed();
      const alarms = yield* detector.readAlarms;

      expect(encodeSnapshot(firstViolation)).toEqual({
        openBrowsers: 0,
        openContexts: 0,
        openPages: 2,
        consecutiveViolationCount: 1,
        sampleCount: 2,
        lastPlanId: "plan-alarm-001",
        recordedAt: "2026-03-06T16:00:01.000Z",
      });
      expect(alarmsBeforeThreshold).toEqual([]);
      expect(encodeSnapshot(thresholdViolation)).toEqual({
        openBrowsers: 0,
        openContexts: 0,
        openPages: 3,
        consecutiveViolationCount: 2,
        sampleCount: 3,
        lastPlanId: "plan-alarm-001",
        recordedAt: "2026-03-06T16:00:02.000Z",
      });
      expect(encodeSnapshot(stillOverLimit)).toEqual({
        openBrowsers: 0,
        openContexts: 0,
        openPages: 2,
        consecutiveViolationCount: 3,
        sampleCount: 4,
        lastPlanId: "plan-alarm-001",
        recordedAt: "2026-03-06T16:00:03.000Z",
      });
      expect(encodeSnapshot(recovered)).toEqual({
        openBrowsers: 0,
        openContexts: 0,
        openPages: 1,
        consecutiveViolationCount: 0,
        sampleCount: 5,
        lastPlanId: "plan-alarm-001",
        recordedAt: "2026-03-06T16:00:04.000Z",
      });
      expect(alarms.map((alarm) => encodeAlarm(alarm))).toEqual([
        {
          snapshot: {
            openBrowsers: 0,
            openContexts: 0,
            openPages: 3,
            consecutiveViolationCount: 2,
            sampleCount: 3,
            lastPlanId: "plan-alarm-001",
            recordedAt: "2026-03-06T16:00:02.000Z",
          },
          reason: "Open page count 3 exceeded limit 1.",
          recordedAt: "2026-03-06T16:00:02.000Z",
        },
        {
          snapshot: {
            openBrowsers: 0,
            openContexts: 0,
            openPages: 2,
            consecutiveViolationCount: 3,
            sampleCount: 4,
            lastPlanId: "plan-alarm-001",
            recordedAt: "2026-03-06T16:00:03.000Z",
          },
          reason: "Open page count 2 exceeded limit 1.",
          recordedAt: "2026-03-06T16:00:03.000Z",
        },
      ]);
    }),
  );

  it.effect("stores crash telemetry entries with typed failure envelopes", () =>
    Effect.gen(function* () {
      const detector = yield* makeInMemoryBrowserLeakDetector(BASE_POLICY);

      const firstTelemetryInput = makeBrowserCrashTelemetry({
        planId: "plan-crash-001",
        browserGeneration: 7,
        recycledToGeneration: null,
        recovered: false,
        failure: new RenderCrashError({
          message: "Renderer process exited during scrape.",
        }),
        recordedAt: "2026-03-06T17:00:00.000Z",
      });
      const secondTelemetryInput = makeBrowserCrashTelemetry({
        planId: "plan-crash-001",
        browserGeneration: 8,
        recycledToGeneration: 9,
        recovered: true,
        failure: new TimeoutError({
          message: "Browser relaunch timed out before recovery.",
        }),
        recordedAt: "2026-03-06T17:00:01.000Z",
      });

      const firstTelemetry = yield* detector.recordCrashTelemetry(firstTelemetryInput);
      const secondTelemetry = yield* detector.recordCrashTelemetry(secondTelemetryInput);
      const storedTelemetry = yield* detector.readCrashTelemetry;

      expect(encodeCrashTelemetry(firstTelemetry)).toEqual(firstTelemetryInput);
      expect(encodeCrashTelemetry(secondTelemetry)).toEqual(secondTelemetryInput);
      expect(storedTelemetry.map((telemetry) => encodeCrashTelemetry(telemetry))).toEqual([
        firstTelemetryInput,
        secondTelemetryInput,
      ]);
    }),
  );
});
