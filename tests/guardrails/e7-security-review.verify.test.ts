import { describe, expect, it } from "@effect-native/bun-test";
import { Effect } from "effect";
import { buildQualityReportExport } from "../../libs/foundation/core/src/quality-report-runtime.ts";
import { runLiveCanaryHarness } from "../../libs/foundation/core/src/live-canary-runtime.ts";
import { toCoreErrorEnvelope } from "../../libs/foundation/core/src/tagged-errors.ts";
import { createDefaultQualityReportInput } from "../../scripts/benchmarks/e7-quality-report.ts";
import { createDefaultLiveCanaryInput } from "../../scripts/benchmarks/e7-live-canary.ts";

describe("E7 security review verification", () => {
  it.effect("rejects unauthorized live-canary seed URLs before execution", () =>
    Effect.gen(function* () {
      const input = createDefaultLiveCanaryInput();
      const scenario = input.scenarios[0];
      if (scenario === undefined) {
        throw new Error("Expected the default E7 canary suite to include at least one scenario.");
      }

      const failure = yield* runLiveCanaryHarness({
        ...input,
        scenarios: [
          {
            ...scenario,
            target: {
              ...scenario.target,
              seedUrls: ["https://attacker:secret@catalog.example.com/products/widget-http#token"],
            },
          },
          ...input.scenarios.slice(1),
        ],
      }).pipe(
        Effect.match({
          onFailure: toCoreErrorEnvelope,
          onSuccess: () => null,
        }),
      );

      expect(failure).toMatchObject({
        code: "parser_failure",
        retryable: false,
      });
      expect(failure?.message).toContain("canonical absolute HTTP(S) URL");
    }),
  );

  it.effect(
    "rejects quality-report exports when chaos evidence loses planner rationale traces",
    () =>
      Effect.gen(function* () {
        const input = yield* Effect.promise(() => createDefaultQualityReportInput());
        const firstResult = input.evidence.chaosProviderSuite.results[0];
        if (firstResult === undefined) {
          throw new Error(
            "Expected the default E7 chaos provider suite to include at least one result.",
          );
        }

        const failure = yield* buildQualityReportExport({
          ...input,
          evidence: {
            ...input.evidence,
            chaosProviderSuite: {
              ...input.evidence.chaosProviderSuite,
              results: [
                {
                  ...firstResult,
                  plannerRationale: [],
                },
                ...input.evidence.chaosProviderSuite.results.slice(1),
              ],
            },
          },
        }).pipe(
          Effect.match({
            onFailure: toCoreErrorEnvelope,
            onSuccess: () => null,
          }),
        );

        expect(failure).toMatchObject({
          code: "parser_failure",
          retryable: false,
        });
        expect(failure?.message).toContain("planner rationale");
      }),
  );
});
