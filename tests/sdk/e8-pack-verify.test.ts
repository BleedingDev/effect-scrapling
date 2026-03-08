import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  PackCreateEnvelopeSchema,
  PackPromoteEnvelopeSchema,
  PackValidateEnvelopeSchema,
  runPackCreateOperation,
  runPackPromoteOperation,
  runPackValidateOperation,
} from "effect-scrapling/e8";
import { executeCli } from "../../src/standalone.ts";
import { InvalidInputError } from "../../src/sdk/errors.ts";

function makePackDefinition(state: "draft" | "shadow" | "active") {
  return {
    pack: {
      id: "pack-shop-example-com",
      tenantId: "tenant-main",
      domainPattern: "*.example.com",
      state,
      accessPolicyId: "policy-default",
      version: state === "active" ? "2026.03.09" : "2026.03.08",
    },
    selectors: [
      {
        field: "title",
        candidates: [{ path: `title/${state}`, selector: "h1.product-title" }],
        fallbackPolicy: {
          maxFallbackCount: 0,
          fallbackConfidenceImpact: 0,
          maxConfidenceImpact: 0,
        },
      },
    ],
    assertions: {
      requiredFields: [{ field: "title" }],
      businessInvariants: [],
    },
    policy: {
      targetKinds: ["productPage"],
      mode: "http",
      render: "never",
    },
    metadata: {
      tenantId: "tenant-main",
      owners: ["team-catalog"],
      labels: [],
    },
  };
}

function makePackValidateInput() {
  return {
    pack: makePackDefinition("active").pack,
    snapshotDiff: {
      id: "diff-pack-active",
      baselineSnapshotId: "snapshot-pack-baseline",
      candidateSnapshotId: "snapshot-pack-candidate",
      metrics: {
        fieldRecallDelta: 0.01,
        falsePositiveDelta: 0.01,
        driftDelta: 0.02,
        latencyDeltaMs: 15,
        memoryDelta: 1,
      },
      createdAt: "2026-03-09T11:00:00.000Z",
    },
    checks: {
      replayDeterminism: true,
      workflowResume: true,
      canary: true,
      chaos: false,
      securityRedaction: true,
      soakStability: false,
    },
    createdAt: "2026-03-09T11:30:00.000Z",
  };
}

function makePackPromoteInput() {
  const activeDefinition = makePackDefinition("active");
  const shadowDefinition = makePackDefinition("shadow");

  return {
    catalog: [
      {
        definition: activeDefinition,
        recordedAt: "2026-03-08T08:00:00.000Z",
        recordedBy: "curator-main",
      },
      {
        definition: shadowDefinition,
        recordedAt: "2026-03-09T08:00:00.000Z",
        recordedBy: "curator-main",
      },
    ],
    subjectPackId: shadowDefinition.pack.id,
    subjectPackVersion: shadowDefinition.pack.version,
    decision: {
      id: "decision-pack-activate",
      packId: shadowDefinition.pack.id,
      sourceVersion: shadowDefinition.pack.version,
      triggerVerdictId: "verdict-pack-shadow",
      createdAt: "2026-03-09T12:00:00.000Z",
      fromState: "shadow",
      toState: "active",
      action: "active",
    },
    changedBy: "curator-main",
    rationale: "shadow pack passed the validation ladder",
    occurredAt: "2026-03-09T12:30:00.000Z",
    nextVersion: "2026.03.10",
  };
}

describe("E8 pack verification", () => {
  it.effect("returns deterministic typed verdicts and governed promotions across SDK and CLI", () =>
    Effect.gen(function* () {
      const validateInput = makePackValidateInput();
      const promoteInput = makePackPromoteInput();

      const created = yield* runPackCreateOperation({ definition: makePackDefinition("shadow") });
      const validated = yield* runPackValidateOperation(validateInput);
      const promoted = yield* runPackPromoteOperation(promoteInput);
      const cliValidated = yield* Effect.promise(() =>
        executeCli(["pack", "validate", "--input", JSON.stringify(validateInput)]),
      );
      const cliPromoted = yield* Effect.promise(() =>
        executeCli(["pack", "promote", "--input", JSON.stringify(promoteInput)]),
      );

      expect(
        Schema.decodeUnknownSync(PackCreateEnvelopeSchema)(created).data.definition.pack.id,
      ).toBe("pack-shop-example-com");
      expect(Schema.decodeUnknownSync(PackValidateEnvelopeSchema)(validated)).toEqual(
        Schema.decodeUnknownSync(PackValidateEnvelopeSchema)(JSON.parse(cliValidated.output)),
      );
      expect(validated.data.verdict.qualityVerdict.action).toBe("quarantined");
      expect(
        validated.data.verdict.qualityVerdict.gates.find(({ name }) => name === "soakStability")
          ?.status,
      ).toBe("fail");
      expect(Schema.decodeUnknownSync(PackPromoteEnvelopeSchema)(promoted)).toEqual(
        Schema.decodeUnknownSync(PackPromoteEnvelopeSchema)(JSON.parse(cliPromoted.output)),
      );
      expect(promoted.data.result.activeArtifact?.definition.pack.version).toBe("2026.03.10");
    }),
  );

  it.effect("rejects invalid definitions and governance mismatches across SDK and CLI", () =>
    Effect.gen(function* () {
      const invalidCreateInput = {
        definition: {
          ...makePackDefinition("shadow"),
          selectors: [],
        },
      };
      const invalidCreateSdkError = yield* Effect.flip(runPackCreateOperation(invalidCreateInput));
      const invalidCreateCli = yield* Effect.promise(() =>
        executeCli(["pack", "create", "--input", JSON.stringify(invalidCreateInput)]),
      );

      const invalidPromoteInput = {
        ...makePackPromoteInput(),
        decision: {
          ...makePackPromoteInput().decision,
          packId: "pack-other-example-com",
        },
      };
      const invalidPromoteSdkError = yield* Effect.flip(
        runPackPromoteOperation(invalidPromoteInput),
      );
      const invalidPromoteCli = yield* Effect.promise(() =>
        executeCli(["pack", "promote", "--input", JSON.stringify(invalidPromoteInput)]),
      );

      expect(invalidCreateSdkError).toBeInstanceOf(InvalidInputError);
      expect(invalidCreateSdkError.message).toContain("Invalid pack create payload.");
      expect(invalidCreateCli.exitCode).toBe(2);
      expect(JSON.parse(invalidCreateCli.output)).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });

      expect(invalidPromoteSdkError).toBeInstanceOf(InvalidInputError);
      expect(invalidPromoteSdkError.message).toContain(
        "Failed to apply the pack promotion decision.",
      );
      expect(invalidPromoteCli.exitCode).toBe(2);
      expect(JSON.parse(invalidPromoteCli.output)).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });
    }),
  );
});
