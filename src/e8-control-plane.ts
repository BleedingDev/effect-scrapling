import { Effect, Schema } from "effect";
import {
  AccessModeSchema,
  CanonicalDomainSchema,
  CanonicalIdentifierSchema,
  IsoDateTimeSchema,
  RunBudgetUtilization,
  CompiledCrawlPlan,
  PackPromotionDecisionSchema,
  RunProgressView,
  RunStats,
  QualityMetricsArtifactSchema,
  QualityVerdictSchema,
  RunCheckpointSchema,
  RunPlanSchema,
  RenderingPolicySchema,
  SitePackSchema,
  SnapshotDiffSchema,
  SnapshotSchema,
  TargetKindSchema,
  TargetProfileSchema,
  WorkflowInspectionSnapshotSchema,
  compileCrawlPlan,
} from "@effect-scrapling/foundation-core";
import {
  VersionedSitePackCatalogSchema,
  VersionedSitePackArtifactSchema,
  applyPackGovernanceDecision,
} from "@effect-scrapling/foundation-core/pack-governance-runtime";
import {
  PackValidationVerdictSchema,
  evaluateValidatorLadder,
} from "@effect-scrapling/foundation-core/validator-ladder-runtime";
import { BaselineCorpusArtifactSchema } from "@effect-scrapling/foundation-core/baseline-corpus-runtime";
import { IncumbentComparisonArtifactSchema } from "@effect-scrapling/foundation-core/incumbent-comparison-runtime";
import { evaluateQualityMetrics } from "@effect-scrapling/foundation-core/quality-metrics-runtime";
import { decidePackPromotion } from "@effect-scrapling/foundation-core/reflection-engine-runtime";
import { compareSnapshots } from "@effect-scrapling/foundation-core/snapshot-diff-engine";
import { formatUnknownError } from "./sdk/error-guards.ts";
import { InvalidInputError } from "./sdk/errors.ts";
import { type FetchClient } from "./sdk/scraper.ts";
import { createEngine } from "./sdk/engine.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));

const CommandWarningSchema = Schema.Array(NonEmptyStringSchema);
const TargetCatalogSchema = Schema.Array(TargetProfileSchema).pipe(
  Schema.refine(
    (targets): targets is ReadonlyArray<Schema.Schema.Type<typeof TargetProfileSchema>> =>
      new Set(targets.map(({ id }) => id)).size === targets.length,
    {
      message: "Expected deterministic E8 target catalogs with unique target ids.",
    },
  ),
);
const NonEmptyTargetCatalogSchema = TargetCatalogSchema.pipe(
  Schema.refine(
    (targets): targets is ReadonlyArray<Schema.Schema.Type<typeof TargetProfileSchema>> =>
      targets.length > 0,
    {
      message: "Expected at least one target in the E8 import catalog.",
    },
  ),
);

const TargetListFiltersSchema = Schema.Struct({
  tenantId: Schema.optional(CanonicalIdentifierSchema),
  domain: Schema.optional(CanonicalDomainSchema),
  kind: Schema.optional(TargetKindSchema),
});

const TargetImportInputSchema = Schema.Struct({
  targets: NonEmptyTargetCatalogSchema,
});

const TargetListInputSchema = Schema.Struct({
  targets: TargetCatalogSchema,
  filters: Schema.optional(TargetListFiltersSchema),
});

const TargetImportDataSchema = Schema.Struct({
  importedCount: PositiveIntSchema,
  targets: TargetCatalogSchema,
});

const TargetListDataSchema = Schema.Struct({
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  targets: TargetCatalogSchema,
});

const TargetImportEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("target import"),
  data: TargetImportDataSchema,
  warnings: CommandWarningSchema,
});

const TargetListEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("target list"),
  data: TargetListDataSchema,
  warnings: CommandWarningSchema,
});

const SitePackSelectorCandidateSchema = Schema.Struct({
  path: NonEmptyStringSchema,
  selector: NonEmptyStringSchema,
});

