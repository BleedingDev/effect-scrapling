import { join } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { PackCandidateProposalSchema } from "@effect-scrapling/foundation-core/pack-candidate-generator";
import { PackGovernanceResultSchema } from "@effect-scrapling/foundation-core/pack-governance-runtime";
import { PackLifecycleTransitionResultSchema } from "@effect-scrapling/foundation-core/pack-lifecycle-runtime";
import { PackPromotionDecisionSchema } from "@effect-scrapling/foundation-core/diff-verdict";
import { SelectorTrustSummarySchema } from "@effect-scrapling/foundation-core/selector-trust-decay";
import { SitePackSchema } from "@effect-scrapling/foundation-core/site-pack";
import { PackValidationVerdictSchema } from "@effect-scrapling/foundation-core/validator-ladder-runtime";
import { runE6SdkConsumerExample } from "../../examples/e6-sdk-consumer.ts";

const REPO_ROOT = import.meta.dir ? join(import.meta.dir, "..", "..") : process.cwd();
const EXAMPLE_PATH = join(REPO_ROOT, "examples", "e6-sdk-consumer.ts");

describe("E6 SDK consumer example", () => {
  it.effect("runs the E6 workspace consumer flow through foundation-core subpaths only", () =>
    Effect.gen(function* () {
      const result = yield* runE6SdkConsumerExample();

      const transitionedShadow = Schema.decodeUnknownSync(PackLifecycleTransitionResultSchema)(
        result.payload.transitionedShadow,
      );
      const resolvedPack = Schema.decodeUnknownSync(SitePackSchema)(result.payload.resolvedPack);
      const trustSummary = Schema.decodeUnknownSync(SelectorTrustSummarySchema)(
        result.payload.trustSummary,
      );
      const candidateProposal = Schema.decodeUnknownSync(PackCandidateProposalSchema)(
        result.payload.candidateProposal,
      );
      const validationVerdict = Schema.decodeUnknownSync(PackValidationVerdictSchema)(
        result.payload.validationVerdict,
      );
      const automationDecision = Schema.decodeUnknownSync(PackPromotionDecisionSchema)(
        result.payload.automationDecision,
      );
      const governanceResult = Schema.decodeUnknownSync(PackGovernanceResultSchema)(
        result.payload.governanceResult,
      );

      expect(
        result.importPaths.every((path: string) => path.startsWith("@effect-scrapling/")),
      ).toBe(true);
      expect(result.importPaths).toContain("@effect-scrapling/foundation-core/tagged-errors");
      expect(
        result.prerequisites.some((entry: string) => entry.includes("package subpath imports")),
      ).toBe(true);
      expect(
        result.pitfalls.some((entry: string) => entry.includes("workspace package subpaths")),
      ).toBe(true);

      expect(transitionedShadow.pack.state).toBe("shadow");
      expect(resolvedPack.state).toBe("shadow");
      expect(trustSummary.records).toHaveLength(2);
      expect(trustSummary.records.map((record) => record.selectorPath)).toEqual([
        "price/fallback",
        "title/secondary",
      ]);
      expect(
        candidateProposal.operations.map((operation) => ({
          field: operation.field,
          action: operation.action,
        })),
      ).toEqual([
        {
          field: "price",
          action: "promoteSelectorCandidate",
        },
        {
          field: "title",
          action: "appendSelectorCandidate",
        },
      ]);
      expect(validationVerdict.qualityVerdict.action).toBe("active");
      expect(automationDecision.toState).toBe("active");
      expect(governanceResult.activeArtifact?.definition.pack.version).toBe("2026.03.09");
      expect(result.payload.expectedError.code).toBe("PolicyViolation");
      expect(result.payload.expectedError.message).toContain("explicit nextVersion");
    }),
  );

  it("keeps the example on workspace package subpaths only", async () => {
    const source = await Bun.file(EXAMPLE_PATH).text();
    const importSpecifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].flatMap((match) => {
      const specifier = match[1];
      return specifier === undefined ? [] : [specifier];
    });
    const packageImportSpecifiers = importSpecifiers.filter((specifier) => specifier !== "effect");

    expect(
      importSpecifiers.every(
        (specifier) =>
          specifier === "effect" || specifier.startsWith("@effect-scrapling/foundation-core/"),
      ),
    ).toBe(true);
    expect(packageImportSpecifiers.sort()).toEqual([
      "@effect-scrapling/foundation-core/diff-verdict",
      "@effect-scrapling/foundation-core/pack-candidate-generator",
      "@effect-scrapling/foundation-core/pack-governance-runtime",
      "@effect-scrapling/foundation-core/pack-lifecycle-runtime",
      "@effect-scrapling/foundation-core/pack-registry-runtime",
      "@effect-scrapling/foundation-core/reflection-engine-runtime",
      "@effect-scrapling/foundation-core/selector-trust-decay",
      "@effect-scrapling/foundation-core/site-pack",
      "@effect-scrapling/foundation-core/tagged-errors",
      "@effect-scrapling/foundation-core/validator-ladder-runtime",
    ]);
    expect(source.includes("../libs/foundation/core")).toBeFalse();
    expect(source.includes("../../libs/foundation/core")).toBeFalse();
    expect(source.includes("../src/")).toBeFalse();
  });
});
