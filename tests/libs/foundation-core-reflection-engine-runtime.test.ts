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

function makeGates(
  overrides: Partial<
    Record<
      | "requiredFieldCoverage"
      | "falsePositiveRate"
      | "incumbentComparison"
      | "replayDeterminism"
      | "workflowResume"
      | "soakStability"
      | "securityRedaction",
      "pass" | "fail"
    >
  > = {},
): QualityVerdict["gates"] {
  const statuses = {
    requiredFieldCoverage: "pass",
    falsePositiveRate: "pass",
    incumbentComparison: "pass",
    replayDeterminism: "pass",
    workflowResume: "pass",
    soakStability: "pass",
    securityRedaction: "pass",
    ...overrides,
  } as const;

  return [
    {
      name: "requiredFieldCoverage",
      status: statuses.requiredFieldCoverage,
    },
    {
      name: "falsePositiveRate",
      status: statuses.falsePositiveRate,
    },
    {
      name: "incumbentComparison",
      status: statuses.incumbentComparison,
    },
    {
      name: "replayDeterminism",
      status: statuses.replayDeterminism,
    },
    {
      name: "workflowResume",
      status: statuses.workflowResume,
    },
    {
      name: "soakStability",
      status: statuses.soakStability,
    },
    {
      name: "securityRedaction",
      status: statuses.securityRedaction,
    },
  ] satisfies QualityVerdict["gates"];
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

  it.effect(
    "derives a guarded shadow verdict from validator thresholds and blocks service activation",
    () =>
      Effect.gen(function* () {
        const pack = makePack("shadow");
        const driftDeltaAboveThreshold = 0.11;
        const verdict = yield* evaluateValidatorLadder({
          pack,
          snapshotDiff: {
            id: "diff-pack-002",
            baselineSnapshotId: "snapshot-baseline-002",
            candidateSnapshotId: "snapshot-candidate-002",
            metrics: {
              fieldRecallDelta: 0.02,
              falsePositiveDelta: 0.01,
              driftDelta: driftDeltaAboveThreshold,
              latencyDeltaMs: 30,
              memoryDelta: 4,
            },
            createdAt: "2026-03-08T12:05:00.000Z",
          },
          checks: {
            replayDeterminism: true,
            workflowResume: true,
            canary: true,
            chaos: true,
            securityRedaction: true,
            soakStability: true,
          },
          createdAt: "2026-03-08T12:10:00.000Z",
        }).pipe(Effect.map(({ qualityVerdict }) => qualityVerdict));

        expect(verdict).toMatchObject({
          id: "quality-pack-shadow-example-com-diff-pack-002",
          packId: pack.id,
          snapshotDiffId: "diff-pack-002",
          action: "guarded",
        });
        expect(verdict.gates.find(({ name }) => name === "incumbentComparison")?.status).toBe(
          "fail",
        );

        const error = yield* Effect.flip(makeReflectionEngine().decide(pack, verdict));

        expect(error.message).toContain("valid for pack state shadow");
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
            gates: makeGates({
              incumbentComparison: "fail",
            }),
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
            gates: makeGates({
              incumbentComparison: "fail",
            }),
          }),
        }),
      );

      expect(error.message).toContain("valid for pack state shadow");
    }),
  );

  it.effect("automates guarded decisions only for non-critical validator failures", () =>
    Effect.gen(function* () {
      const decision = yield* decidePackPromotion({
        pack: makePack("active"),
        verdict: makeVerdict({
          action: "guarded",
          gates: makeGates({
            incumbentComparison: "fail",
          }),
        }),
      });

      expect(decision).toMatchObject({
        fromState: "active",
        toState: "guarded",
        action: "guarded",
      });
    }),
  );

  it.effect("rejects guarded automation when every validator gate passes", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decidePackPromotion({
          pack: makePack("active"),
          verdict: makeVerdict({
            action: "guarded",
            gates: makeGates(),
          }),
        }),
      );

      expect(error.message).toContain("retain at least one failing validator gate");
    }),
  );

  it.effect("rejects guarded automation when a critical validator gate fails", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decidePackPromotion({
          pack: makePack("active"),
          verdict: makeVerdict({
            action: "guarded",
            gates: makeGates({
              workflowResume: "fail",
            }),
          }),
        }),
      );

      expect(error.message).toContain("non-critical validator failures");
    }),
  );

  it.effect("automates quarantined decisions when critical validator gates fail", () =>
    Effect.gen(function* () {
      const decision = yield* decidePackPromotion({
        pack: makePack("active"),
        verdict: makeVerdict({
          action: "quarantined",
          gates: makeGates({
            workflowResume: "fail",
            securityRedaction: "fail",
          }),
        }),
      });

      expect(decision).toMatchObject({
        fromState: "active",
        toState: "quarantined",
        action: "quarantined",
      });
    }),
  );

  it.effect("rejects quarantined automation when only non-critical gates fail", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decidePackPromotion({
          pack: makePack("active"),
          verdict: makeVerdict({
            action: "quarantined",
            gates: makeGates({
              incumbentComparison: "fail",
            }),
          }),
        }),
      );

      expect(error.message).toContain("critical validator failure");
    }),
  );

  it.effect("automates retired decisions when validator failures still exist", () =>
    Effect.gen(function* () {
      const decision = yield* decidePackPromotion({
        pack: makePack("draft"),
        verdict: makeVerdict({
          action: "retired",
          gates: makeGates({
            requiredFieldCoverage: "fail",
          }),
        }),
      });

      expect(decision).toMatchObject({
        fromState: "draft",
        toState: "retired",
        action: "retired",
      });
    }),
  );

  it.effect("rejects retired automation when every validator gate passes", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decidePackPromotion({
          pack: makePack("draft"),
          verdict: makeVerdict({
            action: "retired",
            gates: makeGates(),
          }),
        }),
      );

      expect(error.message).toContain("include failing validator gates");
    }),
  );
});
