import { Effect, Layer, Schema, ServiceMap } from "effect";
import {
  AccessPlannerDecisionSchema,
  PlannerRationaleEntry,
  PlannerRationaleEntrySchema,
  planAccessExecution,
} from "./access-planner-runtime.ts";
import { AccessPolicySchema } from "./access-policy.ts";
import { ConcurrencyBudgetSchema } from "./budget-lease-artifact.ts";
import {
  RunExecutionConfigOverrideSchema,
  RunExecutionConfigSchema,
  resolveRunExecutionConfig,
} from "./config-storage.ts";
import { RunCheckpointSchema, RunPlanSchema } from "./run-state.ts";
import {
  CanonicalIdentifierSchema,
  IsoDateTimeSchema,
  type IsoDateTime,
} from "./schema-primitives.ts";
import { SitePackSchema } from "./site-pack.ts";
import { PolicyViolation } from "./tagged-errors.ts";
import { TargetProfileSchema } from "./target-profile.ts";

const RunStepSchema = Schema.Struct({
  id: CanonicalIdentifierSchema,
  stage: Schema.Literals(["capture", "extract", "snapshot", "diff", "quality", "reflect"] as const),
  requiresBrowser: Schema.Boolean,
  artifactKind: Schema.optional(
    Schema.Literals([
      "requestMetadata",
      "responseMetadata",
      "html",
      "renderedDom",
      "screenshot",
      "networkSummary",
      "timings",
    ] as const),
  ),
});

class CrawlPlanCompilerEntry extends Schema.Class<CrawlPlanCompilerEntry>("CrawlPlanCompilerEntry")(
  {
    target: TargetProfileSchema,
    pack: SitePackSchema,
    accessPolicy: AccessPolicySchema,
    runConfig: Schema.optional(RunExecutionConfigOverrideSchema),
  },
) {}

const CrawlPlanCompilerEntriesSchema = Schema.Array(CrawlPlanCompilerEntry).pipe(
  Schema.refine(
    (entries): entries is ReadonlyArray<CrawlPlanCompilerEntry> =>
      entries.length > 0 && new Set(entries.map(({ target }) => target.id)).size === entries.length,
    {
      message: "Expected at least one crawl-plan entry and unique target ids.",
    },
  ),
);

export const CrawlPlanCompilerInputSchema = Schema.Struct({
  createdAt: IsoDateTimeSchema,
  defaults: Schema.optional(RunExecutionConfigOverrideSchema),
  entries: CrawlPlanCompilerEntriesSchema,
});

export class CompiledCrawlPlan extends Schema.Class<CompiledCrawlPlan>("CompiledCrawlPlan")({
  resolvedConfig: RunExecutionConfigSchema,
  concurrencyBudget: ConcurrencyBudgetSchema,
  rationale: Schema.Array(PlannerRationaleEntrySchema).pipe(
    Schema.refine(
      (entries): entries is ReadonlyArray<PlannerRationaleEntry> =>
        entries.length > 0 && new Set(entries.map(({ key }) => key)).size === entries.length,
      {
        message: "Expected crawl-plan rationale with at least one entry and unique rationale keys.",
      },
    ),
  ),
  plan: RunPlanSchema,
  checkpoint: RunCheckpointSchema,
}) {}

export const CompiledCrawlPlansSchema = Schema.Array(CompiledCrawlPlan).pipe(
  Schema.refine(
    (plans): plans is ReadonlyArray<CompiledCrawlPlan> =>
      plans.length > 0 && new Set(plans.map(({ plan }) => plan.targetId)).size === plans.length,
    {
      message: "Expected compiled crawl plans with unique target ids.",
    },
  ),
);

export const CrawlPlanCompilationRequestSchema = CrawlPlanCompilerInputSchema;
export const CrawlPlanSchema = CompiledCrawlPlansSchema;

function compareEntries(left: CrawlPlanCompilerEntry, right: CrawlPlanCompilerEntry) {
  return (
    right.target.priority - left.target.priority ||
    left.target.domain.localeCompare(right.target.domain) ||
    left.target.canonicalKey.localeCompare(right.target.canonicalKey) ||
    left.target.id.localeCompare(right.target.id)
  );
}

function matchesDomainPattern(pattern: string, domain: string) {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return domain === suffix || domain.endsWith(`.${suffix}`);
  }

  return domain === pattern;
}

function matchesTargetDomain(targetDomain: string, candidateDomain: string) {
  return candidateDomain === targetDomain || candidateDomain.endsWith(`.${targetDomain}`);
}

