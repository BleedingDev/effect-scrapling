import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { SnapshotDiffSchema } from "../../libs/foundation/core/src/diff-verdict.ts";
import { SitePackSchema } from "../../libs/foundation/core/src/site-pack.ts";
import { evaluateValidatorLadder } from "../../libs/foundation/core/src/validator-ladder-runtime.ts";

function makePack(state: "draft" | "shadow" | "active" | "guarded" | "quarantined" | "retired") {
  return Schema.decodeUnknownSync(SitePackSchema)({
    id: `pack-${state}-001`,
    domainPattern: "*.example.com",
    state,
    accessPolicyId: "policy-default",
    version: "2026.03.08",
  });
}

function makeDiff(overrides?: Partial<Schema.Schema.Type<typeof SnapshotDiffSchema>["metrics"]>) {
  return Schema.decodeUnknownSync(SnapshotDiffSchema)({
    id: "diff-pack-001",
    baselineSnapshotId: "snapshot-baseline-001",
    candidateSnapshotId: "snapshot-candidate-001",
    metrics: {
      fieldRecallDelta: 0.02,
      falsePositiveDelta: 0.01,
      driftDelta: 0.03,
      latencyDeltaMs: 30,
      memoryDelta: 4,
      ...overrides,
    },
    createdAt: "2026-03-08T11:50:00.000Z",
  });
}

describe("foundation-core validator ladder runtime", () => {
  it.effect("emits an active verdict with carried deltas when all ladder checks pass", () =>
    Effect.gen(function* () {
      const verdict = yield* evaluateValidatorLadder({
        pack: makePack("shadow"),
        snapshotDiff: makeDiff(),
        checks: {
          replayDeterminism: true,
          workflowResume: true,
          canary: true,
          chaos: true,
          securityRedaction: true,
          soakStability: true,
        },
        createdAt: "2026-03-08T12:00:00.000Z",
      });

      expect(verdict.qualityVerdict.action).toBe("active");
      expect(verdict.deltas).toMatchObject({
        recallDelta: 0.02,
        falsePositiveDelta: 0.01,
        driftDelta: 0.03,
        latencyDeltaMs: 30,
        memoryDelta: 4,
      });
      expect(verdict.stages.every(({ status }) => status === "pass")).toBe(true);
      expect(verdict.qualityVerdict.gates.every(({ status }) => status === "pass")).toBe(true);
    }),
  );

  it.effect("promotes draft packs only to shadow when the ladder is green", () =>
    Effect.gen(function* () {
      const verdict = yield* evaluateValidatorLadder({
        pack: makePack("draft"),
        snapshotDiff: makeDiff(),
        checks: {
          replayDeterminism: true,
          workflowResume: true,
          canary: true,
          chaos: true,
          securityRedaction: true,
          soakStability: true,
        },
        createdAt: "2026-03-08T12:00:00.000Z",
      });

      expect(verdict.qualityVerdict.action).toBe("promote-shadow");
    }),
  );

  it.effect(
    "guards packs when incumbent deltas breach canary thresholds without critical failures",
    () =>
      Effect.gen(function* () {
        const verdict = yield* evaluateValidatorLadder({
          pack: makePack("active"),
          snapshotDiff: makeDiff({
            driftDelta: 0.2,
            latencyDeltaMs: 400,
          }),
          checks: {
            replayDeterminism: true,
            workflowResume: true,
            canary: false,
            chaos: true,
            securityRedaction: true,
            soakStability: true,
          },
          createdAt: "2026-03-08T12:00:00.000Z",
        });

        expect(verdict.qualityVerdict.action).toBe("guarded");
        expect(verdict.stages.find(({ stage }) => stage === "canary")?.status).toBe("fail");
        expect(
          verdict.qualityVerdict.gates.find(({ name }) => name === "incumbentComparison")?.status,
        ).toBe("fail");
      }),
  );

  it.effect("quarantines packs when critical replay or safety checks fail", () =>
    Effect.gen(function* () {
      const verdict = yield* evaluateValidatorLadder({
        pack: makePack("active"),
        snapshotDiff: makeDiff({
          falsePositiveDelta: 0.2,
        }),
        checks: {
          replayDeterminism: false,
          workflowResume: false,
          canary: true,
          chaos: false,
          securityRedaction: false,
          soakStability: false,
        },
        createdAt: "2026-03-08T12:00:00.000Z",
      });

      expect(verdict.qualityVerdict.action).toBe("quarantined");
      expect(verdict.stages.find(({ stage }) => stage === "replay")?.status).toBe("fail");
      expect(verdict.stages.find(({ stage }) => stage === "chaos")?.status).toBe("fail");
      expect(
        verdict.qualityVerdict.gates.find(({ name }) => name === "securityRedaction")?.status,
      ).toBe("fail");
    }),
  );

  it.effect("rejects malformed validator policies through shared schema contracts", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        evaluateValidatorLadder({
          pack: makePack("shadow"),
          snapshotDiff: makeDiff(),
          checks: {
            replayDeterminism: true,
            workflowResume: true,
            canary: true,
            chaos: true,
            securityRedaction: true,
            soakStability: true,
          },
          createdAt: "2026-03-08T12:00:00.000Z",
          policy: {
            minimumRecallDelta: 0.5,
            maximumFalsePositiveDelta: 0.05,
            maximumDriftDelta: 0.1,
            maximumLatencyDeltaMs: 250,
            maximumMemoryDelta: 32,
          },
        }),
      );

      expect(error.message).toContain("minimumRecallDelta");
    }),
  );
});
