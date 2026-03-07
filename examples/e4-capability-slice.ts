import { Effect, Logger, Schema } from "effect";
import {
  AccessPlannerDecisionSchema,
  AccessPlannerLive,
  planAccessExecution,
} from "../libs/foundation/core/src/access-planner-runtime.ts";
import { AccessPolicySchema } from "../libs/foundation/core/src/access-policy.ts";
import {
  BrowserPolicyDecisionSchema,
  makeInMemoryBrowserAccessSecurityPolicy,
} from "../libs/foundation/core/src/browser-access-policy.ts";
import {
  type BrowserAccessEngine,
  type BrowserInstance,
  BrowserAccessLive,
  BrowserArtifactExportBundleSchema,
  BrowserCaptureBundleSchema,
  buildRedactedBrowserArtifactExports,
  captureBrowserArtifacts,
} from "../libs/foundation/core/src/browser-access-runtime.ts";
import {
  type BrowserLeakDetector,
  BrowserCrashTelemetrySchema,
  BrowserLeakAlarmSchema,
  BrowserLeakSnapshotSchema,
  makeInMemoryBrowserLeakDetector,
} from "../libs/foundation/core/src/browser-leak-detection.ts";
import { ArtifactMetadataRecordSchema } from "../libs/foundation/core/src/config-storage.ts";
import { RunPlanSchema } from "../libs/foundation/core/src/run-state.ts";
import { AccessPlanner, BrowserAccess } from "../libs/foundation/core/src/service-topology.ts";
import { SitePackSchema } from "../libs/foundation/core/src/site-pack.ts";
import { ProviderUnavailable } from "../libs/foundation/core/src/tagged-errors.ts";
import { TargetProfileSchema } from "../libs/foundation/core/src/target-profile.ts";

const ENTRY_URL = "https://example.com/search?q=effect";
const PLANNER_CREATED_AT = "2026-03-07T10:00:00.000Z";
const CAPTURE_STARTED_AT = "2026-03-07T10:01:00.000Z";
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const target = Schema.decodeUnknownSync(TargetProfileSchema)({
  id: "target-browser-search-001",
  tenantId: "tenant-main",
  domain: "example.com",
  kind: "searchResult",
  canonicalKey: "search/effect",
  seedUrls: [ENTRY_URL],
  accessPolicyId: "policy-browser-hybrid",
  packId: "pack-example-com",
  priority: 20,
});

const pack = Schema.decodeUnknownSync(SitePackSchema)({
  id: "pack-example-com",
  domainPattern: "*.example.com",
  state: "shadow",
  accessPolicyId: "policy-browser-hybrid",
  version: "2026.03.07",
});

const accessPolicy = Schema.decodeUnknownSync(AccessPolicySchema)({
  id: "policy-browser-hybrid",
  mode: "hybrid",
  perDomainConcurrency: 2,
  globalConcurrency: 4,
  timeoutMs: 20_000,
  maxRetries: 1,
  render: "onDemand",
});

const BrowserLifecycleEvidenceSchema = Schema.Struct({
  launches: NonNegativeIntSchema,
  browserCloses: NonNegativeIntSchema,
  contextCloses: NonNegativeIntSchema,
  pageCloses: NonNegativeIntSchema,
});

type LifecycleState = {
  readonly launches: { current: number };
  readonly browserCloses: { current: number };
  readonly contextCloses: { current: number };
  readonly pageCloses: { current: number };
};

function createClock(startAtIso: string) {
  let offset = 0;

  return () => {
    const next = new Date(Date.parse(startAtIso) + offset);
    offset += 1;
    return next;
  };
}

function createLifecycleState(): LifecycleState {
  return {
    launches: { current: 0 },
    browserCloses: { current: 0 },
    contextCloses: { current: 0 },
    pageCloses: { current: 0 },
  };
}