function buildRunExecutionDefaults(entry: CrawlPlanCompilerEntry) {
  const entryUrl = entry.target.seedUrls[0];
  if (entryUrl === undefined) {
    throw new PolicyViolation({
      message: `Target ${entry.target.id} must provide at least one seed URL for crawl planning.`,
    });
  }

  return {
    targetId: entry.target.id,
    targetDomain: entry.target.domain,
    packId: entry.pack.id,
    accessPolicyId: entry.accessPolicy.id,
    entryUrl,
    mode: entry.accessPolicy.mode,
    render: entry.accessPolicy.render,
    perDomainConcurrency: entry.accessPolicy.perDomainConcurrency,
    globalConcurrency: entry.accessPolicy.globalConcurrency,
    timeoutMs: entry.accessPolicy.timeoutMs,
    maxRetries: entry.accessPolicy.maxRetries,
    checkpointInterval: 1,
    artifactNamespace: `artifacts/${entry.target.domain}`,
    checkpointNamespace: `checkpoints/${entry.target.domain}`,
  };
}

function resolveEntryConfig(
  defaultsOverride: Schema.Schema.Type<typeof RunExecutionConfigOverrideSchema> | undefined,
  entry: CrawlPlanCompilerEntry,
) {
  const resolved = resolveRunExecutionConfig({
    defaults: {
      ...buildRunExecutionDefaults(entry),
      ...defaultsOverride,
    },
    run: entry.runConfig,
  });

  if (
    resolved.targetId !== entry.target.id ||
    resolved.targetDomain !== entry.target.domain ||
    resolved.packId !== entry.pack.id ||
    resolved.accessPolicyId !== entry.accessPolicy.id
  ) {
    throw new PolicyViolation({
      message:
        "Resolved crawl-plan execution config must preserve targetId, targetDomain, packId, and accessPolicyId from the entry contract.",
    });
  }

  const entryUrlHost = new URL(resolved.entryUrl).hostname;
  if (
    !matchesTargetDomain(entry.target.domain, entryUrlHost) ||
    !matchesDomainPattern(entry.pack.domainPattern, entryUrlHost)
  ) {
    throw new PolicyViolation({
      message: `Configured entry URL host ${entryUrlHost} must remain inside target domain ${entry.target.domain} and pack domain pattern ${entry.pack.domainPattern}.`,
    });
  }

  let effectiveAccessPolicy: Schema.Schema.Type<typeof AccessPolicySchema>;
  try {
    effectiveAccessPolicy = Schema.decodeUnknownSync(AccessPolicySchema)({
      id: entry.accessPolicy.id,
      mode: resolved.mode,
      render: resolved.render,
      perDomainConcurrency: resolved.perDomainConcurrency,
      globalConcurrency: resolved.globalConcurrency,
      timeoutMs: resolved.timeoutMs,
      maxRetries: resolved.maxRetries,
    });
  } catch {
    throw new PolicyViolation({
      message:
        "Resolved crawl-plan execution config must satisfy the access policy contract before planning.",
    });
  }

  return { effectiveAccessPolicy, resolved };
}

function withWorkflowStages(
  planDecision: Schema.Schema.Type<typeof AccessPlannerDecisionSchema>,
  resolvedConfig: Schema.Schema.Type<typeof RunExecutionConfigSchema>,
) {
  const existingSteps = Schema.encodeSync(RunPlanSchema)(planDecision.plan).steps;
  const stages = new Set(existingSteps.map(({ stage }) => stage));
  const nextSteps = [...existingSteps];

  if (!stages.has("diff")) {
    nextSteps.push(
      Schema.decodeUnknownSync(RunStepSchema)({
        id: "step-diff",
        stage: "diff",
        requiresBrowser: false,
      }),
    );
  }

  if (!stages.has("quality")) {
    nextSteps.push(
      Schema.decodeUnknownSync(RunStepSchema)({
        id: "step-quality",
        stage: "quality",
        requiresBrowser: false,
      }),
    );
  }

  if (!stages.has("reflect")) {
    nextSteps.push(
      Schema.decodeUnknownSync(RunStepSchema)({
        id: "step-reflect",
        stage: "reflect",
        requiresBrowser: false,
      }),
    );
  }

  return Schema.decodeUnknownSync(RunPlanSchema)({
    ...Schema.encodeSync(RunPlanSchema)(planDecision.plan),
    entryUrl: resolvedConfig.entryUrl,
    timeoutMs: resolvedConfig.timeoutMs,
    checkpointInterval: resolvedConfig.checkpointInterval,
    maxAttempts: resolvedConfig.maxRetries + 1,
    steps: nextSteps,
  });
}

