import { describe, expect, it } from "@effect-native/bun-test";
import { Effect } from "effect";
import { summarizeSelectorTrust } from "../../libs/foundation/core/src/selector-trust-decay.ts";

describe("foundation-core selector trust decay", () => {
  it.effect("keeps recent successful selector histories in the trusted band", () =>
    Effect.gen(function* () {
      const summary = yield* summarizeSelectorTrust({
        evaluatedAt: "2026-03-08T12:00:00.000Z",
        events: [
          {
            selectorPath: "price/primary",
            outcome: "success",
            observedAt: "2026-03-08T11:00:00.000Z",
            evidenceRefs: ["artifact-price-001"],
          },
          {
            selectorPath: "price/primary",
            outcome: "success",
            observedAt: "2026-03-07T12:00:00.000Z",
            evidenceRefs: ["artifact-price-002"],
          },
        ],
      });

      expect(summary.records).toHaveLength(1);
      expect(summary.records[0]).toMatchObject({
        selectorPath: "price/primary",
        band: "trusted",
      });
      expect(summary.records[0]?.band).not.toBe("degraded");
      expect(summary.records[0]?.band).not.toBe("blocked");
      expect(summary.records[0]?.score).toBeGreaterThanOrEqual(0.8);
    }),
  );

  it.effect("degrades selectors after recoverable failures without blocking them immediately", () =>
    Effect.gen(function* () {
      const summary = yield* summarizeSelectorTrust({
        evaluatedAt: "2026-03-08T12:00:00.000Z",
        events: [
          {
            selectorPath: "price/primary",
            outcome: "success",
            observedAt: "2026-03-08T10:00:00.000Z",
            evidenceRefs: ["artifact-price-001"],
          },
          {
            selectorPath: "price/primary",
            outcome: "recoverableFailure",
            observedAt: "2026-03-08T11:00:00.000Z",
            evidenceRefs: ["artifact-price-002"],
          },
        ],
      });

      expect(summary.records[0]).toMatchObject({
        selectorPath: "price/primary",
        band: "degraded",
      });
      expect(summary.records[0]?.band).not.toBe("trusted");
      expect(summary.records[0]?.band).not.toBe("blocked");
      expect(summary.records[0]?.score).toBeGreaterThanOrEqual(0.45);
      expect(summary.records[0]?.score).toBeLessThan(0.8);
    }),
  );

  it.effect(
    "keeps a single recent hard failure degraded until repeated failures cross the blocked threshold",
    () =>
      Effect.gen(function* () {
        const summary = yield* summarizeSelectorTrust({
          evaluatedAt: "2026-03-08T12:00:00.000Z",
          events: [
            {
              selectorPath: "price/primary",
              outcome: "hardFailure",
              observedAt: "2026-03-08T11:45:00.000Z",
              evidenceRefs: ["artifact-price-001"],
            },
          ],
        });

        expect(summary.records[0]).toMatchObject({
          selectorPath: "price/primary",
          band: "degraded",
        });
        expect(summary.records[0]?.band).not.toBe("trusted");
        expect(summary.records[0]?.band).not.toBe("blocked");
      }),
  );

  it.effect("blocks selectors after repeated recent hard failures", () =>
    Effect.gen(function* () {
      const summary = yield* summarizeSelectorTrust({
        evaluatedAt: "2026-03-08T12:00:00.000Z",
        events: [
          {
            selectorPath: "price/primary",
            outcome: "hardFailure",
            observedAt: "2026-03-08T11:30:00.000Z",
            evidenceRefs: ["artifact-price-001"],
          },
          {
            selectorPath: "price/primary",
            outcome: "hardFailure",
            observedAt: "2026-03-08T11:45:00.000Z",
            evidenceRefs: ["artifact-price-002"],
          },
        ],
      });

      expect(summary.records[0]).toMatchObject({
        selectorPath: "price/primary",
        band: "blocked",
      });
      expect(summary.records[0]?.band).not.toBe("trusted");
      expect(summary.records[0]?.band).not.toBe("degraded");
      expect(summary.records[0]?.score).toBeLessThan(0.45);
    }),
  );

  it.effect(
    "lets stale failures decay across half-life windows before new successes restore trust",
    () =>
      Effect.gen(function* () {
        const summary = yield* summarizeSelectorTrust({
          evaluatedAt: "2026-03-08T12:00:00.000Z",
          events: [
            {
              selectorPath: "price/primary",
              outcome: "hardFailure",
              observedAt: "2026-02-27T12:00:00.000Z",
              evidenceRefs: ["artifact-price-001"],
            },
            {
              selectorPath: "price/primary",
              outcome: "success",
              observedAt: "2026-03-08T10:00:00.000Z",
              evidenceRefs: ["artifact-price-002"],
            },
            {
              selectorPath: "price/primary",
              outcome: "success",
              observedAt: "2026-03-08T11:00:00.000Z",
              evidenceRefs: ["artifact-price-003"],
            },
          ],
        });

        expect(summary.records[0]).toMatchObject({
          selectorPath: "price/primary",
          band: "trusted",
        });
        expect(summary.records[0]?.weightedFailures).toBeLessThan(1.5);
      }),
  );

  it.effect(
    "sorts trust summaries deterministically by band severity then score then selector path",
    () =>
      Effect.gen(function* () {
        const summary = yield* summarizeSelectorTrust({
          evaluatedAt: "2026-03-08T12:00:00.000Z",
          events: [
            {
              selectorPath: "price/fallback",
              outcome: "recoverableFailure",
              observedAt: "2026-03-08T11:00:00.000Z",
              evidenceRefs: ["artifact-price-001"],
            },
            {
              selectorPath: "price/primary",
              outcome: "hardFailure",
              observedAt: "2026-03-08T11:30:00.000Z",
              evidenceRefs: ["artifact-price-002"],
            },
            {
              selectorPath: "price/primary",
              outcome: "hardFailure",
              observedAt: "2026-03-08T11:45:00.000Z",
              evidenceRefs: ["artifact-price-003"],
            },
            {
              selectorPath: "title/primary",
              outcome: "success",
              observedAt: "2026-03-08T10:00:00.000Z",
              evidenceRefs: ["artifact-title-001"],
            },
          ],
        });

        expect(summary.records.map(({ selectorPath, band }) => ({ selectorPath, band }))).toEqual([
          {
            selectorPath: "price/primary",
            band: "blocked",
          },
          {
            selectorPath: "price/fallback",
            band: "degraded",
          },
          {
            selectorPath: "title/primary",
            band: "trusted",
          },
        ]);
      }),
  );

  it.effect("rejects malformed trust policies through shared schema contracts", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        summarizeSelectorTrust({
          evaluatedAt: "2026-03-08T12:00:00.000Z",
          events: [
            {
              selectorPath: "price/primary",
              outcome: "success",
              observedAt: "2026-03-08T11:00:00.000Z",
              evidenceRefs: ["artifact-price-001"],
            },
          ],
          policy: {
            halfLifeHours: 72,
            priorSuccessWeight: 4,
            priorFailureWeight: 1,
            recoverableFailurePenalty: 1.25,
            hardFailurePenalty: 3,
            degradedThreshold: 0.8,
            trustedThreshold: 0.45,
          },
        }),
      );

      expect(error.message).toContain("trustedThreshold");
    }),
  );
});
