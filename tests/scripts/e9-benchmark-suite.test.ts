import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "@effect-native/bun-test";
import { mock } from "bun:test";
import { Effect, Schema } from "effect";
import { visibleProgressWidth } from "../../scripts/benchmarks/progress-line.ts";
import {
  E9BenchmarkSuiteArtifactSchema,
  type E9BenchmarkSuiteProgressEvent,
  formatMixedFailureDomainsForRecommendation,
  mergeE9BenchmarkArtifacts,
  mergeChallengeSignals,
  runE9BenchmarkSuite,
} from "../../src/e9-benchmark-suite.ts";
import { E9HighFrictionCanaryArtifactSchema } from "../../src/e9-high-friction-canary.ts";
import { E9ScraplingParityArtifactSchema } from "../../src/e9-scrapling-parity.ts";
import { makePreferredPathOverrideWarning } from "../../src/sdk/access-health-warning-runtime.ts";
import { resetBrowserPoolForTests } from "../../src/sdk/browser-pool.ts";
import {
  formatE9BenchmarkSuiteProgressEvent,
  parseOptions,
  runE9BenchmarkSuiteCli,
} from "../../scripts/benchmarks/e9-benchmark-suite.ts";

describe("e9 benchmark suite", () => {
  const legacyPreferredPathOverrideWarnings = {
    egress:
      'Selection policy chose egress "leased-direct" instead of preferred "direct"; access health signals rate the preferred path as less healthy.',
    identity:
      'Selection policy chose identity "leased-default" instead of preferred "default"; access health signals rate the preferred path as less healthy.',
    provider:
      'Selection policy chose provider "browser-basic" instead of preferred "http-basic"; access health signals rate the preferred provider as less healthy.',
  } as const;

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
    delete summary?.preferredPathOverrideCount;
    delete summary?.topPreferredPathOverrideDomains;
    delete summary?.topPreferredPathOverrideKinds;
    delete summary?.topHttpPreferredPathOverrideDomains;
    delete summary?.topHttpPreferredPathOverrideKinds;
    delete summary?.topBrowserPreferredPathOverrideDomains;
    delete summary?.topBrowserPreferredPathOverrideKinds;

    const decoded = Schema.decodeUnknownSync(E9BenchmarkSuiteArtifactSchema)(legacyArtifact);
    expect(decoded.summary?.topRemoteFailureCategories).toBeUndefined();
    expect(decoded.summary?.topRemoteFailureDomains).toBeUndefined();
    expect(decoded.summary?.preferredPathOverrideCount).toBeUndefined();
    expect(decoded.summary?.topPreferredPathOverrideDomains).toBeUndefined();
    expect(decoded.summary?.topPreferredPathOverrideKinds).toBeUndefined();
    expect(decoded.summary?.topHttpPreferredPathOverrideDomains).toBeUndefined();
    expect(decoded.summary?.topHttpPreferredPathOverrideKinds).toBeUndefined();
    expect(decoded.summary?.topBrowserPreferredPathOverrideDomains).toBeUndefined();
    expect(decoded.summary?.topBrowserPreferredPathOverrideKinds).toBeUndefined();
  });

  it("formats legacy mixed-domain summaries that do not yet carry per-category counts", () => {
    expect(
      formatMixedFailureDomainsForRecommendation([
        {
          domain: "legacy-boozt.example",
          count: 4,
          categories: ["access-wall", "access-wall-forbidden"],
        },
        {
          domain: "legacy-datart.example",
          count: 3,
          categories: ["browser-header-read-failed", "browser-navigation-http-error"],
        },
      ]),
    ).toBe(
      "legacy-boozt.example (access-wall, access-wall-forbidden); legacy-datart.example (browser-header-read-failed, browser-navigation-http-error)",
    );
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
    expect(artifact.summary?.topTimeoutFailureDomains).toEqual([
      { key: "alpha.example", count: 1 },
    ]);
    expect(artifact.summary?.skippedPhases).toContain("http");
    expect(artifact.recommendations).toContain(
      "Review browser failure categories and top failing domains before treating browser fallback as production-ready.",
    );
    expect(artifact.recommendations).toContain(
      "Top remote failures are browser navigation timeouts; prioritize timeout stratification, wait-condition tuning and domain-specific retry diagnostics before judging fallback quality.",
    );
    expect(artifact.recommendations).toContain(
      "Timeout-heavy domains to inspect first: alpha.example.",
    );
  });

  it("surfaces access-health-driven preferred-path override drift separately from hard local failures", async () => {
    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        phases: ["http", "browser"],
        httpProfiles: ["effect-http"],
        browserProfiles: ["effect-browser"],
        httpConcurrency: [1],
        browserConcurrency: [1],
      },
      {
        pages: [
          {
            siteId: "site-http-alpha",
            domain: "alpha.example",
            kind: "retailer",
            state: "healthy",
            url: "https://alpha.example/http-a",
            pageType: "listing",
            title: "Alpha A",
            challengeSignals: [],
          },
          {
            siteId: "site-http-beta",
            domain: "beta.example",
            kind: "retailer",
            state: "healthy",
            url: "https://beta.example/http-b",
            pageType: "listing",
            title: "Beta B",
            challengeSignals: [],
          },
          {
            siteId: "site-browser-alpha",
            domain: "alpha.example",
            kind: "retailer",
            state: "healthy",
            url: "https://alpha.example/browser-a",
            pageType: "product",
            title: "Alpha Browser",
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
                durationMs: 50,
                contentBytes: 20_000,
                titlePresent: true,
                finalUrl: page.url,
                warnings: page.url.endsWith("/http-a")
                  ? [
                      makePreferredPathOverrideWarning({
                        kind: "egress",
                        selectedId: "leased-direct",
                        preferredId: "direct",
                      }),
                      makePreferredPathOverrideWarning({
                        kind: "identity",
                        selectedId: "leased-default",
                        preferredId: "default",
                      }),
                    ]
                  : page.url.endsWith("/http-b")
                    ? [
                        makePreferredPathOverrideWarning({
                          kind: "provider",
                          selectedId: "browser-basic",
                          preferredId: "http-basic",
                        }),
                      ]
                    : [],
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
                contentBytes: 20_000,
                titlePresent: true,
                finalUrl: page.url,
                warnings: page.url.endsWith("/browser-a")
                  ? [
                      makePreferredPathOverrideWarning({
                        kind: "egress",
                        selectedId: "leased-direct",
                        preferredId: "direct",
                      }),
                    ]
                  : [],
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.summary?.preferredPathOverrideCount).toBe(3);
    expect(artifact.summary?.topPreferredPathOverrideDomains).toEqual([
      { key: "alpha.example", count: 2 },
      { key: "beta.example", count: 1 },
    ]);
    expect(artifact.summary?.topPreferredPathOverrideKinds).toEqual([
      { key: "egress", count: 2 },
      { key: "identity", count: 1 },
      { key: "provider", count: 1 },
    ]);
    expect(artifact.summary?.topHttpPreferredPathOverrideDomains).toEqual([
      { key: "alpha.example", count: 1 },
      { key: "beta.example", count: 1 },
    ]);
    expect(artifact.summary?.topHttpPreferredPathOverrideKinds).toEqual([
      { key: "egress", count: 1 },
      { key: "identity", count: 1 },
      { key: "provider", count: 1 },
    ]);
    expect(artifact.summary?.topBrowserPreferredPathOverrideDomains).toEqual([
      { key: "alpha.example", count: 1 },
    ]);
    expect(artifact.summary?.topBrowserPreferredPathOverrideKinds).toEqual([
      { key: "egress", count: 1 },
    ]);
    expect(artifact.warnings).toContain(
      "Access-health-driven preferred-path overrides affected 3 attempts; success and throughput may reflect fallback provider, egress or identity choices instead of the preferred route.",
    );
    expect(artifact.warnings).toContain(
      "Preferred-path overrides cluster on alpha.example (2 attempts).",
    );
    expect(artifact.warnings).toContain("Top preferred-path override kind: egress (2 attempts).");
    expect(artifact.warnings).toContain(
      "HTTP preferred-path overrides span multiple domains: alpha.example, beta.example.",
    );
    expect(artifact.warnings).toContain(
      "HTTP preferred-path override kinds are mixed: egress, identity, provider.",
    );
    expect(artifact.warnings).toContain(
      "Browser preferred-path overrides cluster on alpha.example (1 attempts).",
    );
    expect(artifact.warnings).toContain(
      "Top browser preferred-path override kind: egress (1 attempts).",
    );
    expect(artifact.recommendations).toContain(
      "Stabilize or isolate access-health-driven provider, egress, or identity overrides before comparing benchmark trends against the preferred path.",
    );
    expect(artifact.recommendations).toContain(
      "Preferred-path override domains to inspect first: alpha.example, beta.example.",
    );
    expect(artifact.recommendations).toContain(
      "Inspect egress health-scoring drift before treating throughput or success changes as domain behavior.",
    );
    expect(artifact.recommendations).toContain(
      "HTTP preferred-path override domains to inspect first: alpha.example, beta.example.",
    );
    expect(artifact.recommendations).toContain(
      "Browser preferred-path override domains to inspect first: alpha.example.",
    );
    expect(artifact.recommendations).toContain(
      "Browser preferred-path drift is egress-led; inspect browser egress health scoring before interpreting fallback results.",
    );
    expect(artifact.summary?.topLocalFailureCategories).toEqual([]);
  });

  it("keeps browser identity override drift visible when aggregate preferred-path drift is egress-led", async () => {
    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        phases: ["http", "browser"],
        httpProfiles: ["effect-http"],
        browserProfiles: ["effect-browser"],
        httpConcurrency: [1],
        browserConcurrency: [1],
      },
      {
        pages: [
          {
            siteId: "site-http-alpha",
            domain: "alpha.example",
            kind: "retailer",
            state: "healthy",
            url: "https://alpha.example/http-a",
            pageType: "listing",
            title: "Alpha A",
            challengeSignals: [],
          },
          {
            siteId: "site-http-beta",
            domain: "beta.example",
            kind: "retailer",
            state: "healthy",
            url: "https://beta.example/http-b",
            pageType: "listing",
            title: "Beta B",
            challengeSignals: [],
          },
          {
            siteId: "site-browser-datart",
            domain: "datart.cz",
            kind: "retailer",
            state: "partial",
            url: "https://datart.cz/browser-a",
            pageType: "product",
            title: "Datart Browser",
            challengeSignals: [],
          },
          {
            siteId: "site-browser-sportisimo",
            domain: "sportisimo.cz",
            kind: "retailer",
            state: "partial",
            url: "https://sportisimo.cz/browser-b",
            pageType: "listing",
            title: "Sportisimo Browser",
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
                durationMs: 50,
                contentBytes: 20_000,
                titlePresent: true,
                finalUrl: page.url,
                warnings:
                  page.domain === "alpha.example" || page.domain === "beta.example"
                    ? [
                        makePreferredPathOverrideWarning({
                          kind: "egress",
                          selectedId: "leased-direct",
                          preferredId: "direct",
                        }),
                      ]
                    : [],
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
                contentBytes: 20_000,
                titlePresent: true,
                finalUrl: page.url,
                warnings:
                  page.domain === "datart.cz" || page.domain === "sportisimo.cz"
                    ? [
                        makePreferredPathOverrideWarning({
                          kind: "identity",
                          selectedId: "leased-default",
                          preferredId: "default",
                        }),
                      ]
                    : [],
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.summary?.topPreferredPathOverrideKinds).toEqual([
      { key: "egress", count: 2 },
      { key: "identity", count: 2 },
    ]);
    expect(artifact.summary?.topHttpPreferredPathOverrideKinds).toEqual([
      { key: "egress", count: 2 },
    ]);
    expect(artifact.summary?.topBrowserPreferredPathOverrideKinds).toEqual([
      { key: "identity", count: 2 },
    ]);
    expect(artifact.summary?.topBrowserPreferredPathOverrideDomains).toEqual([
      { key: "datart.cz", count: 1 },
      { key: "sportisimo.cz", count: 1 },
    ]);
    expect(artifact.warnings).toContain(
      "Preferred-path override kinds are mixed: egress, identity.",
    );
    expect(artifact.warnings).not.toContain(
      "Top preferred-path override kind: egress (2 attempts).",
    );
    expect(artifact.warnings).toContain(
      "Browser preferred-path overrides span multiple domains: datart.cz, sportisimo.cz.",
    );
    expect(artifact.warnings).toContain(
      "Top browser preferred-path override kind: identity (2 attempts).",
    );
    expect(artifact.recommendations).not.toContain(
      "Inspect egress health-scoring drift before treating throughput or success changes as domain behavior.",
    );
    expect(artifact.recommendations).toContain(
      "Browser preferred-path override domains to inspect first: datart.cz, sportisimo.cz.",
    );
    expect(artifact.recommendations).toContain(
      "Browser preferred-path drift is identity-led; inspect browser identity health scoring before treating browser failures as domain-side regressions.",
    );
  });

  it("merges runtime warnings with locally detectable access-wall signals", () => {
    expect(
      mergeChallengeSignals(
        ["status-403"],
        ["text-consent", "title-consent", "url-consent"],
        ["url-consent"],
      ),
    ).toEqual(["status-403", "text-consent", "title-consent", "url-consent"]);
    expect(mergeChallengeSignals(["status-403"], ["url-trap"])).toEqual(["status-403", "url-trap"]);
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

  it("classifies bare 403 walls into a dedicated forbidden benchmark category", async () => {
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
            siteId: "site-forbidden",
            domain: "boozt.example",
            kind: "retailer",
            state: "partial",
            url: "https://boozt.example/shop",
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
                statusCode: 403,
                redirected: false,
                challengeDetected: true,
                observedChallengeSignals: ["status-403"],
                durationMs: 50,
                contentBytes: 20_000,
                titlePresent: true,
                finalUrl: "https://boozt.example/shop",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.attempts[0]?.failureCategory).toBe("access-wall-forbidden");
    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall-forbidden",
      count: 1,
    });
    expect(artifact.summary?.topForbiddenFailureDomains).toEqual([
      { key: "boozt.example", count: 1 },
    ]);
    expect(artifact.recommendations).toContain(
      "Top remote failures are explicit forbidden walls; inspect domain-specific 401/403 blocking behavior before treating them as generic challenge regressions.",
    );
    expect(artifact.recommendations).toContain(
      "Forbidden-wall domains to inspect first: boozt.example.",
    );
  });

  it("classifies inferred bare 403 walls into a dedicated forbidden benchmark category", async () => {
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
            siteId: "site-inferred-forbidden",
            domain: "boozt.example",
            kind: "retailer",
            state: "partial",
            url: "https://boozt.example/shop",
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
                statusCode: 403,
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 50,
                contentBytes: 20_000,
                titlePresent: true,
                finalUrl: "https://boozt.example/shop",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.attempts[0]?.observedChallengeSignals).toEqual(["status-403"]);
    expect(artifact.browserCorpus.attempts[0]?.failureCategory).toBe("access-wall-forbidden");
    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall-forbidden",
      count: 1,
    });
    expect(artifact.summary?.topForbiddenFailureDomains).toEqual([
      { key: "boozt.example", count: 1 },
    ]);
  });

  it("classifies bare 401 walls into a dedicated forbidden benchmark category", async () => {
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
            siteId: "site-forbidden-401",
            domain: "auth.example",
            kind: "retailer",
            state: "partial",
            url: "https://auth.example/shop",
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
                statusCode: 401,
                redirected: false,
                challengeDetected: true,
                observedChallengeSignals: ["status-401"],
                durationMs: 50,
                contentBytes: 20_000,
                titlePresent: true,
                finalUrl: "https://auth.example/shop",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.attempts[0]?.failureCategory).toBe("access-wall-forbidden");
    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall-forbidden",
      count: 1,
    });
    expect(artifact.summary?.topForbiddenFailureDomains).toEqual([
      { key: "auth.example", count: 1 },
    ]);
  });

  it("classifies inferred bare 401 walls into a dedicated forbidden benchmark category", async () => {
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
            siteId: "site-inferred-forbidden-401",
            domain: "auth.example",
            kind: "retailer",
            state: "partial",
            url: "https://auth.example/shop",
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
                statusCode: 401,
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 50,
                contentBytes: 20_000,
                titlePresent: true,
                finalUrl: "https://auth.example/shop",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.attempts[0]?.observedChallengeSignals).toEqual(["status-401"]);
    expect(artifact.browserCorpus.attempts[0]?.failureCategory).toBe("access-wall-forbidden");
    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall-forbidden",
      count: 1,
    });
    expect(artifact.summary?.topForbiddenFailureDomains).toEqual([
      { key: "auth.example", count: 1 },
    ]);
  });

  it("keeps weak-hint 403 walls in the generic access-wall benchmark category", async () => {
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
            siteId: "site-generic-403",
            domain: "boozt.example",
            kind: "retailer",
            state: "partial",
            url: "https://boozt.example/shop",
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
                statusCode: 403,
                redirected: false,
                challengeDetected: true,
                observedChallengeSignals: ["status-403", "text-cookies"],
                durationMs: 50,
                contentBytes: 20_000,
                titlePresent: true,
                finalUrl: "https://boozt.example/shop",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.attempts[0]?.failureCategory).toBe("access-wall");
    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall",
      count: 1,
    });
    expect(artifact.summary?.topForbiddenFailureDomains).toEqual([]);
  });

  it("classifies Cloudflare-style 403 redirects into challenge benchmark failures", async () => {
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
            siteId: "site-cloudflare-403",
            domain: "boozt.example",
            kind: "retailer",
            state: "partial",
            url: "https://boozt.example/shop",
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
                statusCode: 403,
                redirected: true,
                challengeDetected: true,
                observedChallengeSignals: ["status-403"],
                durationMs: 50,
                contentBytes: 20_000,
                titlePresent: true,
                finalUrl: "https://boozt.example/shop?__cf_chl_rt_tk=abc123&__cf_chl_tk=def456",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.attempts[0]?.failureCategory).toBe("access-wall-challenge");
    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall-challenge",
      count: 1,
    });
    expect(artifact.summary?.topChallengeFailureDomains).toEqual([
      { key: "boozt.example", count: 1 },
    ]);
    expect(artifact.summary?.topForbiddenFailureDomains).toEqual([]);
  });

  it("does not let locally inferred 429 status override runner-reported challenge signals", async () => {
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
            siteId: "site-rate-limited-challenge",
            domain: "challenge.example",
            kind: "retailer",
            state: "partial",
            url: "https://challenge.example/shop",
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
                statusCode: 429,
                redirected: true,
                challengeDetected: true,
                observedChallengeSignals: ["url-challenge"],
                durationMs: 50,
                contentBytes: 0,
                titlePresent: false,
                finalUrl: "https://challenge.example/challenge?flow=bot-check",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.attempts[0]?.failureCategory).toBe("access-wall-challenge");
    expect(artifact.browserCorpus.attempts[0]?.observedChallengeSignals).toContain("url-challenge");
    expect(artifact.browserCorpus.attempts[0]?.observedChallengeSignals).not.toContain(
      "status-429",
    );
    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall-challenge",
      count: 1,
    });
    expect(artifact.summary?.topRateLimitFailureDomains).toEqual([]);
  });

  it("classifies locally detected 429 Cloudflare challenge redirects as challenge benchmark failures", async () => {
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
            siteId: "site-local-cloudflare-429",
            domain: "challenge.example",
            kind: "retailer",
            state: "partial",
            url: "https://challenge.example/shop",
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
                statusCode: 429,
                redirected: true,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 50,
                contentBytes: 0,
                titlePresent: false,
                finalUrl:
                  "https://challenge.example/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?__cf_chl_rt_tk=abc123",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.attempts[0]?.failureCategory).toBe("access-wall-challenge");
    expect(artifact.browserCorpus.attempts[0]?.observedChallengeSignals).toContain("status-429");
    expect(artifact.browserCorpus.attempts[0]?.observedChallengeSignals).toContain("url-challenge");
    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall-challenge",
      count: 1,
    });
    expect(artifact.summary?.topRateLimitFailureDomains).toEqual([]);
    expect(artifact.summary?.topChallengeFailureDomains).toEqual([
      { key: "challenge.example", count: 1 },
    ]);
  });

  it("keeps weak challenge-hint 403 walls in the generic access-wall benchmark category", async () => {
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
            siteId: "site-generic-403-challenge-hint",
            domain: "verify.example",
            kind: "retailer",
            state: "partial",
            url: "https://verify.example/shop",
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
                statusCode: 403,
                redirected: false,
                challengeDetected: true,
                observedChallengeSignals: ["status-403", "title-challenge-hint"],
                durationMs: 50,
                contentBytes: 20_000,
                titlePresent: true,
                finalUrl: "https://verify.example/shop",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.attempts[0]?.failureCategory).toBe("access-wall");
    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall",
      count: 1,
    });
    expect(artifact.summary?.topForbiddenFailureDomains).toEqual([]);
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
    expect(artifact.summary?.topConsentFailureDomains?.[0]).toEqual({
      key: "zbozi.example",
      count: 1,
    });
    expect(artifact.recommendations).toContain("Prioritize diagnostics for zbozi.example.");
    expect(artifact.recommendations).toContain(
      "Top remote failures are consent walls; prioritize consent-screen detection and domain-aware handling before judging fallback quality.",
    );
    expect(artifact.recommendations).toContain(
      "Consent-heavy domains to inspect first: zbozi.example.",
    );
  });

  it("classifies consent hint bundles into consent failures when privacy signals accompany them", async () => {
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
            siteId: "site-http-consent-hints",
            domain: "lidl.example",
            kind: "retailer",
            state: "partial",
            url: "https://lidl.example/",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
        ],
        httpProfileFactories: [
          {
            profile: "effect-http",
            createRunner: async () => ({
              runPage: async () => ({
                statusCode: 200,
                redirected: true,
                challengeDetected: true,
                observedChallengeSignals: ["text-consent-hint", "text-gdpr", "text-privacy"],
                durationMs: 50,
                contentBytes: 0,
                titlePresent: false,
                finalUrl: "https://www.lidl.example/privacy-center",
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
  });

  it("surfaces challenge-heavy domains separately from mixed remote failure domains", async () => {
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
            siteId: "site-challenge-a",
            domain: "ebay.example",
            kind: "aggregator",
            state: "partial",
            url: "https://ebay.example/a",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
          {
            siteId: "site-challenge-b",
            domain: "shein.example",
            kind: "retailer",
            state: "partial",
            url: "https://shein.example/b",
            pageType: "search",
            title: "Search",
            challengeSignals: [],
          },
          {
            siteId: "site-consent-a",
            domain: "zbozi.example",
            kind: "aggregator",
            state: "partial",
            url: "https://zbozi.example/c",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
        ],
        httpProfileFactories: [
          {
            profile: "effect-http",
            createRunner: async () => ({
              runPage: async (page) => {
                if (page.url === "https://ebay.example/a") {
                  return {
                    statusCode: 200,
                    redirected: true,
                    challengeDetected: true,
                    observedChallengeSignals: ["url-challenge"],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    finalUrl: "https://ebay.example/challenge",
                  };
                }

                if (page.url === "https://shein.example/b") {
                  return {
                    statusCode: 200,
                    redirected: true,
                    challengeDetected: true,
                    observedChallengeSignals: ["text-challenge"],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    finalUrl: "https://shein.example/challenge",
                  };
                }

                return {
                  statusCode: 200,
                  redirected: true,
                  challengeDetected: true,
                  observedChallengeSignals: ["text-consent", "title-consent"],
                  durationMs: 50,
                  contentBytes: 0,
                  titlePresent: false,
                  finalUrl: "https://zbozi.example/consent",
                };
              },
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall-challenge",
      count: 2,
    });
    expect(artifact.summary?.topChallengeFailureDomains).toEqual([
      { key: "ebay.example", count: 1 },
      { key: "shein.example", count: 1 },
    ]);
    expect(artifact.recommendations).toContain(
      "Challenge-heavy domains to inspect first: ebay.example, shein.example.",
    );
  });

  it("surfaces timeout-heavy domains separately from mixed remote failure domains", async () => {
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
            siteId: "site-timeout-a",
            domain: "sportisimo.example",
            kind: "retailer",
            state: "partial",
            url: "https://sportisimo.example/a",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
          {
            siteId: "site-timeout-b",
            domain: "bonami.example",
            kind: "retailer",
            state: "partial",
            url: "https://bonami.example/b",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
          {
            siteId: "site-timeout-c",
            domain: "ebay.example",
            kind: "aggregator",
            state: "partial",
            url: "https://ebay.example/c",
            pageType: "search",
            title: "Search",
            challengeSignals: [],
          },
          {
            siteId: "site-consent-a",
            domain: "zbozi.example",
            kind: "aggregator",
            state: "partial",
            url: "https://zbozi.example/d",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async (page) => {
                if (page.domain === "sportisimo.example") {
                  return {
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    error:
                      "Browser access failed :: navigation: TimeoutError: goto: Timeout 20000ms exceeded",
                  };
                }

                if (page.domain === "bonami.example") {
                  return {
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    error: "patchright navigation failed: Timeout 30000ms exceeded",
                  };
                }

                if (page.domain === "ebay.example") {
                  return {
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    error:
                      "Browser access failed :: navigation: TimeoutError: goto: Timeout 20000ms exceeded",
                  };
                }

                return {
                  statusCode: 200,
                  redirected: true,
                  challengeDetected: true,
                  observedChallengeSignals: ["text-consent", "title-consent"],
                  durationMs: 50,
                  contentBytes: 0,
                  titlePresent: false,
                  finalUrl: "https://zbozi.example/consent",
                };
              },
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "browser-navigation-timeout",
      count: 3,
    });
    expect(artifact.summary?.topTimeoutFailureDomains).toEqual([
      { key: "bonami.example", count: 1 },
      { key: "ebay.example", count: 1 },
      { key: "sportisimo.example", count: 1 },
    ]);
    expect(artifact.recommendations).toContain(
      "Top remote failures are browser navigation timeouts; prioritize timeout stratification, wait-condition tuning and domain-specific retry diagnostics before judging fallback quality.",
    );
    expect(artifact.recommendations).toContain(
      "Timeout-heavy domains to inspect first: bonami.example, ebay.example, sportisimo.example.",
    );
  });

  it("keeps timeout-heavy browser domains visible when challenge walls remain the top remote category", async () => {
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
            siteId: "site-challenge-a",
            domain: "ebay.example",
            kind: "aggregator",
            state: "partial",
            url: "https://ebay.example/a",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
          {
            siteId: "site-challenge-b",
            domain: "shein.example",
            kind: "retailer",
            state: "partial",
            url: "https://shein.example/b",
            pageType: "search",
            title: "Search",
            challengeSignals: [],
          },
          {
            siteId: "site-timeout-a",
            domain: "sportisimo.example",
            kind: "retailer",
            state: "partial",
            url: "https://sportisimo.example/c",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async (page) => {
                if (page.domain === "ebay.example") {
                  return {
                    statusCode: 200,
                    redirected: true,
                    challengeDetected: true,
                    observedChallengeSignals: ["url-challenge"],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    finalUrl: "https://ebay.example/challenge",
                  };
                }

                if (page.domain === "shein.example") {
                  return {
                    statusCode: 200,
                    redirected: true,
                    challengeDetected: true,
                    observedChallengeSignals: ["text-challenge"],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    finalUrl: "https://shein.example/challenge",
                  };
                }

                return {
                  redirected: false,
                  challengeDetected: false,
                  observedChallengeSignals: [],
                  durationMs: 50,
                  contentBytes: 0,
                  titlePresent: false,
                  error: "patchright navigation failed: Timeout 30000ms exceeded",
                };
              },
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall-challenge",
      count: 2,
    });
    expect(artifact.summary?.topTimeoutFailureDomains).toEqual([
      { key: "sportisimo.example", count: 1 },
    ]);
    expect(artifact.recommendations).toContain(
      "Challenge-heavy domains to inspect first: ebay.example, shein.example.",
    );
    expect(artifact.recommendations).toContain(
      "Browser navigation timeouts remain concentrated on: sportisimo.example.",
    );
  });

  it("keeps forbidden-heavy domains visible when challenge walls remain the top remote category", async () => {
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
            siteId: "site-challenge-a",
            domain: "ebay.example",
            kind: "aggregator",
            state: "partial",
            url: "https://ebay.example/a",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
          {
            siteId: "site-challenge-b",
            domain: "shein.example",
            kind: "retailer",
            state: "partial",
            url: "https://shein.example/b",
            pageType: "search",
            title: "Search",
            challengeSignals: [],
          },
          {
            siteId: "site-forbidden",
            domain: "boozt.example",
            kind: "retailer",
            state: "partial",
            url: "https://boozt.example/c",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
        ],
        httpProfileFactories: [
          {
            profile: "effect-http",
            createRunner: async () => ({
              runPage: async (page) => {
                if (page.domain === "boozt.example") {
                  return {
                    statusCode: 403,
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: 50,
                    contentBytes: 20_000,
                    titlePresent: true,
                    finalUrl: page.url,
                  };
                }

                return {
                  statusCode: 200,
                  redirected: true,
                  challengeDetected: true,
                  observedChallengeSignals: ["url-challenge"],
                  durationMs: 50,
                  contentBytes: 0,
                  titlePresent: false,
                  finalUrl: `${page.url}/challenge`,
                };
              },
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall-challenge",
      count: 2,
    });
    expect(artifact.summary?.topForbiddenFailureDomains).toEqual([
      { key: "boozt.example", count: 1 },
    ]);
    expect(artifact.recommendations).toContain(
      "Challenge-heavy domains to inspect first: ebay.example, shein.example.",
    );
    expect(artifact.recommendations).toContain(
      "Explicit 401/403 blocking remains concentrated on: boozt.example.",
    );
  });

  it("keeps browser HTTP and header-read domains visible when access walls remain the top browser category", async () => {
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
            siteId: "site-access-wall-a",
            domain: "boozt.example",
            kind: "retailer",
            state: "partial",
            url: "https://boozt.example/a",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
          {
            siteId: "site-access-wall-b",
            domain: "boozt.example",
            kind: "retailer",
            state: "partial",
            url: "https://boozt.example/b",
            pageType: "search",
            title: "Search",
            challengeSignals: [],
          },
          {
            siteId: "site-http-error",
            domain: "datart.example",
            kind: "retailer",
            state: "partial",
            url: "https://datart.example/c",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
          {
            siteId: "site-header-read",
            domain: "datart.example",
            kind: "retailer",
            state: "partial",
            url: "https://datart.example/d",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async (page) => {
                if (page.url.endsWith("/c")) {
                  return {
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    error:
                      "Browser access failed :: navigation: HTTP 404 from https://datart.example/c",
                  };
                }

                if (page.url.endsWith("/d")) {
                  return {
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    error:
                      "Browser access failed for https://datart.example/d :: header-read: Error: HTTP 404",
                  };
                }

                return {
                  statusCode: 403,
                  redirected: false,
                  challengeDetected: true,
                  observedChallengeSignals: ["status-403", "text-cookies"],
                  durationMs: 50,
                  contentBytes: 20_000,
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

    expect(artifact.summary?.topBrowserRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall",
      count: 2,
    });
    expect(artifact.summary?.topNavigationHttpErrorFailureDomains).toEqual([
      { key: "datart.example", count: 1 },
    ]);
    expect(artifact.summary?.topHeaderReadFailureDomains).toEqual([
      { key: "datart.example", count: 1 },
    ]);
    expect(artifact.summary?.topBrowserResponseFailureDomains).toEqual([
      { key: "datart.example", count: 2 },
    ]);
    expect(artifact.recommendations).toContain(
      "Browser response-handling failures remain concentrated on: datart.example.",
    );
    expect(artifact.recommendations).not.toContain(
      "Browser navigation HTTP errors remain concentrated on: datart.example.",
    );
    expect(artifact.recommendations).not.toContain(
      "Browser header-read failures remain concentrated on: datart.example.",
    );
  });

  it("keeps specific browser HTTP guidance when header-read is too weak to make the top category breakdown", async () => {
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
            siteId: "site-access-wall-a",
            domain: "boozt.example",
            kind: "retailer",
            state: "partial",
            url: "https://boozt.example/a",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
          {
            siteId: "site-access-wall-b",
            domain: "boozt.example",
            kind: "retailer",
            state: "partial",
            url: "https://boozt.example/b",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
          {
            siteId: "site-access-wall-c",
            domain: "boozt.example",
            kind: "retailer",
            state: "partial",
            url: "https://boozt.example/c",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
          {
            siteId: "site-http-error-a",
            domain: "datart.example",
            kind: "retailer",
            state: "partial",
            url: "https://datart.example/d",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
          {
            siteId: "site-http-error-b",
            domain: "datart.example",
            kind: "retailer",
            state: "partial",
            url: "https://datart.example/e",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
          {
            siteId: "site-header-read",
            domain: "datart.example",
            kind: "retailer",
            state: "partial",
            url: "https://datart.example/f",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
          {
            siteId: "site-challenge",
            domain: "ebay.example",
            kind: "retailer",
            state: "partial",
            url: "https://ebay.example/g",
            pageType: "search",
            title: "Search",
            challengeSignals: [],
          },
          {
            siteId: "site-consent",
            domain: "zbozi.example",
            kind: "aggregator",
            state: "partial",
            url: "https://zbozi.example/h",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
          {
            siteId: "site-forbidden",
            domain: "boozt.example",
            kind: "retailer",
            state: "partial",
            url: "https://boozt.example/i",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async (page) => {
                if (page.url.endsWith("/d") || page.url.endsWith("/e")) {
                  return {
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    error: `Browser access failed :: navigation: HTTP 404 from ${page.url}`,
                  };
                }

                if (page.url.endsWith("/f")) {
                  return {
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    error: `Browser access failed for ${page.url} :: header-read: Error: HTTP 404`,
                  };
                }

                if (page.url.endsWith("/g")) {
                  return {
                    statusCode: 403,
                    redirected: true,
                    challengeDetected: true,
                    observedChallengeSignals: ["status-403"],
                    durationMs: 50,
                    contentBytes: 20_000,
                    titlePresent: true,
                    finalUrl: "https://ebay.example/g?__cf_chl_rt_tk=abc123&__cf_chl_tk=def456",
                  };
                }

                if (page.url.endsWith("/h")) {
                  return {
                    statusCode: 403,
                    redirected: false,
                    challengeDetected: true,
                    observedChallengeSignals: ["status-403", "text-consent", "text-gdpr"],
                    durationMs: 50,
                    contentBytes: 20_000,
                    titlePresent: true,
                    finalUrl: page.url,
                  };
                }

                if (page.url.endsWith("/i")) {
                  return {
                    statusCode: 403,
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: 50,
                    contentBytes: 20_000,
                    titlePresent: true,
                    finalUrl: page.url,
                  };
                }

                return {
                  statusCode: 403,
                  redirected: false,
                  challengeDetected: true,
                  observedChallengeSignals: ["status-403", "text-cookies"],
                  durationMs: 50,
                  contentBytes: 20_000,
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

    expect(artifact.summary?.topBrowserRemoteFailureCategories).toEqual([
      { key: "access-wall", count: 3 },
      { key: "browser-navigation-http-error", count: 2 },
      { key: "access-wall-challenge", count: 1 },
      { key: "access-wall-consent", count: 1 },
      { key: "access-wall-forbidden", count: 1 },
    ]);
    expect(artifact.summary?.topHeaderReadFailureDomains).toEqual([
      { key: "datart.example", count: 1 },
    ]);
    expect(artifact.summary?.topBrowserResponseFailureDomains).toEqual([
      { key: "datart.example", count: 3 },
    ]);
    expect(artifact.recommendations).toContain(
      "Browser navigation HTTP errors remain concentrated on: datart.example.",
    );
    expect(artifact.recommendations).not.toContain(
      "Browser response-handling failures remain concentrated on: datart.example.",
    );
  });

  it("keeps browser HTTP and header-read guidance separate when they cluster on different domains", async () => {
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
            siteId: "site-access-wall-a",
            domain: "boozt.example",
            kind: "retailer",
            state: "partial",
            url: "https://boozt.example/a",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
          {
            siteId: "site-access-wall-b",
            domain: "boozt.example",
            kind: "retailer",
            state: "partial",
            url: "https://boozt.example/b",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
          {
            siteId: "site-http-error",
            domain: "datart.example",
            kind: "retailer",
            state: "partial",
            url: "https://datart.example/c",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
          {
            siteId: "site-header-read",
            domain: "tesla.example",
            kind: "retailer",
            state: "partial",
            url: "https://tesla.example/d",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async (page) => {
                if (page.url.endsWith("/c")) {
                  return {
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    error: `Browser access failed :: navigation: HTTP 404 from ${page.url}`,
                  };
                }

                if (page.url.endsWith("/d")) {
                  return {
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    error: `Browser access failed for ${page.url} :: header-read: Error: HTTP 404`,
                  };
                }

                return {
                  statusCode: 403,
                  redirected: false,
                  challengeDetected: true,
                  observedChallengeSignals: ["status-403", "text-cookies"],
                  durationMs: 50,
                  contentBytes: 20_000,
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

    expect(artifact.summary?.topBrowserResponseFailureDomains).toEqual([
      { key: "datart.example", count: 1 },
      { key: "tesla.example", count: 1 },
    ]);
    expect(artifact.recommendations).toContain(
      "Browser navigation HTTP errors remain concentrated on: datart.example.",
    );
    expect(artifact.recommendations).toContain(
      "Browser header-read failures remain concentrated on: tesla.example.",
    );
    expect(artifact.recommendations).not.toContain(
      "Browser response-handling failures remain concentrated on: datart.example, tesla.example.",
    );
  });

  it("keeps combined browser response guidance visible when HTTP-side categories crowd the global remote top list", async () => {
    const artifact = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        phases: ["http", "browser"],
        httpProfiles: ["effect-http"],
        browserProfiles: ["effect-browser"],
        httpConcurrency: [1],
        browserConcurrency: [1],
      },
      {
        pages: [
          {
            siteId: "site-http-challenge",
            domain: "challenge.example",
            kind: "retailer",
            state: "partial",
            url: "https://challenge.example/a",
            pageType: "listing",
            title: "Challenge",
            challengeSignals: [],
          },
          {
            siteId: "site-http-consent",
            domain: "consent.example",
            kind: "aggregator",
            state: "partial",
            url: "https://consent.example/b",
            pageType: "listing",
            title: "Consent",
            challengeSignals: [],
          },
          {
            siteId: "site-http-forbidden",
            domain: "forbidden.example",
            kind: "retailer",
            state: "partial",
            url: "https://forbidden.example/c",
            pageType: "listing",
            title: "Forbidden",
            challengeSignals: [],
          },
          {
            siteId: "site-http-rate-limit",
            domain: "rate.example",
            kind: "retailer",
            state: "partial",
            url: "https://rate.example/d",
            pageType: "listing",
            title: "Rate",
            challengeSignals: [],
          },
          {
            siteId: "site-http-trap",
            domain: "trap.example",
            kind: "retailer",
            state: "partial",
            url: "https://trap.example/TSPD/?type=25",
            pageType: "listing",
            title: "Trap",
            challengeSignals: [],
          },
          {
            siteId: "site-browser-http-error",
            domain: "datart.example",
            kind: "retailer",
            state: "partial",
            url: "https://datart.example/e",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
          {
            siteId: "site-browser-header-read",
            domain: "datart.example",
            kind: "retailer",
            state: "partial",
            url: "https://datart.example/f",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
        ],
        httpProfileFactories: [
          {
            profile: "effect-http",
            createRunner: async () => ({
              runPage: async (page) => {
                switch (page.domain) {
                  case "challenge.example":
                    return {
                      statusCode: 403,
                      redirected: true,
                      challengeDetected: true,
                      observedChallengeSignals: ["status-403"],
                      durationMs: 50,
                      contentBytes: 20_000,
                      titlePresent: true,
                      finalUrl:
                        "https://challenge.example/a?__cf_chl_rt_tk=abc123&__cf_chl_tk=def456",
                    };
                  case "consent.example":
                    return {
                      statusCode: 403,
                      redirected: false,
                      challengeDetected: true,
                      observedChallengeSignals: ["status-403", "text-consent", "text-gdpr"],
                      durationMs: 50,
                      contentBytes: 20_000,
                      titlePresent: true,
                      finalUrl: page.url,
                    };
                  case "forbidden.example":
                    return {
                      statusCode: 403,
                      redirected: false,
                      challengeDetected: false,
                      observedChallengeSignals: [],
                      durationMs: 50,
                      contentBytes: 20_000,
                      titlePresent: true,
                      finalUrl: page.url,
                    };
                  case "rate.example":
                    return {
                      statusCode: 429,
                      redirected: false,
                      challengeDetected: false,
                      observedChallengeSignals: [],
                      durationMs: 50,
                      contentBytes: 20_000,
                      titlePresent: true,
                      finalUrl: page.url,
                    };
                  case "trap.example":
                    return {
                      statusCode: 200,
                      redirected: false,
                      challengeDetected: true,
                      observedChallengeSignals: ["url-trap"],
                      durationMs: 50,
                      contentBytes: 0,
                      titlePresent: false,
                      finalUrl: page.url,
                    };
                  default:
                    return {
                      statusCode: 200,
                      redirected: false,
                      challengeDetected: false,
                      observedChallengeSignals: [],
                      durationMs: 50,
                      contentBytes: 20_000,
                      titlePresent: true,
                      finalUrl: page.url,
                    };
                }
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
                if (page.url.endsWith("/e")) {
                  return {
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    error: `Browser access failed :: navigation: HTTP 404 from ${page.url}`,
                  };
                }

                if (page.url.endsWith("/f")) {
                  return {
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    error: `Browser access failed for ${page.url} :: header-read: Error: HTTP 404`,
                  };
                }

                return {
                  statusCode: 200,
                  redirected: false,
                  challengeDetected: false,
                  observedChallengeSignals: [],
                  durationMs: 50,
                  contentBytes: 20_000,
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

    expect(artifact.summary?.topRemoteFailureCategories).toEqual([
      { key: "access-wall-trap", count: 2 },
      { key: "access-wall-challenge", count: 1 },
      { key: "access-wall-consent", count: 1 },
      { key: "access-wall-forbidden", count: 1 },
      { key: "access-wall-rate-limit", count: 1 },
    ]);
    expect(artifact.summary?.topBrowserRemoteFailureCategories).toContainEqual({
      key: "browser-header-read-failed",
      count: 1,
    });
    expect(artifact.summary?.topBrowserRemoteFailureCategories).toContainEqual({
      key: "browser-navigation-http-error",
      count: 1,
    });
    expect(artifact.summary?.topBrowserResponseFailureDomains).toEqual([
      { key: "datart.example", count: 2 },
    ]);
    expect(artifact.recommendations).toContain(
      "Browser response-handling failures remain concentrated on: datart.example.",
    );
    expect(artifact.recommendations).not.toContain(
      "Browser navigation HTTP errors remain concentrated on: datart.example.",
    );
  });

  it("keeps the secondary header-read signal visible when navigation HTTP errors are already the top remote category", async () => {
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
            siteId: "site-http-error-a",
            domain: "datart.example",
            kind: "retailer",
            state: "partial",
            url: "https://datart.example/a",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
          {
            siteId: "site-http-error-b",
            domain: "datart.example",
            kind: "retailer",
            state: "partial",
            url: "https://datart.example/b",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
          {
            siteId: "site-header-read",
            domain: "datart.example",
            kind: "retailer",
            state: "partial",
            url: "https://datart.example/c",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async (page) => {
                if (page.url.endsWith("/a") || page.url.endsWith("/b")) {
                  return {
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    error: `Browser access failed :: navigation: HTTP 404 from ${page.url}`,
                  };
                }

                return {
                  redirected: false,
                  challengeDetected: false,
                  observedChallengeSignals: [],
                  durationMs: 50,
                  contentBytes: 0,
                  titlePresent: false,
                  error: `Browser access failed for ${page.url} :: header-read: Error: HTTP 404`,
                };
              },
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "browser-navigation-http-error",
      count: 2,
    });
    expect(artifact.summary?.topBrowserResponseFailureDomains).toEqual([
      { key: "datart.example", count: 3 },
    ]);
    expect(artifact.recommendations).toContain(
      "Top remote failures are browser navigation HTTP errors; inspect site-specific 4xx/5xx responses, redirect handling and fetch-versus-browser parity before treating them as generic access walls.",
    );
    expect(artifact.recommendations).toContain(
      "Browser header-read failures remain concentrated on: datart.example.",
    );
    expect(artifact.recommendations).not.toContain(
      "Browser response-handling failures remain concentrated on: datart.example.",
    );
  });

  it("surfaces domains that fail across multiple remote failure families", async () => {
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
            siteId: "site-boozt-wall",
            domain: "boozt.example",
            kind: "retailer",
            state: "partial",
            url: "https://boozt.example/a",
            pageType: "listing",
            title: "Listing",
            challengeSignals: [],
          },
          {
            siteId: "site-boozt-challenge",
            domain: "boozt.example",
            kind: "retailer",
            state: "partial",
            url: "https://boozt.example/b",
            pageType: "search",
            title: "Search",
            challengeSignals: [],
          },
          {
            siteId: "site-datart-http-error",
            domain: "datart.example",
            kind: "retailer",
            state: "partial",
            url: "https://datart.example/c",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
          {
            siteId: "site-datart-header-read",
            domain: "datart.example",
            kind: "retailer",
            state: "partial",
            url: "https://datart.example/d",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async (page) => {
                if (page.url.endsWith("/b")) {
                  return {
                    statusCode: 403,
                    redirected: true,
                    challengeDetected: true,
                    observedChallengeSignals: ["status-403"],
                    durationMs: 50,
                    contentBytes: 20_000,
                    titlePresent: true,
                    finalUrl: "https://boozt.example/b?__cf_chl_rt_tk=abc123&__cf_chl_tk=def456",
                  };
                }

                if (page.url.endsWith("/c")) {
                  return {
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    error:
                      "Browser access failed :: navigation: HTTP 404 from https://datart.example/c",
                  };
                }

                if (page.url.endsWith("/d")) {
                  return {
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    error:
                      "Browser access failed for https://datart.example/d :: header-read: Error: HTTP 404",
                  };
                }

                return {
                  statusCode: 403,
                  redirected: false,
                  challengeDetected: true,
                  observedChallengeSignals: ["status-403", "text-cookies"],
                  durationMs: 50,
                  contentBytes: 20_000,
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

    expect(artifact.summary?.topMixedRemoteFailureDomains).toEqual([
      {
        domain: "boozt.example",
        count: 2,
        categories: ["access-wall", "access-wall-challenge"],
        breakdown: [
          { key: "access-wall", count: 1 },
          { key: "access-wall-challenge", count: 1 },
        ],
      },
      {
        domain: "datart.example",
        count: 2,
        categories: ["browser-header-read-failed", "browser-navigation-http-error"],
        breakdown: [
          { key: "browser-header-read-failed", count: 1 },
          { key: "browser-navigation-http-error", count: 1 },
        ],
      },
    ]);
    expect(artifact.summary?.topBrowserResponseFailureDomains).toEqual([
      { key: "datart.example", count: 2 },
    ]);
    expect(artifact.recommendations).toContain(
      "Split domain triage by failure family where domains mix multiple remote signatures: boozt.example (access-wall x1, access-wall-challenge x1); datart.example (browser-header-read-failed x1, browser-navigation-http-error x1).",
    );
  });

  it("prioritizes equally frequent mixed domains by the dominant failure family count", async () => {
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
            siteId: "site-major-a",
            domain: "major.example",
            kind: "retailer",
            state: "partial",
            url: "https://major.example/a",
            pageType: "listing",
            title: "Major A",
            challengeSignals: [],
          },
          {
            siteId: "site-major-b",
            domain: "major.example",
            kind: "retailer",
            state: "partial",
            url: "https://major.example/b",
            pageType: "listing",
            title: "Major B",
            challengeSignals: [],
          },
          {
            siteId: "site-major-c",
            domain: "major.example",
            kind: "retailer",
            state: "partial",
            url: "https://major.example/c",
            pageType: "listing",
            title: "Major C",
            challengeSignals: [],
          },
          {
            siteId: "site-major-d",
            domain: "major.example",
            kind: "retailer",
            state: "partial",
            url: "https://major.example/d",
            pageType: "listing",
            title: "Major D",
            challengeSignals: [],
          },
          {
            siteId: "site-balanced-a",
            domain: "balanced.example",
            kind: "retailer",
            state: "partial",
            url: "https://balanced.example/a",
            pageType: "product",
            title: "Balanced A",
            challengeSignals: [],
          },
          {
            siteId: "site-balanced-b",
            domain: "balanced.example",
            kind: "retailer",
            state: "partial",
            url: "https://balanced.example/b",
            pageType: "product",
            title: "Balanced B",
            challengeSignals: [],
          },
          {
            siteId: "site-balanced-c",
            domain: "balanced.example",
            kind: "retailer",
            state: "partial",
            url: "https://balanced.example/c",
            pageType: "product",
            title: "Balanced C",
            challengeSignals: [],
          },
          {
            siteId: "site-balanced-d",
            domain: "balanced.example",
            kind: "retailer",
            state: "partial",
            url: "https://balanced.example/d",
            pageType: "product",
            title: "Balanced D",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async (page) => {
                if (page.domain === "major.example") {
                  if (page.url.endsWith("/d")) {
                    return {
                      statusCode: 403,
                      redirected: true,
                      challengeDetected: true,
                      observedChallengeSignals: ["status-403"],
                      durationMs: 50,
                      contentBytes: 20_000,
                      titlePresent: true,
                      finalUrl: "https://major.example/d?__cf_chl_rt_tk=abc123&__cf_chl_tk=def456",
                    };
                  }

                  return {
                    statusCode: 403,
                    redirected: false,
                    challengeDetected: true,
                    observedChallengeSignals: ["status-403", "text-cookies"],
                    durationMs: 50,
                    contentBytes: 20_000,
                    titlePresent: true,
                    finalUrl: page.url,
                  };
                }

                if (page.url.endsWith("/a") || page.url.endsWith("/b")) {
                  return {
                    redirected: false,
                    challengeDetected: false,
                    observedChallengeSignals: [],
                    durationMs: 50,
                    contentBytes: 0,
                    titlePresent: false,
                    error:
                      "Browser access failed :: navigation: HTTP 404 from https://balanced.example/c",
                  };
                }

                return {
                  redirected: false,
                  challengeDetected: false,
                  observedChallengeSignals: [],
                  durationMs: 50,
                  contentBytes: 0,
                  titlePresent: false,
                  error:
                    "Browser access failed for https://balanced.example/d :: header-read: Error: HTTP 404",
                };
              },
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.summary?.topMixedRemoteFailureDomains?.slice(0, 2)).toEqual([
      {
        domain: "major.example",
        count: 4,
        categories: ["access-wall", "access-wall-challenge"],
        breakdown: [
          { key: "access-wall", count: 3 },
          { key: "access-wall-challenge", count: 1 },
        ],
      },
      {
        domain: "balanced.example",
        count: 4,
        categories: ["browser-header-read-failed", "browser-navigation-http-error"],
        breakdown: [
          { key: "browser-header-read-failed", count: 2 },
          { key: "browser-navigation-http-error", count: 2 },
        ],
      },
    ]);
    expect(artifact.recommendations).toContain(
      "Split domain triage by failure family where domains mix multiple remote signatures: major.example (access-wall x3, access-wall-challenge x1); balanced.example (browser-header-read-failed x2, browser-navigation-http-error x2).",
    );
  });

  it("surfaces browser navigation HTTP error domains when they become the top remote category", async () => {
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
            siteId: "site-http-error-a",
            domain: "datart.example",
            kind: "retailer",
            state: "partial",
            url: "https://datart.example/a",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
          {
            siteId: "site-http-error-b",
            domain: "tesla.example",
            kind: "retailer",
            state: "partial",
            url: "https://tesla.example/b",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async (page) => ({
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 50,
                contentBytes: 0,
                titlePresent: false,
                error: `Browser access failed :: navigation: HTTP 404 from ${page.url}`,
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "browser-navigation-http-error",
      count: 2,
    });
    expect(artifact.summary?.topNavigationHttpErrorFailureDomains).toEqual([
      { key: "datart.example", count: 1 },
      { key: "tesla.example", count: 1 },
    ]);
    expect(artifact.summary?.topBrowserResponseFailureDomains).toEqual([
      { key: "datart.example", count: 1 },
      { key: "tesla.example", count: 1 },
    ]);
    expect(artifact.recommendations).toContain(
      "Top remote failures are browser navigation HTTP errors; inspect site-specific 4xx/5xx responses, redirect handling and fetch-versus-browser parity before treating them as generic access walls.",
    );
    expect(artifact.recommendations).toContain(
      "HTTP-error-heavy domains to inspect first: datart.example, tesla.example.",
    );
    expect(artifact.recommendations).not.toContain(
      "Browser response-handling failures remain concentrated on: datart.example, tesla.example.",
    );
  });

  it("surfaces browser header-read domains when they become the top remote category", async () => {
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
            siteId: "site-header-read-a",
            domain: "datart.example",
            kind: "retailer",
            state: "partial",
            url: "https://datart.example/a",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
          {
            siteId: "site-header-read-b",
            domain: "tesla.example",
            kind: "retailer",
            state: "partial",
            url: "https://tesla.example/b",
            pageType: "product",
            title: "Product",
            challengeSignals: [],
          },
        ],
        browserProfileFactories: [
          {
            profile: "effect-browser",
            createRunner: async () => ({
              runPage: async (page) => ({
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 50,
                contentBytes: 0,
                titlePresent: false,
                error: `Browser access failed for ${page.url} :: header-read: Error: HTTP 404`,
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.summary?.topRemoteFailureCategories?.[0]).toEqual({
      key: "browser-header-read-failed",
      count: 2,
    });
    expect(artifact.summary?.topHeaderReadFailureDomains).toEqual([
      { key: "datart.example", count: 1 },
      { key: "tesla.example", count: 1 },
    ]);
    expect(artifact.summary?.topBrowserResponseFailureDomains).toEqual([
      { key: "datart.example", count: 1 },
      { key: "tesla.example", count: 1 },
    ]);
    expect(artifact.recommendations).toContain(
      "Top remote failures are browser header-read faults; inspect site-specific response handling and header extraction before judging browser fallback quality.",
    );
    expect(artifact.recommendations).toContain(
      "Header-read-heavy domains to inspect first: datart.example, tesla.example.",
    );
    expect(artifact.recommendations).not.toContain(
      "Browser header-read failures remain concentrated on: datart.example, tesla.example.",
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
      "Local configuration, planning, or browser-engine failures affected 1 attempts; raw throughput and success metrics are partially invalidated.",
    );
    expect(artifact.recommendations).toContain(
      "Fix local selection/plugin configuration failures before comparing remote-site success or throughput across browser sweeps.",
    );
  });

  it("classifies access-health quarantine short-circuits as local failures", async () => {
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
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 0.5,
                contentBytes: 0,
                titlePresent: false,
                error: `Browser access failed for ${page.url} :: subject=["domain","alpha.example"] quarantinedUntil=2026-03-09T23:00:00.000Z`,
                warnings: [
                  'Domain "alpha.example" is currently quarantined in access health state.',
                ],
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.attempts[0]?.failureCategory).toBe(
      "local-access-health-quarantine",
    );
    expect(artifact.browserCorpus.sweeps[0]?.localFailureCount).toBe(1);
    expect(artifact.browserCorpus.sweeps[0]?.effectiveAttemptCount).toBe(0);
    expect(artifact.summary?.browserLocalFailureCount).toBe(1);
    expect(artifact.summary?.browserRemoteFailureCount).toBeUndefined();
    expect(artifact.summary?.topLocalFailureCategories[0]).toEqual({
      key: "local-access-health-quarantine",
      count: 1,
    });
    expect(artifact.summary?.topRemoteFailureCategories).toEqual([]);
    expect(artifact.summary?.topBrowserRemoteFailureCategories).toBeUndefined();
    expect(artifact.status).toBe("warn");
    expect(artifact.recommendations).toContain(
      "Clear or isolate access-health quarantine carryover before interpreting remote-failure or throughput trends from the affected lane.",
    );
  });

  it("uses lane-agnostic quarantine guidance for http-only local access-health failures", async () => {
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
            siteId: "site-http-quarantine",
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
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 0.5,
                contentBytes: 0,
                titlePresent: false,
                error: `HTTP access failed for ${page.url} :: subject=["domain","alpha.example"] quarantinedUntil=2026-03-09T23:00:00.000Z`,
                warnings: [
                  'Domain "alpha.example" is currently quarantined in access health state.',
                ],
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.httpCorpus.attempts[0]?.failureCategory).toBe("local-access-health-quarantine");
    expect(artifact.httpCorpus.sweeps[0]?.localFailureCount).toBe(1);
    expect(artifact.httpCorpus.sweeps[0]?.effectiveAttemptCount).toBe(0);
    expect(artifact.summary?.httpLocalFailureCount).toBe(1);
    expect(artifact.summary?.browserLocalFailureCount).toBe(0);
    expect(artifact.summary?.browserRemoteFailureCount).toBeUndefined();
    expect(artifact.summary?.topLocalFailureCategories[0]).toEqual({
      key: "local-access-health-quarantine",
      count: 1,
    });
    expect(artifact.summary?.topRemoteFailureCategories).toEqual([]);
    expect(artifact.status).toBe("warn");
    expect(artifact.recommendations).toContain(
      "Clear or isolate access-health quarantine carryover before interpreting remote-failure or throughput trends from the affected lane.",
    );
  });

  it("preserves remote browser guidance when local and remote browser failures mix", async () => {
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
                    }
                  : {
                      statusCode: 200,
                      redirected: true,
                      challengeDetected: true,
                      observedChallengeSignals: ["text-consent", "title-consent"],
                      durationMs: 120,
                      contentBytes: 2_048,
                      titlePresent: true,
                      finalUrl: "https://cmp.example/consent",
                      warnings: ["access-wall:text-consent", "access-wall:title-consent"],
                    },
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.summary?.browserLocalFailureCount).toBe(1);
    expect(artifact.summary?.browserRemoteFailureCount).toBe(1);
    expect(artifact.summary?.topBrowserRemoteFailureDomains?.[0]).toEqual({
      key: "beta.example",
      count: 1,
    });
    expect(artifact.summary?.topBrowserRemoteFailureCategories?.[0]).toEqual({
      key: "access-wall-consent",
      count: 1,
    });
    expect(artifact.warnings).toContain("Browser failures cluster on beta.example (1 attempts).");
    expect(artifact.warnings).toContain(
      "Top browser failure category: access-wall-consent (1 attempts).",
    );
    expect(artifact.recommendations).toContain(
      "Review browser failure categories and top failing domains before treating browser fallback as production-ready.",
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
                  identityProfileId: "default",
                  identityPluginId: "builtin-default-identity",
                  identityTenantId: "public",
                  browserRuntimeProfileId: "patchright-default",
                },
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
    expect(artifact.summary?.topBrowserRecoveredAllocationDomains?.[0]).toEqual({
      key: "alpha.example",
      count: 1,
    });
    expect(artifact.summary?.topBrowserRecoveredAllocationProfiles?.[0]).toEqual({
      key: "patchright-default",
      count: 1,
    });
    expect(artifact.warnings).toContain(
      "Recovered browser allocation protocol faults occurred 1 times; browser runtime retried successfully but engine stability noise is present.",
    );
    expect(artifact.warnings).toContain(
      "Recovered browser allocation faults clustered on alpha.example (1 attempts).",
    );
    expect(artifact.recommendations).toContain(
      "Inspect Patchright/Chromium page-allocation stability and recovered protocol faults before trusting browser-lane reliability trends.",
    );
    expect(artifact.recommendations).toContain(
      "Start recovered browser-allocation triage with profile patchright-default on domain alpha.example.",
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
            preferredPathOverrideCount: 0,
            topPreferredPathOverrideDomains: [],
            topPreferredPathOverrideKinds: [],
            topHttpPreferredPathOverrideDomains: [],
            topHttpPreferredPathOverrideKinds: [],
            topBrowserPreferredPathOverrideDomains: [],
            topBrowserPreferredPathOverrideKinds: [],
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
        preferredPathOverrideCount: 0,
        topPreferredPathOverrideDomains: [],
        topPreferredPathOverrideKinds: [],
        topHttpPreferredPathOverrideDomains: [],
        topHttpPreferredPathOverrideKinds: [],
        topBrowserPreferredPathOverrideDomains: [],
        topBrowserPreferredPathOverrideKinds: [],
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

  it("recomputes preferred-path override diagnostics when merging partial artifacts", async () => {
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

    const httpOnly = await runE9BenchmarkSuite(
      {
        generatedAt: "2026-03-09T22:00:00.000Z",
        benchmarkId: "suite-preferred-http",
        phases: ["http"],
        httpConcurrency: [1],
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
                warnings:
                  page.domain === "alpha.example"
                    ? [legacyPreferredPathOverrideWarnings.egress]
                    : [],
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
        benchmarkId: "suite-preferred-browser",
        phases: ["browser"],
        browserConcurrency: [1],
      },
      {
        pages,
        browserProfileFactories: [
          {
            profile: "patchright-browser",
            createRunner: async () => ({
              runPage: async (page) => ({
                statusCode: 200,
                redirected: false,
                challengeDetected: false,
                observedChallengeSignals: [],
                durationMs: 40,
                contentBytes: 2_048,
                titlePresent: true,
                finalUrl: page.url,
                warnings:
                  page.domain === "beta.example"
                    ? [
                        legacyPreferredPathOverrideWarnings.provider,
                        legacyPreferredPathOverrideWarnings.identity,
                      ]
                    : [],
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    const merged = mergeE9BenchmarkArtifacts([httpOnly, browserOnly]);

    expect(merged.summary?.preferredPathOverrideCount).toBe(2);
    expect(merged.summary?.topPreferredPathOverrideDomains).toEqual([
      { key: "alpha.example", count: 1 },
      { key: "beta.example", count: 1 },
    ]);
    expect(merged.summary?.topPreferredPathOverrideKinds).toEqual([
      { key: "egress", count: 1 },
      { key: "identity", count: 1 },
      { key: "provider", count: 1 },
    ]);
    expect(merged.summary?.topHttpPreferredPathOverrideDomains).toEqual([
      { key: "alpha.example", count: 1 },
    ]);
    expect(merged.summary?.topHttpPreferredPathOverrideKinds).toEqual([
      { key: "egress", count: 1 },
    ]);
    expect(merged.summary?.topBrowserPreferredPathOverrideDomains).toEqual([
      { key: "beta.example", count: 1 },
    ]);
    expect(merged.summary?.topBrowserPreferredPathOverrideKinds).toEqual([
      { key: "identity", count: 1 },
      { key: "provider", count: 1 },
    ]);
    expect(merged.warnings).toContain(
      "Access-health-driven preferred-path overrides affected 2 attempts; success and throughput may reflect fallback provider, egress or identity choices instead of the preferred route.",
    );
    expect(merged.warnings).toContain(
      "Browser preferred-path override kinds are mixed: identity, provider.",
    );
    expect(merged.recommendations).toContain(
      "Stabilize or isolate access-health-driven provider, egress, or identity overrides before comparing benchmark trends against the preferred path.",
    );
    expect(merged.recommendations).toContain(
      "Browser preferred-path override domains to inspect first: beta.example.",
    );
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
          close: async () => undefined,
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
      expect(artifact.browserCorpus.sweeps[0]?.localFailureCount).toBe(1);
      expect(artifact.summary?.browserLocalFailureCount).toBe(1);
      expect(artifact.summary?.topLocalFailureCategories[0]).toEqual({
        key: "browser-context-allocation",
        count: 1,
      });
      expect(artifact.summary?.topRemoteFailureCategories).toEqual([]);
      expect(artifact.summary?.topRemoteFailureDomains).toEqual([]);
      expect(artifact.summary?.topBrowserFailureCategories[0]).toEqual({
        key: "browser-context-allocation",
        count: 1,
      });
      expect(artifact.warnings).toContain(
        "Local configuration, planning, or browser-engine failures affected 1 attempts; raw throughput and success metrics are partially invalidated.",
      );
      expect(artifact.recommendations).toContain(
        "Stabilize local browser engine/bootstrap failures before comparing remote-site success or throughput across browser sweeps.",
      );
    } finally {
      mock.restore();
    }
  });

  it("treats local-only browser engine sweeps as warn instead of fail", async () => {
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
                error: "patchright context-allocation failed: context-boom",
              }),
              close: async () => undefined,
            }),
          },
        ],
      },
    );

    expect(artifact.browserCorpus.sweeps[0]?.effectiveAttemptCount).toBe(0);
    expect(artifact.summary?.browserLocalFailureCount).toBe(1);
    expect(artifact.status).toBe("warn");
    const warnings = artifact.warnings ?? [];
    expect(warnings.some((warning) => warning.startsWith("Browser lane is degraded:"))).toBeFalse();
    expect(
      warnings.some((warning) => warning.startsWith("Browser failures cluster on")),
    ).toBeFalse();
    expect(
      warnings.some((warning) => warning.startsWith("Top browser failure category:")),
    ).toBeFalse();
    expect(artifact.recommendations).not.toContain(
      "Review browser failure categories and top failing domains before treating browser fallback as production-ready.",
    );
  });
});
