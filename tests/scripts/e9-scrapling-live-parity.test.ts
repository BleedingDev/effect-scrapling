import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  compareE9ScraplingLiveParityTitleValues,
  createEffectScraplingLiveParityOutcome,
  createDefaultE9ScraplingLiveParityCorpus,
  E9_EFFECT_SCRAPLING_LIVE_COMMAND,
  E9ScraplingLiveParityArtifactSchema,
  E9_UPSTREAM_SCRAPLING_LIVE_COMMAND,
  extractPythonCommandCandidatesFromLauncher,
  runE9ScraplingLiveParity,
} from "../../src/e9-scrapling-live-parity.ts";
import {
  parseOptions,
  runDefaultE9ScraplingLiveParity,
} from "../../scripts/benchmarks/e9-scrapling-live-parity.ts";

describe("e9 scrapling live parity benchmark", () => {
  it("advertises upstream direct selector extraction in the runtime command", () => {
    expect(E9_EFFECT_SCRAPLING_LIVE_COMMAND).toContain("--mode browser");
    expect(E9_EFFECT_SCRAPLING_LIVE_COMMAND).toContain("--provider browser-stealth");
    expect(E9_UPSTREAM_SCRAPLING_LIVE_COMMAND).toContain("--css-selector h1");
    expect(E9_UPSTREAM_SCRAPLING_LIVE_COMMAND).toContain("--wait-selector h1");
  });

  it("extracts upstream python candidates from common shebang launchers", () => {
    expect(
      extractPythonCommandCandidatesFromLauncher(
        "#!/usr/bin/env python3\nprint('unused from launcher body')\n",
      ),
    ).toEqual([["python3"], ["python"]]);
    expect(
      extractPythonCommandCandidatesFromLauncher(
        "#!/usr/bin/env -S python3 -I\nprint('unused from launcher body')\n",
      ),
    ).toEqual([["python3", "-I"], ["python3"], ["python"]]);
    expect(
      extractPythonCommandCandidatesFromLauncher(
        "#!/usr/bin/env -S PYTHONPATH=/tmp python3 -I\nprint('unused from launcher body')\n",
      ),
    ).toEqual([["python3", "-I"], ["python3"], ["python"]]);
    expect(
      extractPythonCommandCandidatesFromLauncher(
        "#!/usr/bin/env -S \"python3 -I\"\nprint('unused from launcher body')\n",
      ),
    ).toEqual([["python3", "-I"], ["python3"], ["python"]]);
    expect(
      extractPythonCommandCandidatesFromLauncher(
        "#!/usr/bin/env PYTHONPATH=/tmp python3 -I\nprint('unused from launcher body')\n",
      ),
    ).toEqual([["python3", "-I"], ["python3"], ["python"]]);
    expect(
      extractPythonCommandCandidatesFromLauncher(
        "#!/opt/homebrew/bin/python3 -I\nprint('unused from launcher body')\n",
      ),
    ).toEqual([["/opt/homebrew/bin/python3", "-I"], ["python3"], ["python"]]);
  });

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

  it("defines a deterministic three-case Alza Turnstile live corpus", () => {
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
      {
        caseId: "case-e9-live-alza-smart-heater-h300-redirect",
        retailer: "alza",
        entryUrl: "https://www.alza.cz/tesla-smart-heater-h300-d7911948.htm",
        selector: "h1",
        expectedValue: "Tesla Smart Air Purifier S300B",
        requiresBypass: true,
      },
    ]);
  });

  it("returns fresh case objects for the default live corpus", () => {
    const firstCorpus = createDefaultE9ScraplingLiveParityCorpus();
    const mutatedCase = firstCorpus[0];
    if (mutatedCase === undefined) {
      throw new Error("Expected a first live corpus case.");
    }

    mutatedCase.expectedValue = "mutated";

    expect(createDefaultE9ScraplingLiveParityCorpus()[0]?.expectedValue).toBe(
      "TESLA RoboStar W800 WiFi",
    );
  });

  it("matches semantically equivalent title variants without requiring exact text equality", async () => {
    await expect(
      compareE9ScraplingLiveParityTitleValues(
        "TESLA Sound EB20 - Pearl Pink",
        "Bezdrátová sluchátka TESLA Sound EB20 (Pearl Pink)",
      ),
    ).resolves.toBe(true);
    await expect(
      compareE9ScraplingLiveParityTitleValues(
        "TESLA Sound EB20 - Pearl Pink",
        "TESLA Sound EB20 Case - Pearl Pink",
      ),
    ).resolves.toBe(false);
    await expect(
      compareE9ScraplingLiveParityTitleValues(
        "Tesla Smart Air Purifier S300B",
        "Tesla Smart Air Purifier S200B",
      ),
    ).resolves.toBe(false);
    await expect(
      compareE9ScraplingLiveParityTitleValues("TESLA Sound EB20 - Pearl Pink", "TESLA Sound EB20"),
    ).resolves.toBe(false);
    await expect(
      compareE9ScraplingLiveParityTitleValues(
        "Tesla Smart Air Purifier S300B",
        "Tesla Smart Air Purifier S300B + S200B",
      ),
    ).resolves.toBe(false);
    await expect(
      compareE9ScraplingLiveParityTitleValues("TESLA Filter", "TESLA Filter for S300B"),
    ).resolves.toBe(false);
    await expect(
      compareE9ScraplingLiveParityTitleValues(
        "TESLA Sound EB20 - Pearl Pink",
        "TESLA Sound EB20 - Pearl Pink used",
      ),
    ).resolves.toBe(false);
  });

  it("maps a decoded Effect-Scrapling success payload into a live parity outcome", async () => {
    const outcome = await createEffectScraplingLiveParityOutcome(
      {
        expectedValue: "TESLA Sound EB20 - Pearl Pink",
        requiresBypass: true,
      },
      {
        url: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
        values: ["Bezdrátová sluchátka TESLA Sound EB20 (Pearl Pink)"],
        mediationStatus: "cleared",
      },
      875,
    );

    expect(outcome.fetchSuccess).toBe(true);
    expect(outcome.valueMatchesReference).toBe(true);
    expect(outcome.bypassSuccess).toBe(true);
    expect(outcome.finalUrl).toBe("https://www.alza.cz/tesla-sound-eb20-d7915352.htm");
    expect(outcome.mediationStatus).toBe("cleared");
    expect(outcome.cloudflareSolved).toBe(true);
  });

  it("keeps bypass success when a decoded Effect-Scrapling payload is non-empty but off-reference", async () => {
    const outcome = await createEffectScraplingLiveParityOutcome(
      {
        expectedValue: "TESLA Sound EB20 - Pearl Pink",
        requiresBypass: true,
      },
      {
        url: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
        values: ["challenge-shell:case-e9-live-alza-sound-eb20"],
        mediationStatus: "cleared",
      },
      910,
    );

    expect(outcome.fetchSuccess).toBe(true);
    expect(outcome.valueMatchesReference).toBe(false);
    expect(outcome.bypassSuccess).toBe(true);
    expect(outcome.cloudflareSolved).toBe(true);
  });

  it("produces a passing live parity artifact when Effect-Scrapling is equal or better", async () => {
    const corpus = createDefaultE9ScraplingLiveParityCorpus();
    const artifact = await runE9ScraplingLiveParity({
      selectCases: async () => corpus,
      resolveRuntime: async () => ({
        measurementMode: "live-upstream-cli-turnstile",
        ourCommand: E9_EFFECT_SCRAPLING_LIVE_COMMAND,
        upstreamCommand: E9_UPSTREAM_SCRAPLING_LIVE_COMMAND,
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
    expect(decoded.caseCount).toBe(3);
    expect(decoded.summary.equalOrBetter.fetchSuccess).toBe(true);
    expect(decoded.summary.equalOrBetter.parityAgreement).toBe(true);
    expect(decoded.summary.equalOrBetter.bypassSuccess).toBe(true);
    expect(decoded.summary.equalOrBetter.referenceMatch).toBe(true);
    expect(decoded.summary.ours.referenceMatchRate).toBe(1);
    expect(decoded.cases.every(({ ours }) => ours.mediationStatus === "cleared")).toBe(true);
    expect(decoded.cases.every(({ requiresBypass }) => requiresBypass)).toBe(true);
    expect(decoded.cases.every(({ valueAgreement }) => valueAgreement)).toBe(true);
  });

  it("keeps parity agreement when both implementations return semantically equivalent title variants", async () => {
    const corpus = createDefaultE9ScraplingLiveParityCorpus();
    const secondCase = corpus[1];
    if (secondCase === undefined) {
      throw new Error("Expected the semantic title parity case.");
    }

    const artifact = await runE9ScraplingLiveParity({
      selectCases: async () => [secondCase],
      resolveRuntime: async () => ({
        measurementMode: "live-upstream-cli-turnstile",
        ourCommand: E9_EFFECT_SCRAPLING_LIVE_COMMAND,
        upstreamCommand: E9_UPSTREAM_SCRAPLING_LIVE_COMMAND,
        upstreamCliPath: "/Users/satan/.local/bin/scrapling",
        upstreamVersion: "0.4.1",
      }),
      runEffectScraplingCase: async () => ({
        fetchSuccess: true,
        valueMatchesReference: true,
        bypassSuccess: true,
        durationMs: 850,
        value: "Bezdrátová sluchátka TESLA Sound EB20 (Pearl Pink)",
        finalUrl: secondCase.entryUrl,
        mediationStatus: "cleared",
        cloudflareSolved: true,
      }),
      runUpstreamScraplingCase: async () => ({
        fetchSuccess: true,
        valueMatchesReference: true,
        bypassSuccess: true,
        durationMs: 900,
        value: "TESLA Sound EB20 - Pearl Pink",
        finalUrl: secondCase.entryUrl,
        cloudflareSolved: true,
      }),
    });

    expect(artifact.status).toBe("pass");
    expect(artifact.cases[0]?.valueAgreement).toBe(true);
    expect(artifact.summary.ours.parityAgreementRate).toBe(1);
    expect(artifact.summary.scrapling.parityAgreementRate).toBe(1);
  });

  it("does not claim parity agreement for different reference-aligned title variants", async () => {
    const secondCase = createDefaultE9ScraplingLiveParityCorpus()[1];
    if (secondCase === undefined) {
      throw new Error("Expected the semantic title parity case.");
    }

    const artifact = await runE9ScraplingLiveParity({
      selectCases: async () => [secondCase],
      resolveRuntime: async () => ({
        measurementMode: "live-upstream-cli-turnstile",
        ourCommand: E9_EFFECT_SCRAPLING_LIVE_COMMAND,
        upstreamCommand: E9_UPSTREAM_SCRAPLING_LIVE_COMMAND,
        upstreamCliPath: "/Users/satan/.local/bin/scrapling",
        upstreamVersion: "0.4.1",
      }),
      runEffectScraplingCase: async () => ({
        fetchSuccess: true,
        valueMatchesReference: true,
        bypassSuccess: true,
        durationMs: 850,
        value: "Bezdrátová sluchátka TESLA Sound EB20 (Pearl Pink)",
        finalUrl: secondCase.entryUrl,
        mediationStatus: "cleared",
        cloudflareSolved: true,
      }),
      runUpstreamScraplingCase: async () => ({
        fetchSuccess: true,
        valueMatchesReference: true,
        bypassSuccess: true,
        durationMs: 900,
        value: "Bluetooth sluchátka TESLA Sound EB20 (Pearl Pink)",
        finalUrl: secondCase.entryUrl,
        cloudflareSolved: true,
      }),
    });

    expect(artifact.cases[0]?.valueAgreement).toBe(false);
    expect(artifact.summary.ours.parityAgreementRate).toBe(0);
    expect(artifact.summary.scrapling.parityAgreementRate).toBe(0);
  });

  it("fails when both implementations match the reference loosely but disagree on the actual variant", async () => {
    const redirectCase = createDefaultE9ScraplingLiveParityCorpus()[2];
    if (redirectCase === undefined) {
      throw new Error("Expected the redirect live parity case.");
    }

    const artifact = await runE9ScraplingLiveParity({
      selectCases: async () => [redirectCase],
      resolveRuntime: async () => ({
        measurementMode: "live-upstream-cli-turnstile",
        ourCommand: E9_EFFECT_SCRAPLING_LIVE_COMMAND,
        upstreamCommand: E9_UPSTREAM_SCRAPLING_LIVE_COMMAND,
        upstreamCliPath: "/Users/satan/.local/bin/scrapling",
        upstreamVersion: "0.4.1",
      }),
      runEffectScraplingCase: async () => ({
        fetchSuccess: true,
        valueMatchesReference: true,
        bypassSuccess: true,
        durationMs: 875,
        value: "Tesla Smart Air Purifier S300B White",
        finalUrl: redirectCase.entryUrl,
        mediationStatus: "cleared",
        cloudflareSolved: true,
      }),
      runUpstreamScraplingCase: async () => ({
        fetchSuccess: true,
        valueMatchesReference: true,
        bypassSuccess: true,
        durationMs: 910,
        value: "Tesla Smart Air Purifier S300B Black",
        finalUrl: redirectCase.entryUrl,
        cloudflareSolved: true,
      }),
    });

    expect(artifact.status).toBe("fail");
    expect(artifact.cases[0]?.valueAgreement).toBe(false);
    expect(artifact.summary.ours.referenceMatchRate).toBe(1);
    expect(artifact.summary.scrapling.referenceMatchRate).toBe(1);
  });

  it("preserves redirected final urls in the live parity artifact", async () => {
    const corpus = createDefaultE9ScraplingLiveParityCorpus();
    const redirectCase = corpus[2];
    if (redirectCase === undefined) {
      throw new Error("Expected the redirect live parity case.");
    }

    const redirectedUrl = "https://www.alza.cz/tesla-smart-air-purifier-s300b-d12699012.htm";
    const artifact = await runE9ScraplingLiveParity({
      selectCases: async () => [redirectCase],
      resolveRuntime: async () => ({
        measurementMode: "live-upstream-cli-turnstile",
        ourCommand: E9_EFFECT_SCRAPLING_LIVE_COMMAND,
        upstreamCommand: E9_UPSTREAM_SCRAPLING_LIVE_COMMAND,
        upstreamCliPath: "/Users/satan/.local/bin/scrapling",
        upstreamVersion: "0.4.1",
      }),
      runEffectScraplingCase: async () => ({
        fetchSuccess: true,
        valueMatchesReference: true,
        bypassSuccess: true,
        durationMs: 875,
        value: redirectCase.expectedValue,
        finalUrl: redirectedUrl,
        mediationStatus: "cleared",
        cloudflareSolved: true,
      }),
      runUpstreamScraplingCase: async () => ({
        fetchSuccess: true,
        valueMatchesReference: true,
        bypassSuccess: true,
        durationMs: 940,
        value: redirectCase.expectedValue,
        finalUrl: redirectedUrl,
        cloudflareSolved: true,
      }),
    });

    expect(artifact.status).toBe("pass");
    expect(artifact.cases[0]?.ours.finalUrl).toBe(redirectedUrl);
    expect(artifact.cases[0]?.scrapling.finalUrl).toBe(redirectedUrl);
    expect(artifact.cases[0]?.ours.finalUrl).not.toBe(redirectCase.entryUrl);
    expect(artifact.cases[0]?.scrapling.finalUrl).not.toBe(redirectCase.entryUrl);
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
        ourCommand: E9_EFFECT_SCRAPLING_LIVE_COMMAND,
        upstreamCommand: E9_UPSTREAM_SCRAPLING_LIVE_COMMAND,
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
    expect(artifact.summary.equalOrBetter.parityAgreement).toBe(false);
    expect(artifact.summary.equalOrBetter.bypassSuccess).toBe(false);
    expect(artifact.summary.equalOrBetter.referenceMatch).toBe(false);
    expect(artifact.summary.ours.referenceMatchRate).toBeCloseTo(2 / 3);
    expect(artifact.summary.scrapling.referenceMatchRate).toBe(1);
    expect(artifact.summary.ours.parityAgreementRate).toBeCloseTo(2 / 3);
    expect(artifact.summary.scrapling.parityAgreementRate).toBe(1);
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
        ourCommand: E9_EFFECT_SCRAPLING_LIVE_COMMAND,
        upstreamCommand: E9_UPSTREAM_SCRAPLING_LIVE_COMMAND,
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

  it("tracks parity agreement when both implementations return the same drifted title", async () => {
    const corpus = createDefaultE9ScraplingLiveParityCorpus();
    const artifact = await runE9ScraplingLiveParity({
      selectCases: async () => corpus,
      resolveRuntime: async () => ({
        measurementMode: "live-upstream-cli-turnstile",
        ourCommand: E9_EFFECT_SCRAPLING_LIVE_COMMAND,
        upstreamCommand: E9_UPSTREAM_SCRAPLING_LIVE_COMMAND,
        upstreamCliPath: "/Users/satan/.local/bin/scrapling",
        upstreamVersion: "0.4.2",
      }),
      runEffectScraplingCase: async () => ({
        fetchSuccess: true,
        valueMatchesReference: false,
        bypassSuccess: false,
        durationMs: 900,
        value: "TESLA RoboStar W800 WiFi (2026 edition)",
        finalUrl: "https://www.alza.cz/tesla-robostar-w800-wifi-d12956895.htm",
        mediationStatus: "cleared",
        cloudflareSolved: true,
      }),
      runUpstreamScraplingCase: async () => ({
        fetchSuccess: true,
        valueMatchesReference: false,
        bypassSuccess: false,
        durationMs: 950,
        value: "TESLA RoboStar W800 WiFi (2026 edition)",
        finalUrl: "https://www.alza.cz/tesla-robostar-w800-wifi-d12956895.htm",
        cloudflareSolved: true,
      }),
    });

    expect(artifact.status).toBe("fail");
    expect(artifact.summary.ours.parityAgreementRate).toBe(1);
    expect(artifact.summary.scrapling.parityAgreementRate).toBe(1);
    expect(artifact.summary.ours.referenceMatchRate).toBe(0);
    expect(artifact.summary.scrapling.referenceMatchRate).toBe(0);
  });

  it("fails when both implementations agree on the same wrong value for every live case", async () => {
    const corpus = createDefaultE9ScraplingLiveParityCorpus();
    const artifact = await runE9ScraplingLiveParity({
      selectCases: async () => corpus,
      resolveRuntime: async () => ({
        measurementMode: "live-upstream-cli-turnstile",
        ourCommand: E9_EFFECT_SCRAPLING_LIVE_COMMAND,
        upstreamCommand: E9_UPSTREAM_SCRAPLING_LIVE_COMMAND,
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
    expect(artifact.summary.ours.parityAgreementRate).toBe(1);
    expect(artifact.summary.scrapling.parityAgreementRate).toBe(1);
    expect(artifact.summary.ours.referenceMatchRate).toBe(0);
    expect(artifact.summary.scrapling.referenceMatchRate).toBe(0);
  });

  it("rejects an empty live corpus with a clear validation error", async () => {
    await expect(
      runE9ScraplingLiveParity({
        selectCases: async () => [],
      }),
    ).rejects.toThrow("Expected at least one live parity case.");
  });

  it("passes when Effect-Scrapling matches the reference and upstream does not", async () => {
    const corpus = createDefaultE9ScraplingLiveParityCorpus();
    const artifact = await runE9ScraplingLiveParity({
      selectCases: async () => corpus,
      resolveRuntime: async () => ({
        measurementMode: "live-upstream-cli-turnstile",
        ourCommand: E9_EFFECT_SCRAPLING_LIVE_COMMAND,
        upstreamCommand: E9_UPSTREAM_SCRAPLING_LIVE_COMMAND,
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
        ourCommand: E9_EFFECT_SCRAPLING_LIVE_COMMAND,
        upstreamCommand: E9_UPSTREAM_SCRAPLING_LIVE_COMMAND,
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

  it("fails fast when no live parity cases are selected", async () => {
    await expect(
      runE9ScraplingLiveParity({
        selectCases: async () => [],
        resolveRuntime: async () => ({
          measurementMode: "live-upstream-cli-turnstile",
          ourCommand: E9_EFFECT_SCRAPLING_LIVE_COMMAND,
          upstreamCommand: E9_UPSTREAM_SCRAPLING_LIVE_COMMAND,
          upstreamCliPath: "/Users/satan/.local/bin/scrapling",
          upstreamVersion: "0.4.2",
        }),
      }),
    ).rejects.toThrow("Expected at least one live parity case.");
  });

  it("persists a decodable artifact through the benchmark wrapper", async () => {
    const artifact = await runDefaultE9ScraplingLiveParity(
      {},
      {
        runBenchmark: async () => ({
          benchmark: "e9-scrapling-live-parity",
          comparisonId: "comparison-e9-scrapling-live-parity",
          generatedAt: "2026-03-13T06:45:00.000Z",
          caseCount: 3,
          measurementMode: "live-upstream-cli-turnstile",
          runtime: {
            measurementMode: "live-upstream-cli-turnstile",
            ourCommand: E9_EFFECT_SCRAPLING_LIVE_COMMAND,
            upstreamCommand: E9_UPSTREAM_SCRAPLING_LIVE_COMMAND,
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
