import { describe, expect, it } from "@effect-native/bun-test";
import { type PatchrightPage } from "../../src/sdk/browser-pool.ts";
import {
  detectCloudflareChallengeType,
  resolveBrowserChallenges,
} from "../../src/sdk/browser-challenge-runtime.ts";

const EMBEDDED_CHALLENGE_HTML =
  '<html><head><title>Just a moment...</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body><div class="turnstile"><div><div></div></div></div></body></html>';
const NON_INTERACTIVE_CHALLENGE_HTML =
  "<html><head><title>Just a moment...</title></head><body>cType: 'non-interactive'</body></html>";
const SOLVED_HTML = "<html><head><title>Solved</title></head><body>ok</body></html>";

function makePage(
  overrides: Partial<PatchrightPage> & { readonly content: () => Promise<string> },
): PatchrightPage {
  const { content, ...rest } = overrides;
  return {
    goto: async () => null,
    content,
    url: () => "https://example.com",
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
    route: async () => undefined,
    close: async () => undefined,
    ...rest,
  };
}

describe("sdk browser challenge runtime", () => {
  it("detects managed Cloudflare interstitials from cType markup", () => {
    expect(
      detectCloudflareChallengeType(
        "<html><head><title>Just a moment...</title></head><body>cType: 'managed'</body></html>",
      ),
    ).toBe("managed");
  });

  it("detects embedded Turnstile widgets from the Cloudflare script tag", () => {
    expect(detectCloudflareChallengeType(EMBEDDED_CHALLENGE_HTML)).toBe("embedded");
  });

  it("keeps the solver disabled unless solveCloudflare is explicitly enabled", async () => {
    const resolution = await resolveBrowserChallenges({
      page: makePage({
        content: async () => EMBEDDED_CHALLENGE_HTML,
      }),
      pageContent: EMBEDDED_CHALLENGE_HTML,
      timeoutMs: 1_000,
    });

    expect(resolution.detected).toBe(false);
    expect(resolution.attemptCount).toBe(0);
    expect(resolution.warnings).toEqual([]);
  });

  it("waits through non-interactive interstitials until clearance is observed", async () => {
    let readCount = 0;

    const resolution = await resolveBrowserChallenges({
      page: makePage({
        content: async () => {
          readCount += 1;
          return readCount >= 3 ? SOLVED_HTML : NON_INTERACTIVE_CHALLENGE_HTML;
        },
      }),
      pageContent: NON_INTERACTIVE_CHALLENGE_HTML,
      timeoutMs: 1_000,
      challengeHandling: {
        solveCloudflare: true,
      },
    });

    expect(resolution).toMatchObject({
      detected: true,
      followUpNavigationRequired: true,
      challengeType: "non-interactive",
      resolutionKind: "wait",
      attemptCount: 0,
    });
    expect(resolution.warnings).toContain("cloudflare-solver:clearance-observed:non-interactive");
  });

  it("classifies pre-click auto-clear paths as wait-based clears instead of synthetic clicks", async () => {
    const resolution = await resolveBrowserChallenges({
      page: makePage({
        content: async () => SOLVED_HTML,
      }),
      pageContent: EMBEDDED_CHALLENGE_HTML,
      timeoutMs: 1_000,
      challengeHandling: {
        solveCloudflare: true,
      },
    });

    expect(resolution).toMatchObject({
      detected: true,
      followUpNavigationRequired: true,
      challengeType: "embedded",
      resolutionKind: "wait",
      attemptCount: 0,
    });
  });

  it("retries embedded Turnstile challenges until a later click clears the page", async () => {
    let clickCount = 0;

    const resolution = await resolveBrowserChallenges({
      page: makePage({
        content: async () => (clickCount >= 2 ? SOLVED_HTML : EMBEDDED_CHALLENGE_HTML),
        locator: () => ({
          last: () => ({
            boundingBox: async () => ({
              x: 100,
              y: 100,
              width: 40,
              height: 40,
            }),
          }),
          boundingBox: async () => ({
            x: 100,
            y: 100,
            width: 40,
            height: 40,
          }),
        }),
        mouse: {
          click: async () => {
            clickCount += 1;
          },
        },
      }),
      pageContent: EMBEDDED_CHALLENGE_HTML,
      timeoutMs: 2_000,
      maxAttempts: 2,
      challengeHandling: {
        solveCloudflare: true,
      },
    });

    expect(clickCount).toBe(2);
    expect(resolution).toMatchObject({
      detected: true,
      followUpNavigationRequired: true,
      challengeType: "embedded",
      resolutionKind: "click",
      attemptCount: 2,
    });
    expect(resolution.warnings).toEqual(
      expect.arrayContaining([
        "cloudflare-solver:click-dispatched:embedded",
        "cloudflare-solver:retrying:embedded",
        "cloudflare-solver:clearance-observed:embedded",
      ]),
    );
  });

  it("waits for Cloudflare markers that mount after the initial DOM read", async () => {
    let readCount = 0;
    let clickCount = 0;

    const resolution = await resolveBrowserChallenges({
      page: makePage({
        content: async () => {
          readCount += 1;
          if (clickCount >= 1) {
            return SOLVED_HTML;
          }

          return readCount >= 2
            ? EMBEDDED_CHALLENGE_HTML
            : "<html><head><title>Just a moment...</title></head><body>Booting challenge...</body></html>";
        },
        locator: () => ({
          last: () => ({
            boundingBox: async () => ({
              x: 100,
              y: 100,
              width: 40,
              height: 40,
            }),
          }),
          boundingBox: async () => ({
            x: 100,
            y: 100,
            width: 40,
            height: 40,
          }),
        }),
        mouse: {
          click: async () => {
            clickCount += 1;
          },
        },
      }),
      pageContent:
        "<html><head><title>Just a moment...</title></head><body>Booting challenge...</body></html>",
      timeoutMs: 2_000,
      challengeHandling: {
        solveCloudflare: true,
      },
    });

    expect(clickCount).toBe(1);
    expect(resolution).toMatchObject({
      detected: true,
      followUpNavigationRequired: true,
      challengeType: "embedded",
      resolutionKind: "click",
      attemptCount: 1,
    });
    expect(resolution.warnings).toContain(
      "cloudflare-solver:challenge-emerged-after-initial-dom-read",
    );
  });

  it("refreshes the current page when a weak interstitial clears before any explicit marker appears", async () => {
    let readCount = 0;

    const resolution = await resolveBrowserChallenges({
      page: makePage({
        content: async () => {
          readCount += 1;
          return readCount >= 2
            ? SOLVED_HTML
            : "<html><head><title>Just a moment...</title></head><body>Booting challenge...</body></html>";
        },
      }),
      pageContent:
        "<html><head><title>Just a moment...</title></head><body>Booting challenge...</body></html>",
      timeoutMs: 2_000,
      challengeHandling: {
        solveCloudflare: true,
      },
    });

    expect(resolution).toMatchObject({
      detected: false,
      followUpNavigationRequired: false,
      currentPageRefreshRequired: true,
      attemptCount: 0,
    });
    expect(resolution.warnings).toContain(
      "cloudflare-solver:weak-interstitial-cleared-before-marker-detection",
    );
  });

  it("retries early when a click changes the challenge state without clearing it yet", async () => {
    let clickCount = 0;

    const resolution = await resolveBrowserChallenges({
      page: makePage({
        content: async () => {
          if (clickCount === 0) {
            return EMBEDDED_CHALLENGE_HTML;
          }

          if (clickCount === 1) {
            return "<html><head><title>Just a moment...</title></head><body>cType: 'managed'</body></html>";
          }

          return SOLVED_HTML;
        },
        locator: () => ({
          last: () => ({
            boundingBox: async () => ({
              x: 100,
              y: 100,
              width: 40,
              height: 40,
            }),
          }),
          boundingBox: async () => ({
            x: 100,
            y: 100,
            width: 40,
            height: 40,
          }),
        }),
        mouse: {
          click: async () => {
            clickCount += 1;
          },
        },
      }),
      pageContent: EMBEDDED_CHALLENGE_HTML,
      timeoutMs: 2_000,
      maxAttempts: 2,
      challengeHandling: {
        solveCloudflare: true,
      },
    });

    expect(clickCount).toBe(2);
    expect(resolution.followUpNavigationRequired).toBe(true);
    expect(resolution.attemptCount).toBe(2);
    expect(resolution.warnings).toEqual(
      expect.arrayContaining([
        "cloudflare-solver:state-changed:managed",
        "cloudflare-solver:clearance-observed:managed",
      ]),
    );
  });

  it("retries transient content-read races while the challenge page is navigating", async () => {
    let clickCount = 0;
    let transientReadThrown = false;

    const resolution = await resolveBrowserChallenges({
      page: makePage({
        content: async () => {
          if (clickCount === 0) {
            return EMBEDDED_CHALLENGE_HTML;
          }

          if (!transientReadThrown) {
            transientReadThrown = true;
            throw new Error(
              "content: Unable to retrieve content because the page is navigating and changing the content.",
            );
          }

          return SOLVED_HTML;
        },
        locator: () => ({
          last: () => ({
            boundingBox: async () => ({
              x: 100,
              y: 100,
              width: 40,
              height: 40,
            }),
          }),
          boundingBox: async () => ({
            x: 100,
            y: 100,
            width: 40,
            height: 40,
          }),
        }),
        mouse: {
          click: async () => {
            clickCount += 1;
          },
        },
      }),
      pageContent: EMBEDDED_CHALLENGE_HTML,
      timeoutMs: 2_000,
      challengeHandling: {
        solveCloudflare: true,
      },
    });

    expect(clickCount).toBe(1);
    expect(resolution).toMatchObject({
      detected: true,
      followUpNavigationRequired: true,
      currentPageRefreshRequired: true,
      challengeType: "embedded",
      resolutionKind: "click",
      attemptCount: 1,
    });
    expect(resolution.warnings).toContain("cloudflare-solver:clearance-observed:embedded");
  });

  it("re-evaluates managed challenges after the verifying spinner settles before clicking", async () => {
    let readCount = 0;

    const resolution = await resolveBrowserChallenges({
      page: makePage({
        content: async () => {
          readCount += 1;
          return readCount >= 3
            ? SOLVED_HTML
            : "<html><head><title>Just a moment...</title></head><body>cType: 'managed' Verifying you are human.</body></html>";
        },
      }),
      pageContent:
        "<html><head><title>Just a moment...</title></head><body>cType: 'managed' Verifying you are human.</body></html>",
      timeoutMs: 1_000,
      challengeHandling: {
        solveCloudflare: true,
      },
    });

    expect(resolution).toMatchObject({
      detected: true,
      followUpNavigationRequired: true,
      challengeType: "managed",
      resolutionKind: "wait",
      attemptCount: 0,
    });
    expect(resolution.warnings).toContain("cloudflare-solver:clearance-observed:managed");
  });

  it("classifies missing challenge targets as no-progress instead of clearing optimistically", async () => {
    const resolution = await resolveBrowserChallenges({
      page: makePage({
        content: async () => EMBEDDED_CHALLENGE_HTML,
      }),
      pageContent: EMBEDDED_CHALLENGE_HTML,
      timeoutMs: 1_000,
      maxAttempts: 1,
      challengeHandling: {
        solveCloudflare: true,
      },
    });

    expect(resolution).toMatchObject({
      detected: true,
      followUpNavigationRequired: false,
      challengeType: "embedded",
      resolutionKind: "click",
      failureReason: "no-progress",
      attemptCount: 0,
    });
    expect(resolution.warnings).toContain("cloudflare-solver:target-missing:embedded");
  });

  it("requests a refresh when the challenge changes shape but still remains unresolved", async () => {
    let clickCount = 0;

    const resolution = await resolveBrowserChallenges({
      page: makePage({
        content: async () => {
          if (clickCount === 0) {
            return EMBEDDED_CHALLENGE_HTML;
          }

          return "<html><head><title>Just a moment...</title></head><body>cType: 'managed'</body></html>";
        },
        locator: () => ({
          last: () => ({
            boundingBox: async () => ({
              x: 100,
              y: 100,
              width: 40,
              height: 40,
            }),
          }),
          boundingBox: async () => ({
            x: 100,
            y: 100,
            width: 40,
            height: 40,
          }),
        }),
        mouse: {
          click: async () => {
            clickCount += 1;
          },
        },
      }),
      pageContent: EMBEDDED_CHALLENGE_HTML,
      timeoutMs: 2_000,
      maxAttempts: 1,
      challengeHandling: {
        solveCloudflare: true,
      },
    });

    expect(resolution).toMatchObject({
      detected: true,
      followUpNavigationRequired: false,
      currentPageRefreshRequired: true,
      challengeType: "managed",
      resolutionKind: "click",
      failureReason: "no-progress",
      attemptCount: 1,
    });
    expect(resolution.warnings).toContain("cloudflare-solver:state-changed:managed");
  });

  it("treats disappearing targets as clearance when the challenge vanishes during locator polling", async () => {
    let readCount = 0;

    const resolution = await resolveBrowserChallenges({
      page: makePage({
        content: async () => {
          readCount += 1;
          return readCount >= 2 ? SOLVED_HTML : EMBEDDED_CHALLENGE_HTML;
        },
      }),
      pageContent: EMBEDDED_CHALLENGE_HTML,
      timeoutMs: 1_000,
      challengeHandling: {
        solveCloudflare: true,
      },
    });

    expect(resolution).toMatchObject({
      detected: true,
      followUpNavigationRequired: true,
      challengeType: "embedded",
      resolutionKind: "wait",
      attemptCount: 0,
    });
    expect(resolution.warnings).not.toContain("cloudflare-solver:target-missing:embedded");
  });

  it("waits for the challenge target to mount before failing target-missing", async () => {
    let targetVisible = false;
    let clickCount = 0;

    const resolution = await resolveBrowserChallenges({
      page: makePage({
        content: async () => (clickCount >= 1 ? SOLVED_HTML : EMBEDDED_CHALLENGE_HTML),
        waitForTimeout: async () => {
          targetVisible = true;
        },
        locator: () =>
          targetVisible
            ? {
                last: () => ({
                  boundingBox: async () => ({
                    x: 100,
                    y: 100,
                    width: 40,
                    height: 40,
                  }),
                }),
                boundingBox: async () => ({
                  x: 100,
                  y: 100,
                  width: 40,
                  height: 40,
                }),
              }
            : {
                last: () => ({
                  boundingBox: async () => null,
                }),
                boundingBox: async () => null,
              },
        mouse: {
          click: async () => {
            clickCount += 1;
          },
        },
      }),
      pageContent: EMBEDDED_CHALLENGE_HTML,
      timeoutMs: 1_000,
      challengeHandling: {
        solveCloudflare: true,
      },
    });

    expect(clickCount).toBe(1);
    expect(resolution).toMatchObject({
      detected: true,
      followUpNavigationRequired: true,
      challengeType: "embedded",
      resolutionKind: "click",
      attemptCount: 1,
    });
  });

  it("classifies missing mouse support as unsupported-surface", async () => {
    const resolution = await resolveBrowserChallenges({
      page: makePage({
        content: async () => EMBEDDED_CHALLENGE_HTML,
        locator: () => ({
          last: () => ({
            boundingBox: async () => ({
              x: 100,
              y: 100,
              width: 40,
              height: 40,
            }),
          }),
          boundingBox: async () => ({
            x: 100,
            y: 100,
            width: 40,
            height: 40,
          }),
        }),
      }),
      pageContent: EMBEDDED_CHALLENGE_HTML,
      timeoutMs: 1_000,
      challengeHandling: {
        solveCloudflare: true,
      },
    });

    expect(resolution).toMatchObject({
      detected: true,
      followUpNavigationRequired: false,
      challengeType: "embedded",
      resolutionKind: "click",
      failureReason: "unsupported-surface",
      attemptCount: 0,
    });
    expect(resolution.warnings).toContain("cloudflare-solver:unsupported-page-api");
  });
});
