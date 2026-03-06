import { createHash } from "node:crypto";
import { Deferred, Effect, Layer, Ref, Schema } from "effect";
import { type ArtifactMetadataRecord, ArtifactMetadataRecordSchema } from "./config-storage.ts";
import { BrowserAccess } from "./service-topology.ts";
import type { RunPlan } from "./run-state.ts";
import {
  PolicyViolation,
  ProviderUnavailable,
  RenderCrashError,
  TimeoutError,
} from "./tagged-errors.ts";

type BrowserLaunchError = ProviderUnavailable | RenderCrashError;

type BrowserPage = {
  readonly goto: (
    url: string,
    options: {
      readonly timeout: number;
      readonly waitUntil: "domcontentloaded";
    },
  ) => PromiseLike<unknown>;
  readonly content: () => PromiseLike<string>;
  readonly close: () => PromiseLike<void>;
};

type BrowserContext = {
  readonly newPage: () => PromiseLike<BrowserPage>;
  readonly close: () => PromiseLike<void>;
};

type BrowserInstance = {
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

function hashPayload(payload: string) {
  const encoded = TEXT_ENCODER.encode(payload);
  return {
    encoded,
    sha256: createHash("sha256").update(encoded).digest("hex"),
  } as const;
}

function buildArtifactRecord(input: {
  readonly runId: string;
  readonly artifactId: string;
  readonly kind: "renderedDom" | "timings";
  readonly mediaType: string;
  readonly visibility: "raw" | "redacted";
  readonly key: string;
  readonly payload: string;
  readonly storedAt: string;
}) {
  const { encoded, sha256 } = hashPayload(input.payload);

  return Schema.decodeUnknownSync(ArtifactMetadataRecordSchema)({
    id: input.artifactId,
    runId: input.runId,
    artifactId: input.artifactId,
    kind: input.kind,
    visibility: input.visibility,
    locator: {
      namespace: "captures/browser-access",
      key: input.key,
    },
    sha256,
    sizeBytes: encoded.byteLength,
    mediaType: input.mediaType,
    storedAt: input.storedAt,
  });
}

function toProviderUnavailable(message: string, cause: unknown) {
  return new ProviderUnavailable({
    message: `${message}: ${String(cause)}`,
  });
}

function toRenderCrash(message: string, cause: unknown) {
  return new RenderCrashError({
    message: `${message}: ${String(cause)}`,
  });
}

function closeQuietly(effect: PromiseLike<void>) {
  return Effect.matchEffect(
    Effect.tryPromise({
      try: () => effect,
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

    const capture = Effect.fn("PlaywrightBrowserAccessRuntime.capture")(function* (plan: RunPlan) {
      const startedAt = now();

      return yield* Effect.timeoutOrElse(
        Effect.acquireUseRelease(
          Effect.tryPromise({
            try: () => browser.newContext(),
            catch: (cause) =>
              toRenderCrash("Browser access failed to allocate a browsing context", cause),
          }),
          (context) =>
            Effect.acquireUseRelease(
              Effect.tryPromise({
                try: () => context.newPage(),
                catch: (cause) => toRenderCrash("Browser access failed to allocate a page", cause),
              }),
              (page) =>
                Effect.gen(function* () {
                  yield* Effect.tryPromise({
                    try: () =>
                      page.goto(plan.entryUrl, {
                        timeout: plan.timeoutMs,
                        waitUntil: "domcontentloaded",
                      }),
                    catch: (cause) =>
                      toRenderCrash("Browser access failed during page navigation", cause),
                  });

                  const renderedDom = yield* Effect.tryPromise({
                    try: () => page.content(),
                    catch: (cause) =>
                      toRenderCrash("Browser access failed to capture rendered DOM", cause),
                  });
                  const storedAt = now().toISOString();
                  const timingsPayload = JSON.stringify({
                    startedAt: startedAt.toISOString(),
                    completedAt: storedAt,
                    elapsedMs: now().valueOf() - startedAt.valueOf(),
                  });

                  return [
                    buildArtifactRecord({
                      runId: plan.id,
                      artifactId: `${plan.id}-rendered-dom`,
                      kind: "renderedDom",
                      mediaType: "text/html",
                      visibility: "raw",
                      key: `${plan.id}/rendered-dom.html`,
                      payload: renderedDom,
                      storedAt,
                    }),
                    buildArtifactRecord({
                      runId: plan.id,
                      artifactId: `${plan.id}-timings`,
                      kind: "timings",
                      mediaType: "application/json",
                      visibility: "redacted",
                      key: `${plan.id}/timings.json`,
                      payload: timingsPayload,
                      storedAt,
                    }),
                  ] as const;
                }),
              (page) => closeQuietly(page.close()),
            ),
          (context) => closeQuietly(context.close()),
        ),
        {
          duration: plan.timeoutMs,
          onTimeout: () =>
            Effect.fail(
              new TimeoutError({
                message: `Browser access timed out for run plan ${plan.id}.`,
              }),
            ),
        },
      );
    });

    return {
      capture,
      shutdown: closeQuietly(browser.close()),
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