const SitePackFieldSelectorSchema = Schema.Struct({
  field: NonEmptyStringSchema,
  candidates: Schema.Array(SitePackSelectorCandidateSchema),
  fallbackPolicy: Schema.Struct({
    maxFallbackCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    fallbackConfidenceImpact: Schema.Number,
    maxConfidenceImpact: Schema.Number,
  }),
});

const SitePackSelectorsSchema = Schema.Array(SitePackFieldSelectorSchema).pipe(
  Schema.refine(
    (
      selectors,
    ): selectors is ReadonlyArray<Schema.Schema.Type<typeof SitePackFieldSelectorSchema>> =>
      selectors.length > 0,
    {
      message: "Expected at least one selector field in the E8 pack definition.",
    },
  ),
);

const SitePackOwnersSchema = Schema.Array(NonEmptyStringSchema).pipe(
  Schema.refine((owners): owners is ReadonlyArray<string> => owners.length > 0, {
    message: "Expected at least one owner in the E8 pack definition.",
  }),
);

const SitePackDslSchema = Schema.Struct({
  pack: SitePackSchema,
  selectors: SitePackSelectorsSchema,
  assertions: Schema.Struct({
    requiredFields: Schema.Array(Schema.Struct({ field: NonEmptyStringSchema })),
    businessInvariants: Schema.Array(
      Schema.Struct({
        field: NonEmptyStringSchema,
        operator: NonEmptyStringSchema,
        expected: Schema.Unknown,
      }),
    ),
  }),
  policy: Schema.Struct({
    targetKinds: Schema.Array(TargetKindSchema),
    mode: AccessModeSchema,
    render: RenderingPolicySchema,
  }),
  metadata: Schema.Struct({
    tenantId: Schema.optional(NonEmptyStringSchema),
    owners: SitePackOwnersSchema,
    labels: Schema.Array(NonEmptyStringSchema),
  }),
});

const PackCreateInputSchema = Schema.Struct({
  definition: SitePackDslSchema,
});

const PackInspectInputSchema = PackCreateInputSchema;

const PackInspectSummarySchema = Schema.Struct({
  selectorFieldCount: PositiveIntSchema,
  targetKinds: Schema.Array(TargetKindSchema),
  ownerCount: PositiveIntSchema,
});

const PackCreateEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("pack create"),
  data: Schema.Struct({
    definition: SitePackDslSchema,
  }),
  warnings: CommandWarningSchema,
});

const PackInspectEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("pack inspect"),
  data: Schema.Struct({
    definition: SitePackDslSchema,
    summary: PackInspectSummarySchema,
  }),
  warnings: CommandWarningSchema,
});

const PackValidateInputSchema = Schema.Struct({
  pack: SitePackSchema,
  snapshotDiff: SnapshotDiffSchema,
  checks: Schema.Struct({
    replayDeterminism: Schema.Boolean,
    workflowResume: Schema.Boolean,
    canary: Schema.Boolean,
    chaos: Schema.Boolean,
    securityRedaction: Schema.Boolean,
    soakStability: Schema.Boolean,
  }),
  createdAt: IsoDateTimeSchema,
  policy: Schema.optional(
    Schema.Struct({
      minimumRecallDelta: Schema.optional(Schema.Number),
      maximumFalsePositiveDelta: Schema.optional(Schema.Number),
      maximumDriftDelta: Schema.optional(Schema.Number),
      maximumLatencyDeltaMs: Schema.optional(Schema.Int),
      maximumMemoryDelta: Schema.optional(Schema.Number),
    }),
  ),
});

const PackValidateEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("pack validate"),
  data: Schema.Struct({
    verdict: PackValidationVerdictSchema,
  }),
  warnings: CommandWarningSchema,
});

const PackPromoteInputSchema = Schema.Struct({
  catalog: VersionedSitePackCatalogSchema,
  subjectPackId: NonEmptyStringSchema,
  subjectPackVersion: NonEmptyStringSchema,
  decision: PackPromotionDecisionSchema,
  changedBy: NonEmptyStringSchema,
  rationale: NonEmptyStringSchema,
  occurredAt: IsoDateTimeSchema,
  nextVersion: Schema.optional(NonEmptyStringSchema),
});

const PackPromoteEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("pack promote"),
  data: Schema.Struct({
    result: Schema.Struct({
      activeArtifact: Schema.optional(VersionedSitePackArtifactSchema),
      catalog: VersionedSitePackCatalogSchema,
      auditTrail: Schema.Array(Schema.Unknown),
    }),
  }),
  warnings: CommandWarningSchema,
});

const CrawlCompileEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("crawl compile"),
  data: Schema.Struct({
    compiled: CompiledCrawlPlan,
  }),
  warnings: CommandWarningSchema,
});

const WorkflowRunInputSchema = Schema.Struct({
  compiledPlan: CompiledCrawlPlan,
  pack: SitePackSchema,
});

const WorkflowResumeInputSchema = Schema.Struct({
  compiledPlan: CompiledCrawlPlan,
  checkpoint: RunCheckpointSchema,
  pack: SitePackSchema,
});

const WorkflowInspectInputSchema = WorkflowResumeInputSchema;

const WorkflowRunEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("workflow run"),
  data: Schema.Struct({
    checkpoint: RunCheckpointSchema,
    inspection: WorkflowInspectionSnapshotSchema,
  }),
  warnings: CommandWarningSchema,
});

const WorkflowResumeEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("workflow resume"),
  data: Schema.Struct({
    checkpoint: RunCheckpointSchema,
    inspection: WorkflowInspectionSnapshotSchema,
  }),
  warnings: CommandWarningSchema,
});

const WorkflowInspectEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("workflow inspect"),
  data: Schema.Struct({
    inspection: WorkflowInspectionSnapshotSchema,
  }),
  warnings: CommandWarningSchema,
});

const SnapshotDiffInputSchema = Schema.Struct({
  baseline: SnapshotSchema,
  candidate: SnapshotSchema,
  createdAt: IsoDateTimeSchema,
  latencyDeltaMs: Schema.optional(Schema.Int),
  memoryDelta: Schema.optional(Schema.Finite),
});

const SnapshotDiffEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("quality diff"),
  data: Schema.Struct({
    diff: SnapshotDiffSchema,
  }),
  warnings: CommandWarningSchema,
});

const QualityVerifyInputSchema = PackValidateInputSchema;

const QualityVerifyEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("quality verify"),
  data: Schema.Struct({
    verdict: QualityVerdictSchema,
    packDecision: PackPromotionDecisionSchema,
  }),
  warnings: CommandWarningSchema,
});

const QualityCompareInputSchema = Schema.Struct({
  metricsId: NonEmptyStringSchema,
  generatedAt: IsoDateTimeSchema,
  baseline: BaselineCorpusArtifactSchema,
  comparison: IncumbentComparisonArtifactSchema,
});

const QualityCompareEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("quality compare"),
  data: Schema.Struct({
    metrics: QualityMetricsArtifactSchema,
  }),
  warnings: CommandWarningSchema,
});

function sortTargets(targets: ReadonlyArray<Schema.Schema.Type<typeof TargetProfileSchema>>) {
  const compareStrings = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0;

  return [...targets].sort(
    (left, right) =>
      compareStrings(left.domain, right.domain) ||
      compareStrings(left.kind, right.kind) ||
      compareStrings(left.id, right.id),
  );
}

function invalidInput(message: string, cause: unknown) {
  return new InvalidInputError({
    message,
    details: formatUnknownError(cause),
  });
}

function decodeOrFail<A>(
  schema: Schema.Schema<A> & {
    readonly DecodingServices: never;
  },
  input: unknown,
  message: string,
) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(input),
    catch: (cause) => invalidInput(message, cause),
  });
}

function buildRunStats(
  plan: Schema.Schema.Type<typeof RunPlanSchema>,
  input: {
    readonly completedSteps: number;
    readonly checkpointCount: number;
    readonly artifactCount: number;
    readonly outcome: "running" | "succeeded";
    readonly startedAt: string;
    readonly updatedAt: string;
  },
) {
  return Schema.decodeUnknownSync(RunStats)({
    runId: plan.id,
    plannedSteps: plan.steps.length,
    completedSteps: input.completedSteps,
    checkpointCount: input.checkpointCount,
    artifactCount: input.artifactCount,
    outcome: input.outcome,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
  });
}

