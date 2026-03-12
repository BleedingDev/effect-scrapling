import { describe, expect, it } from "@effect-native/bun-test";
import { Effect } from "effect";
import { type PatchrightPage } from "../../src/sdk/browser-pool.ts";
import {
  BrowserMediationRuntime,
  BrowserMediationRuntimeLive,
  resolveBrowserMediationPolicy,
  resolveEffectivePostClearanceStrategy,
} from "../../src/sdk/browser-mediation-runtime.ts";

function makePage(config: {
  readonly content: () => Promise<string>;
  readonly onClick?: () => Promise<void> | void;
  readonly locator?: PatchrightPage["locator"];
  readonly disableLocator?: boolean;
}): PatchrightPage {
  return {
    goto: async () => null,
    content: config.content,
    url: () => "https://example.com",
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
    ...(config.disableLocator
      ? {}
      : {
          locator:
            config.locator ??
            (() => ({
              last: () => ({
                boundingBox: async () => ({
                  x: 100,
                  y: 100,
                  width: 40,
                  height: 40,
                }),
                isVisible: async () => true,
              }),
              boundingBox: async () => ({
                x: 100,
                y: 100,
                width: 40,
                height: 40,
              }),
              isVisible: async () => true,
            })),
        }),
    mouse: {
      click: async () => {
        await config.onClick?.();
      },
    },
    route: async () => undefined,
    close: async () => undefined,
  };
}

const EMBEDDED_CHALLENGE_HTML =
  '<html><head><title>Just a moment...</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body><div class="turnstile"><div><div></div></div></div></body></html>';

const INITIAL_SNAPSHOT = {
  requestedUrl: "https://example.com",
  finalUrl: "https://example.com",
  status: 403,
  title: "Just a moment...",
  contentType: "text/html; charset=utf-8",
  htmlLength: EMBEDDED_CHALLENGE_HTML.length,
  redirectCount: 0,
} as const;