function createSyntheticBrowserAccessEngine(state: LifecycleState): BrowserAccessEngine {
  let pageSequence = 0;

  return {
    chromium: {
      launch: async () => {
        state.launches.current += 1;
        const browserId = `browser-${state.launches.current}`;

        return {
          newContext: async () => ({
            newPage: async () => {
              pageSequence += 1;
              const pageId = `${browserId}/page-${pageSequence}`;

              return {
                goto: async () => undefined,
                url: async () => ENTRY_URL,
                content: async () => `
                  <html>
                    <head>
                      <title>Effect Search Results</title>
                    </head>
                    <body>
                      <main data-browser-id="${browserId}" data-page-id="${pageId}">
                        <form action="https://example.com/checkout?token=browser-secret">
                          <input type="hidden" name="session" value="session=super-secret" />
                        </form>
                        <a href="https://example.com/products/42?token=browser-secret">
                          View product
                        </a>
                        <img src="https://cdn.example.com/image.png?api_key=browser-secret" />
                        <section>
                          Search results for Effect session=super-secret should never leak.
                        </section>
                      </main>
                    </body>
                  </html>
                `,
                screenshot: async () =>
                  Uint8Array.from([state.launches.current, pageSequence, 4, 2]),
                evaluate: async () => ({
                  navigation: [
                    {
                      url: `${ENTRY_URL}&token=browser-secret`,
                      type: "navigate",
                      startTimeMs: 0,
                      durationMs: 12,
                      transferSize: 2048,
                      encodedBodySize: 1900,
                      decodedBodySize: 4096,
                      responseStatus: 200,
                    },
                  ],
                  resources: [
                    {
                      url: "https://cdn.example.com/app.js?api_key=browser-secret",
                      initiatorType: "script",
                      startTimeMs: 1,
                      durationMs: 3,
                      transferSize: 512,
                      encodedBodySize: 512,
                      decodedBodySize: 1024,
                    },
                    {
                      url: "https://cdn.example.com/image.png?session=browser-secret",
                      initiatorType: "img",
                      startTimeMs: 2,
                      durationMs: 4,
                      transferSize: 256,
                      encodedBodySize: 256,
                      decodedBodySize: 256,
                    },
                  ],
                }),
                close: async () => {
                  state.pageCloses.current += 1;
                },
              };
            },
            close: async () => {
              state.contextCloses.current += 1;
            },
          }),
          close: async () => {
            state.browserCloses.current += 1;
          },
        };
      },
    },
  };
}

function ensureEqual(label: string, left: unknown, right: unknown) {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`Expected ${label} to remain aligned across the E4 capability slice.`);
  }
}

function launchTrackedBrowser(
  engine: BrowserAccessEngine,
  detector: BrowserLeakDetector,
  planId: string,
) {
  return Effect.tryPromise({
    try: () => engine.chromium.launch({ headless: true }),
    catch: (cause) =>
      new ProviderUnavailable({
        message: `Failed to launch synthetic browser for the E4 capability slice: ${String(cause)}`,
      }),
  }).pipe(Effect.tap(() => detector.recordBrowserOpened(planId)));
}

function closeTrackedBrowser(
  browser: BrowserInstance,
  detector: BrowserLeakDetector,
  planId: string,
) {
  return Effect.tryPromise({
    try: () => browser.close(),
    catch: (cause) =>
      new ProviderUnavailable({
        message: `Failed to close synthetic browser for the E4 capability slice: ${String(cause)}`,
      }),
  }).pipe(
    Effect.andThen(detector.recordBrowserClosed(planId)),
    Effect.asVoid,
    Effect.catch(() => Effect.void),
  );
}

export class E4CapabilitySliceEvidence extends Schema.Class<E4CapabilitySliceEvidence>(
  "E4CapabilitySliceEvidence",
)({
  target: TargetProfileSchema,
  pack: SitePackSchema,
  accessPolicy: AccessPolicySchema,
  plannerDecision: AccessPlannerDecisionSchema,
  servicePlan: RunPlanSchema,
  rawCaptureBundle: BrowserCaptureBundleSchema,
  redactedExports: BrowserArtifactExportBundleSchema,
  serviceArtifacts: Schema.Array(ArtifactMetadataRecordSchema),
  policyDecisions: Schema.Array(BrowserPolicyDecisionSchema),
  leakSnapshot: BrowserLeakSnapshotSchema,
  leakAlarms: Schema.Array(BrowserLeakAlarmSchema),
  crashTelemetry: Schema.Array(BrowserCrashTelemetrySchema),
  lifecycle: BrowserLifecycleEvidenceSchema,
}) {}

