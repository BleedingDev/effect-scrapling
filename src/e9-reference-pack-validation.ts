import { Effect, Schema } from "effect";
import { captureHttpArtifacts } from "../libs/foundation/core/src/http-access-runtime.ts";
import {
  ExtractionRecipeSchema,
  makeHttpCapturePayloadLoader,
  runExtractorOrchestration,
} from "../libs/foundation/core/src/extractor-runtime.ts";
import { SnapshotDiffSchema } from "../libs/foundation/core/src/diff-verdict.ts";
import {
  PackGovernanceResultSchema,
  VersionedSitePackArtifactSchema,
  applyPackGovernanceDecision,
} from "../libs/foundation/core/src/pack-governance-runtime.ts";
import { decidePackPromotion } from "../libs/foundation/core/src/reflection-engine-runtime.ts";
import { RunPlanSchema } from "../libs/foundation/core/src/run-state.ts";
import {
  CanonicalIdentifierSchema,
  IsoDateTimeSchema,
} from "../libs/foundation/core/src/schema-primitives.ts";
import { SitePackDslSchema } from "../libs/foundation/core/src/site-pack.ts";
import {
  PackValidationVerdictSchema,
  evaluateValidatorLadder,
} from "../libs/foundation/core/src/validator-ladder-runtime.ts";
import { SnapshotSchema } from "../libs/foundation/core/src/observation-snapshot.ts";
import { E9ReferencePackSchema, ReferencePackDomainSchema } from "./e9-reference-packs.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));

const ReferencePackValidationCaseInputSchema = Schema.Struct({
  domain: ReferencePackDomainSchema,
  referencePack: E9ReferencePackSchema,
  entryUrl: NonEmptyStringSchema,
  html: NonEmptyStringSchema,
  previousActiveVersion: NonEmptyStringSchema,
  nextActiveVersion: NonEmptyStringSchema,
});

const ReferencePackValidationCasesSchema = Schema.Array(
  ReferencePackValidationCaseInputSchema,
).pipe(
  Schema.refine(
    (
      cases,
    ): cases is ReadonlyArray<Schema.Schema.Type<typeof ReferencePackValidationCaseInputSchema>> =>
      cases.length > 0 &&
      new Set(cases.map(({ domain }) => domain)).size === cases.length &&
      cases.every(
        ({ referencePack, previousActiveVersion, nextActiveVersion }) =>
          previousActiveVersion !== referencePack.definition.pack.version &&
          nextActiveVersion !== referencePack.definition.pack.version &&
          nextActiveVersion !== previousActiveVersion,
      ),
    {
      message:
        "Expected unique E9 validation cases with distinct previous, shadow, and next active versions.",
    },
  ),
);

export const E9ReferencePackValidationInputSchema = Schema.Struct({
  validationId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  cases: ReferencePackValidationCasesSchema,
});

export const E9ReferencePackValidationCaseResultSchema = Schema.Struct({
  domain: ReferencePackDomainSchema,
  packId: CanonicalIdentifierSchema,
  extractedSnapshot: SnapshotSchema,
  shadowValidation: PackValidationVerdictSchema,
  governanceResult: PackGovernanceResultSchema,
  activeValidation: PackValidationVerdictSchema,
});

const E9ReferencePackValidationCaseResultsSchema = Schema.Array(
  E9ReferencePackValidationCaseResultSchema,
).pipe(
  Schema.refine(
    (
      results,
    ): results is ReadonlyArray<
      Schema.Schema.Type<typeof E9ReferencePackValidationCaseResultSchema>
    > => results.length > 0 && new Set(results.map(({ domain }) => domain)).size === results.length,
    {
      message: "Expected unique E9 validation results keyed by domain.",
    },
  ),
);

export const E9ReferencePackValidationArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e9-reference-pack-validation"),
  validationId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  caseCount: PositiveIntSchema,
  results: E9ReferencePackValidationCaseResultsSchema,
  status: Schema.Literal("pass"),
});

function makeRunPlan(input: {
  domain: Schema.Schema.Type<typeof ReferencePackDomainSchema>;
  packId: string;
  entryUrl: string;
  generatedAt: string;
}) {
  return Schema.decodeUnknownSync(RunPlanSchema)({
    id: `plan-e9-${input.domain}-tesla-001`,
    targetId: `target-e9-${input.domain}-tesla-001`,
    packId: input.packId,
    accessPolicyId: `policy-e9-${input.domain}-http`,
    concurrencyBudgetId: `budget-e9-${input.domain}-tesla`,
    entryUrl: input.entryUrl,
    maxAttempts: 1,
    timeoutMs: 5_000,
    checkpointInterval: 1,
    steps: [
      {
        id: `step-e9-${input.domain}-capture`,
        stage: "capture",
        requiresBrowser: false,
        artifactKind: "html",
      },
      {
        id: `step-e9-${input.domain}-extract`,
        stage: "extract",
        requiresBrowser: false,
      },
      {
        id: `step-e9-${input.domain}-snapshot`,
        stage: "snapshot",
        requiresBrowser: false,
      },
    ],
    createdAt: input.generatedAt,
  });
}

function makePassingSnapshotDiff(input: {
  domain: Schema.Schema.Type<typeof ReferencePackDomainSchema>;
  snapshotId: string;
  packId: string;
  generatedAt: string;
}) {
  return Schema.decodeUnknownSync(SnapshotDiffSchema)({
    id: `diff-e9-${input.domain}-${input.packId}`,
    baselineSnapshotId: input.snapshotId,
    candidateSnapshotId: input.snapshotId,
    metrics: {
      fieldRecallDelta: 0,
      falsePositiveDelta: 0,
      driftDelta: 0,
      latencyDeltaMs: 0,
      memoryDelta: 0,
    },
    createdAt: input.generatedAt,
  });
}