describe("sdk browser mediation runtime", () => {
  it("keeps mediation disabled by default", () => {
    const policy = resolveBrowserMediationPolicy({
      timeoutMs: 5_000,
    });

    expect(policy.mode).toBe("off");
    expect(policy.vendors).toEqual([]);
  });

  it("lifts solve-cloudflare into an internal mediation policy", () => {
    const policy = resolveBrowserMediationPolicy({
      timeoutMs: 5_000,
      challengeHandling: {
        solveCloudflare: true,
      },
    });

    expect(policy.mode).toBe("solve");
    expect(policy.vendors).toEqual(["cloudflare"]);
    expect(policy.timeBudgetMs).toBe(60_000);
    expect(policy.postClearanceStrategy).toBe("reload-target");
    expect(policy.captureEvidence).toBe(true);
    expect(policy.maxAttempts).toBe(4);
  });

  it.effect("returns a typed empty outcome when mediation is disabled", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMediationRuntime;
      const result = yield* runtime.mediate({
        page: makePage({
          content: async () => "<html></html>",
        }),
        pageContent: "<html></html>",
        initialSnapshot: {
          requestedUrl: "https://example.com",
          finalUrl: "https://example.com",
          status: 200,
          title: null,
          contentType: "text/html; charset=utf-8",
          htmlLength: 13,
          redirectCount: 0,
        },
        timeoutMs: 5_000,
      });

      expect(result.policy.mode).toBe("off");
      expect(result.outcome.kind).toBe("none");
      expect(result.followUpNavigationRequired).toBe(false);
      expect(result.currentPageRefreshRequired).toBe(false);
      expect(result.warnings).toEqual([]);
    }).pipe(Effect.provide(BrowserMediationRuntimeLive)),
  );

  it.effect("surfaces multi-attempt Cloudflare clears as typed mediation evidence", () =>
    Effect.gen(function* () {
      let clickCount = 0;
      const runtime = yield* BrowserMediationRuntime;
      const result = yield* runtime.mediate({
        page: makePage({
          content: async () =>
            clickCount >= 2
              ? "<html><head><title>Solved</title></head><body>ok</body></html>"
              : EMBEDDED_CHALLENGE_HTML,
          onClick: async () => {
            clickCount += 1;
          },
        }),
        pageContent: EMBEDDED_CHALLENGE_HTML,
        initialSnapshot: INITIAL_SNAPSHOT,
        timeoutMs: 5_000,
        challengeHandling: {
          solveCloudflare: true,
        },
      });

      expect(result.policy.mode).toBe("solve");
      expect(result.postClearanceStrategy).toBe("reload-target");
      expect(result.outcome).toMatchObject({
        kind: "challenge",
        status: "cleared",
        vendor: "cloudflare",
        resolutionKind: "click",
        attemptCount: 2,
      });
      expect(result.followUpNavigationRequired).toBe(true);
      expect(result.currentPageRefreshRequired).toBe(false);
      expect(result.outcome.evidence.preNavigation).toEqual(INITIAL_SNAPSHOT);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          "cloudflare-solver:retrying:embedded",
          "cloudflare-solver:clearance-observed:embedded",
        ]),
      );
    }).pipe(Effect.provide(BrowserMediationRuntimeLive)),
  );

  it.effect("maps unresolved Cloudflare challenge failures to typed mediation failures", () =>
    Effect.gen(function* () {
      const runtime = yield* BrowserMediationRuntime;
      const result = yield* runtime.mediate({
        page: makePage({
          content: async () => EMBEDDED_CHALLENGE_HTML,
          disableLocator: true,
        }),
        pageContent: EMBEDDED_CHALLENGE_HTML,
        initialSnapshot: INITIAL_SNAPSHOT,
        timeoutMs: 2_000,
        challengeHandling: {
          solveCloudflare: true,
        },
      });

      expect(result.outcome).toMatchObject({
        kind: "challenge",
        status: "unresolved",
        vendor: "cloudflare",
        resolutionKind: "click",
        failureReason: "no-progress",
        attemptCount: 0,
      });
      expect(result.followUpNavigationRequired).toBe(false);
      expect(result.currentPageRefreshRequired).toBe(false);
      expect(result.postClearanceStrategy).toBe("reload-target");
    }).pipe(Effect.provide(BrowserMediationRuntimeLive)),
  );

  it.effect(
    "refreshes the current page when a weak interstitial clears before challenge detection completes",
    () =>
      Effect.gen(function* () {
        let readCount = 0;
        const runtime = yield* BrowserMediationRuntime;
        const result = yield* runtime.mediate({
          page: makePage({
            content: async () => {
              readCount += 1;
              return readCount >= 2
                ? "<html><head><title>Solved</title></head><body>ok</body></html>"
                : "<html><head><title>Just a moment...</title></head><body>Booting challenge...</body></html>";
            },
          }),
          pageContent:
            "<html><head><title>Just a moment...</title></head><body>Booting challenge...</body></html>",
          initialSnapshot: INITIAL_SNAPSHOT,
          timeoutMs: 2_000,
          challengeHandling: {
            solveCloudflare: true,
          },
        });

        expect(result.outcome.kind).toBe("none");
        expect(result.followUpNavigationRequired).toBe(true);
        expect(result.currentPageRefreshRequired).toBe(false);
        expect(result.postClearanceStrategy).toBe("reload-target");
        expect(result.warnings).toContain(
          "cloudflare-solver:weak-interstitial-cleared-before-marker-detection",
        );
      }).pipe(Effect.provide(BrowserMediationRuntimeLive)),
  );

  it("falls back to reload-target when a solved flow would otherwise request reuse-current", () => {
    expect(
      resolveEffectivePostClearanceStrategy({
        postClearanceStrategy: "reuse-current",
        followUpNavigationRequired: true,
        currentPageRefreshRequired: false,
      }),
    ).toBe("reload-target");
    expect(
      resolveEffectivePostClearanceStrategy({
        postClearanceStrategy: "reuse-current",
        followUpNavigationRequired: false,
        currentPageRefreshRequired: true,
      }),
    ).toBe("reload-target");
    expect(
      resolveEffectivePostClearanceStrategy({
        postClearanceStrategy: "reuse-current",
        followUpNavigationRequired: false,
        currentPageRefreshRequired: false,
      }),
    ).toBe("reuse-current");
  });
});
