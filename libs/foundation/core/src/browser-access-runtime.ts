import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Deferred, Effect, Layer, Ref, Schema } from "effect";
import {
  type ArtifactMetadataRecord,
  ArtifactMetadataRecordSchema,
  StorageLocatorSchema,
} from "./config-storage.ts";
import { BrowserAccess } from "./service-topology.ts";
import type { RunPlan } from "./run-state.ts";
import { RunPlanSchema } from "./run-state.ts";
import { IsoDateTimeSchema } from "./schema-primitives.ts";
import {
  PolicyViolation,
  ProviderUnavailable,
  RenderCrashError,
  TimeoutError,
} from "./tagged-errors.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const NonNegativeFiniteSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const BrowserPayloadEncodingSchema = Schema.Literals(["utf8", "base64"] as const);

export class BrowserCapturePayload extends Schema.Class<BrowserCapturePayload>(
  "BrowserCapturePayload",
)({
  locator: StorageLocatorSchema,
  mediaType: NonEmptyStringSchema,
  encoding: BrowserPayloadEncodingSchema,
  body: Schema.String,
}) {}

class BrowserNavigationEntry extends Schema.Class<BrowserNavigationEntry>("BrowserNavigationEntry")(
  {
    url: NonEmptyStringSchema,
    type: NonEmptyStringSchema,
    startTimeMs: NonNegativeFiniteSchema,
    durationMs: NonNegativeFiniteSchema,
    transferSize: NonNegativeFiniteSchema,
    encodedBodySize: NonNegativeFiniteSchema,
    decodedBodySize: NonNegativeFiniteSchema,
    responseStatus: NonNegativeFiniteSchema,
  },
) {}

class BrowserResourceEntry extends Schema.Class<BrowserResourceEntry>("BrowserResourceEntry")({
  url: NonEmptyStringSchema,
  initiatorType: NonEmptyStringSchema,
  startTimeMs: NonNegativeFiniteSchema,
  durationMs: NonNegativeFiniteSchema,
  transferSize: NonNegativeFiniteSchema,
  encodedBodySize: NonNegativeFiniteSchema,
  decodedBodySize: NonNegativeFiniteSchema,
}) {}

export class BrowserNetworkSummary extends Schema.Class<BrowserNetworkSummary>(
  "BrowserNetworkSummary",
)({
  navigation: Schema.Array(BrowserNavigationEntry),
  resources: Schema.Array(BrowserResourceEntry),
}) {}

export class BrowserCaptureBundle extends Schema.Class<BrowserCaptureBundle>(
  "BrowserCaptureBundle",
)({
  capturedAt: IsoDateTimeSchema,
  artifacts: Schema.Array(ArtifactMetadataRecordSchema),
  payloads: Schema.Array(BrowserCapturePayload),
}) {}

export const BrowserCapturePayloadSchema = BrowserCapturePayload;
export const BrowserNetworkSummarySchema = BrowserNetworkSummary;
export const BrowserCaptureBundleSchema = BrowserCaptureBundle;

type BrowserLaunchError = ProviderUnavailable | RenderCrashError;
type BrowserCapturePayloadEncoding = Schema.Schema.Type<typeof BrowserPayloadEncodingSchema>;

type BrowserPage = {
  readonly goto: (
    url: string,
    options: {
      readonly timeout: number;
      readonly waitUntil: "domcontentloaded";
    },
  ) => PromiseLike<unknown>;
  readonly content: () => PromiseLike<string>;
  readonly screenshot: (options: {
    readonly type: "png";
    readonly fullPage: true;
  }) => PromiseLike<Uint8Array | ArrayBuffer>;
  readonly evaluate: <A>(callback: () => A | Promise<A>) => PromiseLike<A>;
  readonly close: () => PromiseLike<void>;
};

type BrowserContext = {
  readonly newPage: () => PromiseLike<BrowserPage>;
  readonly close: () => PromiseLike<void>;
};

export type BrowserInstance = {
  readonly newContext: () => PromiseLike<BrowserContext>;
  readonly close: () => PromiseLike<void>;
};

