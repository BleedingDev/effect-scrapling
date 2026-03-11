import { describe, expect, it } from "@effect-native/bun-test";
import { Effect } from "effect";
import { type AccessHealthSnapshot } from "@effect-scrapling/foundation-core/access-health-runtime";
import {
  makeHealthyFirstAccessSelectionStrategy,
  type AccessSelectionCandidate,
} from "../../src/sdk/access-selection-strategy-runtime.ts";

function providerSnapshot(input: {
  readonly providerId: string;
  readonly score: number;
  readonly quarantinedUntil?: string | null | undefined;
}): AccessHealthSnapshot {
  return {
    subject: {
      kind: "provider",
      providerId: input.providerId,
    },
    successCount: 0,
    failureCount: 0,
    successStreak: 0,
    failureStreak: 0,
    score: input.score,
    quarantinedUntil: input.quarantinedUntil ?? null,
  };
}

const candidates: ReadonlyArray<AccessSelectionCandidate> = [
  {
    providerId: "managed-browser",
    mode: "browser",
    inputOrder: 0,
    preferred: true,
  },
  {
    providerId: "browser-basic",
    mode: "browser",
    inputOrder: 1,
    preferred: false,
  },
];

describe("sdk access selection strategy runtime", () => {
  it("prefers a healthy higher-score candidate over a quarantined preferred provider", async () => {
    const strategy = makeHealthyFirstAccessSelectionStrategy();

    const selectedProviderId = await Effect.runPromise(
      strategy.selectCandidate({
        url: "https://example.com/browser-selection",
        mode: "browser",
        preferredProviderId: "managed-browser",
        candidates,
        healthSignals: {
          domain: {
            subject: {
              kind: "domain",
              domain: "example.com",
            },
            successCount: 0,
            failureCount: 0,
            successStreak: 0,
            failureStreak: 0,
            score: 100,
            quarantinedUntil: null,
          },
          providers: {
            "managed-browser": providerSnapshot({
              providerId: "managed-browser",
              score: 0,
              quarantinedUntil: "2099-01-01T00:00:00.000Z",
            }),
            "browser-basic": providerSnapshot({
              providerId: "browser-basic",
              score: 90,
            }),
          },
        },
      }),
    );

    expect(selectedProviderId.providerId).toBe("browser-basic");
    expect(selectedProviderId.rationale).toBe("health-signals");
  });

  it("keeps the preferred provider when health is equivalent", async () => {
    const strategy = makeHealthyFirstAccessSelectionStrategy();

    const selectedProviderId = await Effect.runPromise(
      strategy.selectCandidate({
        url: "https://example.com/browser-selection",
        mode: "browser",
        preferredProviderId: "managed-browser",
        candidates,
        healthSignals: {
          domain: {
            subject: {
              kind: "domain",
              domain: "example.com",
            },
            successCount: 0,
            failureCount: 0,
            successStreak: 0,
            failureStreak: 0,
            score: 100,
            quarantinedUntil: null,
          },
          providers: {
            "managed-browser": providerSnapshot({
              providerId: "managed-browser",
              score: 100,
            }),
            "browser-basic": providerSnapshot({
              providerId: "browser-basic",
              score: 100,
            }),
          },
        },
      }),
    );

    expect(selectedProviderId.providerId).toBe("managed-browser");
    expect(selectedProviderId.rationale).toBe("preferred");
  });

  it("falls back to input-order rationale when the preferred provider is absent", async () => {
    const strategy = makeHealthyFirstAccessSelectionStrategy();

    const selectedProviderId = await Effect.runPromise(
      strategy.selectCandidate({
        url: "https://example.com/browser-selection",
        mode: "browser",
        preferredProviderId: "missing-browser",
        candidates,
        healthSignals: {
          domain: {
            subject: {
              kind: "domain",
              domain: "example.com",
            },
            successCount: 0,
            failureCount: 0,
            successStreak: 0,
            failureStreak: 0,
            score: 100,
            quarantinedUntil: null,
          },
          providers: {
            "managed-browser": providerSnapshot({
              providerId: "managed-browser",
              score: 100,
            }),
            "browser-basic": providerSnapshot({
              providerId: "browser-basic",
              score: 100,
            }),
          },
        },
      }),
    );

    expect(selectedProviderId.providerId).toBe("managed-browser");
    expect(selectedProviderId.rationale).toBe("input-order");
  });
});