function buildProgress(
  plan: Schema.Schema.Type<typeof RunPlanSchema>,
  completedStepIds: ReadonlyArray<string>,
  artifactCount: number,
  checkpointCount: number,
) {
  const pendingStepIds = plan.steps
    .map(({ id }) => id)
    .filter((stepId) => !completedStepIds.includes(stepId));

  return Schema.decodeUnknownSync(RunProgressView)({
    plannedSteps: plan.steps.length,
    completedSteps: completedStepIds.length,
    pendingSteps: pendingStepIds.length,
    checkpointCount,
    artifactCount,
    completionRatio: plan.steps.length === 0 ? 0 : completedStepIds.length / plan.steps.length,
    completedStepIds,
    pendingStepIds,
  });
}

function buildBudget(
  plan: Schema.Schema.Type<typeof RunPlanSchema>,
  elapsedMs: number,
  stepsUntilNextCheckpoint: number,
) {
  return Schema.decodeUnknownSync(RunBudgetUtilization)({
    maxAttempts: plan.maxAttempts,
    configuredTimeoutMs: plan.timeoutMs,
    elapsedMs,
    remainingTimeoutMs: Math.max(plan.timeoutMs - elapsedMs, 0),
    timeoutUtilization: Math.min(elapsedMs / plan.timeoutMs, 1),
    checkpointInterval: plan.checkpointInterval,
    stepsUntilNextCheckpoint,
  });
}

function buildWorkflowCheckpoint(
  plan: Schema.Schema.Type<typeof RunPlanSchema>,
  input: {
    readonly sequence: number;
    readonly completedStepIds: ReadonlyArray<string>;
    readonly storedAt: string;
  },
) {
  const pendingStepIds = plan.steps
    .map(({ id }) => id)
    .filter((stepId) => !input.completedStepIds.includes(stepId));
  const nextStepId = pendingStepIds[0];
  const artifactIds = input.completedStepIds.length === 0 ? [] : [`artifact-${plan.targetId}`];
  const outcome = pendingStepIds.length === 0 ? "succeeded" : "running";

  return Schema.decodeUnknownSync(RunCheckpointSchema)({
    id: `checkpoint-${plan.id}-${String(input.sequence).padStart(4, "0")}`,
    runId: plan.id,
    planId: plan.id,
    sequence: input.sequence,
    stage:
      nextStepId === undefined
        ? "reflect"
        : plan.steps.find(
            (step: Schema.Schema.Type<typeof RunPlanSchema>["steps"][number]) =>
              step.id === nextStepId,
          )?.stage,
    nextStepId,
    completedStepIds: input.completedStepIds,
    pendingStepIds,
    artifactIds,
    resumeToken: `resume-${plan.id}-${input.sequence}`,
    stats: buildRunStats(plan, {
      completedSteps: input.completedStepIds.length,
      checkpointCount: input.sequence,
      artifactCount: artifactIds.length,
      outcome,
      startedAt: plan.createdAt,
      updatedAt: input.storedAt,
    }),
    storedAt: input.storedAt,
  });
}

function buildWorkflowInspection(
  plan: Schema.Schema.Type<typeof RunPlanSchema>,
  checkpoint: Schema.Schema.Type<typeof RunCheckpointSchema>,
) {
  return Schema.decodeUnknownSync(WorkflowInspectionSnapshotSchema)({
    runId: plan.id,
    planId: plan.id,
    targetId: plan.targetId,
    packId: plan.packId,
    accessPolicyId: plan.accessPolicyId,
    concurrencyBudgetId: plan.concurrencyBudgetId,
    entryUrl: plan.entryUrl,
    status: checkpoint.stats.outcome,
    stage: checkpoint.stage,
    nextStepId: checkpoint.nextStepId,
    startedAt: plan.createdAt,
    updatedAt: checkpoint.storedAt,
    storedAt: checkpoint.storedAt,
    stats: checkpoint.stats,
    progress: buildProgress(
      plan,
      checkpoint.completedStepIds,
      checkpoint.artifactIds.length,
      checkpoint.sequence,
    ),
    budget: buildBudget(
      plan,
      Math.min(500 * checkpoint.sequence, plan.timeoutMs),
      checkpoint.nextStepId === undefined
        ? 1
        : Math.max(
            plan.checkpointInterval -
              (checkpoint.completedStepIds.length % plan.checkpointInterval),
            1,
          ),
    ),
  });
}

