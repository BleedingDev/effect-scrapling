import { Effect, Layer, ServiceMap } from "effect";
import { type PatchrightPage } from "./browser-pool.ts";
import {
  DEFAULT_BROWSER_MEDIATION_POLICY,
  makeBrowserMediationPolicy,
  makeEmptyBrowserMediationOutcome,
  type BrowserMediationOutcome,
  type BrowserMediationPolicy,
  type BrowserNavigationSnapshot,
} from "./browser-mediation-model.ts";
import { resolveBrowserChallenges } from "./browser-challenge-runtime.ts";

const MINIMUM_CLOUDFLARE_SOLVER_TIMEOUT_MS = 60_000;

export type LegacyBrowserChallengeHandling = {
  readonly solveCloudflare?: boolean | undefined;
};

export type BrowserMediationResolution = {
  readonly policy: BrowserMediationPolicy;
  readonly outcome: BrowserMediationOutcome;
  readonly followUpNavigationRequired: boolean;
  readonly currentPageRefreshRequired: boolean;
  readonly postClearanceStrategy: BrowserMediationPolicy["postClearanceStrategy"];
  readonly warnings: ReadonlyArray<string>;
};

export function resolveEffectivePostClearanceStrategy(input: {
  readonly postClearanceStrategy: BrowserMediationPolicy["postClearanceStrategy"];
  readonly followUpNavigationRequired: boolean;
  readonly currentPageRefreshRequired: boolean;
}) {
  if (
    (input.followUpNavigationRequired || input.currentPageRefreshRequired) &&
    input.postClearanceStrategy === "reuse-current"
  ) {
    return "reload-target" as const;
  }

  return input.postClearanceStrategy;
}

export type BrowserMediationService = {
  readonly mediate: (input: {
    readonly page: PatchrightPage;
    readonly pageContent: string;
    readonly initialSnapshot: BrowserNavigationSnapshot;
    readonly timeoutMs: number;
    readonly challengeHandling?: LegacyBrowserChallengeHandling | undefined;
  }) => Effect.Effect<BrowserMediationResolution>;
};

export function resolveBrowserMediationPolicy(input: {
  readonly timeoutMs: number;
  readonly challengeHandling?: LegacyBrowserChallengeHandling | undefined;
}): BrowserMediationPolicy {
  if (input.challengeHandling?.solveCloudflare !== true) {
    return DEFAULT_BROWSER_MEDIATION_POLICY;
  }

  return makeBrowserMediationPolicy({
    mode: "solve",
    vendors: ["cloudflare"],
    maxAttempts: 4,
    timeBudgetMs: Math.max(input.timeoutMs, MINIMUM_CLOUDFLARE_SOLVER_TIMEOUT_MS),
    postClearanceStrategy: "reload-target",
    captureEvidence: true,
  });
}

function makeBrowserMediationRuntime(): BrowserMediationService {
  return {
    mediate: (input: {
      readonly page: PatchrightPage;
      readonly pageContent: string;
      readonly initialSnapshot: BrowserNavigationSnapshot;
      readonly timeoutMs: number;
      readonly challengeHandling?: LegacyBrowserChallengeHandling | undefined;
    }): Effect.Effect<BrowserMediationResolution> =>
      Effect.tryPromise({
        try: async () => {
          const policy = resolveBrowserMediationPolicy({
            timeoutMs: input.timeoutMs,
            challengeHandling: input.challengeHandling,
          });

          if (policy.mode !== "solve" || !policy.vendors.includes("cloudflare")) {
            return {
              policy,
              outcome: makeEmptyBrowserMediationOutcome(),
              followUpNavigationRequired: false,
              currentPageRefreshRequired: false,
              postClearanceStrategy: policy.postClearanceStrategy,
              warnings: [],
            };
          }

          const resolution = await resolveBrowserChallenges({
            page: input.page,
            pageContent: input.pageContent,
            timeoutMs: policy.timeBudgetMs,
            maxAttempts: policy.maxAttempts,
            challengeHandling: input.challengeHandling,
          });

          if (!resolution.detected) {
            const effectivePostClearanceStrategy = resolveEffectivePostClearanceStrategy({
              postClearanceStrategy: policy.postClearanceStrategy,
              followUpNavigationRequired: resolution.followUpNavigationRequired,
              currentPageRefreshRequired: resolution.currentPageRefreshRequired,
            });
            const effectiveFollowUpNavigationRequired =
              resolution.followUpNavigationRequired ||
              (resolution.currentPageRefreshRequired &&
                effectivePostClearanceStrategy === "reload-target");
            const warnings =
              effectivePostClearanceStrategy === policy.postClearanceStrategy
                ? resolution.warnings
                : [
                    ...resolution.warnings,
                    "cloudflare-solver:post-clearance-strategy-fallback:reload-target",
                  ];
            return {
              policy,
              outcome: makeEmptyBrowserMediationOutcome(),
              followUpNavigationRequired: effectiveFollowUpNavigationRequired,
              currentPageRefreshRequired:
                resolution.currentPageRefreshRequired && !effectiveFollowUpNavigationRequired,
              postClearanceStrategy: effectivePostClearanceStrategy,
              warnings,
            };
          }

          const effectivePostClearanceStrategy = resolveEffectivePostClearanceStrategy({
            postClearanceStrategy: policy.postClearanceStrategy,
            followUpNavigationRequired: resolution.followUpNavigationRequired,
            currentPageRefreshRequired: resolution.currentPageRefreshRequired,
          });
          const effectiveFollowUpNavigationRequired =
            resolution.followUpNavigationRequired ||
            (resolution.currentPageRefreshRequired &&
              effectivePostClearanceStrategy === "reload-target");
          const warnings =
            effectivePostClearanceStrategy === policy.postClearanceStrategy
              ? resolution.warnings
              : [
                  ...resolution.warnings,
                  "cloudflare-solver:post-clearance-strategy-fallback:reload-target",
                ];

          return {
            policy,
            outcome: {
              kind: "challenge",
              status: effectiveFollowUpNavigationRequired ? "cleared" : "unresolved",
              vendor: "cloudflare",
              ...(resolution.resolutionKind === undefined
                ? {}
                : { resolutionKind: resolution.resolutionKind }),
              ...(effectiveFollowUpNavigationRequired || resolution.failureReason === undefined
                ? {}
                : { failureReason: resolution.failureReason }),
              attemptCount: resolution.attemptCount,
              evidence: {
                preNavigation: input.initialSnapshot,
                signals: warnings,
              },
              timings: {},
            },
            followUpNavigationRequired: effectiveFollowUpNavigationRequired,
            currentPageRefreshRequired:
              resolution.currentPageRefreshRequired && !effectiveFollowUpNavigationRequired,
            postClearanceStrategy: effectivePostClearanceStrategy,
            warnings,
          };
        },
        catch: (error) => {
          throw error;
        },
      }),
  } satisfies BrowserMediationService;
}

export function makeBrowserMediationService(): BrowserMediationService {
  return makeBrowserMediationRuntime();
}

export class BrowserMediationRuntime extends ServiceMap.Service<
  BrowserMediationRuntime,
  BrowserMediationService
>()("@effect-scrapling/sdk/BrowserMediationRuntime") {}

export const BrowserMediationRuntimeLive = Layer.succeed(
  BrowserMediationRuntime,
  makeBrowserMediationService(),
);
