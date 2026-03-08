import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  QualityVerdictSchema,
  type QualityVerdict,
} from "../../libs/foundation/core/src/diff-verdict.ts";
import {
  decidePackPromotion,
  makeReflectionEngine,
} from "../../libs/foundation/core/src/reflection-engine-runtime.ts";
import { SitePackSchema, type SitePack } from "../../libs/foundation/core/src/site-pack.ts";
import { evaluateValidatorLadder } from "../../libs/foundation/core/src/validator-ladder-runtime.ts";

function makePack(state: SitePack["state"]) {
  return Schema.decodeUnknownSync(SitePackSchema)({
    id: "pack-shadow-example-com",
    tenantId: "tenant-main",
    domainPattern: "*.example.com",
    state,
    accessPolicyId: "policy-default",
    version: "2026.03.08",
  });
}

function makeGreenVerdict(pack: SitePack) {
  return evaluateValidatorLadder({
    pack,
    snapshotDiff: {
      id: "diff-pack-001",
      baselineSnapshotId: "snapshot-baseline-001",
      candidateSnapshotId: "snapshot-candidate-001",
      metrics: {
        fieldRecallDelta: 0.02,
        falsePositiveDelta: 0.01,
        driftDelta: 0.03,
        latencyDeltaMs: 30,
        memoryDelta: 4,
      },
      createdAt: "2026-03-08T11:50:00.000Z",
    },
    checks: {
      replayDeterminism: true,
      workflowResume: true,
      canary: true,
      chaos: true,
      securityRedaction: true,
      soakStability: true,
    },
    createdAt: "2026-03-08T12:00:00.000Z",
  }).pipe(Effect.map(({ qualityVerdict }) => qualityVerdict));
}

function makeVerdict(overrides: Partial<QualityVerdict>) {
  return Schema.decodeUnknownSync(QualityVerdictSchema)({
    id: "quality-pack-shadow-example-com-diff-pack-001",
    packId: "pack-shadow-example-com",
    snapshotDiffId: "diff-pack-001",
    action: "active",
    createdAt: "2026-03-08T12:00:00.000Z",
    gates: [
      {
        name: "requiredFieldCoverage",
        status: "pass",
      },
      {
        name: "falsePositiveRate",
        status: "pass",
      },
      {
        name: "incumbentComparison",
        status: "pass",
      },
      {
        name: "replayDeterminism",
        status: "pass",
      },
      {
        name: "workflowResume",
        status: "pass",
      },
      {
        name: "soakStability",
        status: "pass",
      },
      {
        name: "securityRedaction",
        status: "pass",
      },
    ],
    ...overrides,
  });
}

describe("foundation-core reflection engine runtime", () => {
  it.effect("automates a green shadow verdict into an active promotion decision", () =>
    Effect.gen(function* () {
      const pack = makePack("shadow");
      const verdict = yield* makeGreenVerdict(pack);
      const decision = yield* decidePackPromotion({
        pack,
        verdict,
      });

      expect(decision).toMatchObject({
        packId: pack.id,
        triggerVerdictId: verdict.id,
        fromState: "shadow",
        toState: "active",
        action: "active",
      });
    }),
  );

  it.effect("automates a green draft verdict into a promote-shadow decision", () =>
    Effect.gen(function* () {
      const pack = makePack("draft");
      const verdict = yield* makeGreenVerdict(pack);
      const decision = yield* decidePackPromotion({
        pack,
        verdict,
      });

      expect(decision).toMatchObject({
        fromState: "draft",
        toState: "shadow",
        action: "promote-shadow",
      });
    }),
  );

  it.effect("encodes the same decision through the ReflectionEngine service surface", () =>
    Effect.gen(function* () {
      const pack = makePack("shadow");
      const verdict = yield* makeGreenVerdict(pack);
      const encoded = yield* makeReflectionEngine().decide(pack, verdict);

      expect(encoded).toMatchObject({
        packId: pack.id,
        triggerVerdictId: verdict.id,
        fromState: "shadow",
        toState: "active",
        action: "active",
      });
    }),
  );

  it.effect("rejects verdicts that point at a different pack id", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decidePackPromotion({
          pack: makePack("shadow"),
          verdict: makeVerdict({
            packId: "pack-other-example-com",
          }),
        }),
      );

      expect(error.message).toContain("verdict pack id");
    }),
  );

  it.effect("rejects active automation when any validator gate is still failing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decidePackPromotion({
          pack: makePack("shadow"),
          verdict: makeVerdict({
            gates: [
              {
                name: "requiredFieldCoverage",
                status: "pass",
              },
              {
                name: "falsePositiveRate",
                status: "pass",
              },
              {
                name: "incumbentComparison",
                status: "fail",
              },
              {
                name: "replayDeterminism",
                status: "pass",
              },
              {
                name: "workflowResume",
                status: "pass",
              },
              {
                name: "soakStability",
                status: "pass",
              },
              {
                name: "securityRedaction",
                status: "pass",
              },
            ],
          }),
        }),
      );

      expect(error.message).toContain("every validator gate passes");
    }),
  );

  it.effect("rejects lifecycle actions that are invalid for the current pack state", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decidePackPromotion({
          pack: makePack("shadow"),
          verdict: makeVerdict({
            action: "guarded",
            gates: [
              {
                name: "requiredFieldCoverage",
                status: "pass",
              },
              {
                name: "falsePositiveRate",
                status: "pass",
              },
              {
                name: "incumbentComparison",
                status: "fail",
              },
              {
                name: "replayDeterminism",
                status: "pass",
              },
              {
                name: "workflowResume",
                status: "pass",
              },
              {
                name: "soakStability",
                status: "pass",
              },
              {
                name: "securityRedaction",
                status: "pass",
              },
            ],
          }),
        }),
      );

      expect(error.message).toContain("valid for pack state shadow");
    }),
  );
});
