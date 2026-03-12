import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  BrowserMediationOutcomeSchema,
  BrowserMediationPolicySchema,
  didBrowserMediationAttempt,
  isBrowserMediationCleared,
  makeBrowserMediationPolicy,
  makeEmptyBrowserMediationOutcome,
} from "../../src/sdk/browser-mediation-model.ts";

describe("sdk browser mediation model", () => {
  it("builds a stable default mediation policy", () => {
    const policy = makeBrowserMediationPolicy();

    expect(Schema.decodeUnknownSync(BrowserMediationPolicySchema)(policy)).toEqual(policy);
    expect(policy.mode).toBe("off");
    expect(policy.maxAttempts).toBe(2);
    expect(policy.timeBudgetMs).toBe(15_000);
    expect(policy.postClearanceStrategy).toBe("auto");
  });

  it("lets overrides tighten the mediation policy without changing omitted defaults", () => {
    const policy = makeBrowserMediationPolicy({
      mode: "solve",
      vendors: ["cloudflare"],
      captureEvidence: true,
    });

    expect(policy.mode).toBe("solve");
    expect(policy.vendors).toEqual(["cloudflare"]);
    expect(policy.maxAttempts).toBe(2);
    expect(policy.captureEvidence).toBe(true);
  });

  it("classifies the empty outcome as neither attempted nor cleared", () => {
    const outcome = makeEmptyBrowserMediationOutcome();

    expect(Schema.decodeUnknownSync(BrowserMediationOutcomeSchema)(outcome)).toEqual(outcome);
    expect(didBrowserMediationAttempt(outcome)).toBe(false);
    expect(isBrowserMediationCleared(outcome)).toBe(false);
  });

  it("treats cleared outcomes as attempted and resolved", () => {
    const outcome = {
      kind: "challenge" as const,
      status: "cleared" as const,
      vendor: "cloudflare" as const,
      resolutionKind: "click" as const,
      attemptCount: 1,
      evidence: {
        signals: ["cloudflare:embedded"],
      },
      timings: {
        detectionMs: 12,
        resolutionMs: 82,
      },
    };

    expect(Schema.decodeUnknownSync(BrowserMediationOutcomeSchema)(outcome)).toEqual(outcome);
    expect(didBrowserMediationAttempt(outcome)).toBe(true);
    expect(isBrowserMediationCleared(outcome)).toBe(true);
  });
});