function buildInitialCheckpoint(
  plan: Schema.Schema.Type<typeof RunPlanSchema>,
  createdAt: IsoDateTime,
) {
  return Schema.decodeUnknownSync(RunCheckpointSchema)({
    id: `checkpoint-${plan.id}-0001`,
    runId: plan.id,
    planId: plan.id,
    sequence: 1,
    stage: "capture",
    nextStepId: plan.steps[0]?.id,
    completedStepIds: [],
    pendingStepIds: plan.steps.map(({ id }) => id),
    artifactIds: [],
    stats: {
      runId: plan.id,
      plannedSteps: plan.steps.length,
      completedSteps: 0,
      checkpointCount: 1,
      artifactCount: 0,
      outcome: "running",
      startedAt: createdAt,
      updatedAt: createdAt,
    },
    storedAt: createdAt,
  });
}

function compileEntry(
  defaultsOverride: Schema.Schema.Type<typeof RunExecutionConfigOverrideSchema> | undefined,
  entry: CrawlPlanCompilerEntry,
  createdAt: IsoDateTime,
) {
  return Effect.gen(function* () {
    const { effectiveAccessPolicy, resolved } = yield* Effect.try({
      try: () => resolveEntryConfig(defaultsOverride, entry),
      catch: (cause) => {
        const message =
          typeof cause === "object" &&
          cause !== null &&
          "message" in cause &&
          typeof cause.message === "string"
            ? cause.message
            : "Failed to resolve crawl-plan execution config through shared contracts.";

        return new PolicyViolation({ message });
      },
    });

    const decision = yield* planAccessExecution({
      target: entry.target,
      pack: entry.pack,
      accessPolicy: effectiveAccessPolicy,
      createdAt,
    });
    const plan = withWorkflowStages(decision, resolved);

    return Schema.decodeUnknownSync(CompiledCrawlPlan)({
      resolvedConfig: resolved,
      concurrencyBudget: decision.concurrencyBudget,
      rationale: [
        ...decision.rationale,
        Schema.decodeUnknownSync(PlannerRationaleEntrySchema)({
          key: "workflow-graph",
          message:
            "Expanded crawl plan with diff, quality, and reflect stages for durable workflow fan-out/fan-in execution.",
        }),
      ],
      plan,
      checkpoint: buildInitialCheckpoint(plan, createdAt),
    });
  });
}

export function compileCrawlPlans(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(CrawlPlanCompilerInputSchema)(input),
      catch: () =>
        new PolicyViolation({
          message: "Failed to decode crawl-plan compiler input through shared contracts.",
        }),
    });

    const sortedEntries = [...decoded.entries].sort(compareEntries);
    return yield* Effect.forEach(sortedEntries, (entry) =>
      compileEntry(decoded.defaults, entry, decoded.createdAt),
    );
  });
}

export function compileCrawlPlan(input: unknown) {
  return compileCrawlPlans(input).pipe(
    Effect.flatMap((plans) => {
      const firstPlan = plans[0];
      return firstPlan === undefined
        ? Effect.fail(
            new PolicyViolation({
              message: "Expected at least one compiled crawl plan.",
            }),
          )
        : Effect.succeed(firstPlan);
    }),
  );
}

export class CrawlPlanCompiler extends ServiceMap.Service<
  CrawlPlanCompiler,
  {
    readonly compile: (
      input: Schema.Schema.Type<typeof CrawlPlanCompilerInputSchema>,
    ) => Effect.Effect<Schema.Schema.Type<typeof CompiledCrawlPlansSchema>, PolicyViolation>;
  }
>()("@effect-scrapling/foundation/CrawlPlanCompiler") {}

export function makeCrawlPlanCompiler() {
  const compile = Effect.fn("CrawlPlanCompilerLive.compile")(function* (
    input: Schema.Schema.Type<typeof CrawlPlanCompilerInputSchema>,
  ) {
    return yield* compileCrawlPlans(input);
  });

  return CrawlPlanCompiler.of({ compile });
}

export function CrawlPlanCompilerLive() {
  return Layer.succeed(CrawlPlanCompiler)(makeCrawlPlanCompiler());
}

export type CrawlPlanCompilerInput = Schema.Schema.Type<typeof CrawlPlanCompilerInputSchema>;
export type CompiledCrawlPlanEncoded = Schema.Codec.Encoded<typeof CompiledCrawlPlan>;