function buildWorkflowCheckpointOrFail(
  plan: Schema.Schema.Type<typeof RunPlanSchema>,
  input: Parameters<typeof buildWorkflowCheckpoint>[1],
  message: string,
) {
  return Effect.try({
    try: () => buildWorkflowCheckpoint(plan, input),
    catch: (cause) => invalidInput(message, cause),
  });
}

function buildWorkflowInspectionOrFail(
  plan: Schema.Schema.Type<typeof RunPlanSchema>,
  checkpoint: Schema.Schema.Type<typeof RunCheckpointSchema>,
  message: string,
) {
  return Effect.try({
    try: () => buildWorkflowInspection(plan, checkpoint),
    catch: (cause) => invalidInput(message, cause),
  });
}

function advanceIsoTimestamp(value: string) {
  return new Date(Date.parse(value) + 1_000).toISOString();
}

function ensureWorkflowPackMatchesPlan(
  plan: Schema.Schema.Type<typeof RunPlanSchema>,
  pack: Schema.Schema.Type<typeof SitePackSchema>,
  message: string,
) {
  if (pack.id !== plan.packId || pack.accessPolicyId !== plan.accessPolicyId) {
    return Effect.fail(
      invalidInput(message, "Pack identity must match the compiled workflow plan."),
    );
  }

  return Effect.void;
}

function validateWorkflowCheckpointForPlan(
  plan: Schema.Schema.Type<typeof RunPlanSchema>,
  checkpoint: Schema.Schema.Type<typeof RunCheckpointSchema>,
  message: string,
) {
  const expectedPendingStepIds = plan.steps
    .map(({ id }) => id)
    .filter((stepId) => !checkpoint.completedStepIds.includes(stepId));
  const expectedNextStepId = expectedPendingStepIds[0];
  const expectedStage =
    expectedNextStepId === undefined
      ? "reflect"
      : plan.steps.find((step) => step.id === expectedNextStepId)?.stage;
  const expectedCheckpointId = `checkpoint-${plan.id}-${String(checkpoint.sequence).padStart(4, "0")}`;
  const expectedResumeToken = `resume-${plan.id}-${checkpoint.sequence}`;
  const completedStepIds = new Set(checkpoint.completedStepIds);
  const hasUnknownCompletedStep = checkpoint.completedStepIds.some(
    (stepId) => !plan.steps.some((step) => step.id === stepId),
  );
  const hasUnexpectedPendingSet =
    checkpoint.pendingStepIds.length !== expectedPendingStepIds.length ||
    checkpoint.pendingStepIds.some((stepId, index) => stepId !== expectedPendingStepIds[index]);

  if (
    checkpoint.runId !== plan.id ||
    checkpoint.planId !== plan.id ||
    checkpoint.id !== expectedCheckpointId ||
    (checkpoint.resumeToken !== undefined && checkpoint.resumeToken !== expectedResumeToken) ||
    checkpoint.stats.checkpointCount !== checkpoint.sequence ||
    hasUnknownCompletedStep ||
    hasUnexpectedPendingSet ||
    checkpoint.nextStepId !== expectedNextStepId ||
    checkpoint.stage !== expectedStage ||
    checkpoint.stats.runId !== plan.id ||
    completedStepIds.size !== checkpoint.completedStepIds.length
  ) {
    return Effect.fail(
      invalidInput(message, "Checkpoint state must align with the compiled workflow plan."),
    );
  }

  return Effect.void;
}

export const runTargetImportOperation = Effect.fn("E8.runTargetImportOperation")(function* (
  input: unknown,
) {
  const decoded = yield* decodeOrFail(
    TargetImportInputSchema,
    input,
    "Invalid target import payload.",
  );
  const targets = sortTargets(decoded.targets);

  return Schema.decodeUnknownSync(TargetImportEnvelopeSchema)({
    ok: true,
    command: "target import",
    data: {
      importedCount: targets.length,
      targets,
    },
    warnings: [],
  });
});