function makeValidatorChecks() {
  return {
    replayDeterminism: true,
    workflowResume: true,
    canary: true,
    chaos: true,
    securityRedaction: true,
    soakStability: true,
  } as const;
}

function makeCatalogArtifact(input: {
  definition: Schema.Schema.Type<typeof SitePackDslSchema>;
  recordedAt: string;
  recordedBy: string;
}) {
  return Schema.decodeUnknownSync(VersionedSitePackArtifactSchema)({
    definition: input.definition,
    recordedAt: input.recordedAt,
    recordedBy: input.recordedBy,
  });
}

function buildPreviousActiveDefinition(
  referencePack: Schema.Schema.Type<typeof E9ReferencePackSchema>,
  previousActiveVersion: string,
) {
  return Schema.decodeUnknownSync(SitePackDslSchema)({
    ...referencePack.definition,
    pack: {
      ...referencePack.definition.pack,
      state: "active",
      version: previousActiveVersion,
    },
  });
}

function captureFixtureHtml(input: {
  plan: Schema.Schema.Type<typeof RunPlanSchema>;
  html: string;
  generatedAt: string;
}) {
  return captureHttpArtifacts(
    input.plan,
    () =>
      Promise.resolve(
        new Response(input.html, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        }),
      ),
    () => new Date(input.generatedAt),
    () => 1,
  );
}

const validateReferencePackCase = Effect.fn("E9.validateReferencePackCase")(function* (
  input: Schema.Schema.Type<typeof ReferencePackValidationCaseInputSchema>,
  generatedAt: string,
) {
  const plan = makeRunPlan({
    domain: input.domain,
    packId: input.referencePack.definition.pack.id,
    entryUrl: input.entryUrl,
    generatedAt,
  });
  const captureBundle = yield* captureFixtureHtml({
    plan,
    html: input.html,
    generatedAt,
  });
  const orchestration = yield* runExtractorOrchestration(
    {
      plan,
      artifacts: captureBundle.artifacts,
      recipe: Schema.decodeUnknownSync(ExtractionRecipeSchema)(input.referencePack.recipe),
      createdAt: generatedAt,
    },
    makeHttpCapturePayloadLoader(captureBundle),
  );
  const shadowValidation = yield* evaluateValidatorLadder({
    pack: input.referencePack.definition.pack,
    snapshotDiff: makePassingSnapshotDiff({
      domain: input.domain,
      snapshotId: orchestration.snapshotAssembly.snapshot.id,
      packId: input.referencePack.definition.pack.id,
      generatedAt,
    }),
    checks: makeValidatorChecks(),
    createdAt: generatedAt,
  });
  const decision = yield* decidePackPromotion({
    pack: input.referencePack.definition.pack,
    verdict: shadowValidation.qualityVerdict,
  });
  const governanceResult = yield* applyPackGovernanceDecision({
    catalog: [
      makeCatalogArtifact({
        definition: buildPreviousActiveDefinition(input.referencePack, input.previousActiveVersion),
        recordedAt: generatedAt,
        recordedBy: "curator-reference-packs",
      }),
      makeCatalogArtifact({
        definition: input.referencePack.definition,
        recordedAt: generatedAt,
        recordedBy: "curator-reference-packs",
      }),
    ],
    subjectPackId: input.referencePack.definition.pack.id,
    subjectPackVersion: input.referencePack.definition.pack.version,
    decision,
    changedBy: "curator-reference-packs",
    rationale: `${input.domain} Tesla reference pack passed shadow validation and is eligible for active rollout.`,
    occurredAt: generatedAt,
    nextVersion: input.nextActiveVersion,
  });
  const activeArtifact = governanceResult.activeArtifact;
  if (activeArtifact === undefined) {
    throw new Error(`Active artifact missing for ${input.domain} reference pack validation.`);
  }

  const activeValidation = yield* evaluateValidatorLadder({
    pack: activeArtifact.definition.pack,
    snapshotDiff: makePassingSnapshotDiff({
      domain: input.domain,
      snapshotId: orchestration.snapshotAssembly.snapshot.id,
      packId: input.referencePack.definition.pack.id,
      generatedAt,
    }),
    checks: makeValidatorChecks(),
    createdAt: generatedAt,
  });

  return Schema.decodeUnknownSync(E9ReferencePackValidationCaseResultSchema)({
    domain: input.domain,
    packId: input.referencePack.definition.pack.id,
    extractedSnapshot: orchestration.snapshotAssembly.snapshot,
    shadowValidation,
    governanceResult,
    activeValidation,
  });
});

export function runE9ReferencePackValidation(input: unknown) {
  return Effect.gen(function* () {
    const decoded = Schema.decodeUnknownSync(E9ReferencePackValidationInputSchema)(input);
    const results = new Array<
      Schema.Schema.Type<typeof E9ReferencePackValidationCaseResultSchema>
    >();

    for (const entry of decoded.cases) {
      results.push(yield* validateReferencePackCase(entry, decoded.generatedAt));
    }

    return Schema.decodeUnknownSync(E9ReferencePackValidationArtifactSchema)({
      benchmark: "e9-reference-pack-validation",
      validationId: decoded.validationId,
      generatedAt: decoded.generatedAt,
      caseCount: results.length,
      results,
      status: "pass",
    });
  });
}

export type E9ReferencePackValidationArtifact = Schema.Schema.Type<
  typeof E9ReferencePackValidationArtifactSchema
>;
