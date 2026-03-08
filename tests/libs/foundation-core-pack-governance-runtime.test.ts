import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  applyPackGovernanceDecision,
  VersionedSitePackCatalogSchema,
  type VersionedSitePackArtifactEncoded,
} from "../../libs/foundation/core/src/pack-governance-runtime.ts";
import { PackPromotionDecisionSchema } from "../../libs/foundation/core/src/diff-verdict.ts";
import { SitePackDslSchema } from "../../libs/foundation/core/src/site-pack.ts";

function makePackDefinition(input: {
  state: "draft" | "shadow" | "active" | "guarded" | "quarantined" | "retired";
  version: string;
  titleSelector?: string;
}) {
  return Schema.decodeUnknownSync(SitePackDslSchema)({
    pack: {
      id: "pack-shop-example-com",
      tenantId: "tenant-main",
      domainPattern: "*.example.com",
      state: input.state,
      accessPolicyId: "policy-default",
      version: input.version,
    },
    selectors: [
      {
        field: "title",
        candidates: [
          {
            path: `title/${input.version}`,
            selector: input.titleSelector ?? "h1",
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
      requiredFields: [
        {
          field: "title",
        },
      ],
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
  });
}

function makeArtifact(input: {
  state: "draft" | "shadow" | "active" | "guarded" | "quarantined" | "retired";
  version: string;
  recordedAt: string;
  titleSelector?: string;
}): VersionedSitePackArtifactEncoded {
  return {
    definition: Schema.encodeSync(SitePackDslSchema)(
      makePackDefinition({
        state: input.state,
        version: input.version,
        ...(input.titleSelector === undefined ? {} : { titleSelector: input.titleSelector }),
      }),
    ),
    recordedAt: input.recordedAt,
    recordedBy: "curator-main",
  };
}

describe("foundation-core pack governance runtime", () => {
  it("rejects governance catalogs with duplicate version artifacts or multiple active artifacts for one pack id", () => {
    expect(() =>
      Schema.decodeUnknownSync(VersionedSitePackCatalogSchema)([
        makeArtifact({
          state: "shadow",
          version: "2026.03.08",
          recordedAt: "2026-03-08T09:00:00.000Z",
        }),
        makeArtifact({
          state: "shadow",
          version: "2026.03.08",
          recordedAt: "2026-03-08T10:00:00.000Z",
        }),
      ]),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(VersionedSitePackCatalogSchema)([
        makeArtifact({
          state: "active",
          version: "2026.03.09",
          recordedAt: "2026-03-09T09:00:00.000Z",
        }),
        makeArtifact({
          state: "active",
          version: "2026.03.10",
          recordedAt: "2026-03-10T09:00:00.000Z",
        }),
      ]),
    ).toThrow();
  });

  it.effect(
    "promotes a shadow candidate into a new active version and demotes the previous active version to shadow",
    () =>
      Effect.gen(function* () {
        const result = yield* applyPackGovernanceDecision({
          catalog: [
            makeArtifact({
              state: "active",
              version: "2026.03.07",
              recordedAt: "2026-03-07T12:00:00.000Z",
              titleSelector: "h1.active",
            }),
            makeArtifact({
              state: "shadow",
              version: "2026.03.08",
              recordedAt: "2026-03-08T09:00:00.000Z",
              titleSelector: "h1.shadow",
            }),
          ],
          subjectPackId: "pack-shop-example-com",
          subjectPackVersion: "2026.03.08",
          decision: {
            id: "decision-promote-001",
            packId: "pack-shop-example-com",
            sourceVersion: "2026.03.08",
            triggerVerdictId: "verdict-001",
            createdAt: "2026-03-08T12:00:00.000Z",
            fromState: "shadow",
            toState: "active",
            action: "active",
          },
          changedBy: "curator-main",
          rationale: "shadow pack passed the promotion ladder",
          occurredAt: "2026-03-08T12:30:00.000Z",
          nextVersion: "2026.03.09",
        });

        const demotedActive = result.catalog.find(
          (artifact) => artifact.definition.pack.version === "2026.03.07",
        );
        const originalShadow = result.catalog.find(
          (artifact) => artifact.definition.pack.version === "2026.03.08",
        );

        expect(result.activeArtifact?.definition.pack).toMatchObject({
          id: "pack-shop-example-com",
          state: "active",
          version: "2026.03.09",
        });
        expect(result.activeArtifact?.definition.selectors[0]?.candidates[0]?.selector).toBe(
          "h1.shadow",
        );
        expect(result.activeArtifact?.lastGovernedAt).toBe("2026-03-08T12:30:00.000Z");
        expect(result.activeArtifact?.lastGovernedBy).toBe("curator-main");
        expect(demotedActive?.definition.pack.state).toBe("shadow");
        expect(demotedActive?.lastGovernedAt).toBe("2026-03-08T12:30:00.000Z");
        expect(demotedActive?.lastGovernedBy).toBe("curator-main");
        expect(originalShadow?.definition.pack.state).toBe("shadow");
        expect(result.auditTrail).toEqual([
          expect.objectContaining({
            auditKind: "demote-previous-active",
            sourceVersion: "2026.03.07",
            targetVersion: "2026.03.07",
            targetState: "shadow",
          }),
          expect.objectContaining({
            auditKind: "activate-version",
            sourceVersion: "2026.03.08",
            targetVersion: "2026.03.09",
            targetState: "active",
          }),
        ]);
      }),
  );

  it.effect("promotes a shadow candidate into active when no prior active artifact exists", () =>
    Effect.gen(function* () {
      const result = yield* applyPackGovernanceDecision({
        catalog: [
          makeArtifact({
            state: "shadow",
            version: "2026.03.08",
            recordedAt: "2026-03-08T09:00:00.000Z",
            titleSelector: "h1.shadow",
          }),
        ],
        subjectPackId: "pack-shop-example-com",
        subjectPackVersion: "2026.03.08",
        decision: Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
          id: "decision-promote-001b",
          packId: "pack-shop-example-com",
          sourceVersion: "2026.03.08",
          triggerVerdictId: "verdict-001b",
          createdAt: "2026-03-08T12:00:00.000Z",
          fromState: "shadow",
          toState: "active",
          action: "active",
        }),
        changedBy: "curator-main",
        rationale: "first active promotion",
        occurredAt: "2026-03-08T12:30:00.000Z",
        nextVersion: "2026.03.09",
      });

      expect(result.catalog).toHaveLength(2);
      expect(result.activeArtifact?.definition.pack.version).toBe("2026.03.09");
      expect(result.auditTrail).toEqual([
        expect.objectContaining({
          auditKind: "activate-version",
          sourceVersion: "2026.03.08",
          targetVersion: "2026.03.09",
          targetState: "active",
        }),
      ]);
    }),
  );

  it.effect(
    "supports rollback by re-activating a historical quarantined version as a fresh active version",
    () =>
      Effect.gen(function* () {
        const result = yield* applyPackGovernanceDecision({
          catalog: [
            makeArtifact({
              state: "active",
              version: "2026.03.09",
              recordedAt: "2026-03-09T09:00:00.000Z",
              titleSelector: "h1.current",
            }),
            makeArtifact({
              state: "quarantined",
              version: "2026.03.07",
              recordedAt: "2026-03-07T09:00:00.000Z",
              titleSelector: "h1.rollback",
            }),
          ],
          subjectPackId: "pack-shop-example-com",
          subjectPackVersion: "2026.03.07",
          decision: Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
            id: "decision-rollback-001",
            packId: "pack-shop-example-com",
            sourceVersion: "2026.03.07",
            triggerVerdictId: "verdict-rollback-001",
            createdAt: "2026-03-09T10:00:00.000Z",
            fromState: "quarantined",
            toState: "active",
            action: "active",
          }),
          changedBy: "curator-main",
          rationale: "roll back to the last stable quarantined revision",
          occurredAt: "2026-03-09T10:15:00.000Z",
          nextVersion: "2026.03.10",
        });

        expect(result.activeArtifact?.definition.selectors[0]?.candidates[0]?.selector).toBe(
          "h1.rollback",
        );
        expect(result.activeArtifact?.definition.pack.version).toBe("2026.03.10");
        expect(result.activeArtifact?.lastGovernedAt).toBe("2026-03-09T10:15:00.000Z");
        expect(
          result.catalog.find((artifact) => artifact.definition.pack.version === "2026.03.09")
            ?.definition.pack.state,
        ).toBe("shadow");
        expect(
          result.catalog.find((artifact) => artifact.definition.pack.version === "2026.03.07")
            ?.definition.pack.state,
        ).toBe("quarantined");
        expect(result.auditTrail).toEqual([
          expect.objectContaining({
            auditKind: "demote-previous-active",
            packId: "pack-shop-example-com",
            sourceVersion: "2026.03.09",
            targetVersion: "2026.03.09",
            triggerVerdictId: "verdict-rollback-001",
          }),
          expect.objectContaining({
            auditKind: "activate-version",
            packId: "pack-shop-example-com",
            sourceVersion: "2026.03.07",
            targetVersion: "2026.03.10",
            triggerVerdictId: "verdict-rollback-001",
          }),
        ]);
      }),
  );

  it.effect("quarantines an active version in place without minting a replacement version", () =>
    Effect.gen(function* () {
      const result = yield* applyPackGovernanceDecision({
        catalog: [
          makeArtifact({
            state: "active",
            version: "2026.03.09",
            recordedAt: "2026-03-09T09:00:00.000Z",
          }),
        ],
        subjectPackId: "pack-shop-example-com",
        subjectPackVersion: "2026.03.09",
        decision: Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
          id: "decision-quarantine-001",
          packId: "pack-shop-example-com",
          sourceVersion: "2026.03.09",
          triggerVerdictId: "verdict-quarantine-001",
          createdAt: "2026-03-09T11:00:00.000Z",
          fromState: "active",
          toState: "quarantined",
          action: "quarantined",
        }),
        changedBy: "curator-main",
        rationale: "critical operator review failed",
        occurredAt: "2026-03-09T11:15:00.000Z",
      });

      expect(result.activeArtifact).toBeUndefined();
      expect(result.catalog[0]?.definition.pack).toMatchObject({
        version: "2026.03.09",
        state: "quarantined",
      });
      expect(result.catalog[0]?.lastGovernedAt).toBe("2026-03-09T11:15:00.000Z");
      expect(result.catalog[0]?.lastGovernedBy).toBe("curator-main");
      expect(result.auditTrail).toEqual([
        expect.objectContaining({
          auditKind: "transition",
          sourceVersion: "2026.03.09",
          targetVersion: "2026.03.09",
          targetState: "quarantined",
        }),
      ]);
    }),
  );

  it.effect("rejects lifecycle-only curator actions that incorrectly supply nextVersion", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        applyPackGovernanceDecision({
          catalog: [
            makeArtifact({
              state: "active",
              version: "2026.03.09",
              recordedAt: "2026-03-09T09:00:00.000Z",
            }),
          ],
          subjectPackId: "pack-shop-example-com",
          subjectPackVersion: "2026.03.09",
          decision: Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
            id: "decision-quarantine-002",
            packId: "pack-shop-example-com",
            sourceVersion: "2026.03.09",
            triggerVerdictId: "verdict-quarantine-002",
            createdAt: "2026-03-09T11:00:00.000Z",
            fromState: "active",
            toState: "quarantined",
            action: "quarantined",
          }),
          changedBy: "curator-main",
          rationale: "quarantine actions must not mint versions",
          occurredAt: "2026-03-09T11:15:00.000Z",
          nextVersion: "2026.03.10",
        }),
      );

      expect(error.message).toContain("nextVersion");
      expect(error.message).toContain("omitted");
    }),
  );

  it.effect(
    "rejects active promotion when nextVersion is missing or does not advance historical ordering",
    () =>
      Effect.gen(function* () {
        const missingVersionError = yield* Effect.flip(
          applyPackGovernanceDecision({
            catalog: [
              makeArtifact({
                state: "shadow",
                version: "2026.03.08",
                recordedAt: "2026-03-08T09:00:00.000Z",
              }),
            ],
            subjectPackId: "pack-shop-example-com",
            subjectPackVersion: "2026.03.08",
            decision: Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
              id: "decision-promote-002",
              packId: "pack-shop-example-com",
              sourceVersion: "2026.03.08",
              triggerVerdictId: "verdict-002",
              createdAt: "2026-03-08T12:00:00.000Z",
              fromState: "shadow",
              toState: "active",
              action: "active",
            }),
            changedBy: "curator-main",
            rationale: "promote without explicit version",
            occurredAt: "2026-03-08T12:30:00.000Z",
          }),
        );

        const staleVersionError = yield* Effect.flip(
          applyPackGovernanceDecision({
            catalog: [
              makeArtifact({
                state: "active",
                version: "2026.03.09",
                recordedAt: "2026-03-09T09:00:00.000Z",
              }),
              makeArtifact({
                state: "shadow",
                version: "2026.03.08",
                recordedAt: "2026-03-08T09:00:00.000Z",
              }),
            ],
            subjectPackId: "pack-shop-example-com",
            subjectPackVersion: "2026.03.08",
            decision: Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
              id: "decision-promote-003",
              packId: "pack-shop-example-com",
              sourceVersion: "2026.03.08",
              triggerVerdictId: "verdict-003",
              createdAt: "2026-03-09T12:00:00.000Z",
              fromState: "shadow",
              toState: "active",
              action: "active",
            }),
            changedBy: "curator-main",
            rationale: "promote with stale version",
            occurredAt: "2026-03-09T12:15:00.000Z",
            nextVersion: "2026.03.09",
          }),
        );

        expect(missingVersionError.message).toContain("nextVersion");
        expect(staleVersionError.message).toContain("sort after all recorded historical versions");
      }),
  );

  it.effect(
    "rejects active promotion when the replacement version reuses the source artifact version",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          applyPackGovernanceDecision({
            catalog: [
              makeArtifact({
                state: "shadow",
                version: "2026.03.08",
                recordedAt: "2026-03-08T09:00:00.000Z",
              }),
            ],
            subjectPackId: "pack-shop-example-com",
            subjectPackVersion: "2026.03.08",
            decision: Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
              id: "decision-promote-003b",
              packId: "pack-shop-example-com",
              sourceVersion: "2026.03.08",
              triggerVerdictId: "verdict-003b",
              createdAt: "2026-03-09T12:00:00.000Z",
              fromState: "shadow",
              toState: "active",
              action: "active",
            }),
            changedBy: "curator-main",
            rationale: "reused version",
            occurredAt: "2026-03-09T12:15:00.000Z",
            nextVersion: "2026.03.08",
          }),
        );

        expect(error.message).toContain("new version");
        expect(error.message).toContain("reusing");
      }),
  );

  it.effect(
    "rejects rollback activation when the replacement active version is missing or stale",
    () =>
      Effect.gen(function* () {
        const missingVersionError = yield* Effect.flip(
          applyPackGovernanceDecision({
            catalog: [
              makeArtifact({
                state: "active",
                version: "2026.03.09",
                recordedAt: "2026-03-09T09:00:00.000Z",
              }),
              makeArtifact({
                state: "quarantined",
                version: "2026.03.07",
                recordedAt: "2026-03-07T09:00:00.000Z",
              }),
            ],
            subjectPackId: "pack-shop-example-com",
            subjectPackVersion: "2026.03.07",
            decision: Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
              id: "decision-rollback-002",
              packId: "pack-shop-example-com",
              sourceVersion: "2026.03.07",
              triggerVerdictId: "verdict-rollback-002",
              createdAt: "2026-03-09T10:00:00.000Z",
              fromState: "quarantined",
              toState: "active",
              action: "active",
            }),
            changedBy: "curator-main",
            rationale: "missing rollback replacement version",
            occurredAt: "2026-03-09T10:15:00.000Z",
          }),
        );

        const staleVersionError = yield* Effect.flip(
          applyPackGovernanceDecision({
            catalog: [
              makeArtifact({
                state: "active",
                version: "2026.03.09",
                recordedAt: "2026-03-09T09:00:00.000Z",
              }),
              makeArtifact({
                state: "quarantined",
                version: "2026.03.07",
                recordedAt: "2026-03-07T09:00:00.000Z",
              }),
            ],
            subjectPackId: "pack-shop-example-com",
            subjectPackVersion: "2026.03.07",
            decision: Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
              id: "decision-rollback-003",
              packId: "pack-shop-example-com",
              sourceVersion: "2026.03.07",
              triggerVerdictId: "verdict-rollback-003",
              createdAt: "2026-03-09T10:00:00.000Z",
              fromState: "quarantined",
              toState: "active",
              action: "active",
            }),
            changedBy: "curator-main",
            rationale: "stale rollback replacement version",
            occurredAt: "2026-03-09T10:15:00.000Z",
            nextVersion: "2026.03.08",
          }),
        );

        expect(missingVersionError.message).toContain("nextVersion");
        expect(staleVersionError.message).toContain("sort after all recorded historical versions");
      }),
  );

  it.effect(
    "rejects curator decisions whose declared source state does not match the selected artifact",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          applyPackGovernanceDecision({
            catalog: [
              makeArtifact({
                state: "shadow",
                version: "2026.03.08",
                recordedAt: "2026-03-08T09:00:00.000Z",
              }),
            ],
            subjectPackId: "pack-shop-example-com",
            subjectPackVersion: "2026.03.08",
            decision: Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
              id: "decision-promote-004",
              packId: "pack-shop-example-com",
              sourceVersion: "2026.03.08",
              triggerVerdictId: "verdict-004",
              createdAt: "2026-03-09T12:00:00.000Z",
              fromState: "guarded",
              toState: "active",
              action: "active",
            }),
            changedBy: "curator-main",
            rationale: "mismatched state declaration",
            occurredAt: "2026-03-09T12:15:00.000Z",
            nextVersion: "2026.03.10",
          }),
        );

        expect(error.message).toContain("source state");
      }),
  );

  it.effect(
    "rejects curator decisions whose declared pack id does not match the selected artifact",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          applyPackGovernanceDecision({
            catalog: [
              makeArtifact({
                state: "shadow",
                version: "2026.03.08",
                recordedAt: "2026-03-08T09:00:00.000Z",
              }),
            ],
            subjectPackId: "pack-shop-example-com",
            subjectPackVersion: "2026.03.08",
            decision: Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
              id: "decision-promote-005",
              packId: "pack-other-example-com",
              sourceVersion: "2026.03.08",
              triggerVerdictId: "verdict-005",
              createdAt: "2026-03-09T12:00:00.000Z",
              fromState: "shadow",
              toState: "active",
              action: "active",
            }),
            changedBy: "curator-main",
            rationale: "pack id drift",
            occurredAt: "2026-03-09T12:15:00.000Z",
            nextVersion: "2026.03.10",
          }),
        );

        expect(error.message).toContain("pack id");
      }),
  );

  it.effect(
    "rejects governance requests that target a pack artifact missing from the catalog",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          applyPackGovernanceDecision({
            catalog: [
              makeArtifact({
                state: "shadow",
                version: "2026.03.08",
                recordedAt: "2026-03-08T09:00:00.000Z",
              }),
            ],
            subjectPackId: "pack-shop-example-com",
            subjectPackVersion: "2026.03.11",
            decision: Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
              id: "decision-promote-006",
              packId: "pack-shop-example-com",
              sourceVersion: "2026.03.11",
              triggerVerdictId: "verdict-006",
              createdAt: "2026-03-09T12:00:00.000Z",
              fromState: "shadow",
              toState: "active",
              action: "active",
            }),
            changedBy: "curator-main",
            rationale: "missing pack version",
            occurredAt: "2026-03-09T12:15:00.000Z",
            nextVersion: "2026.03.12",
          }),
        );

        expect(error.message).toContain("selected pack artifact");
        expect(error.message).toContain("exist");
      }),
  );
});