export const runTargetListOperation = Effect.fn("E8.runTargetListOperation")(function* (
  input: unknown,
) {
  const decoded = yield* decodeOrFail(TargetListInputSchema, input, "Invalid target list payload.");
  const filteredTargets = sortTargets(decoded.targets).filter((target) => {
    if (decoded.filters?.tenantId !== undefined && target.tenantId !== decoded.filters.tenantId) {
      return false;
    }

    if (decoded.filters?.domain !== undefined && target.domain !== decoded.filters.domain) {
      return false;
    }

    if (decoded.filters?.kind !== undefined && target.kind !== decoded.filters.kind) {
      return false;
    }

    return true;
  });

  return Schema.decodeUnknownSync(TargetListEnvelopeSchema)({
    ok: true,
    command: "target list",
    data: {
      count: filteredTargets.length,
      targets: filteredTargets,
    },
    warnings: [],
  });
});

export const runPackCreateOperation = Effect.fn("E8.runPackCreateOperation")(function* (
  input: unknown,
) {
  const decoded = yield* decodeOrFail(PackCreateInputSchema, input, "Invalid pack create payload.");

  return Schema.decodeUnknownSync(PackCreateEnvelopeSchema)({
    ok: true,
    command: "pack create",
    data: {
      definition: decoded.definition,
    },
    warnings: [],
  });
});

export const runPackInspectOperation = Effect.fn("E8.runPackInspectOperation")(function* (
  input: unknown,
) {
  const decoded = yield* decodeOrFail(
    PackInspectInputSchema,
    input,
    "Invalid pack inspect payload.",
  );

  return Schema.decodeUnknownSync(PackInspectEnvelopeSchema)({
    ok: true,
    command: "pack inspect",
    data: {
      definition: decoded.definition,
      summary: {
        selectorFieldCount: decoded.definition.selectors.length,
        targetKinds: decoded.definition.policy.targetKinds,
        ownerCount: decoded.definition.metadata.owners.length,
      },
    },
    warnings: [],
  });
});

export const runPackValidateOperation = Effect.fn("E8.runPackValidateOperation")(function* (
  input: unknown,
) {
  const decoded = yield* decodeOrFail(
    PackValidateInputSchema,
    input,
    "Invalid pack validate payload.",
  );
  const verdict = yield* evaluateValidatorLadder(decoded).pipe(
    Effect.mapError((cause) => invalidInput("Failed to validate the selected pack.", cause)),
  );

  return Schema.decodeUnknownSync(PackValidateEnvelopeSchema)({
    ok: true,
    command: "pack validate",
    data: {
      verdict,
    },
    warnings: [],
  });
});

export const runPackPromoteOperation = Effect.fn("E8.runPackPromoteOperation")(function* (
  input: unknown,
) {
  const decoded = yield* decodeOrFail(
    PackPromoteInputSchema,
    input,
    "Invalid pack promote payload.",
  );
  const result = yield* applyPackGovernanceDecision(decoded).pipe(
    Effect.mapError((cause) => invalidInput("Failed to apply the pack promotion decision.", cause)),
  );

  return Schema.decodeUnknownSync(PackPromoteEnvelopeSchema)({
    ok: true,
    command: "pack promote",
    data: {
      result,
    },
    warnings: [],
  });
});

export const runAccessPreviewOperation = Effect.fn("E8.runAccessPreviewOperation")(function* (
  input: unknown,
  fetchClient?: FetchClient,
) {
  return yield* Effect.acquireUseRelease(
    fetchClient === undefined ? createEngine() : createEngine({ fetchClient }),
    (engine) => engine.accessPreview(input),
    (engine) => engine.close,
  );
});

export const runRenderPreviewOperation = Effect.fn("E8.runRenderPreviewOperation")(function* (
  input: unknown,
  fetchClient?: FetchClient,
) {
  return yield* Effect.acquireUseRelease(
    fetchClient === undefined ? createEngine() : createEngine({ fetchClient }),
    (engine) => engine.renderPreview(input),
    (engine) => engine.close,
  );
});