export type BrowserAccessEngine = {
  readonly chromium: {
    readonly launch: (options: { readonly headless: true }) => PromiseLike<BrowserInstance>;
  };
};

export type BrowserAccessRuntimeHandle = {
  readonly capture: (
    plan: RunPlan,
  ) => Effect.Effect<
    ReadonlyArray<ArtifactMetadataRecord>,
    ProviderUnavailable | RenderCrashError | TimeoutError
  >;
  readonly shutdown: Effect.Effect<void>;
};

type BrowserRuntimeState =
  | { readonly status: "idle" }
  | {
      readonly status: "launching";
      readonly deferred: Deferred.Deferred<BrowserAccessRuntimeHandle, BrowserLaunchError>;
    }
  | {
      readonly status: "ready";
      readonly handle: BrowserAccessRuntimeHandle;
    }
  | { readonly status: "closed" };

type LaunchDecision =
  | { readonly kind: "ready"; readonly handle: BrowserAccessRuntimeHandle }
  | {
      readonly kind: "await";
      readonly deferred: Deferred.Deferred<BrowserAccessRuntimeHandle, BrowserLaunchError>;
    }
  | {
      readonly kind: "launch";
      readonly deferred: Deferred.Deferred<BrowserAccessRuntimeHandle, BrowserLaunchError>;
    }
  | { readonly kind: "closed" };

const TEXT_ENCODER = new TextEncoder();
const idleState: BrowserRuntimeState = { status: "idle" };
const closedState: BrowserRuntimeState = { status: "closed" };

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function decodeBrowserPlan(plan: unknown) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(RunPlanSchema)(plan),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode browser capture plan through shared contracts.",
      }),
  });
}

function ensureBrowserCapturePlan(plan: RunPlan) {
  const captureStep = plan.steps[0];
  if (captureStep === undefined || captureStep.stage !== "capture") {
    return Effect.fail(
      new PolicyViolation({
        message: "Run plan must start with a capture step before browser execution.",
      }),
    );
  }

  if (!captureStep.requiresBrowser) {
    return Effect.fail(
      new PolicyViolation({
        message: "Run plan capture step does not require browser resources.",
      }),
    );
  }

  return Effect.succeed(plan);
}

