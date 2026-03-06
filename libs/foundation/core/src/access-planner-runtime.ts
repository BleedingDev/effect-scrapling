import { Effect, Layer, Schema } from "effect";
import { AccessPolicySchema } from "./access-policy.js";
import { ConcurrencyBudgetSchema } from "./budget-lease-artifact.js";
import { RunPlanSchema } from "./run-state.js";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.js";
import { AccessPlanner } from "./service-topology.js";
import { SitePackSchema } from "./site-pack.js";
import { PolicyViolation } from "./tagged-errors.js";
import { TargetProfileSchema } from "./target-profile.js";

export class PlannerRationaleEntry extends Schema.Class<PlannerRationaleEntry>(
  "PlannerRationaleEntry",
)({
  key: CanonicalIdentifierSchema,
  message: Schema.Trim.check(Schema.isNonEmpty()),
}) {}

const PlannerRationaleSchema = Schema.Array(PlannerRationaleEntry).pipe(
  Schema.refine(
    (entries): entries is ReadonlyArray<PlannerRationaleEntry> =>
      entries.length > 0 && new Set(entries.map(({ key }) => key)).size === entries.length,
    {
      message: "Expected planner rationale with at least one entry and unique rationale keys.",
    },
  ),
);

export class AccessPlannerDecision extends Schema.Class<AccessPlannerDecision>(
  "AccessPlannerDecision",
)({
  plan: RunPlanSchema,
  concurrencyBudget: ConcurrencyBudgetSchema,
  rationale: PlannerRationaleSchema,
}) {}

export const AccessPlannerInputSchema = Schema.Struct({
  target: TargetProfileSchema,
  pack: SitePackSchema,
  accessPolicy: AccessPolicySchema,
  createdAt: IsoDateTimeSchema,
});

export const PlannerRationaleEntrySchema = PlannerRationaleEntry;
export const AccessPlannerDecisionSchema = AccessPlannerDecision;

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

function buildPlanRationale(input: Schema.Schema.Type<typeof AccessPlannerInputSchema>) {
  const requiresBrowser =
    input.accessPolicy.mode !== "http" || input.accessPolicy.render !== "never";

  return [
    Schema.decodeUnknownSync(PlannerRationaleEntrySchema)({
      key: "mode",
      message: `Access mode resolved to ${input.accessPolicy.mode}.`,
    }),
    Schema.decodeUnknownSync(PlannerRationaleEntrySchema)({
      key: "rendering",
      message: `Rendering policy resolved to ${input.accessPolicy.render}.`,
    }),
    Schema.decodeUnknownSync(PlannerRationaleEntrySchema)({
      key: "budget",
      message: `Concurrency budget resolved to ${input.accessPolicy.perDomainConcurrency}/${input.accessPolicy.globalConcurrency}.`,
    }),
    Schema.decodeUnknownSync(PlannerRationaleEntrySchema)({
      key: "capture-path",
      message: requiresBrowser
        ? "Capture step requires browser-backed execution."
        : "Capture step can execute over plain HTTP.",
    }),
  ];
}

export function planAccessExecution(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(AccessPlannerInputSchema)(input),
      catch: () =>
        new PolicyViolation({
          message: "Failed to decode access-planner input through shared contracts.",
        }),
    });

    if (decoded.target.packId !== decoded.pack.id) {
      return yield* Effect.fail(
        new PolicyViolation({
          message: "Target profile packId must resolve to the same site pack.",
        }),
      );
    }

    if (
      decoded.target.accessPolicyId !== decoded.accessPolicy.id ||
      decoded.pack.accessPolicyId !== decoded.accessPolicy.id
    ) {
      return yield* Effect.fail(
        new PolicyViolation({
          message: "Target profile, site pack, and access policy must agree on accessPolicyId.",
        }),
      );
    }

    if (!matchesDomainPattern(decoded.pack.domainPattern, decoded.target.domain)) {
      return yield* Effect.fail(
        new PolicyViolation({
          message: `Target domain ${decoded.target.domain} does not match pack domain pattern ${decoded.pack.domainPattern}.`,
        }),
      );
    }

    const entryUrl = decoded.target.seedUrls[0];
    if (entryUrl === undefined) {
      return yield* Effect.fail(
        new PolicyViolation({
          message: "Target profile must provide at least one seed URL for planning.",
        }),
      );
    }

    const entryUrlHost = new URL(entryUrl).hostname;
    if (
      !matchesTargetDomain(decoded.target.domain, entryUrlHost) ||
      !matchesDomainPattern(decoded.pack.domainPattern, entryUrlHost)
    ) {
      return yield* Effect.fail(
        new PolicyViolation({
          message: `Target entry URL host ${entryUrlHost} must stay within target domain ${decoded.target.domain} and pack domain pattern ${decoded.pack.domainPattern}.`,
        }),
      );
    }

    const requiresBrowser =
      decoded.accessPolicy.mode !== "http" || decoded.accessPolicy.render !== "never";
    const concurrencyBudget = Schema.decodeUnknownSync(ConcurrencyBudgetSchema)({
      id: `budget-${decoded.target.id}`,
      ownerId: decoded.target.id,
      globalConcurrency: decoded.accessPolicy.globalConcurrency,
      maxPerDomain: decoded.accessPolicy.perDomainConcurrency,
    });
    const plan = Schema.decodeUnknownSync(RunPlanSchema)({
      id: `plan-${decoded.target.id}-${decoded.pack.id}`,
      targetId: decoded.target.id,
      packId: decoded.pack.id,
      accessPolicyId: decoded.accessPolicy.id,
      concurrencyBudgetId: concurrencyBudget.id,
      entryUrl,
      maxAttempts: decoded.accessPolicy.maxRetries + 1,
      checkpointInterval: 1,
      steps: [
        {
          id: "step-capture",
          stage: "capture",
          requiresBrowser,
          artifactKind: requiresBrowser ? "renderedDom" : "html",
        },
        {
          id: "step-extract",
          stage: "extract",
          requiresBrowser: false,
        },
        {
          id: "step-snapshot",
          stage: "snapshot",
          requiresBrowser: false,
        },
      ],
      createdAt: decoded.createdAt,
    });

    return Schema.decodeUnknownSync(AccessPlannerDecisionSchema)({
      plan,
      concurrencyBudget,
      rationale: buildPlanRationale(decoded),
    });
  });
}

export function makeAccessPlanner(now: () => Date = () => new Date()) {
  const plan = Effect.fn("AccessPlannerLive.plan")(function* (
    target: Schema.Schema.Type<typeof TargetProfileSchema>,
    pack: Schema.Schema.Type<typeof SitePackSchema>,
    accessPolicy: Schema.Schema.Type<typeof AccessPolicySchema>,
  ) {
    const decision = yield* planAccessExecution({
      target,
      pack,
      accessPolicy,
      createdAt: now().toISOString(),
    });

    return decision.plan;
  });

  return AccessPlanner.of({ plan });
}

export function AccessPlannerLive(now: () => Date = () => new Date()) {
  return Layer.succeed(AccessPlanner)(makeAccessPlanner(now));
}