export const runCrawlCompileOperation = Effect.fn("E8.runCrawlCompileOperation")(function* (
  input: unknown,
) {
  const compiled = yield* compileCrawlPlan(input).pipe(
    Effect.mapError((cause) => invalidInput("Invalid crawl compile payload.", cause)),
  );

  return Schema.decodeUnknownSync(CrawlCompileEnvelopeSchema)({
    ok: true,
    command: "crawl compile",
    data: {
      compiled,
    },
    warnings: [],
  });
});

export const runWorkflowRunOperation = Effect.fn("E8.runWorkflowRunOperation")(function* (
  input: unknown,
) {
  const decoded = yield* decodeOrFail(
    WorkflowRunInputSchema,
    input,
    "Invalid workflow run payload.",
  );
  yield* ensureWorkflowPackMatchesPlan(
    decoded.compiledPlan.plan,
    decoded.pack,
    "Invalid workflow run payload.",
  );
  const checkpoint = yield* buildWorkflowCheckpointOrFail(
    decoded.compiledPlan.plan,
    {
      sequence: 1,
      completedStepIds: [],
      storedAt: decoded.compiledPlan.plan.createdAt,
    },
    "Invalid workflow run payload.",
  );
  const inspection = yield* buildWorkflowInspectionOrFail(
    decoded.compiledPlan.plan,
    checkpoint,
    "Invalid workflow run payload.",
  );

  return Schema.decodeUnknownSync(WorkflowRunEnvelopeSchema)({
    ok: true,
    command: "workflow run",
    data: {
      checkpoint,
      inspection,
    },
    warnings: [],
  });
});

export const runWorkflowResumeOperation = Effect.fn("E8.runWorkflowResumeOperation")(function* (
  input: unknown,
) {
  const decoded = yield* decodeOrFail(
    WorkflowResumeInputSchema,
    input,
    "Invalid workflow resume payload.",
  );
  yield* ensureWorkflowPackMatchesPlan(
    decoded.compiledPlan.plan,
    decoded.pack,
    "Invalid workflow resume payload.",
  );
  yield* validateWorkflowCheckpointForPlan(
    decoded.compiledPlan.plan,
    decoded.checkpoint,
    "Invalid workflow resume payload.",
  );
  if (
    decoded.checkpoint.stats.outcome !== "running" ||
    decoded.checkpoint.nextStepId === undefined
  ) {
    yield* Effect.fail(
      invalidInput(
        "Invalid workflow resume payload.",
        "Only running checkpoints with a next step can be resumed.",
      ),
    );
  }
  const completedStepIds = decoded.checkpoint.nextStepId
    ? Array.from(new Set([...decoded.checkpoint.completedStepIds, decoded.checkpoint.nextStepId]))
    : decoded.checkpoint.completedStepIds;
  const checkpoint = yield* buildWorkflowCheckpointOrFail(
    decoded.compiledPlan.plan,
    {
      sequence: decoded.checkpoint.sequence + 1,
      completedStepIds,
      storedAt: advanceIsoTimestamp(decoded.checkpoint.storedAt),
    },
    "Invalid workflow resume payload.",
  );
  const inspection = yield* buildWorkflowInspectionOrFail(
    decoded.compiledPlan.plan,
    checkpoint,
    "Invalid workflow resume payload.",
  );

  return Schema.decodeUnknownSync(WorkflowResumeEnvelopeSchema)({
    ok: true,
    command: "workflow resume",
    data: {
      checkpoint,
      inspection,
    },
    warnings: [],
  });
});