function utf8Bytes(value: string) {
  return TEXT_ENCODER.encode(value);
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function toBytes(data: Uint8Array | ArrayBuffer) {
  return ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
}

function closeQuietly(effect: () => PromiseLike<void>) {
  return Effect.matchEffect(
    Effect.tryPromise({
      try: effect,
      catch: () =>
        new ProviderUnavailable({
          message: "Browser cleanup failed.",
        }),
    }),
    {
      onFailure: () => Effect.void,
      onSuccess: () => Effect.void,
    },
  );
}

const browserAccessTimedOut = Symbol.for("foundation.core.browserAccess.timedOut");

function runTimedBrowserPromise<A, E>(options: {
  readonly timeoutMs: number;
  readonly timeoutMessage: string;
  readonly try: () => PromiseLike<A>;
  readonly onError: (cause: unknown) => E;
}) {
  return Effect.tryPromise({
    try: async () => {
      let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

      try {
        return await new Promise<A>((resolve, reject) => {
          timer = globalThis.setTimeout(() => reject(browserAccessTimedOut), options.timeoutMs);
          Promise.resolve().then(options.try).then(resolve, reject);
        });
      } finally {
        if (timer !== undefined) {
          globalThis.clearTimeout(timer);
        }
      }
    },
    catch: (cause) =>
      cause === browserAccessTimedOut
        ? new TimeoutError({
            message: options.timeoutMessage,
          })
        : options.onError(cause),
  });
}

function remainingTimeoutMs(options: {
  readonly deadlineMs: number;
  readonly now: () => Date;
  readonly timeoutMessage: string;
}) {
  return Effect.sync(() => options.deadlineMs - options.now().valueOf()).pipe(
    Effect.flatMap((value) =>
      value > 0
        ? Effect.succeed(value)
        : Effect.fail(
            new TimeoutError({
              message: options.timeoutMessage,
            }),
          ),
    ),
  );
}

function buildCapturePayload(input: {
  readonly plan: RunPlan;
  readonly keySuffix: string;
  readonly mediaType: string;
  readonly encoding: BrowserCapturePayloadEncoding;
  readonly body: string;
}) {
  return Schema.decodeUnknownSync(BrowserCapturePayloadSchema)({
    locator: {
      namespace: `captures/${input.plan.targetId}`,
      key: `${input.plan.id}/${input.keySuffix}`,
    },
    mediaType: input.mediaType,
    encoding: input.encoding,
    body: input.body,
  });
}

function buildArtifactRecord(input: {
  readonly plan: RunPlan;
  readonly storedAt: string;
  readonly artifactId: string;
  readonly kind: "renderedDom" | "screenshot" | "networkSummary" | "timings";
  readonly visibility: "raw" | "redacted";
  readonly payload: Schema.Schema.Type<typeof BrowserCapturePayloadSchema>;
  readonly bytes: Uint8Array;
}) {
  return Schema.decodeUnknownSync(ArtifactMetadataRecordSchema)({
    id: input.artifactId,
    runId: input.plan.id,
    artifactId: input.artifactId,
    kind: input.kind,
    visibility: input.visibility,
    locator: input.payload.locator,
    sha256: sha256(input.bytes),
    sizeBytes: input.bytes.byteLength,
    mediaType: input.payload.mediaType,
    storedAt: input.storedAt,
  });
}

function normalizeNetworkSummary(input: unknown) {
  const decoded = Schema.decodeUnknownSync(BrowserNetworkSummarySchema)(input);

  return Schema.decodeUnknownSync(BrowserNetworkSummarySchema)({
    navigation: [...decoded.navigation].sort((left, right) =>
      left.url === right.url
        ? left.startTimeMs - right.startTimeMs
        : left.url.localeCompare(right.url),
    ),
    resources: [...decoded.resources].sort((left, right) =>
      left.url === right.url
        ? left.initiatorType === right.initiatorType
          ? left.startTimeMs - right.startTimeMs
          : left.initiatorType.localeCompare(right.initiatorType)
        : left.url.localeCompare(right.url),
    ),
  });
}

function toProviderUnavailable(message: string, cause: unknown) {
  return new ProviderUnavailable({
    message: `${message}: ${readCauseMessage(cause, message)}`,
  });
}

function toRenderCrash(message: string, cause: unknown) {
  return new RenderCrashError({
    message: `${message}: ${readCauseMessage(cause, message)}`,
  });
}

function loadPlaywrightEngine() {
  return Effect.tryPromise({
    try: async () => {
      const module = await import("playwright");
      return module satisfies BrowserAccessEngine;
    },
    catch: (cause) =>
      toProviderUnavailable(
        "Playwright is unavailable for browser access; run `bun run browser:install`",
        cause,
      ),
  });
}

const readBrowserNetworkSummary = Effect.fn("BrowserAccess.readBrowserNetworkSummary")(function* (
  page: BrowserPage,
  options: {
    readonly timeoutMs: number;
    readonly timeoutMessage: string;
  },
) {
  return yield* runTimedBrowserPromise({
    timeoutMs: options.timeoutMs,
    timeoutMessage: options.timeoutMessage,
    try: () =>
      page.evaluate(() => ({
        navigation: performance.getEntriesByType("navigation").flatMap((entry) =>
          "transferSize" in entry && "encodedBodySize" in entry && "decodedBodySize" in entry
            ? [
                {
                  url: entry.name,
                  type: "navigation",
                  startTimeMs: entry.startTime,
                  durationMs: entry.duration,
                  transferSize: entry.transferSize,
                  encodedBodySize: entry.encodedBodySize,
                  decodedBodySize: entry.decodedBodySize,
                  responseStatus:
                    "responseStatus" in entry && typeof entry.responseStatus === "number"
                      ? entry.responseStatus
                      : 0,
                },
              ]
            : [],
        ),
        resources: performance.getEntriesByType("resource").flatMap((entry) =>
          "initiatorType" in entry &&
          "transferSize" in entry &&
          "encodedBodySize" in entry &&
          "decodedBodySize" in entry
            ? [
                {
                  url: entry.name,
                  initiatorType: entry.initiatorType,
                  startTimeMs: entry.startTime,
                  durationMs: entry.duration,
                  transferSize: entry.transferSize,
                  encodedBodySize: entry.encodedBodySize,
                  decodedBodySize: entry.decodedBodySize,
                },
              ]
            : [],
        ),
      })),
    onError: (cause) => toRenderCrash("Browser access failed to capture network summary", cause),
  }).pipe(Effect.map(normalizeNetworkSummary));
});

export function captureBrowserArtifacts(
  plan: unknown,
  browser: BrowserInstance,
  now: () => Date = () => new Date(),
) {
  return Effect.gen(function* () {
    const decodedPlan = yield* decodeBrowserPlan(plan).pipe(
      Effect.flatMap(ensureBrowserCapturePlan),
    );
    return yield* captureDecodedBrowserArtifacts(decodedPlan, browser, now);
  });
}

const captureDecodedBrowserArtifacts = Effect.fn("BrowserAccess.captureDecodedBrowserArtifacts")(
  function* (plan: RunPlan, browser: BrowserInstance, now: () => Date) {
    const startedAt = now();
    const timeoutMessage = `Browser access timed out for run plan ${plan.id}.`;
    const deadlineMs = startedAt.valueOf() + plan.timeoutMs;

    return yield* Effect.acquireUseRelease(
      remainingTimeoutMs({
        deadlineMs,
        now,
        timeoutMessage,
      }).pipe(
        Effect.flatMap((timeoutMs) =>
          runTimedBrowserPromise({
            timeoutMs,
            timeoutMessage,
            try: () => browser.newContext(),
            onError: (cause) =>
              toRenderCrash("Browser access failed to allocate a browsing context", cause),
          }),
        ),
      ),
      (context) =>
        Effect.acquireUseRelease(
          remainingTimeoutMs({
            deadlineMs,
            now,
            timeoutMessage,
          }).pipe(
            Effect.flatMap((timeoutMs) =>
              runTimedBrowserPromise({
                timeoutMs,
                timeoutMessage,
                try: () => context.newPage(),
                onError: (cause) =>
                  toRenderCrash("Browser access failed to allocate a page", cause),
              }),
            ),
          ),
          (page) =>
            Effect.gen(function* () {
              const navigationTimeoutMs = yield* remainingTimeoutMs({
                deadlineMs,
                now,
                timeoutMessage,
              });
              yield* runTimedBrowserPromise({
                timeoutMs: navigationTimeoutMs,
                timeoutMessage,
                try: () =>
                  page.goto(plan.entryUrl, {
                    timeout: navigationTimeoutMs,
                    waitUntil: "domcontentloaded",
                  }),
                onError: (cause) =>
                  toRenderCrash("Browser access failed during page navigation", cause),
              });

              const renderedDom = yield* remainingTimeoutMs({
                deadlineMs,
                now,
                timeoutMessage,
              }).pipe(
                Effect.flatMap((timeoutMs) =>
                  runTimedBrowserPromise({
                    timeoutMs,
                    timeoutMessage,
                    try: () => page.content(),
                    onError: (cause) =>
                      toRenderCrash("Browser access failed to capture rendered DOM", cause),
                  }),
                ),
              );
              const screenshotBytes = yield* remainingTimeoutMs({
                deadlineMs,
                now,
                timeoutMessage,
              }).pipe(
                Effect.flatMap((timeoutMs) =>
                  runTimedBrowserPromise({
                    timeoutMs,
                    timeoutMessage,
                    try: () =>
                      page.screenshot({
                        type: "png",
                        fullPage: true,
                      }),
                    onError: (cause) =>
                      toRenderCrash("Browser access failed to capture page screenshot", cause),
                  }),
                ),
                Effect.map(toBytes),
              );
              const networkSummary = yield* remainingTimeoutMs({
                deadlineMs,
                now,
                timeoutMessage,
              }).pipe(
                Effect.flatMap((timeoutMs) =>
                  readBrowserNetworkSummary(page, {
                    timeoutMs,
                    timeoutMessage,
                  }),
                ),
              );
              const completedAt = now();
              const storedAt = completedAt.toISOString();

              const renderedDomPayload = buildCapturePayload({
                plan,
                keySuffix: "rendered-dom.html",
                mediaType: "text/html",
                encoding: "utf8",
                body: renderedDom,
              });
              const screenshotPayload = buildCapturePayload({
                plan,
                keySuffix: "screenshot.png",
                mediaType: "image/png",
                encoding: "base64",
                body: Buffer.from(screenshotBytes).toString("base64"),
              });
              const networkSummaryPayload = buildCapturePayload({
                plan,
                keySuffix: "network-summary.json",
                mediaType: "application/json",
                encoding: "utf8",
                body: `${JSON.stringify(
                  Schema.encodeSync(BrowserNetworkSummarySchema)(networkSummary),
                  null,
                  2,
                )}\n`,
              });
              const timingsPayload = buildCapturePayload({
                plan,
                keySuffix: "timings.json",
                mediaType: "application/json",
                encoding: "utf8",
                body: `${JSON.stringify(
                  {
                    startedAt: startedAt.toISOString(),
                    completedAt: storedAt,
                    elapsedMs: completedAt.valueOf() - startedAt.valueOf(),
                  },
                  null,
                  2,
                )}\n`,
              });

              return Schema.decodeUnknownSync(BrowserCaptureBundleSchema)({
                capturedAt: storedAt,
                artifacts: [
                  buildArtifactRecord({
                    plan,
                    storedAt,
                    artifactId: `${plan.id}-rendered-dom`,
                    kind: "renderedDom",
                    visibility: "raw",
                    payload: renderedDomPayload,
                    bytes: utf8Bytes(renderedDomPayload.body),
                  }),
                  buildArtifactRecord({
                    plan,
                    storedAt,
                    artifactId: `${plan.id}-screenshot`,
                    kind: "screenshot",
                    visibility: "raw",
                    payload: screenshotPayload,
                    bytes: screenshotBytes,
                  }),
                  buildArtifactRecord({
                    plan,
                    storedAt,
                    artifactId: `${plan.id}-network-summary`,
                    kind: "networkSummary",
                    visibility: "redacted",
                    payload: networkSummaryPayload,
                    bytes: utf8Bytes(networkSummaryPayload.body),
                  }),
                  buildArtifactRecord({
                    plan,
                    storedAt,
                    artifactId: `${plan.id}-timings`,
                    kind: "timings",
                    visibility: "redacted",
                    payload: timingsPayload,
                    bytes: utf8Bytes(timingsPayload.body),
                  }),
                ],
                payloads: [
                  renderedDomPayload,
                  screenshotPayload,
                  networkSummaryPayload,
                  timingsPayload,
                ],
              });
            }),
          (page) => closeQuietly(() => page.close()),
        ),
      (context) => closeQuietly(() => context.close()),
    );
  },
);

export function makePlaywrightBrowserAccessRuntime(options?: {
  readonly engine?: BrowserAccessEngine;
  readonly now?: () => Date;
}) {
  const now = options?.now ?? (() => new Date());

  return Effect.gen(function* () {
    const engine = options?.engine ?? (yield* loadPlaywrightEngine());
    const browser = yield* Effect.tryPromise({
      try: () => engine.chromium.launch({ headless: true }),
      catch: (cause) => toProviderUnavailable("Browser access launch failed", cause),
    });

    return {
      capture: Effect.fn("PlaywrightBrowserAccessRuntime.capture")(function* (plan: RunPlan) {
        const bundle = yield* captureDecodedBrowserArtifacts(plan, browser, now);
        return bundle.artifacts;
      }),
      shutdown: closeQuietly(() => browser.close()),
    } satisfies BrowserAccessRuntimeHandle;
  });
}

function releaseRuntime(stateRef: Ref.Ref<BrowserRuntimeState>) {
  return Ref.modify(stateRef, (state): readonly [Effect.Effect<void>, BrowserRuntimeState] => {
    if (state.status === "ready") {
      return [state.handle.shutdown, closedState];
    }

    return [Effect.void, closedState];
  }).pipe(Effect.flatten);
}

function getOrLaunchRuntime(options: {
  readonly stateRef: Ref.Ref<BrowserRuntimeState>;
  readonly launch: Effect.Effect<BrowserAccessRuntimeHandle, BrowserLaunchError>;
}) {
  return Effect.gen(function* () {
    const deferred = yield* Deferred.make<BrowserAccessRuntimeHandle, BrowserLaunchError>();
    const decision = yield* Ref.modify(
      options.stateRef,
      (state): readonly [LaunchDecision, BrowserRuntimeState] => {
        switch (state.status) {
          case "ready": {
            return [{ kind: "ready", handle: state.handle }, state];
          }
          case "launching": {
            return [{ kind: "await", deferred: state.deferred }, state];
          }
          case "closed": {
            return [{ kind: "closed" }, state];
          }
          case "idle": {
            return [
              { kind: "launch", deferred },
              { status: "launching", deferred },
            ];
          }
        }
      },
    );

    switch (decision.kind) {
      case "ready": {
        return decision.handle;
      }
      case "await": {
        return yield* Deferred.await(decision.deferred);
      }
      case "closed": {
        return yield* Effect.fail(
          new ProviderUnavailable({
            message: "Browser access runtime is closed for this scope.",
          }),
        );
      }
      case "launch": {
        return yield* Effect.matchEffect(options.launch, {
          onFailure: (error) =>
            Effect.gen(function* () {
              yield* Ref.modify(options.stateRef, (state): readonly [void, BrowserRuntimeState] => [
                undefined,
                state.status === "closed" ? closedState : idleState,
              ]);
              yield* Deferred.fail(decision.deferred, error);
              return yield* Effect.fail(error);
            }),
          onSuccess: (handle) =>
            Effect.gen(function* () {
              const transition = yield* Ref.modify(
                options.stateRef,
                (
                  state,
                ): readonly [{ readonly shutdownAfterLaunch: boolean }, BrowserRuntimeState] => {
                  if (state.status === "closed") {
                    return [{ shutdownAfterLaunch: true }, closedState];
                  }

                  return [{ shutdownAfterLaunch: false }, { status: "ready", handle }];
                },
              );
              yield* Deferred.succeed(decision.deferred, handle);

              if (transition.shutdownAfterLaunch) {
                yield* handle.shutdown;
              }

              return handle;
            }),
        });
      }
    }
  });
}

function getPlaywrightRuntimeOptions(options?: {
  readonly engine?: BrowserAccessEngine;
  readonly now?: () => Date;
}) {
  if (options?.engine === undefined && options?.now === undefined) {
    return undefined;
  }

  return {
    ...(options?.engine === undefined ? {} : { engine: options.engine }),
    ...(options?.now === undefined ? {} : { now: options.now }),
  };
}

export function BrowserAccessLive(options?: {
  readonly launch?: Effect.Effect<BrowserAccessRuntimeHandle, BrowserLaunchError>;
  readonly engine?: BrowserAccessEngine;
  readonly now?: () => Date;
}) {
  const launch =
    options?.launch ?? makePlaywrightBrowserAccessRuntime(getPlaywrightRuntimeOptions(options));

  return Layer.effect(BrowserAccess)(
    Effect.gen(function* () {
      const stateRef = yield* Ref.make<BrowserRuntimeState>(idleState);
      yield* Effect.addFinalizer(() => releaseRuntime(stateRef));

      return BrowserAccess.of({
        capture: Effect.fn("BrowserAccess.capture")(function* (plan: RunPlan) {
          yield* ensureBrowserCapturePlan(plan);
          const runtime = yield* getOrLaunchRuntime({ stateRef, launch });
          return yield* runtime.capture(plan);
        }),
      });
    }),
  );
}
