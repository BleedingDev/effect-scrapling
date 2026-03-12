import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "@effect-native/bun-test";
import { mock } from "bun:test";
import { Effect, Schema } from "effect";
import { visibleProgressWidth } from "../../scripts/benchmarks/progress-line.ts";
import {
  E9BenchmarkSuiteArtifactSchema,
  type E9BenchmarkSuiteProgressEvent,
  mergeE9BenchmarkArtifacts,
  runE9BenchmarkSuite,
} from "../../src/e9-benchmark-suite.ts";
import { E9HighFrictionCanaryArtifactSchema } from "../../src/e9-high-friction-canary.ts";
import { E9ScraplingParityArtifactSchema } from "../../src/e9-scrapling-parity.ts";
import { resetBrowserPoolForTests } from "../../src/sdk/browser-pool.ts";
import {
  formatE9BenchmarkSuiteProgressEvent,
  parseOptions,
  runE9BenchmarkSuiteCli,
} from "../../scripts/benchmarks/e9-benchmark-suite.ts";

describe("e9 benchmark suite", () => {
  it("parses CLI options", () => {
    expect(
      parseOptions([
        "--artifact",
        "tmp/e9-benchmark-suite.json",
        "--corpus",
        "tmp/frozen-corpus.json",
        "--preset",
        "fast-regression",
        "--phases",
        "http,browser",
        "--http-profiles",
        "effect-http,native-fetch",
        "--browser-profiles",
        "patchright-browser",
        "--http-concurrency",
        "1,4,16",
        "--browser-concurrency",
        "1,2,4",
        "--http-timeout",
        "12000",
        "--browser-timeout",
        "20000",
        "--sample-size",
        "128",
        "--sample-seed",
        "bench-seed",
        "--shard-count",
        "4",
        "--shard-index",
        "2",
        "--adaptive-stop",
        "--progress",
        "compact",
        "--progress-width",
        "120",
        "--force-color",
      ]),
    ).toEqual({
      artifactPath: "tmp/e9-benchmark-suite.json",
      corpusArtifactPath: "tmp/frozen-corpus.json",
      preset: "fast-regression",
      phases: ["http", "browser"],
      httpProfiles: ["effect-http", "native-fetch"],
      browserProfiles: ["patchright-browser"],
      httpConcurrency: [1, 4, 16],
      browserConcurrency: [1, 2, 4],
      httpTimeoutMs: 12_000,
      browserTimeoutMs: 20_000,
      samplePageCount: 128,
      sampleSeed: "bench-seed",
      shardCount: 4,
      shardIndex: 2,
      adaptiveStop: true,
      progressMode: "compact",
      progressWidth: 120,
      forceColor: true,
    });
  });

  it("parses artifact jsonl CLI options", () => {
    expect(
      parseOptions([
        "--artifact",
        "tmp/e9-benchmark-suite.json",
        "--artifact-jsonl",
        "tmp/e9-benchmark-suite.jsonl",
        "--no-artifact-jsonl",
      ]),
    ).toEqual({
      artifactPath: "tmp/e9-benchmark-suite.json",
      artifactJsonlPath: "tmp/e9-benchmark-suite.jsonl",
      artifactJsonlEnabled: false,
    });
  });

  it("parses explicit adaptive stop disable", () => {
    expect(parseOptions(["--preset", "scale-study", "--no-adaptive-stop"])).toEqual({
      preset: "scale-study",
      adaptiveStop: false,
    });
  });

  it("builds a schema-valid artifact from deterministic synthetic runners", async () => {
    const pages = [
      {
        siteId: "site-alpha",
        domain: "alpha.example",
        kind: "retailer",
        state: "healthy",
        url: "https://alpha.example/p/1",
        pageType: "product",
        title: "Alpha Product",
        challengeSignals: [],
      },
      {
        siteId: "site-beta",
        domain: "beta.example",
        kind: "aggregator",
        state: "partial",
        url: "https://beta.example/search?q=tesla",
        pageType: "search",
        title: "Beta Search",
        challengeSignals: ["bot"],
      },
    ] as const;

    const makeParity = () =>
      Schema.decodeUnknownSync(E9ScraplingParityArtifactSchema)({
        benchmark: "e9-scrapling-parity",
        comparisonId: "comparison-e9-synthetic",
        generatedAt: "2026-03-09T22:00:00.000Z",
        caseCount: 1,
        measurementMode: "fixture-corpus-postcapture",
        scraplingRuntime: {
          scraplingVersion: "0.4.1",
          parserAvailable: true,
          fetcherAvailable: false,
          fetcherDiagnostic: "synthetic",
        },
        summary: {
          ours: {
            measurementMode: "fixture-corpus-postcapture",
            fetchSuccessRate: 1,
            extractionCompleteness: 1,
            bypassSuccessRate: 1,
          },
          scrapling: {
            measurementMode: "fixture-corpus-postcapture",
            fetchSuccessRate: 1,
            extractionCompleteness: 1,
            bypassSuccessRate: 1,
          },
          equalOrBetter: {
            fetchSuccess: true,
            extractionCompleteness: true,
            bypassSuccess: true,
          },
        },
        cases: [
          {
            caseId: "case-e9-synthetic",
            retailer: "datart",
            ourCompleteness: 1,
            scraplingCompleteness: 1,
            ourFetchSuccess: true,
            scraplingFetchSuccess: true,
            ourBypassSuccess: true,
            scraplingBypassSuccess: true,
            valueAgreement: true,
            matchedSelectors: ["title"],
          },
        ],
        status: "pass",
      });

    const makeCanary = () =>
      Schema.decodeUnknownSync(E9HighFrictionCanaryArtifactSchema)({
        benchmark: "e9-high-friction-canary",
        suiteId: "suite-e9-high-friction-canary",
        generatedAt: "2026-03-09T22:00:00.000Z",
        status: "pass",
        summary: {
          scenarioCount: 1,
          browserEscalationRate: 1,
          bypassSuccessRate: 1,
          policyViolationCount: 0,
          promotionVerdict: "promote",
        },
        results: [
          {
            caseId: "case-e9-synthetic",
            retailer: "datart",
            provider: "browser",
            action: "active",
            status: "pass",
            requiresBypass: true,
            bypassQualified: true,
            policyCompliant: true,
          },
        ],
        liveCanary: {
          benchmark: "e7-live-canary",
          suiteId: "suite-live-canary",
          generatedAt: "2026-03-09T22:00:00.000Z",
          status: "pass",
          summary: {
            scenarioCount: 1,
            passedScenarioCount: 1,
            failedScenarioIds: [],
            verdict: "promote",
          },
          results: [
            {
              scenarioId: "scenario-e9-synthetic",
              authorizationId: "auth-e9-synthetic",
              provider: "browser",
              action: "active",
              failedStages: [],
              status: "pass",
              plannerRationale: [
                {
                  key: "capture-path",
                  message: "synthetic",
                },
              ],
            },
          ],
        },
      });

    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        httpConcurrency: [1, 2],
        browserConcurrency: [1],
      },
      {
        pages,
        httpProfileFactories: [
          {
            profile: "effect-http",
            createRunner: async () => ({
              runPage: async (page) => ({
                statusCode: 200,
                redirected: false,
                challengeDetected: page.challengeSignals.length > 0,
                observedChallengeSignals: [...page.challengeSignals],
                durationMs: page.pageType === "product" ? 100 : 300,
                contentBytes: page.pageType === "product" ? 8_000 : 12_000,
                titlePresent: page.pageType === "product",
                finalUrl: page.url,
              }),
              close: async () => undefined,
            }),
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async () => ({
                statusCode: 200,
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 500,
                contentBytes: 20_000,
                titlePresent: true,
                finalUrl: "https://synthetic.example/final",
              }),
              close: async () => undefined,
            }),
          },
        ],
        scraplingParityRunner: async () => makeParity(),
        highFrictionCanaryRunner: async () => makeCanary(),
      },
    );

    const decoded = Schema.decodeUnknownSync(E9BenchmarkSuiteArtifactSchema)(artifact);
    expect(decoded.benchmark).toBe("e9-benchmark-suite");
    expect(decoded.corpus.selectedPageCount).toBe(2);
    expect(decoded.httpCorpus.sweeps).toHaveLength(2);
    expect(decoded.httpCorpus.sweeps[0]?.concurrency).toBe(1);
    expect(decoded.httpCorpus.sweeps[0]?.parallelEfficiency).toBe(1);
    expect(decoded.httpCorpus.attempts[0]?.timings.totalWallMs).toBe(100);
    expect(decoded.httpCorpus.sweeps[0]?.timings.totalWallMs.count).toBe(2);
    expect(decoded.httpCorpus.sweeps[0]?.timings.overheadMs.mean).toBe(0);
    expect(decoded.httpCorpus.sweeps[1]?.parallelEfficiency).toBeLessThanOrEqual(1);
    expect(decoded.browserCorpus.sweeps).toHaveLength(1);
    expect(decoded.scraplingParity.artifact?.status).toBe("pass");
    expect(decoded.highFrictionCanary.artifact?.status).toBe("pass");
  });

  it("decodes legacy artifacts that do not yet carry top remote failure categories", async () => {
    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        phases: ["http"],
        httpConcurrency: [1],
      },
      {
        pages: [
          {
            siteId: "site-alpha",
            domain: "alpha.example",
            kind: "retailer",
            state: "healthy",
            url: "https://alpha.example/p/1",
            pageType: "product",
            title: "Alpha Product",
            challengeSignals: [],
          },
        ],
        httpProfileFactories: [
          {
            profile: "effect-http",
            createRunner: async () => ({
              runPage: async () => ({
                statusCode: 200,
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 10,
                contentBytes: 1_024,
                titlePresent: true,
                finalUrl: "https://alpha.example/p/1",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    const legacyArtifact = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    const summary = legacyArtifact.summary as Record<string, unknown> | undefined;
    expect(summary).toBeDefined();
    delete summary?.topRemoteFailureCategories;
    delete summary?.topRemoteFailureDomains;

    const decoded = Schema.decodeUnknownSync(E9BenchmarkSuiteArtifactSchema)(legacyArtifact);
    expect(decoded.summary?.topRemoteFailureCategories).toBeUndefined();
    expect(decoded.summary?.topRemoteFailureDomains).toBeUndefined();

    const recommendations = decoded.recommendations ?? [];
    expect(recommendations).toContain("Prioritize diagnostics for alpha.example.");
  });

  it("treats skipped subbenchmarks as neutral for fast regression presets", async () => {
    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        preset: "fast-regression",
      },
      {
        pages: [
          {
            siteId: "site-alpha",
            domain: "alpha.example",
            kind: "retailer",
            state: "healthy",
            url: "https://alpha.example/p/1",
            pageType: "product",
            title: "Alpha Product",
            challengeSignals: [],
          },
        ],
        httpProfileFactories: [
          {
            profile: "effect-http",
            createRunner: async () => ({
              runPage: async (page) => ({
                statusCode: 200,
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 25,
                contentBytes: 1_024,
                titlePresent: true,
                finalUrl: page.url,
              }),
              close: async () => undefined,
            }),
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async (page) => ({
                statusCode: 200,
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 50,
                contentBytes: 2_048,
                titlePresent: true,
                finalUrl: page.url,
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.status).toBe("pass");
    expect(artifact.scraplingParity.totalWallMs).toBe(0);
    expect(artifact.scraplingParity.skipped).toBe(true);
    expect(artifact.scraplingParity.artifact).toBeUndefined();
    expect(artifact.highFrictionCanary.totalWallMs).toBe(0);
    expect(artifact.highFrictionCanary.skipped).toBe(true);
    expect(artifact.highFrictionCanary.artifact).toBeUndefined();
    expect(artifact.summary?.skippedPhases).toEqual(["scrapling", "canary"]);
    expect(artifact.warnings).toContain("Skipped phases: scrapling, canary.");
  });

  it("emits suite summary and classifies browser failures", async () => {
    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        phases: ["browser"],
        browserProfiles: ["patchright-browser"],
        browserConcurrency: [1],
      },
      {
        pages: [
          {
            siteId: "site-alpha",
            domain: "alpha.example",
            kind: "retailer",
            state: "healthy",
            url: "https://alpha.example/p/1",
            pageType: "product",
            title: "Alpha Product",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "patchright-browser",
            createRunner: async () => ({
              runPage: async () => ({
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 50,
                contentBytes: 0,
                titlePresent: false,
                error: "patchright navigation failed: Timeout 30000ms exceeded",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.attempts[0]?.failureCategory).toBe("browser-navigation-timeout");
    expect(artifact.summary?.browserAttemptCount).toBe(1);
    expect(artifact.summary?.topBrowserFailureCategories[0]).toEqual({
      key: "browser-navigation-timeout",
      count: 1,
    });
    expect(artifact.summary?.skippedPhases).toContain("http");
    expect(artifact.recommendations).toContain(
      "Review browser failure categories and top failing domains before treating browser fallback as production-ready.",
    );
  });

  it("classifies consent walls into a dedicated benchmark failure category even when they return 403", async () => {
    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        phases: ["browser"],
        browserProfiles: ["effect-browser"],
        browserConcurrency: [1],
      },
      {
        pages: [
          {
            siteId: "site-consent",
            domain: "zbozi.example",
            kind: "aggregator",
            state: "partial",
            url: "https://zbozi.example/search?q=chair",
            pageType: "search",
            title: "Search",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async () => ({
                statusCode: 403,
                redirected: true,
                challengeDetected: true,
                observedChallengeSignals: [
                  "status-403",
                  "text-consent",
                  "title-consent",
                  "url-consent",
                ],
                durationMs: 50,
                contentBytes: 20_000,
                titlePresent: true,
                finalUrl: "https://cmp.example.test/consent?returnUrl=%2Fsearch",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.attempts[0]?.failureCategory).toBe("access-wall-consent");
    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall-consent",
      count: 1,
    });
    expect(artifact.summary?.topBrowserFailureCategories[0]).toEqual({
      key: "access-wall-consent",
      count: 1,
    });
    expect(artifact.recommendations).toContain(
      "Top remote failures are consent walls; prioritize consent-screen detection and domain-aware handling before judging fallback quality.",
    );
  });

  it("uses remote failure categories for consent recommendations even without browser attempts", async () => {
    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        phases: ["http"],
        httpProfiles: ["effect-http"],
        httpConcurrency: [1],
      },
      {
        pages: [
          {
            siteId: "site-http-consent",
            domain: "zbozi.example",
            kind: "aggregator",
            state: "partial",
            url: "https://zbozi.example/search?q=chair",
            pageType: "search",
            title: "Search",
            challengeSignals: [],
          },
        ],
        httpProfileFactories: [
          {
            profile: "effect-http",
            createRunner: async () => ({
              runPage: async () => ({
                statusCode: 403,
                redirected: true,
                challengeDetected: true,
                observedChallengeSignals: ["status-403", "text-consent", "url-consent"],
                durationMs: 50,
                contentBytes: 0,
                titlePresent: false,
                finalUrl: "https://cmp.example.test/consent?returnUrl=%2Fsearch",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.httpCorpus.attempts[0]?.failureCategory).toBe("access-wall-consent");
    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall-consent",
      count: 1,
    });
    expect(artifact.recommendations).toContain("Prioritize diagnostics for zbozi.example.");
    expect(artifact.recommendations).toContain(
      "Top remote failures are consent walls; prioritize consent-screen detection and domain-aware handling before judging fallback quality.",
    );
  });

  it("classifies trap interstitials separately from generic empty-content failures", async () => {
    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        phases: ["browser"],
        browserProfiles: ["effect-browser"],
        browserConcurrency: [1],
      },
      {
        pages: [
          {
            siteId: "site-trap",
            domain: "datart.example",
            kind: "retailer",
            state: "partial",
            url: "https://datart.example/category/televize",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async () => ({
                statusCode: 200,
                redirected: false,
                challengeDetected: true,
                observedChallengeSignals: ["url-trap"],
                durationMs: 50,
                contentBytes: 0,
                titlePresent: false,
                finalUrl: "https://datart.example/TSPD/?type=25",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.attempts[0]?.failureCategory).toBe("access-wall-trap");
    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall-trap",
      count: 1,
    });
    expect(artifact.summary?.topBrowserFailureCategories[0]).toEqual({
      key: "access-wall-trap",
      count: 1,
    });
    expect(artifact.recommendations).toContain(
      "Top remote failures are trap or interstitial endpoints; recognize and bail out on known trap URLs before treating them as generic content failures.",
    );
  });

  it("infers rate-limit walls from status codes even when runner warnings are missing", async () => {
    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        phases: ["http"],
        httpProfiles: ["effect-http"],
        httpConcurrency: [1],
      },
      {
        pages: [
          {
            siteId: "site-rate-limit",
            domain: "glami.example",
            kind: "aggregator",
            state: "partial",
            url: "https://glami.example/bench",
            pageType: "listing",
            title: "Bench",
            challengeSignals: [],
          },
        ],
        httpProfileFactories: [
          {
            profile: "effect-http",
            createRunner: async () => ({
              runPage: async () => ({
                statusCode: 429,
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 50,
                contentBytes: 1_024,
                titlePresent: true,
                finalUrl: "https://glami.example/bench",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.httpCorpus.attempts[0]?.success).toBe(false);
    expect(artifact.httpCorpus.attempts[0]?.challengeDetected).toBe(true);
    expect(artifact.httpCorpus.attempts[0]?.observedChallengeSignals).toEqual(["status-429"]);
    expect(artifact.httpCorpus.attempts[0]?.failureCategory).toBe("access-wall-rate-limit");
    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall-rate-limit",
      count: 1,
    });
    expect(artifact.recommendations).toContain(
      "Top remote failures are rate limits; review pacing, concurrency and egress rotation before comparing site success rates.",
    );
  });

  it("separates local config failures from remote browser failures in summary metrics", async () => {
    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        phases: ["browser"],
        browserProfiles: ["effect-browser"],
        browserConcurrency: [1],
      },
      {
        pages: [
          {
            siteId: "site-alpha",
            domain: "alpha.example",
            kind: "retailer",
            state: "healthy",
            url: "https://alpha.example/p/1",
            pageType: "product",
            title: "Alpha Product",
            challengeSignals: [],
          },
          {
            siteId: "site-beta",
            domain: "beta.example",
            kind: "retailer",
            state: "healthy",
            url: "https://beta.example/p/2",
            pageType: "product",
            title: "Beta Product",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async (page) =>
                page.siteId === "site-alpha"
                  ? {
                      redirected: false,
                      challengeDetected: false,
                      observedChallengeSignals: [],
                      durationMs: 0.5,
                      contentBytes: 0,
                      titlePresent: false,
                      error:
                        'Browser access failed for https://alpha.example/p/1 :: Plugin "builtin-http-connect-egress" requires a non-empty "proxyUrl" value.',
                      executionMetadata: {
                        source: "planned",
                        providerId: "browser-basic",
                        mode: "browser",
                        egressProfileId: "http-connect",
                        egressPluginId: "builtin-http-connect-egress",
                        egressRouteKind: "http-connect",
                        egressRouteKey: "http-connect",
                        egressPoolId: "http-connect-pool",
                        egressRoutePolicyId: "http-connect-route",
                        identityProfileId: "default",
                        identityPluginId: "builtin-default-identity",
                        identityTenantId: "public",
                        browserRuntimeProfileId: "patchright-default",
                      },
                      warnings: [
                        'Skipped implicit egress auto-selection for profiles requiring explicit plugin config: "http-connect".',
                      ],
                    }
                  : {
                      statusCode: 200,
                      redirected: false,
                      challengeDetected: false,
                      observedChallengeSignals: [],
                      durationMs: 120,
                      contentBytes: 2_048,
                      titlePresent: true,
                      finalUrl: page.url,
                      executionMetadata: {
                        source: "executed",
                        providerId: "browser-basic",
                        mode: "browser",
                        egressProfileId: "direct",
                        egressPluginId: "builtin-direct-egress",
                        egressRouteKind: "direct",
                        egressRouteKey: "direct",
                        egressPoolId: "direct-pool",
                        egressRoutePolicyId: "direct-route",
                        egressKey: "direct",
                        identityProfileId: "default",
                        identityPluginId: "builtin-default-identity",
                        identityTenantId: "public",
                        identityKey: "default",
                        browserRuntimeProfileId: "patchright-default",
                        browserPoolKey: "browser-basic::patchright-default::direct::default",
                      },
                    },
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.attempts[0]?.failureCategory).toBe("local-egress-config");
    expect(artifact.browserCorpus.attempts[0]?.executionMetadata?.egressPluginId).toBe(
      "builtin-http-connect-egress",
    );
    expect(artifact.browserCorpus.attempts[0]?.warnings).toContain(
      'Skipped implicit egress auto-selection for profiles requiring explicit plugin config: "http-connect".',
    );
    expect(artifact.browserCorpus.sweeps[0]?.localFailureCount).toBe(1);
    expect(artifact.browserCorpus.sweeps[0]?.effectiveAttemptCount).toBe(1);
    expect(artifact.browserCorpus.sweeps[0]?.effectiveSuccessRate).toBe(1);
    expect(artifact.browserCorpus.sweeps[0]?.bySite[0]?.key).toBe("site-alpha (alpha.example)");
    expect(artifact.summary?.browserLocalFailureCount).toBe(1);
    expect(artifact.summary?.browserEffectiveSuccessRate).toBe(1);
    expect(artifact.summary?.topLocalFailureCategories[0]).toEqual({
      key: "local-egress-config",
      count: 1,
    });
    expect(artifact.warnings).toContain(
      "Local configuration or planning failures affected 1 attempts; raw throughput and success metrics are partially invalidated.",
    );
    expect(artifact.recommendations).toContain(
      "Fix local selection/plugin configuration failures before comparing remote-site success or throughput across browser sweeps.",
    );
  });

  it("surfaces recovered browser allocation faults as warnings and summary metrics", async () => {
    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        phases: ["browser"],
        browserProfiles: ["effect-browser"],
        browserConcurrency: [1],
      },
      {
        pages: [
          {
            siteId: "site-alpha",
            domain: "alpha.example",
            kind: "retailer",
            state: "healthy",
            url: "https://alpha.example/p/1",
            pageType: "product",
            title: "Alpha Product",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async (page) => ({
                statusCode: 200,
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 42,
                contentBytes: 2_048,
                titlePresent: true,
                finalUrl: page.url,
                warnings: [
                  "Recovered browser allocation after retryable protocol error: Protocol error (Page.enable): Internal server error, session closed.",
                ],
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.attempts[0]?.warnings).toContain(
      "Recovered browser allocation after retryable protocol error: Protocol error (Page.enable): Internal server error, session closed.",
    );
    expect(artifact.browserCorpus.sweeps[0]?.recoveredBrowserAllocationCount).toBe(1);
    expect(artifact.summary?.browserRecoveredBrowserAllocationCount).toBe(1);
    expect(artifact.warnings).toContain(
      "Recovered browser allocation protocol faults occurred 1 times; browser runtime retried successfully but engine stability noise is present.",
    );
    expect(artifact.recommendations).toContain(
      "Inspect Patchright/Chromium page-allocation stability and recovered protocol faults before trusting browser-lane reliability trends.",
    );
  });

  it("counts recovered browser allocation faults even when the attempt later fails", async () => {
    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        phases: ["browser"],
        browserProfiles: ["effect-browser"],
        browserConcurrency: [1],
      },
      {
        pages: [
          {
            siteId: "site-alpha",
            domain: "alpha.example",
            kind: "retailer",
            state: "healthy",
            url: "https://alpha.example/p/1",
            pageType: "product",
            title: "Alpha Product",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async () => ({
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 42,
                contentBytes: 0,
                titlePresent: false,
                error:
                  "Browser access failed for https://alpha.example/p/1 :: navigation: net::ERR_CONNECTION_RESET",
                warnings: [
                  "Recovered browser allocation after retryable protocol error: Protocol error (Page.enable): Internal server error, session closed.",
                ],
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.attempts[0]?.success).toBe(false);
    expect(artifact.browserCorpus.attempts[0]?.warnings).toContain(
      "Recovered browser allocation after retryable protocol error: Protocol error (Page.enable): Internal server error, session closed.",
    );
    expect(artifact.browserCorpus.sweeps[0]?.recoveredBrowserAllocationCount).toBe(1);
    expect(artifact.summary?.browserRecoveredBrowserAllocationCount).toBe(1);
  });

  it("uses effective sweep success when local selection failures would otherwise drag raw success below threshold", async () => {
    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        phases: ["browser"],
        browserProfiles: ["effect-browser"],
        browserConcurrency: [1],
      },
      {
        pages: [
          {
            siteId: "site-alpha",
            domain: "alpha.example",
            kind: "retailer",
            state: "healthy",
            url: "https://alpha.example/p/1",
            pageType: "product",
            title: "Alpha Product",
            challengeSignals: [],
          },
          {
            siteId: "site-beta",
            domain: "beta.example",
            kind: "retailer",
            state: "healthy",
            url: "https://beta.example/p/2",
            pageType: "product",
            title: "Beta Product",
            challengeSignals: [],
          },
          {
            siteId: "site-gamma",
            domain: "gamma.example",
            kind: "retailer",
            state: "healthy",
            url: "https://gamma.example/p/3",
            pageType: "product",
            title: "Gamma Product",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async (page) =>
                page.siteId === "site-gamma"
                  ? {
                      statusCode: 200,
                      redirected: false,
                      challengeDetected: false,
                      observedChallengeSignals: [],
                      durationMs: 35,
                      contentBytes: 1_024,
                      titlePresent: true,
                      finalUrl: page.url,
                    }
                  : {
                      redirected: false,
                      challengeDetected: false,
                      observedChallengeSignals: [],
                      durationMs: 0.5,
                      contentBytes: 0,
                      titlePresent: false,
                      error: `Browser access failed for ${page.url} :: Unknown egress profile :: No egress profile named missing-egress.`,
                    },
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(
      artifact.browserCorpus.attempts.filter(
        (attempt) => attempt.failureCategory === "local-selection",
      ).length,
    ).toBe(2);
    expect(artifact.browserCorpus.sweeps[0]?.successRate).toBeCloseTo(0.333, 3);
    expect(artifact.browserCorpus.sweeps[0]?.effectiveAttemptCount).toBe(1);
    expect(artifact.browserCorpus.sweeps[0]?.effectiveSuccessRate).toBe(1);
    expect(artifact.summary?.topLocalFailureCategories[0]).toEqual({
      key: "local-selection",
      count: 2,
    });
    expect(artifact.status).toBe("warn");
  });

  it("uses a fresh generatedAt timestamp when none is provided", async () => {
    const artifact = await runE9BenchmarkSuite(
      {
        phases: ["http"],
        httpConcurrency: [1],
      },
      {
        pages: [
          {
            siteId: "site-alpha",
            domain: "alpha.example",
            kind: "retailer",
            state: "healthy",
            url: "https://alpha.example/p/1",
            pageType: "product",
            title: "Alpha Product",
            challengeSignals: [],
          },
        ],
        httpProfileFactories: [
          {
            profile: "effect-http",
            createRunner: async () => ({
              runPage: async () => ({
                statusCode: 200,
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 25,
                contentBytes: 1_024,
                titlePresent: true,
                finalUrl: "https://alpha.example/p/1",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.generatedAt).toMatch(/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u);
    expect(artifact.generatedAt).not.toBe("2026-03-09T22:00:00.000Z");
  });

  it("interleaves sweep ordering across domains instead of clustering one site together", async () => {
    const observedDomains = new Array<string>();

    await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        phases: ["http"],
        httpConcurrency: [1],
      },
      {
        pages: [
          {
            siteId: "site-alpha",
            domain: "alpha.example",
            kind: "retailer",
            state: "healthy",
            url: "https://alpha.example/p/1",
            pageType: "product",
            title: "Alpha Product 1",
            challengeSignals: [],
          },
          {
            siteId: "site-alpha",
            domain: "alpha.example",
            kind: "retailer",
            state: "healthy",
            url: "https://alpha.example/p/2",
            pageType: "product",
            title: "Alpha Product 2",
            challengeSignals: [],
          },
          {
            siteId: "site-beta",
            domain: "beta.example",
            kind: "retailer",
            state: "healthy",
            url: "https://beta.example/p/1",
            pageType: "product",
            title: "Beta Product 1",
            challengeSignals: [],
          },
          {
            siteId: "site-beta",
            domain: "beta.example",
            kind: "retailer",
            state: "healthy",
            url: "https://beta.example/p/2",
            pageType: "product",
            title: "Beta Product 2",
            challengeSignals: [],
          },
          {
            siteId: "site-gamma",
            domain: "gamma.example",
            kind: "retailer",
            state: "healthy",
            url: "https://gamma.example/p/1",
            pageType: "product",
            title: "Gamma Product 1",
            challengeSignals: [],
          },
        ],
        httpProfileFactories: [
          {
            profile: "effect-http",
            createRunner: async () => ({
              runPage: async (page) => {
                observedDomains.push(page.domain);
                return {
                  statusCode: 200,
                  redirected: false,
                  challengeDetected: false,
                  observedChallengeSignals: [],
                  durationMs: 20,
                  contentBytes: 1_024,
                  titlePresent: true,
                  finalUrl: page.url,
                };
              },
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(observedDomains).toHaveLength(5);
    expect(new Set(observedDomains.slice(0, 3)).size).toBe(3);
    expect(observedDomains[0]).not.toBe(observedDomains[1]);
    expect(observedDomains[1]).not.toBe(observedDomains[2]);
    expect(observedDomains[2]).not.toBe(observedDomains[3]);
  });

  it("classifies enriched browser navigation detail strings into connection failures", async () => {
    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        phases: ["browser"],
        browserProfiles: ["effect-browser"],
        browserConcurrency: [1],
      },
      {
        pages: [
          {
            siteId: "site-alpha",
            domain: "alpha.example",
            kind: "retailer",
            state: "healthy",
            url: "https://alpha.example/p/1",
            pageType: "product",
            title: "Alpha Product",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async () => ({
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 50,
                contentBytes: 0,
                titlePresent: false,
                error:
                  "Browser access failed for https://alpha.example/p/1 :: navigation: Error: net::ERR_NAME_NOT_RESOLVED",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.attempts[0]?.failureCategory).toBe(
      "browser-navigation-connection",
    );
  });

  it("samples pages deterministically with stratified metadata", async () => {
    const pages = [
      {
        siteId: "site-alpha",
        domain: "alpha.example",
        kind: "retailer",
        state: "healthy",
        url: "https://alpha.example/p/1",
        pageType: "product",
        title: "Alpha Product 1",
        challengeSignals: [],
      },
      {
        siteId: "site-alpha",
        domain: "alpha.example",
        kind: "retailer",
        state: "healthy",
        url: "https://alpha.example/p/2",
        pageType: "listing",
        title: "Alpha Listing",
        challengeSignals: [],
      },
      {
        siteId: "site-beta",
        domain: "beta.example",
        kind: "aggregator",
        state: "partial",
        url: "https://beta.example/search?q=tesla",
        pageType: "search",
        title: "Beta Search",
        challengeSignals: ["bot"],
      },
      {
        siteId: "site-beta",
        domain: "beta.example",
        kind: "aggregator",
        state: "partial",
        url: "https://beta.example/o/1",
        pageType: "offer",
        title: "Beta Offer",
        challengeSignals: [],
      },
      {
        siteId: "site-gamma",
        domain: "gamma.example",
        kind: "retailer",
        state: "healthy",
        url: "https://gamma.example/u/1",
        pageType: "unknown",
        title: "Gamma Unknown",
        challengeSignals: [],
      },
      {
        siteId: "site-gamma",
        domain: "gamma.example",
        kind: "retailer",
        state: "healthy",
        url: "https://gamma.example/p/3",
        pageType: "product",
        title: "Gamma Product",
        challengeSignals: [],
      },
    ] as const;

    const makeArtifact = () =>
      runE9BenchmarkSuite(
        {
          generatedAt: "2026-03-09T22:00:00.000Z",
          phases: ["http"],
          httpConcurrency: [1],
          samplePageCount: 4,
          sampleSeed: "stable-seed",
        },
        {
          pages,
          httpProfileFactories: [
            {
              profile: "effect-http",
              createRunner: async () => ({
                runPage: async (page) => ({
                  statusCode: 200,
                  redirected: false,
                  challengeDetected: false,
                  observedChallengeSignals: [],
                  durationMs: 10,
                  contentBytes: 1_000,
                  titlePresent: true,
                  finalUrl: page.url,
                }),
                close: async () => undefined,
              }),
            },
          ],
        },
      );

    const first = await makeArtifact();
    const second = await makeArtifact();
    expect(first.corpus.selectedPageCount).toBe(4);
    expect(first.corpus.samplingStrategy).toBe("stratified-site-page-friction");
    expect(first.corpus.sampleSeed).toBe("stable-seed");
    expect(first.httpCorpus.pageCount).toBe(4);
    expect(first.httpCorpus.attempts.map(({ url }) => url)).toEqual(
      second.httpCorpus.attempts.map(({ url }) => url),
    );
  });

  it("stops redundant higher concurrency sweeps when adaptive stop is enabled", async () => {
    const pages = Array.from({ length: 8 }, (_value, index) => ({
      siteId: `site-${String(index + 1).padStart(2, "0")}`,
      domain: `site-${index + 1}.example`,
      kind: "retailer" as const,
      state: "healthy" as const,
      url: `https://site-${index + 1}.example/p/${index + 1}`,
      pageType: "product" as const,
      title: `Page ${index + 1}`,
      challengeSignals: [] as string[],
    }));
    const sweepDurationsMs = [12, 12, 24, 24];
    let sweepIndex = 0;

    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        phases: ["http"],
        httpConcurrency: [1, 2, 4, 8],
        adaptiveStop: true,
      },
      {
        pages,
        httpProfileFactories: [
          {
            profile: "effect-http",
            createRunner: async () => {
              const sleepMs = sweepDurationsMs[sweepIndex] ?? 24;
              sweepIndex += 1;
              return {
                runPage: async (page) => {
                  await new Promise((resolve) => setTimeout(resolve, sleepMs));
                  return {
                    statusCode: 200,
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: sleepMs,
                    contentBytes: 512,
                    titlePresent: true,
                    finalUrl: page.url,
                  };
                },
                close: async () => undefined,
              };
            },
          },
        ],
      },
    );

    expect(artifact.httpCorpus.sweeps.map(({ concurrency }) => concurrency)).toEqual([1, 2, 4]);
  });

  it("emits detailed live progress for long-running sweeps", async () => {
    const pages = [
      {
        siteId: "site-alpha",
        domain: "alpha.example",
        kind: "retailer",
        state: "healthy",
        url: "https://alpha.example/p/1",
        pageType: "product",
        title: "Alpha Product",
        challengeSignals: [],
      },
      {
        siteId: "site-beta",
        domain: "beta.example",
        kind: "aggregator",
        state: "partial",
        url: "https://beta.example/search?q=tesla",
        pageType: "search",
        title: "Beta Search",
        challengeSignals: ["bot"],
      },
    ] as const;
    const progressEvents = new Array<E9BenchmarkSuiteProgressEvent>();

    await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        httpConcurrency: [2],
        browserConcurrency: [2],
      },
      {
        pages,
        httpProfileFactories: [
          {
            profile: "effect-http",
            createRunner: async () => ({
              runPage: async (page) => {
                if (page.siteId === "site-alpha") {
                  await new Promise((resolve) => setTimeout(resolve, 15));
                }

                return {
                  statusCode: 200,
                  redirected: false,
                  challengeDetected: page.challengeSignals.length > 0,
                  observedChallengeSignals: [...page.challengeSignals],
                  durationMs: 75,
                  reportedDurationMs: 70,
                  requestCount: 1,
                  contentBytes: 4_096,
                  titlePresent: false,
                  finalUrl: page.url,
                };
              },
              close: async () => undefined,
            }),
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async (page) => {
                if (page.siteId === "site-alpha") {
                  await new Promise((resolve) => setTimeout(resolve, 10));
                }

                return {
                  statusCode: 200,
                  redirected: false,
                  challengeDetected: false,
                  observedChallengeSignals: [],
                  durationMs: 125,
                  reportedDurationMs: 120,
                  requestCount: 1,
                  contentBytes: 8_192,
                  titlePresent: true,
                  finalUrl: "https://synthetic.example/final",
                };
              },
              close: async () => undefined,
            }),
          },
        ],
        scraplingParityRunner: async () =>
          Schema.decodeUnknownSync(E9ScraplingParityArtifactSchema)({
            benchmark: "e9-scrapling-parity",
            comparisonId: "comparison-e9-progress",
            generatedAt: "2026-03-09T22:00:00.000Z",
            caseCount: 1,
            measurementMode: "fixture-corpus-postcapture",
            scraplingRuntime: {
              scraplingVersion: "0.4.1",
              parserAvailable: true,
              fetcherAvailable: false,
              fetcherDiagnostic: "synthetic",
            },
            summary: {
              ours: {
                measurementMode: "fixture-corpus-postcapture",
                fetchSuccessRate: 1,
                extractionCompleteness: 1,
                bypassSuccessRate: 1,
              },
              scrapling: {
                measurementMode: "fixture-corpus-postcapture",
                fetchSuccessRate: 1,
                extractionCompleteness: 1,
                bypassSuccessRate: 1,
              },
              equalOrBetter: {
                fetchSuccess: true,
                extractionCompleteness: true,
                bypassSuccess: true,
              },
            },
            cases: [
              {
                caseId: "case-e9-progress",
                retailer: "datart",
                ourCompleteness: 1,
                scraplingCompleteness: 1,
                ourFetchSuccess: true,
                scraplingFetchSuccess: true,
                ourBypassSuccess: true,
                scraplingBypassSuccess: true,
                valueAgreement: true,
                matchedSelectors: ["title"],
              },
            ],
            status: "pass",
          }),
        highFrictionCanaryRunner: async () =>
          Schema.decodeUnknownSync(E9HighFrictionCanaryArtifactSchema)({
            benchmark: "e9-high-friction-canary",
            suiteId: "suite-e9-high-friction-canary",
            generatedAt: "2026-03-09T22:00:00.000Z",
            status: "pass",
            summary: {
              scenarioCount: 1,
              browserEscalationRate: 1,
              bypassSuccessRate: 1,
              policyViolationCount: 0,
              promotionVerdict: "promote",
            },
            results: [
              {
                caseId: "case-e9-progress",
                retailer: "datart",
                provider: "browser",
                action: "active",
                status: "pass",
                requiresBypass: true,
                bypassQualified: true,
                policyCompliant: true,
              },
            ],
            liveCanary: {
              benchmark: "e7-live-canary",
              suiteId: "suite-live-canary-progress",
              generatedAt: "2026-03-09T22:00:00.000Z",
              status: "pass",
              summary: {
                scenarioCount: 1,
                passedScenarioCount: 1,
                failedScenarioIds: [],
                verdict: "promote",
              },
              results: [
                {
                  scenarioId: "scenario-e9-progress",
                  authorizationId: "auth-e9-progress",
                  provider: "browser",
                  action: "active",
                  failedStages: [],
                  status: "pass",
                  plannerRationale: [
                    {
                      key: "capture-path",
                      message: "synthetic",
                    },
                  ],
                },
              ],
            },
          }),
        onProgress: (event) => {
          progressEvents.push(event);
        },
      },
    );

    expect(progressEvents[0]).toMatchObject({
      kind: "suite-start",
      pageCount: 2,
      expectedSweepCount: 2,
    });
    expect(
      progressEvents.some((event) => {
        if (event.kind !== "attempt-complete") {
          return false;
        }

        return (
          event.profile === "effect-http" &&
          event.completedCount === 1 &&
          event.totalCount === 2 &&
          event.pageOrdinal === 2
        );
      }),
    ).toBe(true);
    expect(
      progressEvents.some(
        (event) =>
          event.kind === "subbenchmark-complete" &&
          event.task === "scrapling-parity" &&
          event.status === "pass",
      ),
    ).toBe(true);
    expect(progressEvents.at(-1)).toMatchObject({
      kind: "suite-complete",
      status: "pass",
      totalAttemptCount: 4,
      totalSweepCount: 2,
    });

    const lines = progressEvents.map((event) => formatE9BenchmarkSuiteProgressEvent(event));
    expect(
      lines.some((line) => line.includes("[progress:e9-benchmark-suite] attempt complete")),
    ).toBe(true);
    expect(lines.some((line) => line.includes('input_page="2/2"'))).toBe(true);
    expect(lines.some((line) => line.includes("reported_duration_ms=70"))).toBe(true);
    expect(lines.some((line) => line.includes("overhead_ms=5"))).toBe(true);
    expect(lines.some((line) => line.includes('task="scrapling-parity"'))).toBe(true);
  });

  it("includes execution metadata and warnings in full progress lines", () => {
    const line = formatE9BenchmarkSuiteProgressEvent(
      {
        kind: "attempt-complete",
        benchmarkId: "e9-benchmark-suite",
        generatedAt: "2026-03-09T22:00:00.000Z",
        phase: "live-browser-corpus",
        profile: "effect-browser",
        concurrency: 1,
        pageOrdinal: 1,
        completedCount: 1,
        totalCount: 1,
        siteId: "site-alpha",
        domain: "alpha.example",
        url: "https://alpha.example/p/1",
        pageType: "product",
        frictionClass: "low",
        success: false,
        blocked: true,
        challengeDetected: false,
        redirected: false,
        durationMs: 0.5,
        overheadDurationMs: 0,
        contentBytes: 0,
        elapsedMs: 100,
        etaMs: 0,
        failureCategory: "local-egress-config",
        executionMetadata: {
          source: "planned",
          providerId: "browser-basic",
          mode: "browser",
          egressProfileId: "http-connect",
          egressPluginId: "builtin-http-connect-egress",
          egressRouteKind: "http-connect",
          egressRouteKey: "http-connect",
          egressPoolId: "http-connect-pool",
          egressRoutePolicyId: "http-connect-route",
          identityProfileId: "default",
          identityPluginId: "builtin-default-identity",
          identityTenantId: "public",
          browserRuntimeProfileId: "patchright-default",
        },
        warnings: [
          'Skipped implicit egress auto-selection for \u001B[31mprofiles\u001B[0m requiring explicit plugin config: "http-connect".',
          "\u001B]8;;https://evil.example\u0007danger\u001B]8;;\u0007",
        ],
        error:
          'Browser access failed for https://alpha.example/p/1 :: Plugin "builtin-http-connect-egress" requires a non-empty "proxyUrl" value.',
      },
      { color: false },
    );

    expect(line).toContain('provider_id="browser-basic"');
    expect(line).toContain('egress_profile="http-connect"');
    expect(line).toContain('egress_plugin="builtin-http-connect-egress"');
    expect(line).toContain('identity_profile="default"');
    expect(line).toContain(
      'warnings=["Skipped implicit egress auto-selection for profiles requiring explicit plugin config: \\"http-connect\\".","danger"]',
    );
    expect(line).not.toContain("\u001B[31m");
    expect(line).not.toContain("\u001B]8;;");
  });

  it("includes recovered browser allocation counts in sweep progress lines", () => {
    const line = formatE9BenchmarkSuiteProgressEvent({
      kind: "sweep-complete",
      benchmarkId: "e9-benchmark-suite",
      generatedAt: "2026-03-09T22:00:00.000Z",
      phase: "live-browser-corpus",
      profile: "effect-browser",
      concurrency: 1,
      pageCount: 10,
      sweepOrdinal: 1,
      sweepCount: 1,
      totalWallMs: 1_000,
      throughputPagesPerMinute: 600,
      parallelEfficiency: 1,
      successCount: 9,
      blockedCount: 1,
      challengeCount: 0,
      recoveredBrowserAllocationCount: 2,
      rssPeakMb: 128,
      cpuUserMs: 100,
      cpuSystemMs: 20,
    });

    expect(line).toContain("recovered_browser_allocations=2");
  });

  it("renders compact single-line progress without wrapping long URLs", () => {
    const event = {
      kind: "attempt-complete",
      benchmarkId: "e9-benchmark-suite",
      generatedAt: "2026-03-09T22:00:00.000Z",
      phase: "live-http-corpus",
      profile: "effect-http",
      concurrency: 1,
      pageOrdinal: 22,
      completedCount: 22,
      totalCount: 622,
      siteId: "really-long-site-identifier-example-cz",
      domain: "example.com",
      url: "https://example.com/very/long/path/to/a/product/page/that/would/normally/wrap/in/the/terminal?with=query&and=even-more-detail=true",
      pageType: "product",
      frictionClass: "high",
      success: true,
      blocked: false,
      challengeDetected: false,
      redirected: false,
      statusCode: 200,
      durationMs: 315.808,
      reportedDurationMs: 307.297,
      overheadDurationMs: 8.511,
      requestCount: 1,
      redirectCount: 0,
      blockedRequestCount: 0,
      contentBytes: 912_257,
      elapsedMs: 317.027,
      etaMs: 196_873.767,
      finalUrl:
        "https://example.com/very/long/path/to/a/product/page/that/would/normally/wrap/in/the/terminal?with=query&and=even-more-detail=true",
    } as const satisfies E9BenchmarkSuiteProgressEvent;

    const line = formatE9BenchmarkSuiteProgressEvent(event, {
      color: false,
      progressMode: "compact",
      maxWidth: 120,
    });

    expect(line.includes("\n")).toBe(false);
    expect(visibleProgressWidth(line)).toBeLessThanOrEqual(120);
    expect(line).toContain("d=315.808");
    expect(line).toContain("r=307.297");
    expect(line).toContain("o=8.511");
    expect(line).toContain("url=");
    expect(line).toContain("…");

    const widerLine = formatE9BenchmarkSuiteProgressEvent(event, {
      color: false,
      progressMode: "compact",
      maxWidth: 160,
    });
    expect(widerLine).toContain("rq=1");
    expect(widerLine).toContain("rd=0");
    expect(widerLine).toContain("br=0");
  });

  it("preserves redirect markers and honors tiny compact width limits", () => {
    const redirectedLine = formatE9BenchmarkSuiteProgressEvent(
      {
        kind: "attempt-complete",
        benchmarkId: "e9-benchmark-suite",
        generatedAt: "2026-03-09T22:00:00.000Z",
        phase: "live-http-corpus",
        profile: "effect-http",
        concurrency: 2,
        pageOrdinal: 3,
        completedCount: 3,
        totalCount: 10,
        siteId: "redirect-site",
        domain: "example.com",
        url: "https://example.com/original/very/long/path?campaign=alpha",
        pageType: "product",
        frictionClass: "medium",
        success: true,
        blocked: false,
        challengeDetected: false,
        redirected: true,
        statusCode: 302,
        durationMs: 140.5,
        reportedDurationMs: 138.2,
        overheadDurationMs: 2.3,
        requestCount: 2,
        redirectCount: 1,
        blockedRequestCount: 0,
        contentBytes: 12_345,
        elapsedMs: 400,
        etaMs: 9_000,
        finalUrl: "https://example.com/final/very/long/path?campaign=delta",
      },
      {
        color: false,
        progressMode: "compact",
        maxWidth: 120,
      },
    );

    expect(redirectedLine).toContain("rdr1");
    expect(redirectedLine).toContain("final=");
    expect(redirectedLine.includes("\n")).toBe(false);
    expect(visibleProgressWidth(redirectedLine)).toBeLessThanOrEqual(120);

    const tinyLine = formatE9BenchmarkSuiteProgressEvent(
      {
        kind: "suite-complete",
        benchmarkId: "e9-benchmark-suite",
        generatedAt: "2026-03-09T22:00:00.000Z",
        status: "pass",
        totalWallMs: 1_234,
        totalAttemptCount: 22,
        totalSweepCount: 6,
      },
      {
        color: false,
        progressMode: "compact",
        maxWidth: 5,
      },
    );
    expect(visibleProgressWidth(tinyLine)).toBeLessThanOrEqual(5);
  });

  it("sanitizes terminal escape sequences from compact progress text", () => {
    const line = formatE9BenchmarkSuiteProgressEvent(
      {
        kind: "attempt-complete",
        benchmarkId: "e9-benchmark-suite",
        generatedAt: "2026-03-09T22:00:00.000Z",
        phase: "live-http-corpus",
        profile: "effect-http",
        concurrency: 1,
        pageOrdinal: 1,
        completedCount: 1,
        totalCount: 1,
        siteId: "evil-site",
        domain: "example.com",
        url: "\u001B]8;;https://evil.test\u0007click\u001B]8;;\u0007",
        pageType: "product",
        frictionClass: "low",
        success: false,
        blocked: false,
        challengeDetected: false,
        redirected: false,
        statusCode: 500,
        durationMs: 10,
        overheadDurationMs: 1,
        contentBytes: 0,
        elapsedMs: 10,
        etaMs: 0,
        error: "boom\u001B]8;;https://evil.test\u0007oops\u001B]8;;\u0007",
      },
      {
        color: false,
        progressMode: "compact",
        maxWidth: 160,
      },
    );

    expect(line).not.toContain("\u001B");
    expect(line).not.toContain("\u0007");
    expect(line).not.toContain("8;;https://evil.test");
  });

  it("swallows progress sink failures instead of aborting a concurrent sweep", async () => {
    const pages = [
      {
        siteId: "site-alpha",
        domain: "alpha.example",
        kind: "retailer",
        state: "healthy",
        url: "https://alpha.example/p/1",
        pageType: "product",
        title: "Alpha Product",
        challengeSignals: [],
      },
      {
        siteId: "site-beta",
        domain: "beta.example",
        kind: "aggregator",
        state: "partial",
        url: "https://beta.example/search?q=tesla",
        pageType: "search",
        title: "Beta Search",
        challengeSignals: [],
      },
    ] as const;

    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        phases: ["http"],
        httpConcurrency: [2],
      },
      {
        pages,
        httpProfileFactories: [
          {
            profile: "effect-http",
            createRunner: async () => ({
              runPage: async (page) => {
                if (page.siteId === "site-alpha") {
                  await new Promise((resolve) => setTimeout(resolve, 10));
                }

                return {
                  statusCode: 200,
                  redirected: false,
                  challengeDetected: false,
                  observedChallengeSignals: [],
                  durationMs: 50,
                  contentBytes: 1_024,
                  titlePresent: false,
                  finalUrl: page.url,
                };
              },
              close: async () => undefined,
            }),
          },
        ],
        onProgress: () => {
          throw new Error("sink failed");
        },
      },
    );

    expect(artifact.httpCorpus.attempts).toHaveLength(2);
    expect(artifact.httpCorpus.sweeps).toHaveLength(1);
    expect(artifact.status).toBe("pass");
  });

  it("writes progress separately from the final CLI artifact", async () => {
    const outputLines = new Array<string>();
    const progressLines = new Array<string>();
    const artifactPath = `tmp/${randomUUID()}-e9-benchmark-suite-cli.json`;

    await runE9BenchmarkSuiteCli(["--artifact", artifactPath], {
      writeLine: (line) => {
        outputLines.push(line);
      },
      writeProgressLine: (line) => {
        progressLines.push(line);
      },
      runBenchmarkSuite: async (_options, dependencies) => {
        dependencies?.onProgress?.({
          kind: "suite-start",
          benchmarkId: "suite-cli-progress",
          generatedAt: "2026-03-09T22:00:00.000Z",
          selectedPhases: ["http"],
          corpusPath: "tmp/corpus.json",
          pageCount: 2,
          siteCount: 1,
          httpProfiles: ["effect-http"],
          browserProfiles: [],
          httpConcurrency: [2],
          browserConcurrency: [],
          expectedSweepCount: 1,
        });

        return Schema.decodeUnknownSync(E9BenchmarkSuiteArtifactSchema)({
          benchmark: "e9-benchmark-suite",
          benchmarkId: "suite-cli-progress",
          generatedAt: "2026-03-09T22:00:00.000Z",
          corpus: {
            sourceArtifactPath: "tmp/corpus.json",
            selectedPageCount: 2,
            selectedSiteCount: 1,
            highFrictionPageCount: 0,
            pageTypeCounts: {
              product: 1,
              listing: 0,
              search: 1,
              offer: 0,
              unknown: 0,
            },
          },
          profiles: {
            available: [],
            unavailable: [],
          },
          httpCorpus: {
            phase: "live-http-corpus",
            pageCount: 2,
            attempts: [],
            sweeps: [],
          },
          browserCorpus: {
            phase: "live-browser-corpus",
            pageCount: 0,
            attempts: [],
            sweeps: [],
          },
          scraplingParity: {
            totalWallMs: 0,
            artifact: Schema.decodeUnknownSync(E9ScraplingParityArtifactSchema)({
              benchmark: "e9-scrapling-parity",
              comparisonId: "comparison-skipped",
              generatedAt: "2026-03-09T22:00:00.000Z",
              caseCount: 1,
              measurementMode: "fixture-corpus-postcapture",
              scraplingRuntime: {
                scraplingVersion: "unknown",
                parserAvailable: false,
                fetcherAvailable: false,
                fetcherDiagnostic: "Skipped in this benchmark phase.",
              },
              summary: {
                ours: {
                  measurementMode: "fixture-corpus-postcapture",
                  fetchSuccessRate: 0,
                  extractionCompleteness: 0,
                  bypassSuccessRate: 0,
                },
                scrapling: {
                  measurementMode: "fixture-corpus-postcapture",
                  fetchSuccessRate: 0,
                  extractionCompleteness: 0,
                  bypassSuccessRate: 0,
                },
                equalOrBetter: {
                  fetchSuccess: false,
                  extractionCompleteness: false,
                  bypassSuccess: false,
                },
              },
              cases: [
                {
                  caseId: "case-skipped",
                  retailer: "datart",
                  ourCompleteness: 0,
                  scraplingCompleteness: 0,
                  ourFetchSuccess: false,
                  scraplingFetchSuccess: false,
                  ourBypassSuccess: false,
                  scraplingBypassSuccess: false,
                  valueAgreement: false,
                  matchedSelectors: [],
                },
              ],
              status: "fail",
            }),
          },
          highFrictionCanary: {
            totalWallMs: 0,
            artifact: Schema.decodeUnknownSync(E9HighFrictionCanaryArtifactSchema)({
              benchmark: "e9-high-friction-canary",
              suiteId: "suite-skipped",
              generatedAt: "2026-03-09T22:00:00.000Z",
              status: "fail",
              summary: {
                scenarioCount: 1,
                browserEscalationRate: 0,
                bypassSuccessRate: 0,
                policyViolationCount: 0,
                promotionVerdict: "hold",
              },
              results: [
                {
                  caseId: "case-skipped",
                  retailer: "datart",
                  provider: "browser",
                  action: "guarded",
                  status: "fail",
                  requiresBypass: true,
                  bypassQualified: false,
                  policyCompliant: false,
                },
              ],
              liveCanary: {
                benchmark: "e7-live-canary",
                suiteId: "suite-live-canary-skipped",
                generatedAt: "2026-03-09T22:00:00.000Z",
                status: "fail",
                summary: {
                  scenarioCount: 1,
                  passedScenarioCount: 0,
                  failedScenarioIds: ["scenario-skipped"],
                  verdict: "hold",
                },
                results: [
                  {
                    scenarioId: "scenario-skipped",
                    authorizationId: "auth-skipped",
                    provider: "browser",
                    action: "guarded",
                    failedStages: ["canary"],
                    status: "fail",
                    plannerRationale: [
                      {
                        key: "skipped",
                        message: "Skipped in this benchmark phase.",
                      },
                    ],
                  },
                ],
              },
            }),
          },
          summary: {
            executedPhases: ["http"],
            skippedPhases: ["browser", "scrapling", "canary"],
            sampled: false,
            totalAttemptCount: 0,
            totalSweepCount: 0,
            httpAttemptCount: 0,
            browserAttemptCount: 0,
            httpLocalFailureCount: 0,
            browserLocalFailureCount: 0,
            browserRecoveredBrowserAllocationCount: 0,
            httpSuccessRate: 0,
            browserSuccessRate: 0,
            httpEffectiveSuccessRate: 0,
            browserEffectiveSuccessRate: 0,
            httpBestThroughputPagesPerMinute: 0,
            browserBestThroughputPagesPerMinute: 0,
            httpBestEffectiveThroughputPagesPerMinute: 0,
            browserBestEffectiveThroughputPagesPerMinute: 0,
            topHttpFailureDomains: [],
            topBrowserFailureDomains: [],
            topRemoteFailureCategories: [],
            topBrowserFailureCategories: [],
            topLocalFailureCategories: [],
          },
          warnings: ["Skipped phases: browser, scrapling, canary."],
          recommendations: [
            "Use the full-corpus preset when you need definitive release evidence.",
          ],
          status: "fail",
        });
      },
    });

    expect(progressLines).toHaveLength(1);
    expect(progressLines[0]).toContain("[progress:e9-benchmark-suite] suite start");
    expect(outputLines).toHaveLength(1);
    expect(JSON.parse(outputLines[0] ?? "")).toEqual({
      benchmark: "e9-benchmark-suite",
      benchmarkId: "suite-cli-progress",
      status: "fail",
      generatedAt: "2026-03-09T22:00:00.000Z",
      artifactPath,
      artifactJsonlPath: expect.stringMatching(/e9-benchmark-suite-cli\.jsonl$/u),
      selectedPageCount: 2,
      selectedSiteCount: 1,
      highFrictionPageCount: 0,
      httpAttemptCount: 0,
      httpSweepCount: 0,
      browserAttemptCount: 0,
      browserSweepCount: 0,
      summary: {
        executedPhases: ["http"],
        skippedPhases: ["browser", "scrapling", "canary"],
        sampled: false,
        totalAttemptCount: 0,
        totalSweepCount: 0,
        httpAttemptCount: 0,
        browserAttemptCount: 0,
        httpLocalFailureCount: 0,
        browserLocalFailureCount: 0,
        browserRecoveredBrowserAllocationCount: 0,
        httpSuccessRate: 0,
        browserSuccessRate: 0,
        httpEffectiveSuccessRate: 0,
        browserEffectiveSuccessRate: 0,
        httpBestThroughputPagesPerMinute: 0,
        browserBestThroughputPagesPerMinute: 0,
        httpBestEffectiveThroughputPagesPerMinute: 0,
        browserBestEffectiveThroughputPagesPerMinute: 0,
        topHttpFailureDomains: [],
        topBrowserFailureDomains: [],
        topRemoteFailureCategories: [],
        topBrowserFailureCategories: [],
        topLocalFailureCategories: [],
      },
      warnings: ["Skipped phases: browser, scrapling, canary."],
      recommendations: ["Use the full-corpus preset when you need definitive release evidence."],
    });

    const artifactJsonlRaw = await readFile(artifactPath.replace(/\.json$/u, ".jsonl"), "utf8");
    const artifactJsonlEntries = artifactJsonlRaw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly recordType: string; readonly runId: string });
    expect(artifactJsonlEntries.map((entry) => entry.recordType)).toEqual([
      "run-start",
      "progress-event",
      "final-artifact",
    ]);
    expect(new Set(artifactJsonlEntries.map((entry) => entry.runId)).size).toBe(1);
  });

  it("persists run errors to artifact jsonl even when option parsing fails", async () => {
    const artifactJsonlPath = `tmp/${randomUUID()}-e9-benchmark-suite-errors.jsonl`;

    await expect(
      runE9BenchmarkSuiteCli(["--artifact-jsonl", artifactJsonlPath, "--bogus"]),
    ).rejects.toThrow("Unknown argument: --bogus");

    const artifactJsonlRaw = await readFile(artifactJsonlPath, "utf8");
    const artifactJsonlEntries = artifactJsonlRaw
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { readonly recordType: string; readonly message?: string },
      );
    expect(artifactJsonlEntries.at(-1)?.recordType).toBe("run-error");
    expect(artifactJsonlEntries.at(-1)?.message).toContain("Unknown argument: --bogus");
  });

  it("does not mutate process.exitCode when the imported CLI helper fails", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await expect(runE9BenchmarkSuiteCli(["--bogus"])).rejects.toThrow(
        "Unknown argument: --bogus",
      );
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("fails the CLI when artifact jsonl persistence fails", async () => {
    const artifactJsonlPath = `tmp/${randomUUID()}-e9-benchmark-suite-jsonl-dir`;
    await mkdir(artifactJsonlPath, { recursive: true });

    await expect(
      runE9BenchmarkSuiteCli(["--artifact-jsonl", artifactJsonlPath], {
        writeLine: () => undefined,
        writeProgressLine: () => undefined,
        runBenchmarkSuite: async (_options, dependencies) => {
          dependencies?.onProgress?.({
            kind: "suite-start",
            benchmarkId: "suite-cli-progress",
            generatedAt: "2026-03-09T22:00:00.000Z",
            selectedPhases: ["http"],
            corpusPath: "tmp/corpus.json",
            pageCount: 2,
            siteCount: 1,
            httpProfiles: ["effect-http"],
            browserProfiles: [],
            httpConcurrency: [2],
            browserConcurrency: [],
            expectedSweepCount: 1,
          });

          return {} as never;
        },
      }),
    ).rejects.toThrow("Failed to persist benchmark JSONL sidecar");
  });

  it("recreates the artifact jsonl parent directory when it disappears mid-run", async () => {
    const artifactJsonlPath = `tmp/${randomUUID()}/e9-benchmark-suite-recreated.jsonl`;
    const artifactJsonlDir = artifactJsonlPath.replace(/\/[^/]+$/u, "");

    await runE9BenchmarkSuiteCli(["--artifact-jsonl", artifactJsonlPath], {
      writeLine: () => undefined,
      writeProgressLine: () => undefined,
      runBenchmarkSuite: async (_options, dependencies) => {
        dependencies?.onProgress?.({
          kind: "suite-start",
          benchmarkId: "suite-cli-progress",
          generatedAt: "2026-03-09T22:00:00.000Z",
          selectedPhases: ["http"],
          corpusPath: "tmp/corpus.json",
          pageCount: 2,
          siteCount: 1,
          httpProfiles: ["effect-http"],
          browserProfiles: [],
          httpConcurrency: [2],
          browserConcurrency: [],
          expectedSweepCount: 1,
        });

        await rm(artifactJsonlDir, { recursive: true, force: true });

        dependencies?.onProgress?.({
          kind: "phase-complete",
          benchmarkId: "suite-cli-progress",
          generatedAt: "2026-03-09T22:00:00.000Z",
          phase: "live-http-corpus",
          attemptCount: 2,
          sweepCount: 1,
          totalWallMs: 12,
        });

        return {} as never;
      },
    });

    const artifactJsonlRaw = await readFile(artifactJsonlPath, "utf8");
    const artifactJsonlEntries = artifactJsonlRaw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly recordType: string; readonly runId: string });

    expect(artifactJsonlEntries.at(-1)?.recordType).toBe("final-artifact");
    expect(artifactJsonlEntries.some((entry) => entry.recordType === "progress-event")).toBe(true);
    expect(new Set(artifactJsonlEntries.map((entry) => entry.runId)).size).toBe(1);
  });

  it("honors narrow tty widths for compact CLI progress", async () => {
    const progressLines = new Array<string>();

    await runE9BenchmarkSuiteCli(["--progress", "compact"], {
      isProgressTTY: true,
      progressColumns: 20,
      writeLine: () => undefined,
      writeProgressLine: (line) => {
        progressLines.push(line);
      },
      runBenchmarkSuite: async (_options, dependencies) => {
        dependencies?.onProgress?.({
          kind: "suite-start",
          benchmarkId: "suite-cli-compact",
          generatedAt: "2026-03-09T22:00:00.000Z",
          selectedPhases: ["http", "browser"],
          corpusPath:
            "https://example.com/really/long/corpus/path/that/should/be/truncated/in-a-narrow-tty",
          pageCount: 622,
          siteCount: 20,
          httpProfiles: ["effect-http", "native-fetch"],
          browserProfiles: ["effect-browser", "patchright-browser"],
          httpConcurrency: [1, 2, 4, 8, 16, 32],
          browserConcurrency: [1, 2, 4, 8],
          expectedSweepCount: 20,
        });

        return {} as never;
      },
    });

    expect(progressLines).toHaveLength(1);
    expect(visibleProgressWidth(progressLines[0] ?? "")).toBeLessThanOrEqual(20);
  });

  it("merges partial phase artifacts without losing completed sweeps", async () => {
    const pages = [
      {
        siteId: "site-alpha",
        domain: "alpha.example",
        kind: "retailer",
        state: "healthy",
        url: "https://alpha.example/p/1",
        pageType: "product",
        title: "Alpha Product",
        challengeSignals: [],
      },
    ] as const;

    const httpOnlyBaseline = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        benchmarkId: "suite-partial-http-baseline",
        phases: ["http"],
        httpConcurrency: [1],
        browserConcurrency: [1],
      },
      {
        pages,
        httpProfileFactories: [
          {
            profile: "effect-http",
            createRunner: async () => ({
              runPage: async () => ({
                statusCode: 200,
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 100,
                contentBytes: 1_000,
                titlePresent: false,
                finalUrl: "https://alpha.example/p/1",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );
    const httpOnlyParallel = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        benchmarkId: "suite-partial-http-parallel",
        phases: ["http"],
        httpConcurrency: [2],
        browserConcurrency: [1],
      },
      {
        pages,
        httpProfileFactories: [
          {
            profile: "effect-http",
            createRunner: async () => ({
              runPage: async () => ({
                statusCode: 200,
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 40,
                contentBytes: 1_000,
                titlePresent: false,
                finalUrl: "https://alpha.example/p/1",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    const browserOnly = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        benchmarkId: "suite-partial-browser",
        phases: ["browser"],
        httpConcurrency: [1],
        browserConcurrency: [1],
      },
      {
        pages,
        browserProfileFactories: [
          {
            profile: "patchright-browser",
            createRunner: async () => ({
              runPage: async () => ({
                statusCode: 200,
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 200,
                contentBytes: 2_000,
                titlePresent: true,
                finalUrl: "https://alpha.example/p/1",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    const merged = mergeE9BenchmarkArtifacts([httpOnlyBaseline, httpOnlyParallel, browserOnly]);
    expect(merged.httpCorpus.sweeps).toHaveLength(2);
    expect(merged.browserCorpus.sweeps).toHaveLength(1);
    expect(merged.httpCorpus.sweeps[0]?.profile).toBe("effect-http");
    expect(merged.httpCorpus.sweeps[0]?.concurrency).toBe(1);
    expect(merged.httpCorpus.sweeps[1]?.concurrency).toBe(2);
    expect(merged.httpCorpus.sweeps[0]?.parallelEfficiency).toBe(1);
    expect(merged.httpCorpus.sweeps[1]?.parallelEfficiency).toBeLessThanOrEqual(1);
    expect(merged.browserCorpus.sweeps[0]?.profile).toBe("patchright-browser");
  });

  it("merges reruns for the same page even when redirect targets differ", async () => {
    const pages = [
      {
        siteId: "site-beta",
        domain: "beta.example",
        kind: "aggregator",
        state: "partial",
        url: "https://beta.example/search?q=tesla",
        pageType: "search",
        title: "Beta Search",
        challengeSignals: ["bot"],
      },
    ] as const;

    const makeArtifact = (finalUrl: string) =>
      runE9BenchmarkSuite(
        {
          generatedAt: "2026-03-09T22:00:00.000Z",
          phases: ["http"],
          httpConcurrency: [1],
        },
        {
          pages,
          httpProfileFactories: [
            {
              profile: "effect-http",
              createRunner: async () => ({
                runPage: async () => ({
                  statusCode: 200,
                  redirected: true,
                  challengeDetected: true,
                  observedChallengeSignals: ["bot"],
                  durationMs: 25,
                  contentBytes: 1_024,
                  titlePresent: true,
                  finalUrl,
                }),
                close: async () => undefined,
              }),
            },
          ],
        },
      );

    const merged = mergeE9BenchmarkArtifacts([
      await makeArtifact("https://beta.example/search?q=tesla&step=1"),
      await makeArtifact("https://beta.example/search?q=tesla&step=2"),
    ]);

    expect(merged.httpCorpus.attempts).toHaveLength(1);
    expect(merged.httpCorpus.attempts[0]?.finalUrl).toBe(
      "https://beta.example/search?q=tesla&step=2",
    );
    expect(merged.corpus.selectedPageCount).toBe(1);
    expect(merged.corpus.highFrictionPageCount).toBe(1);
    expect(merged.corpus.pageTypeCounts.search).toBe(1);
  });

  it("merges sharded artifacts back into a complete sampled corpus", async () => {
    const pages = [
      {
        siteId: "site-alpha",
        domain: "alpha.example",
        kind: "retailer",
        state: "healthy",
        url: "https://alpha.example/p/1",
        pageType: "product",
        title: "Alpha Product",
        challengeSignals: [],
      },
      {
        siteId: "site-beta",
        domain: "beta.example",
        kind: "aggregator",
        state: "partial",
        url: "https://beta.example/search?q=tesla",
        pageType: "search",
        title: "Beta Search",
        challengeSignals: ["bot"],
      },
      {
        siteId: "site-gamma",
        domain: "gamma.example",
        kind: "retailer",
        state: "healthy",
        url: "https://gamma.example/p/3",
        pageType: "listing",
        title: "Gamma Listing",
        challengeSignals: [],
      },
      {
        siteId: "site-delta",
        domain: "delta.example",
        kind: "retailer",
        state: "healthy",
        url: "https://delta.example/o/1",
        pageType: "offer",
        title: "Delta Offer",
        challengeSignals: [],
      },
    ] as const;

    const makeShardArtifact = (shardIndex: number) =>
      runE9BenchmarkSuite(
        {
          generatedAt: "2026-03-09T22:00:00.000Z",
          phases: ["http"],
          httpConcurrency: [1],
          shardCount: 2,
          shardIndex,
        },
        {
          pages,
          httpProfileFactories: [
            {
              profile: "effect-http",
              createRunner: async () => ({
                runPage: async (page) => ({
                  statusCode: 200,
                  redirected: false,
                  challengeDetected: false,
                  observedChallengeSignals: [],
                  durationMs: 25,
                  contentBytes: 1_024,
                  titlePresent: true,
                  finalUrl: page.url,
                }),
                close: async () => undefined,
              }),
            },
          ],
        },
      );

    const shardOne = await makeShardArtifact(1);
    const shardTwo = await makeShardArtifact(2);
    const merged = mergeE9BenchmarkArtifacts([shardOne, shardTwo]);

    expect(shardOne.corpus.selectedPageCount).toBe(4);
    expect(shardOne.corpus.shardPageCount).toBe(2);
    expect(shardTwo.corpus.shardPageCount).toBe(2);
    expect(merged.httpCorpus.pageCount).toBe(4);
    expect(merged.httpCorpus.attempts).toHaveLength(4);
    expect(merged.corpus.selectedPageCount).toBe(4);
    expect(merged.corpus.shardIndex).toBeUndefined();
  });

  it("does not close the process-wide SDK browser pool during effect-browser runner cleanup", async () => {
    await Effect.runPromise(resetBrowserPoolForTests());
    let browserCloseCount = 0;

    mock.module("patchright", () => ({
      chromium: {
        launch: async () => ({
          newContext: async () => ({
            newPage: async () => ({
              route: async () => {},
              goto: async () => ({
                status: () => 200,
                allHeaders: async () => ({
                  "content-type": "text/html; charset=utf-8",
                }),
                request: () => ({
                  redirectedFrom: () => null,
                }),
              }),
              waitForLoadState: async () => {},
              content: async () =>
                "<html><head><title>Closed Pool</title></head><body>ok</body></html>",
              url: () => "https://example.com/p/1",
              close: async () => {},
            }),
            close: async () => {},
          }),
          close: async () => {
            browserCloseCount += 1;
          },
        }),
      },
    }));

    try {
      await runE9BenchmarkSuite(
        {
          generatedAt: "2026-03-09T22:00:00.000Z",
          phases: ["browser"],
          browserProfiles: ["effect-browser"],
          browserConcurrency: [1],
        },
        {
          pages: [
            {
              siteId: "site-alpha",
              domain: "alpha.example",
              kind: "retailer",
              state: "healthy",
              url: "https://example.com/p/1",
              pageType: "product",
              title: "Alpha Product",
              challengeSignals: [],
            },
          ],
        },
      );

      expect(browserCloseCount).toBe(0);
    } finally {
      await Effect.runPromise(resetBrowserPoolForTests());
      mock.restore();
    }
  });

  it("records patchright allocation failures as failed attempts", async () => {
    mock.module("patchright", () => ({
      chromium: {
        launch: async () => ({
          newContext: async () => {
            throw new Error("context-boom");
          },
          close: async () => {},
        }),
      },
    }));

    try {
      const artifact = await runE9BenchmarkSuite(
        {
          generatedAt: "2026-03-09T22:00:00.000Z",
          phases: ["browser"],
          browserProfiles: ["patchright-browser"],
          browserConcurrency: [1],
        },
        {
          pages: [
            {
              siteId: "site-alpha",
              domain: "alpha.example",
              kind: "retailer",
              state: "healthy",
              url: "https://example.com/p/1",
              pageType: "product",
              title: "Alpha Product",
              challengeSignals: [],
            },
          ],
        },
      );

      expect(artifact.browserCorpus.attempts).toHaveLength(1);
      expect(artifact.browserCorpus.attempts[0]?.error).toContain("context-boom");
      expect(artifact.browserCorpus.attempts[0]?.failureCategory).toBe(
        "browser-context-allocation",
      );
    } finally {
      mock.restore();
    }
  });
});
