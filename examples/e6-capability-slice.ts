import { Effect, Option, Schema } from "effect";
import {
  PackCandidateProposalSchema,
  generatePackCandidate,
} from "@effect-scrapling/foundation-core/pack-candidate-generator";
import {
  PackGovernanceResultSchema,
  VersionedSitePackArtifactSchema,
  applyPackGovernanceDecision,
} from "@effect-scrapling/foundation-core/pack-governance-runtime";
import {
  PackLifecycleTransitionResultSchema,
  transitionPackLifecycle,
} from "@effect-scrapling/foundation-core/pack-lifecycle-runtime";
import { resolvePackRegistryLookup } from "@effect-scrapling/foundation-core/pack-registry-runtime";
import {
  PackPromotionDecisionSchema,
  SnapshotDiffSchema,
} from "@effect-scrapling/foundation-core/diff-verdict";
import { decidePackPromotion } from "@effect-scrapling/foundation-core/reflection-engine-runtime";
import {
  PackReflectionRecommendationSchema,
  synthesizePackReflection,
} from "@effect-scrapling/foundation-core/reflector-runtime";
import {
  SelectorTrustSummarySchema,
  summarizeSelectorTrust,
} from "@effect-scrapling/foundation-core/selector-trust-decay";
import { SitePackDslSchema, SitePackSchema } from "@effect-scrapling/foundation-core/site-pack";
import { PolicyViolation } from "@effect-scrapling/foundation-core/tagged-errors";
import {
  PackValidationVerdictSchema,
  evaluateValidatorLadder,
} from "@effect-scrapling/foundation-core/validator-ladder-runtime";