export const E4CapabilitySliceEvidenceSchema = E4CapabilitySliceEvidence;

export function runE4CapabilitySlice() {
  return Effect.gen(function* () {
    const plannerDecision = yield* planAccessExecution({
      target,
      pack,
      accessPolicy,
      createdAt: PLANNER_CREATED_AT,
    });
    const servicePlan = yield* Effect.gen(function* () {
      const planner = yield* AccessPlanner;
      return yield* planner.plan(target, pack, accessPolicy);
    }).pipe(Effect.provide(AccessPlannerLive(() => new Date(PLANNER_CREATED_AT))));

    yield* Effect.sync(() =>
      ensureEqual(
        "planner decision and service plan",
        Schema.encodeSync(RunPlanSchema)(plannerDecision.plan),
        Schema.encodeSync(RunPlanSchema)(servicePlan),
      ),
    );

    const lifecycle = createLifecycleState();
    const engine = createSyntheticBrowserAccessEngine(lifecycle);
    const now = createClock(CAPTURE_STARTED_AT);
    const detector = yield* makeInMemoryBrowserLeakDetector(
      {
        maxOpenBrowsers: 1,
        maxOpenContexts: 1,
        maxOpenPages: 1,
        consecutiveViolationThreshold: 1,
        sampleIntervalMs: 250,
      },
      now,
    );
    const securityPolicy = yield* makeInMemoryBrowserAccessSecurityPolicy({ now });

    const rawCaptureBundle = yield* Effect.acquireUseRelease(
      launchTrackedBrowser(engine, detector, servicePlan.id),
      (browser) => captureBrowserArtifacts(servicePlan, browser, now, { detector, securityPolicy }),
      (browser) => closeTrackedBrowser(browser, detector, servicePlan.id),
    );
    const redactedExports = yield* Effect.sync(() =>
      buildRedactedBrowserArtifactExports(rawCaptureBundle),
    );
    const serviceArtifacts = yield* Effect.scoped(
      Effect.gen(function* () {
        const browserAccess = yield* BrowserAccess;
        return yield* browserAccess.capture(servicePlan);
      }).pipe(
        Effect.provide(
          BrowserAccessLive({
            engine,
            detector,
            securityPolicy,
            now,
          }),
        ),
      ),
    );
    const policyDecisions = yield* securityPolicy.readDecisions;
    const leakSnapshot = yield* detector.inspect;
    const leakAlarms = yield* detector.readAlarms;
    const crashTelemetry = yield* detector.readCrashTelemetry;

    return Schema.decodeUnknownSync(E4CapabilitySliceEvidenceSchema)({
      target,
      pack,
      accessPolicy,
      plannerDecision,
      servicePlan,
      rawCaptureBundle,
      redactedExports,
      serviceArtifacts,
      policyDecisions,
      leakSnapshot,
      leakAlarms,
      crashTelemetry,
      lifecycle: {
        launches: lifecycle.launches.current,
        browserCloses: lifecycle.browserCloses.current,
        contextCloses: lifecycle.contextCloses.current,
        pageCloses: lifecycle.pageCloses.current,
      },
    });
  });
}

export function runE4CapabilitySliceEncoded() {
  return runE4CapabilitySlice().pipe(
    Effect.map((evidence) => Schema.encodeSync(E4CapabilitySliceEvidenceSchema)(evidence)),
  );
}

if (import.meta.main) {
  const encoded = await Effect.runPromise(
    runE4CapabilitySliceEncoded().pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set<Logger.Logger<unknown, unknown>>()),
    ),
  );
  process.stdout.write(`${JSON.stringify(encoded, null, 2)}\n`);
}
