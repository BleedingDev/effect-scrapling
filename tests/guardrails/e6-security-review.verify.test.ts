import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { QualityVerdictSchema } from "../../libs/foundation/core/src/diff-verdict.ts";
import {
  VersionedSitePackCatalogSchema,
  applyPackGovernanceDecision,
} from "../../libs/foundation/core/src/pack-governance-runtime.ts";
import { decidePackPromotion } from "../../libs/foundation/core/src/reflection-engine-runtime.ts";
import { SitePackDslSchema, SitePackSchema } from "../../libs/foundation/core/src/site-pack.ts";
import { toCoreErrorEnvelope } from "../../libs/foundation/core/src/tagged-errors.ts";

function makePack() {
  return Schema.decodeUnknownSync(SitePackSchema)({
    id: "pack-security-example-com",
    tenantId: "tenant-main",
    domainPattern: "*.example.com",
    state: "shadow",
    accessPolicyId: "policy-default",
    version: "2026.03.08",
  });
}

function makePackDefinition(state: "shadow" | "active", version: string) {
  return Schema.decodeUnknownSync(SitePackDslSchema)({
    pack: {
      id: "pack-security-example-com",
      tenantId: "tenant-main",
      domainPattern: "*.example.com",
      state,
      accessPolicyId: "policy-default",
      version,
    },
    selectors: [
      {
        field: "title",
        candidates: [
          {
            path: `title/${version}`,
            selector: "h1",
          },
        ],
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
      labels: ["retail"],
    },
  });
}

describe("E6 security review verification", () => {
  it("rejects unsafe site-pack domain patterns before they reach registry or governance flows", () => {
    const invalidPatterns = [
      "https://example.com",
      " Example.com",
      "*.example.com ",
      " *.example.com",
      "*.Example.com",
      "*.example.com/path",
    ];

    for (const domainPattern of invalidPatterns) {
      expect(() =>
        Schema.decodeUnknownSync(SitePackDslSchema)({
          pack: {
            id: "pack-security-example-com",
            tenantId: "tenant-main",
            domainPattern,
            state: "shadow",
            accessPolicyId: "policy-default",
            version: "2026.03.08",
          },
          selectors: [
            {
              field: "title",
              candidates: [
                {
                  path: "title/primary",
                  selector: "h1",
                },
              ],
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
        }),
      ).toThrow();
    }
  });

  it.effect("rejects forged reflection decisions whose verdict targets a different pack id", () =>
    Effect.gen(function* () {
      const failure = yield* decidePackPromotion({
        pack: makePack(),
        verdict: Schema.decodeUnknownSync(QualityVerdictSchema)({
          id: "quality-forged-001",
          packId: "pack-attacker-example-com",
          snapshotDiffId: "diff-forged-001",
          action: "active",
          createdAt: "2026-03-08T13:00:00.000Z",
          gates: [
            { name: "requiredFieldCoverage", status: "pass" },
            { name: "falsePositiveRate", status: "pass" },
            { name: "incumbentComparison", status: "pass" },
            { name: "replayDeterminism", status: "pass" },
            { name: "workflowResume", status: "pass" },
            { name: "soakStability", status: "pass" },
            { name: "securityRedaction", status: "pass" },
          ],
        }),
      }).pipe(
        Effect.match({
          onFailure: toCoreErrorEnvelope,
          onSuccess: () => null,
        }),
      );

      expect(failure).toEqual({
        code: "policy_violation",
        retryable: false,
        message: "Expected the quality verdict pack id to match the selected site pack.",
      });
    }),
  );

  it.effect(
    "rejects ambiguous active-catalog state and active promotions without a fresh version",
    () =>
      Effect.gen(function* () {
        expect(() =>
          Schema.decodeUnknownSync(VersionedSitePackCatalogSchema)([
            {
              definition: makePackDefinition("active", "2026.03.07"),
              recordedAt: "2026-03-07T10:00:00.000Z",
              recordedBy: "curator-main",
            },
            {
              definition: makePackDefinition("active", "2026.03.08"),
              recordedAt: "2026-03-08T10:00:00.000Z",
              recordedBy: "curator-main",
            },
          ]),
        ).toThrow();

        const failure = yield* applyPackGovernanceDecision({
          catalog: [
            {
              definition: makePackDefinition("active", "2026.03.07"),
              recordedAt: "2026-03-07T10:00:00.000Z",
              recordedBy: "curator-main",
            },
            {
              definition: makePackDefinition("shadow", "2026.03.08"),
              recordedAt: "2026-03-08T10:00:00.000Z",
              recordedBy: "curator-main",
            },
          ],
          subjectPackId: "pack-security-example-com",
          subjectPackVersion: "2026.03.08",
          decision: {
            id: "decision-promote-001",
            packId: "pack-security-example-com",
            sourceVersion: "2026.03.08",
            triggerVerdictId: "verdict-001",
            createdAt: "2026-03-08T13:10:00.000Z",
            fromState: "shadow",
            toState: "active",
            action: "active",
          },
          changedBy: "curator-main",
          rationale: "attempted promotion without a new immutable version",
          occurredAt: "2026-03-08T13:15:00.000Z",
        }).pipe(
          Effect.match({
            onFailure: toCoreErrorEnvelope,
            onSuccess: () => null,
          }),
        );

        expect(failure).toEqual({
          code: "policy_violation",
          retryable: false,
          message: "Expected an explicit nextVersion when promoting a pack artifact into active.",
        });
      }),
  );

  it.effect("rejects governance replay against a different version of the same pack id", () =>
    Effect.gen(function* () {
      const failure = yield* applyPackGovernanceDecision({
        catalog: [
          {
            definition: makePackDefinition("active", "2026.03.07"),
            recordedAt: "2026-03-07T10:00:00.000Z",
            recordedBy: "curator-main",
          },
          {
            definition: makePackDefinition("shadow", "2026.03.08"),
            recordedAt: "2026-03-08T10:00:00.000Z",
            recordedBy: "curator-main",
          },
          {
            definition: makePackDefinition("shadow", "2026.03.09"),
            recordedAt: "2026-03-09T10:00:00.000Z",
            recordedBy: "curator-main",
          },
        ],
        subjectPackId: "pack-security-example-com",
        subjectPackVersion: "2026.03.09",
        decision: {
          id: "decision-promote-002",
          packId: "pack-security-example-com",
          sourceVersion: "2026.03.08",
          triggerVerdictId: "verdict-002",
          createdAt: "2026-03-09T13:10:00.000Z",
          fromState: "shadow",
          toState: "active",
          action: "active",
        },
        changedBy: "curator-main",
        rationale: "attempted replay against a newer shadow version",
        occurredAt: "2026-03-09T13:15:00.000Z",
        nextVersion: "2026.03.10",
      }).pipe(
        Effect.match({
          onFailure: toCoreErrorEnvelope,
          onSuccess: () => null,
        }),
      );

      expect(failure).toEqual({
        code: "policy_violation",
        retryable: false,
        message:
          "Expected the curator decision source version to match the explicitly selected pack artifact version.",
      });
    }),
  );
});