function makePackDefinition(input: {
  readonly state: "draft" | "shadow" | "active" | "guarded" | "quarantined" | "retired";
  readonly version: string;
  readonly titleSelector: string;
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
            path: "title/primary",
            selector: input.titleSelector,
          },
        ],
        fallbackPolicy: {
          maxFallbackCount: 0,
          fallbackConfidenceImpact: 0,
          maxConfidenceImpact: 0,
        },
      },
      {
        field: "price",
        candidates: [
          {
            path: "price/primary",
            selector: "[data-price]",
          },
          {
            path: "price/fallback",
            selector: ".price-box",
          },
        ],
        fallbackPolicy: {
          maxFallbackCount: 1,
          fallbackConfidenceImpact: 0.15,
          maxConfidenceImpact: 0.45,
        },
      },
    ],
    assertions: {
      requiredFields: [{ field: "title" }, { field: "price" }],
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

function makeArtifact(input: {
  readonly definition: Schema.Schema.Type<typeof SitePackDslSchema>;
  readonly recordedAt: string;
}) {
  return Schema.decodeUnknownSync(VersionedSitePackArtifactSchema)({
    definition: input.definition,
    recordedAt: input.recordedAt,
    recordedBy: "curator-main",
  });
}

const CANDIDATE_SIGNALS = [
  {
    kind: "regression",
    field: "price",
    currentPrimarySelectorPath: "price/primary",
    selectorCandidate: {
      path: "price/fallback",
      selector: ".price-box",
    },
    evidenceRefs: ["artifact-regression-001"],
    observedAt: "2026-03-08T11:00:00.000Z",
  },
  {
    kind: "regression",
    field: "price",
    currentPrimarySelectorPath: "price/primary",
    selectorCandidate: {
      path: "price/fallback",
      selector: ".price-box",
    },
    evidenceRefs: ["artifact-regression-002"],
    observedAt: "2026-03-08T11:05:00.000Z",
  },
  {
    kind: "fixture",
    fixtureId: "fixture-title-001",
    field: "title",
    selectorCandidate: {
      path: "title/secondary",
      selector: "[data-title]",
    },
    evidenceRefs: ["artifact-title-001"],
    observedAt: "2026-03-08T11:00:00.000Z",
  },
  {
    kind: "fixture",
    fixtureId: "fixture-title-002",
    field: "title",
    selectorCandidate: {
      path: "title/secondary",
      selector: "[data-title]",
    },
    evidenceRefs: ["artifact-title-002"],
    observedAt: "2026-03-08T11:05:00.000Z",
  },
] as const;

const SNAPSHOT_DIFF = Schema.decodeUnknownSync(SnapshotDiffSchema)({
  id: "diff-pack-shop-example-com-001",
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
});

export class E6CapabilitySliceEvidence extends Schema.Class<E6CapabilitySliceEvidence>(
  "E6CapabilitySliceEvidence",
)({
  transitionedShadow: PackLifecycleTransitionResultSchema,
  resolvedPack: SitePackSchema,
  trustSummary: SelectorTrustSummarySchema,
  candidateProposal: PackCandidateProposalSchema,
  reflectionRecommendation: PackReflectionRecommendationSchema,
  validationVerdict: PackValidationVerdictSchema,
  automationDecision: PackPromotionDecisionSchema,
  governanceResult: PackGovernanceResultSchema,
}) {}

export const E6CapabilitySliceEvidenceSchema = E6CapabilitySliceEvidence;

export function runE6CapabilitySlice() {
  return Effect.gen(function* () {
    const draftDefinition = makePackDefinition({
      state: "draft",
      version: "2026.03.08",
      titleSelector: "h1.shadow",
    });
    const activeDefinition = makePackDefinition({
      state: "active",
      version: "2026.03.07",
      titleSelector: "h1.active",
    });

    const transitionedShadow = yield* transitionPackLifecycle({
      pack: draftDefinition.pack,
      to: "shadow",
      changedBy: "curator-main",
      rationale: "Promote the candidate pack into the proving lane.",
      occurredAt: "2026-03-08T10:00:00.000Z",
    });

    const shadowDefinition = Schema.decodeUnknownSync(SitePackDslSchema)({
      ...draftDefinition,
      pack: transitionedShadow.pack,
    });

    const resolvedPack = yield* Effect.sync(() =>
      resolvePackRegistryLookup([activeDefinition.pack, shadowDefinition.pack], {
        domain: "shop.example.com",
        tenantId: "tenant-main",
        states: ["shadow", "active"],
      }),
    ).pipe(
      Effect.flatMap((candidate) =>
        Option.match(candidate, {
          onNone: () =>
            Effect.fail(
              new PolicyViolation({
                message: "Expected the E6 capability slice to resolve a shadow pack candidate.",
              }),
            ),
          onSome: (pack) => Effect.succeed(pack),
        }),
      ),
    );

    const trustSummary = yield* summarizeSelectorTrust({
      evaluatedAt: "2026-03-08T12:00:00.000Z",
      events: [
        {
          selectorPath: "price/fallback",
          outcome: "hardFailure",
          observedAt: "2026-03-08T11:30:00.000Z",
          evidenceRefs: ["artifact-regression-001"],
        },
        {
          selectorPath: "price/fallback",
          outcome: "recoverableFailure",
          observedAt: "2026-03-08T11:45:00.000Z",
          evidenceRefs: ["artifact-regression-002"],
        },
        {
          selectorPath: "title/primary",
          outcome: "recoverableFailure",
          observedAt: "2026-03-08T11:40:00.000Z",
          evidenceRefs: ["artifact-title-001"],
        },
        {
          selectorPath: "title/secondary",
          outcome: "success",
          observedAt: "2026-03-08T11:35:00.000Z",
          evidenceRefs: ["artifact-title-001"],
        },
        {
          selectorPath: "title/secondary",
          outcome: "success",
          observedAt: "2026-03-08T11:50:00.000Z",
          evidenceRefs: ["artifact-title-002"],
        },
      ],
    });

    const candidateProposal = yield* generatePackCandidate({
      pack: shadowDefinition,
      signals: CANDIDATE_SIGNALS,
      createdAt: "2026-03-08T12:00:00.000Z",
    });

    const reflectionRecommendation = yield* synthesizePackReflection({
      pack: shadowDefinition,
      signals: CANDIDATE_SIGNALS,
      createdAt: "2026-03-08T12:00:00.000Z",
    });

    const validationVerdict = yield* evaluateValidatorLadder({
      pack: shadowDefinition.pack,
      snapshotDiff: SNAPSHOT_DIFF,
      checks: {
        replayDeterminism: true,
        workflowResume: true,
        canary: true,
        chaos: true,
        securityRedaction: true,
        soakStability: true,
      },
      createdAt: "2026-03-08T12:05:00.000Z",
    });

    const automationDecision = yield* decidePackPromotion({
      pack: shadowDefinition.pack,
      verdict: validationVerdict.qualityVerdict,
    });

    const governanceResult = yield* applyPackGovernanceDecision({
      catalog: [
        makeArtifact({
          definition: activeDefinition,
          recordedAt: "2026-03-07T09:00:00.000Z",
        }),
        makeArtifact({
          definition: shadowDefinition,
          recordedAt: "2026-03-08T09:00:00.000Z",
        }),
      ],
      subjectPackId: shadowDefinition.pack.id,
      subjectPackVersion: shadowDefinition.pack.version,
      decision: automationDecision,
      changedBy: "curator-main",
      rationale: "Shadow candidate cleared the full validator ladder.",
      occurredAt: "2026-03-08T12:10:00.000Z",
      nextVersion: "2026.03.09",
    });

    return Schema.decodeUnknownSync(E6CapabilitySliceEvidenceSchema)({
      transitionedShadow,
      resolvedPack,
      trustSummary,
      candidateProposal,
      reflectionRecommendation,
      validationVerdict,
      automationDecision,
      governanceResult,
    });
  });
}

export function runE6CapabilitySliceEncoded() {
  return runE6CapabilitySlice().pipe(
    Effect.map((evidence) => Schema.encodeSync(E6CapabilitySliceEvidenceSchema)(evidence)),
  );
}

if (import.meta.main) {
  const encoded = await Effect.runPromise(runE6CapabilitySliceEncoded());
  process.stdout.write(`${JSON.stringify(encoded, null, 2)}\n`);
}
