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
import { resolvePackRegistryLookup } from "@effect-scrapling/foundation-core/pack-registry-runtime";
import {
  PackPromotionDecisionSchema,
  SnapshotDiffSchema,
} from "@effect-scrapling/foundation-core/diff-verdict";
import { decidePackPromotion } from "@effect-scrapling/foundation-core/reflection-engine-runtime";
import {
  SelectorTrustSummarySchema,
  summarizeSelectorTrust,
} from "@effect-scrapling/foundation-core/selector-trust-decay";
import {
  PackLifecycleTransitionResultSchema,
  transitionPackLifecycle,
} from "@effect-scrapling/foundation-core/pack-lifecycle-runtime";
import { SitePackDslSchema, SitePackSchema } from "@effect-scrapling/foundation-core/site-pack";
import { PolicyViolation } from "@effect-scrapling/foundation-core/tagged-errors";
import {
  PackValidationVerdictSchema,
  evaluateValidatorLadder,
} from "@effect-scrapling/foundation-core/validator-ladder-runtime";

export const e6SdkConsumerPrerequisites = [
  "Bun >= 1.3.10",
  'Run from repository root with "bun run example:e6-sdk-consumer".',
  "Use only @effect-scrapling/foundation-core package subpath imports for E6 flows.",
  "Promoting a shadow candidate to active requires a fresh nextVersion through governance.",
] as const;

export const e6SdkConsumerPitfalls = [
  "Resolve the pack through the registry before building a promotion decision so tenant and lifecycle preference stay truthful.",
  "Treat selector trust and candidate generation as typed evidence inputs, not as free-form patch suggestions.",
  "Never mutate the current active pack version in place; governance activation must mint a fresh immutable version.",
  "Do not import private repo files when integrating E6 through workspace package subpaths.",
] as const;

export type E6SdkConsumerExampleResult = {
  readonly importPaths: readonly [
    "@effect-scrapling/foundation-core/pack-candidate-generator",
    "@effect-scrapling/foundation-core/pack-governance-runtime",
    "@effect-scrapling/foundation-core/pack-lifecycle-runtime",
    "@effect-scrapling/foundation-core/pack-registry-runtime",
    "@effect-scrapling/foundation-core/diff-verdict",
    "@effect-scrapling/foundation-core/reflection-engine-runtime",
    "@effect-scrapling/foundation-core/selector-trust-decay",
    "@effect-scrapling/foundation-core/site-pack",
    "@effect-scrapling/foundation-core/tagged-errors",
    "@effect-scrapling/foundation-core/validator-ladder-runtime",
  ];
  readonly prerequisites: typeof e6SdkConsumerPrerequisites;
  readonly pitfalls: typeof e6SdkConsumerPitfalls;
  readonly payload: {
    readonly transitionedShadow: unknown;
    readonly resolvedPack: unknown;
    readonly trustSummary: unknown;
    readonly candidateProposal: unknown;
    readonly validationVerdict: unknown;
    readonly automationDecision: unknown;
    readonly governanceResult: unknown;
    readonly expectedError:
      | {
          readonly code: "PolicyViolation";
          readonly message: string;
        }
      | {
          readonly code: "UnexpectedSuccess";
          readonly message: string;
        };
  };
};

