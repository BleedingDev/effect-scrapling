import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  createDefaultE9ScraplingLiveParityCorpus,
  E9ScraplingLiveParityArtifactSchema,
  runE9ScraplingLiveParity,
} from "../../src/e9-scrapling-live-parity.ts";
import {
  parseOptions,
  runDefaultE9ScraplingLiveParity,
} from "../../scripts/benchmarks/e9-scrapling-live-parity.ts";

describe("e9 scrapling live parity benchmark", () => {
  it("parses only the supported artifact option", () => {
    expect(parseOptions([])).toEqual({
      artifactPath: undefined,
    });
    expect(parseOptions(["--artifact", "tmp/e9-scrapling-live-parity.json"])).toEqual({
      artifactPath: "tmp/e9-scrapling-live-parity.json",
    });
    expect(() => parseOptions(["--artifact"])).toThrow("Missing value for argument: --artifact");
    expect(() => parseOptions(["--bogus"])).toThrow("Unknown argument: --bogus");
  });

  it("defines a deterministic two-case Alza Turnstile live corpus", () => {
    expect(createDefaultE9ScraplingLiveParityCorpus()).toEqual([
      {
        caseId: "case-e9-live-alza-robostar-w800",
        retailer: "alza",
        entryUrl: "https://www.alza.cz/tesla-robostar-w800-wifi-d12956895.htm",
        selector: "h1",
        expectedValue: "TESLA RoboStar W800 WiFi",
        requiresBypass: true,
      },
      {
        caseId: "case-e9-live-alza-sound-eb20",
        retailer: "alza",
        entryUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
        selector: "h1",
        expectedValue: "TESLA Sound EB20 - Pearl Pink",
        requiresBypass: true,
      },
    ]);
  });

  it("produces a passing live parity artifact when Effect-Scrapling is equal or better", async () => {
    const corpus = createDefaultE9ScraplingLiveParityCorpus();
    const artifact = await runE9ScraplingLiveParity({
      selectCases: async () => corpus,
      resolveRuntime: async () => ({
        measurementMode: "live-upstream-cli-turnstile",
        ourCommand: "bun run src/standalone.ts extract run --solve-cloudflare",
        upstreamCommand: "scrapling extract stealthy-fetch --solve-cloudflare",
        upstreamCliPath: "/Users/satan/.local/bin/scrapling",
        upstreamVersion: "0.4.1",
      }),
      runEffectScraplingCase: async (input) => ({
        fetchSuccess: true,
        valueMatchesReference: true,
        bypassSuccess: true,
        durationMs: input.caseId.endsWith("eb20") ? 800 : 900,
        value: input.expectedValue,
        finalUrl: input.entryUrl,
        mediationStatus: "cleared",
        cloudflareSolved: true,
      }),
      runUpstreamScraplingCase: async (input) => ({
        fetchSuccess: true,
        valueMatchesReference: true,
        bypassSuccess: true,
        durationMs: input.caseId.endsWith("eb20") ? 950 : 1_100,
        value: input.expectedValue,
        finalUrl: input.entryUrl,
        cloudflareSolved: true,
      }),
    });

    const decoded = Schema.decodeUnknownSync(E9ScraplingLiveParityArtifactSchema)(artifact);
    expect(decoded.status).toBe("pass");
    expect(decoded.caseCount).toBe(2);
    expect(decoded.summary.equalOrBetter.fetchSuccess).toBe(true);
    expect(decoded.summary.equalOrBetter.parityAgreement).toBe(true);
    expect(decoded.summary.equalOrBetter.bypassSuccess).toBe(true);
    expect(decoded.summary.equalOrBetter.referenceMatch).toBe(true);
    expect(decoded.summary.ours.referenceMatchRate).toBe(1);
    expect(decoded.cases.every(({ ours }) => ours.mediationStatus === "cleared")).toBe(true);
    expect(decoded.cases.every(({ requiresBypass }) => requiresBypass)).toBe(true);
    expect(decoded.cases.every(({ valueAgreement }) => valueAgreement)).toBe(true);
  });

  it("fails when Effect-Scrapling loses a live case that upstream Scrapling still solves", async () => {
    const corpus = createDefaultE9ScraplingLiveParityCorpus();
    const firstCase = corpus[0];
    if (firstCase === undefined) {
      throw new Error("Expected at least one live parity case.");
    }

    const artifact = await runE9ScraplingLiveParity({
      selectCases: async () => corpus,
      resolveRuntime: async () => ({
        measurementMode: "live-upstream-cli-turnstile",
        ourCommand: "bun run src/standalone.ts extract run --solve-cloudflare",
        upstreamCommand: "scrapling extract stealthy-fetch --solve-cloudflare",
        upstreamCliPath: "/Users/satan/.local/bin/scrapling",
        upstreamVersion: "0.4.1",
      }),
      runEffectScraplingCase: async (input) =>
        input.caseId === firstCase.caseId
          ? {
              fetchSuccess: false,
              valueMatchesReference: false,
              bypassSuccess: false,
              durationMs: 1_500,
              diagnostic: "Browser timeout before clearance.",
            }
          : {
              fetchSuccess: true,
              valueMatchesReference: true,
              bypassSuccess: true,
              durationMs: 900,
              value: input.expectedValue,
              finalUrl: input.entryUrl,
              mediationStatus: "cleared",
              cloudflareSolved: true,
            },
      runUpstreamScraplingCase: async (input) => ({
        fetchSuccess: true,
        valueMatchesReference: true,
        bypassSuccess: true,
        durationMs: 950,
        value: input.expectedValue,
        finalUrl: input.entryUrl,
        cloudflareSolved: true,
      }),
    });

    expect(artifact.status).toBe("fail");
    expect(artifact.summary.equalOrBetter.fetchSuccess).toBe(false);
    expect(artifact.summary.equalOrBetter.parityAgreement).toBe(true);
    expect(artifact.summary.equalOrBetter.bypassSuccess).toBe(false);
    expect(artifact.summary.equalOrBetter.referenceMatch).toBe(false);
    expect(artifact.summary.ours.referenceMatchRate).toBe(0.5);
    expect(artifact.summary.scrapling.referenceMatchRate).toBe(1);
    expect(artifact.cases.find(({ caseId }) => caseId === firstCase.caseId)?.ours.diagnostic).toBe(
      "Browser timeout before clearance.",
    );
  });

  it("fails instead of passing when both implementations are down for every live case", async () => {
    const corpus = createDefaultE9ScraplingLiveParityCorpus();
    const artifact = await runE9ScraplingLiveParity({
      selectCases: async () => corpus,
      resolveRuntime: async () => ({
        measurementMode: "live-upstream-cli-turnstile",
        ourCommand: "bun run src/standalone.ts extract run --solve-cloudflare",
        upstreamCommand: "scrapling extract stealthy-fetch --solve-cloudflare",
        upstreamCliPath: "/Users/satan/.local/bin/scrapling",
        upstreamVersion: "0.4.2",
      }),
      runEffectScraplingCase: async () => ({
        fetchSuccess: false,
        valueMatchesReference: false,
        bypassSuccess: false,
        durationMs: 1_000,
        diagnostic: "Local browser bootstrap outage.",
      }),
      runUpstreamScraplingCase: async () => ({
        fetchSuccess: false,
        valueMatchesReference: false,
        bypassSuccess: false,
        durationMs: 1_100,
        diagnostic: "Shared upstream outage.",
      }),
    });

    expect(artifact.status).toBe("fail");
    expect(artifact.summary.equalOrBetter.fetchSuccess).toBe(true);
    expect(artifact.summary.equalOrBetter.parityAgreement).toBe(true);
    expect(artifact.summary.equalOrBetter.bypassSuccess).toBe(true);
    expect(artifact.summary.equalOrBetter.referenceMatch).toBe(true);
  });

  it("fails when both implementations agree on the same wrong value for every live case", async () => {
    const corpus = createDefaultE9ScraplingLiveParityCorpus();
    const artifact = await runE9ScraplingLiveParity({
      selectCases: async () => corpus,
      resolveRuntime: async () => ({
        measurementMode: "live-upstream-cli-turnstile",
        ourCommand: "bun run src/standalone.ts extract run --solve-cloudflare",
        upstreamCommand: "scrapling extract stealthy-fetch --solve-cloudflare",
        upstreamCliPath: "/Users/satan/.local/bin/scrapling",
        upstreamVersion: "0.4.2",
      }),
      runEffectScraplingCase: async (input) => ({
        fetchSuccess: true,
        valueMatchesReference: false,
        bypassSuccess: true,
        durationMs: 900,
        value: `challenge-shell:${input.caseId}`,
        finalUrl: input.entryUrl,
        mediationStatus: "cleared",
        cloudflareSolved: true,
      }),
      runUpstreamScraplingCase: async (input) => ({
        fetchSuccess: true,
        valueMatchesReference: false,
        bypassSuccess: true,
        durationMs: 950,
        value: `challenge-shell:${input.caseId}`,
        finalUrl: input.entryUrl,
        cloudflareSolved: true,
      }),
    });

    expect(artifact.status).toBe("fail");
    expect(artifact.summary.equalOrBetter.fetchSuccess).toBe(true);
    expect(artifact.summary.equalOrBetter.parityAgreement).toBe(true);
    expect(artifact.summary.equalOrBetter.bypassSuccess).toBe(true);
    expect(artifact.summary.equalOrBetter.referenceMatch).toBe(true);
    expect(artifact.summary.ours.referenceMatchRate).toBe(0);
    expect(artifact.summary.scrapling.referenceMatchRate).toBe(0);
  });

  it("passes when Effect-Scrapling matches the reference and upstream does not", async () => {
    const corpus = createDefaultE9ScraplingLiveParityCorpus();
    const artifact = await runE9ScraplingLiveParity({
      selectCases: async () => corpus,
      resolveRuntime: async () => ({
        measurementMode: "live-upstream-cli-turnstile",
        ourCommand: "bun run src/standalone.ts extract run --solve-cloudflare",
        upstreamCommand: "scrapling extract stealthy-fetch --solve-cloudflare",
        upstreamCliPath: "/Users/satan/.local/bin/scrapling",
        upstreamVersion: "0.4.2",
      }),
      runEffectScraplingCase: async (input) => ({
        fetchSuccess: true,
        valueMatchesReference: true,
        bypassSuccess: true,
        durationMs: 900,
        value: input.expectedValue,
        finalUrl: input.entryUrl,
        mediationStatus: "cleared",
        cloudflareSolved: true,
      }),
      runUpstreamScraplingCase: async (input) => ({
        fetchSuccess: true,
        valueMatchesReference: false,
        bypassSuccess: true,
        durationMs: 950,
        value: `wrong:${input.caseId}`,
        finalUrl: input.entryUrl,
        cloudflareSolved: true,
      }),
    });

    expect(artifact.status).toBe("pass");
    expect(artifact.summary.equalOrBetter.fetchSuccess).toBe(true);
    expect(artifact.summary.equalOrBetter.parityAgreement).toBe(true);
    expect(artifact.summary.equalOrBetter.bypassSuccess).toBe(true);
    expect(artifact.summary.equalOrBetter.referenceMatch).toBe(true);
    expect(artifact.summary.ours.referenceMatchRate).toBe(1);
    expect(artifact.summary.scrapling.referenceMatchRate).toBe(0);
  });

  it("passes when Effect-Scrapling solves every live case and upstream fails every case", async () => {
    const corpus = createDefaultE9ScraplingLiveParityCorpus();
    const artifact = await runE9ScraplingLiveParity({
      selectCases: async () => corpus,
      resolveRuntime: async () => ({
        measurementMode: "live-upstream-cli-turnstile",
        ourCommand: "bun run src/standalone.ts extract run --solve-cloudflare",
        upstreamCommand: "scrapling extract stealthy-fetch --solve-cloudflare",
        upstreamCliPath: "/Users/satan/.local/bin/scrapling",
        upstreamVersion: "0.4.2",
      }),
      runEffectScraplingCase: async (input) => ({
        fetchSuccess: true,
        valueMatchesReference: true,
        bypassSuccess: true,
        durationMs: 900,
        value: input.expectedValue,
        finalUrl: input.entryUrl,
        mediationStatus: "cleared",
        cloudflareSolved: true,
      }),
      runUpstreamScraplingCase: async () => ({
        fetchSuccess: false,
        valueMatchesReference: false,
        bypassSuccess: false,
        durationMs: 1_100,
        diagnostic: "Upstream solver stalled before extraction.",
      }),
    });

    expect(artifact.status).toBe("pass");
    expect(artifact.summary.equalOrBetter.fetchSuccess).toBe(true);
    expect(artifact.summary.equalOrBetter.parityAgreement).toBe(true);
    expect(artifact.summary.equalOrBetter.bypassSuccess).toBe(true);
    expect(artifact.summary.equalOrBetter.referenceMatch).toBe(true);
    expect(artifact.summary.ours.referenceMatchRate).toBe(1);
    expect(artifact.summary.scrapling.fetchSuccessRate).toBe(0);
  });

  it("persists a decodable artifact through the benchmark wrapper", async () => {
    const artifact = await runDefaultE9ScraplingLiveParity(
      {},
      {
        runBenchmark: async () => ({
        benchmark: "e9-scrapling-live-parity",
        comparisonId: "comparison-e9-scrapling-live-parity",
        generatedAt: "2026-03-13T06:45:00.000Z",
        caseCount: 2,
        measurementMode: "live-upstream-cli-turnstile",
        runtime: {
          measurementMode: "live-upstream-cli-turnstile",
          ourCommand: "bun run src/standalone.ts extract run --solve-cloudflare",
          upstreamCommand: "scrapling extract stealthy-fetch --solve-cloudflare",
          upstreamCliPath: "/Users/satan/.local/bin/scrapling",
          upstreamVersion: "0.4.1",
        },
        summary: {
          ours: {
            measurementMode: "live-upstream-cli-turnstile",
            fetchSuccessRate: 1,
            parityAgreementRate: 1,
            bypassSuccessRate: 1,
            referenceMatchRate: 1,
          },
          scrapling: {
            measurementMode: "live-upstream-cli-turnstile",
            fetchSuccessRate: 1,
            parityAgreementRate: 1,
            bypassSuccessRate: 1,
            referenceMatchRate: 1,
          },
          equalOrBetter: {
            fetchSuccess: true,
            parityAgreement: true,
            bypassSuccess: true,
            referenceMatch: true,
          },
        },
        cases: createDefaultE9ScraplingLiveParityCorpus().map((input) => ({
          ...input,
          valueAgreement: true,
          ours: {
            fetchSuccess: true,
            valueMatchesReference: true,
            bypassSuccess: true,
            durationMs: 1_000,
            value: input.expectedValue,
            finalUrl: input.entryUrl,
            mediationStatus: "cleared",
            cloudflareSolved: true,
          },
          scrapling: {
            fetchSuccess: true,
            valueMatchesReference: true,
            bypassSuccess: true,
            durationMs: 1_100,
            value: input.expectedValue,
            finalUrl: input.entryUrl,
            cloudflareSolved: true,
          },
        })),
        status: "pass",
      }),
    },
    );
    expect(artifact.runtime.upstreamVersion).not.toBe("");
    expect(artifact.status).toBe("pass");
  });
});
