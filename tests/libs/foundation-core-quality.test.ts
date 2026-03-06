import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  PackPromotionDecisionSchema,
  QualityVerdictSchema,
  SnapshotDiffSchema,
} from "../../libs/foundation/core/src";

function makeSnapshotDiff() {
  return {
    id: "diff-pack-example-com-001",
    baselineSnapshotId: "snapshot-baseline-001",
    candidateSnapshotId: "snapshot-candidate-001",
    metrics: {
      fieldRecallDelta: 0.03,
      falsePositiveDelta: -0.01,
      driftDelta: -0.02,
      latencyDeltaMs: -50,
      memoryDelta: -12,
    },
    createdAt: "2026-03-06T00:10:00.000Z",
  };
}

function makeVerdict() {
  return {
    id: "verdict-pack-example-com-001",
    packId: "pack-example-com",
    snapshotDiffId: "diff-pack-example-com-001",
    action: "promote-shadow",
    gates: [
      { name: "requiredFieldCoverage", status: "pass" },
      { name: "falsePositiveRate", status: "pass" },
      { name: "incumbentComparison", status: "pass" },
      { name: "replayDeterminism", status: "pass" },
      { name: "workflowResume", status: "pass" },
      { name: "soakStability", status: "pass" },
      { name: "securityRedaction", status: "pass" },
    ],
    createdAt: "2026-03-06T00:11:00.000Z",
  } as const;
}

describe("foundation-core quality decisions", () => {
  it("roundtrips snapshot diffs, quality verdicts, and promotion decisions through public schema contracts", () => {
    expect(
      Schema.encodeSync(SnapshotDiffSchema)(
        Schema.decodeUnknownSync(SnapshotDiffSchema)(makeSnapshotDiff()),
      ),
    ).toEqual(makeSnapshotDiff());

    expect(
      Schema.encodeSync(QualityVerdictSchema)(
        Schema.decodeUnknownSync(QualityVerdictSchema)(makeVerdict()),
      ),
    ).toEqual(makeVerdict());

    expect(
      Schema.encodeSync(PackPromotionDecisionSchema)(
        Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
          id: "decision-pack-example-com-001",
          packId: "pack-example-com",
          fromState: "draft",
          toState: "shadow",
          triggerVerdictId: "verdict-pack-example-com-001",
          action: "promote-shadow",
          createdAt: "2026-03-06T00:12:00.000Z",
        }),
      ),
    ).toEqual({
      id: "decision-pack-example-com-001",
      packId: "pack-example-com",
      fromState: "draft",
      toState: "shadow",
      triggerVerdictId: "verdict-pack-example-com-001",
      action: "promote-shadow",
      createdAt: "2026-03-06T00:12:00.000Z",
    });
  });

  it("rejects incomplete promotion gates and invalid pack decisions deterministically", () => {
    expect(() =>
      Schema.decodeUnknownSync(QualityVerdictSchema)({
        ...makeVerdict(),
        gates: makeVerdict().gates.filter(({ name }) => name !== "workflowResume"),
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
        id: "decision-pack-example-com-001",
        packId: "pack-example-com",
        fromState: "draft",
        toState: "active",
        triggerVerdictId: "verdict-pack-example-com-001",
        action: "promote-shadow",
        createdAt: "2026-03-06T00:12:00.000Z",
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
        id: "decision-pack-example-com-001",
        packId: "pack-example-com",
        fromState: "shadow",
        toState: "quarantined",
        triggerVerdictId: "verdict-pack-example-com-001",
        action: "promote-shadow",
        createdAt: "2026-03-06T00:12:00.000Z",
      }),
    ).toThrow();
  });

  it("accepts explicit recovery and promotion decisions back into active state", () => {
    expect(
      Schema.encodeSync(PackPromotionDecisionSchema)(
        Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
          id: "decision-pack-example-com-002",
          packId: "pack-example-com",
          fromState: "shadow",
          toState: "active",
          triggerVerdictId: "verdict-pack-example-com-001",
          action: "active",
          createdAt: "2026-03-06T00:13:00.000Z",
        }),
      ),
    ).toEqual({
      id: "decision-pack-example-com-002",
      packId: "pack-example-com",
      fromState: "shadow",
      toState: "active",
      triggerVerdictId: "verdict-pack-example-com-001",
      action: "active",
      createdAt: "2026-03-06T00:13:00.000Z",
    });
  });
});