function makePackDefinition(input: {
  readonly state: "draft" | "shadow" | "active" | "guarded" | "quarantined" | "retired";
  readonly version: string;
  readonly titleSelector: string;
}) {
  return Schema.decodeUnknownSync(SitePackDslSchema)({
    pack: {
      id: "pack-sdk-example-com",
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

const SNAPSHOT_DIFF = Schema.decodeUnknownSync(SnapshotDiffSchema)({
  id: "diff-pack-sdk-example-com-001",
  baselineSnapshotId: "snapshot-baseline-001",
  candidateSnapshotId: "snapshot-candidate-001",
  metrics: {
    fieldRecallDelta: 0.02,
    falsePositiveDelta: 0.01,
    driftDelta: 0.03,
    latencyDeltaMs: 30,
    memoryDelta: 4,
  },
  createdAt: "2026-03-08T13:20:00.000Z",
});

export function runE6SdkConsumerExample(): Effect.Effect<
  E6SdkConsumerExampleResult,
  PolicyViolation,
  never
> {
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
      rationale: "Promote the draft candidate into the proving lane.",
      occurredAt: "2026-03-08T13:00:00.000Z",
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
      Effect.flatMap((pack) =>
        Option.match(pack, {
          onNone: () =>
            Effect.fail(
              new PolicyViolation({
                message: "Expected the E6 SDK consumer example to resolve the shadow pack.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

    const trustSummary = yield* summarizeSelectorTrust({
      evaluatedAt: "2026-03-08T13:05:00.000Z",
      events: [
        {
          selectorPath: "price/fallback",
          outcome: "recoverableFailure",
          observedAt: "2026-03-08T12:50:00.000Z",
          evidenceRefs: ["artifact-regression-001"],
        },
        {
          selectorPath: "price/fallback",
          outcome: "success",
          observedAt: "2026-03-08T12:55:00.000Z",
          evidenceRefs: ["artifact-regression-002"],
        },
        {
          selectorPath: "title/secondary",
          outcome: "success",
          observedAt: "2026-03-08T12:57:00.000Z",
          evidenceRefs: ["artifact-title-001"],
        },
      ],
    });

    const candidateProposal = yield* generatePackCandidate({
      pack: shadowDefinition,
      signals: [
        {
          kind: "regression",
          field: "price",
          currentPrimarySelectorPath: "price/primary",
          selectorCandidate: {
            path: "price/fallback",
            selector: ".price-box",
          },
          evidenceRefs: ["artifact-regression-001"],
          observedAt: "2026-03-08T13:08:00.000Z",
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
          observedAt: "2026-03-08T13:09:00.000Z",
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
          observedAt: "2026-03-08T13:08:00.000Z",
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
          observedAt: "2026-03-08T13:09:00.000Z",
        },
      ],
      createdAt: "2026-03-08T13:10:00.000Z",
    });

    const validationVerdict = yield* evaluateValidatorLadder({
      pack: resolvedPack,
      snapshotDiff: SNAPSHOT_DIFF,
      checks: {
        replayDeterminism: true,
        workflowResume: true,
        canary: true,
        chaos: true,
        securityRedaction: true,
        soakStability: true,
      },
      createdAt: "2026-03-08T13:15:00.000Z",
    });

    const automationDecision = yield* decidePackPromotion({
      pack: resolvedPack,
      verdict: validationVerdict.qualityVerdict,
    });

    const governanceResult = yield* applyPackGovernanceDecision({
      catalog: [
        makeArtifact({
          definition: activeDefinition,
          recordedAt: "2026-03-07T12:00:00.000Z",
        }),
        makeArtifact({
          definition: shadowDefinition,
          recordedAt: "2026-03-08T12:30:00.000Z",
        }),
      ],
      subjectPackId: shadowDefinition.pack.id,
      subjectPackVersion: shadowDefinition.pack.version,
      decision: automationDecision,
      changedBy: "curator-main",
      rationale: "Shadow candidate cleared the validator ladder and governance automation.",
      occurredAt: "2026-03-08T13:20:00.000Z",
      nextVersion: "2026.03.09",
    });

    const expectedError = yield* applyPackGovernanceDecision({
      catalog: [
        makeArtifact({
          definition: activeDefinition,
          recordedAt: "2026-03-07T12:00:00.000Z",
        }),
        makeArtifact({
          definition: shadowDefinition,
          recordedAt: "2026-03-08T12:30:00.000Z",
        }),
      ],
      subjectPackId: shadowDefinition.pack.id,
      subjectPackVersion: shadowDefinition.pack.version,
      decision: automationDecision,
      changedBy: "curator-main",
      rationale: "This path should fail because nextVersion is missing.",
      occurredAt: "2026-03-08T13:20:00.000Z",
    }).pipe(
      Effect.as({
        code: "UnexpectedSuccess" as const,
        message: "Expected governance to reject missing nextVersion for active promotion.",
      }),
      Effect.catchTag("PolicyViolation", (error) =>
        Effect.succeed({
          code: "PolicyViolation" as const,
          message: error.message,
        }),
      ),
    );

    return {
      importPaths: [
        "@effect-scrapling/foundation-core/pack-candidate-generator",
        "@effect-scrapling/foundation-core/pack-governance-runtime",
        "@effect-scrapling/foundation-core/pack-lifecycle-runtime",
        "@effect-scrapling/foundation-core/pack-registry-runtime",
        "@effect-scrapling/foundation-core/diff-verdict",
        "@effect-scrapling/foundation-core/reflection-engine-runtime",
        "@effect-scrapling/foundation-core/selector-trust-decay",
        "@effect-scrapling/foundation-core/site-pack",
        "@effect-scrapling/foundation-core/tagged-errors",
        "@effect-scrapling/foundation-core/validator-ladder-runtime",
      ] as const,
      prerequisites: e6SdkConsumerPrerequisites,
      pitfalls: e6SdkConsumerPitfalls,
      payload: {
        transitionedShadow: Schema.encodeSync(PackLifecycleTransitionResultSchema)(
          transitionedShadow,
        ),
        resolvedPack: Schema.encodeSync(SitePackSchema)(resolvedPack),
        trustSummary: Schema.encodeSync(SelectorTrustSummarySchema)(trustSummary),
        candidateProposal: Schema.encodeSync(PackCandidateProposalSchema)(candidateProposal),
        validationVerdict: Schema.encodeSync(PackValidationVerdictSchema)(validationVerdict),
        automationDecision: Schema.encodeSync(PackPromotionDecisionSchema)(automationDecision),
        governanceResult: Schema.encodeSync(PackGovernanceResultSchema)(governanceResult),
        expectedError,
      },
    };
  });
}

if (import.meta.main) {
  const payload = await Effect.runPromise(runE6SdkConsumerExample());
  console.log(JSON.stringify(payload, null, 2));
}
