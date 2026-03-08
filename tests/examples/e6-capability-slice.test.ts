import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  E6CapabilitySliceEvidenceSchema,
  runE6CapabilitySlice,
  runE6CapabilitySliceEncoded,
} from "../../examples/e6-capability-slice.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const exampleEntry = fileURLToPath(
  new URL("../../examples/e6-capability-slice.ts", import.meta.url),
);

describe("examples/e6-capability-slice", () => {
  it.effect("executes the deterministic E6 capability slice in-process with typed evidence", () =>
    Effect.gen(function* () {
      const evidence = yield* runE6CapabilitySlice();
      const encoded = Schema.encodeSync(E6CapabilitySliceEvidenceSchema)(evidence);

      expect(encoded.transitionedShadow.pack.state).toBe("shadow");
      expect(encoded.transitionedShadow.event).toMatchObject({
        from: "draft",
        to: "shadow",
      });

      expect(encoded.resolvedPack).toMatchObject({
        id: "pack-shop-example-com",
        state: "shadow",
        version: "2026.03.08",
      });

      expect(
        encoded.trustSummary.records.map(({ selectorPath, band, eventCount }) => ({
          selectorPath,
          band,
          eventCount,
        })),
      ).toEqual([
        {
          selectorPath: "price/fallback",
          band: "blocked",
          eventCount: 2,
        },
        {
          selectorPath: "title/primary",
          band: "degraded",
          eventCount: 1,
        },
        {
          selectorPath: "title/secondary",
          band: "trusted",
          eventCount: 2,
        },
      ]);

      expect(
        encoded.candidateProposal.operations.map(({ field, action, selectorCandidate }) => ({
          field,
          action,
          path: selectorCandidate.path,
        })),
      ).toEqual([
        {
          field: "price",
          action: "promoteSelectorCandidate",
          path: "price/fallback",
        },
        {
          field: "title",
          action: "appendSelectorCandidate",
          path: "title/secondary",
        },
      ]);

      expect(
        encoded.reflectionRecommendation.clusters.map(({ field, kind, occurrenceCount }) => ({
          field,
          kind,
          occurrenceCount,
        })),
      ).toEqual([
        {
          field: "price",
          kind: "selectorRegressionPattern",
          occurrenceCount: 2,
        },
        {
          field: "title",
          kind: "fixtureConsensusPattern",
          occurrenceCount: 2,
        },
      ]);
      expect(encoded.reflectionRecommendation.proposal.operations).toEqual(
        encoded.candidateProposal.operations,
      );

      expect(encoded.validationVerdict.qualityVerdict.action).toBe("active");
      expect(encoded.validationVerdict.stages.every(({ status }) => status === "pass")).toBe(true);
      expect(
        encoded.validationVerdict.qualityVerdict.gates.every(({ status }) => status === "pass"),
      ).toBe(true);

      expect(encoded.automationDecision).toMatchObject({
        fromState: "shadow",
        toState: "active",
        action: "active",
      });

      expect(encoded.governanceResult.activeArtifact?.definition.pack).toMatchObject({
        id: "pack-shop-example-com",
        state: "active",
        version: "2026.03.09",
      });
      expect(
        encoded.governanceResult.activeArtifact?.definition.selectors[0]?.candidates[0]?.selector,
      ).toBe("h1.shadow");
      expect(encoded.governanceResult.auditTrail.map(({ auditKind }) => auditKind)).toEqual([
        "demote-previous-active",
        "activate-version",
      ]);
    }),
  );

  it("runs standalone and emits the same typed evidence JSON", async () => {
    const expected = await Effect.runPromise(runE6CapabilitySliceEncoded());
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", exampleEntry],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = new TextDecoder().decode(result.stderr).trim();
    expect(result.exitCode).toBe(0);
    expect(stderr).toBe("");

    const stdout = new TextDecoder().decode(result.stdout);
    const decoded = Schema.decodeUnknownSync(E6CapabilitySliceEvidenceSchema)(JSON.parse(stdout));
    const actual = Schema.encodeSync(E6CapabilitySliceEvidenceSchema)(decoded);

    expect(actual).toEqual(expected);
  });
});