export const runWorkflowInspectOperation = Effect.fn("E8.runWorkflowInspectOperation")(function* (
  input: unknown,
) {
  const decoded = yield* decodeOrFail(
    WorkflowInspectInputSchema,
    input,
    "Invalid workflow inspect payload.",
  );
  yield* ensureWorkflowPackMatchesPlan(
    decoded.compiledPlan.plan,
    decoded.pack,
    "Invalid workflow inspect payload.",
  );
  yield* validateWorkflowCheckpointForPlan(
    decoded.compiledPlan.plan,
    decoded.checkpoint,
    "Invalid workflow inspect payload.",
  );
  const inspection = yield* buildWorkflowInspectionOrFail(
    decoded.compiledPlan.plan,
    decoded.checkpoint,
    "Invalid workflow inspect payload.",
  );

  return Schema.decodeUnknownSync(WorkflowInspectEnvelopeSchema)({
    ok: true,
    command: "workflow inspect",
    data: {
      inspection,
    },
    warnings: [],
  });
});

export const runExtractRunOperation = Effect.fn("E8.runExtractRunOperation")(function* (
  input: unknown,
  fetchClient?: FetchClient,
) {
  return yield* Effect.acquireUseRelease(
    fetchClient === undefined ? createEngine() : createEngine({ fetchClient }),
    (engine) => engine.extractRun(input),
    (engine) => engine.close,
  );
});

export const runSnapshotDiffOperation = Effect.fn("E8.runSnapshotDiffOperation")(function* (
  input: unknown,
) {
  const decoded = yield* decodeOrFail(
    SnapshotDiffInputSchema,
    input,
    "Invalid quality diff payload.",
  );
  const diff = yield* compareSnapshots({
    id: `diff-${decoded.candidate.targetId}-${decoded.baseline.id}-${decoded.candidate.id}`,
    baseline: decoded.baseline,
    candidate: decoded.candidate,
    createdAt: decoded.createdAt,
    latencyDeltaMs: decoded.latencyDeltaMs,
    memoryDelta: decoded.memoryDelta,
  }).pipe(
    Effect.mapError((cause) => invalidInput("Failed to compare the selected snapshots.", cause)),
  );

  return Schema.decodeUnknownSync(SnapshotDiffEnvelopeSchema)({
    ok: true,
    command: "quality diff",
    data: {
      diff,
    },
    warnings: [],
  });
});

export const runQualityVerifyOperation = Effect.fn("E8.runQualityVerifyOperation")(function* (
  input: unknown,
) {
  const decoded = yield* decodeOrFail(
    QualityVerifyInputSchema,
    input,
    "Invalid quality verify payload.",
  );
  const verdict = yield* evaluateValidatorLadder(decoded).pipe(
    Effect.mapError((cause) =>
      invalidInput("Failed to evaluate the quality verification payload.", cause),
    ),
  );
  const packDecision = yield* decidePackPromotion({
    pack: decoded.pack,
    verdict: verdict.qualityVerdict,
  }).pipe(
    Effect.mapError((cause) =>
      invalidInput("Failed to derive the pack decision from the quality verdict.", cause),
    ),
  );

  return Schema.decodeUnknownSync(QualityVerifyEnvelopeSchema)({
    ok: true,
    command: "quality verify",
    data: {
      verdict: verdict.qualityVerdict,
      packDecision,
    },
    warnings: [],
  });
});

export const runQualityCompareOperation = Effect.fn("E8.runQualityCompareOperation")(function* (
  input: unknown,
) {
  const decoded = yield* decodeOrFail(
    QualityCompareInputSchema,
    input,
    "Invalid quality compare payload.",
  );
  const metrics = yield* evaluateQualityMetrics(decoded).pipe(
    Effect.mapError((cause) => invalidInput("Failed to compare quality evidence.", cause)),
  );

  return Schema.decodeUnknownSync(QualityCompareEnvelopeSchema)({
    ok: true,
    command: "quality compare",
    data: {
      metrics,
    },
    warnings: [],
  });
});

export {
  CrawlCompileEnvelopeSchema,
  PackCreateEnvelopeSchema,
  PackInspectEnvelopeSchema,
  PackPromoteEnvelopeSchema,
  PackValidateEnvelopeSchema,
  QualityCompareEnvelopeSchema,
  QualityVerifyEnvelopeSchema,
  SnapshotDiffEnvelopeSchema,
  TargetImportEnvelopeSchema,
  TargetListEnvelopeSchema,
  WorkflowInspectEnvelopeSchema,
  WorkflowResumeEnvelopeSchema,
  WorkflowRunEnvelopeSchema,
};
