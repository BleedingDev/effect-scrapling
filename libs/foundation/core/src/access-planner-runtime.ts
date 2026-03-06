import { Effect, Layer, Schema } from "effect";
import { AccessPolicySchema } from "./access-policy.ts";
import { ConcurrencyBudgetSchema } from "./budget-lease-artifact.ts";
import { RunPlanSchema } from "./run-state.ts";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import { AccessPlanner } from "./service-topology.ts";
import { SitePackSchema } from "./site-pack.ts";
import { CoreErrorCodeSchema, PolicyViolation } from "./tagged-errors.ts";
import { TargetProfileSchema } from "./target-profile.ts";

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

const FailureCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(32),
);

class PlannerFailureContext extends Schema.Class<PlannerFailureContext>("PlannerFailureContext")({
  recentFailureCount: FailureCountSchema,
  lastFailureCode: Schema.optional(CoreErrorCodeSchema),
}) {}

export const AccessPlannerInputSchema = Schema.Struct({
  target: TargetProfileSchema,
  pack: SitePackSchema,
  accessPolicy: AccessPolicySchema,
  createdAt: IsoDateTimeSchema,
  failureContext: Schema.optional(PlannerFailureContext),
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

const highFrictionTargetKinds: ReadonlySet<string> = new Set([
  "productListing",
  "searchResult",
  "socialPost",
] as const);
const accessFailureEscalationCodes: ReadonlySet<string> = new Set([
  "timeout",
  "provider_unavailable",
  "render_crash",
] as const);

type PlannerInput = Schema.Schema.Type<typeof AccessPlannerInputSchema>;
type CaptureProvider = "http" | "browser";

type ProviderSelection = {
  readonly provider: CaptureProvider;
  readonly evidence: string;
};

function isHighFrictionTarget(target: PlannerInput["target"]) {
  return highFrictionTargetKinds.has(target.kind);
}

function describeFailureEscalation(input: PlannerInput) {
  const failureContext = input.failureContext;
  if (failureContext === undefined || failureContext.recentFailureCount === 0) {
    return;
  }

  if (
    failureContext.recentFailureCount >= 2 ||
    (failureContext.lastFailureCode !== undefined &&
      accessFailureEscalationCodes.has(failureContext.lastFailureCode))
  ) {
    const failureCode =
      failureContext.lastFailureCode === undefined
        ? "unspecified-access-failure"
        : failureContext.lastFailureCode;

    return `${failureContext.recentFailureCount} recent access failure(s), latest ${failureCode}`;
  }
}

function selectCaptureProvider(input: PlannerInput): ProviderSelection {
  switch (input.accessPolicy.mode) {
    case "http": {
      return {
        provider: "http",
        evidence: 'HTTP mode with `render: "never"` keeps capture on the plain HTTP provider.',
      };
    }
    case "browser": {
      return {
        provider: "browser",
        evidence: "Browser mode requires browser-backed capture.",
      };
    }
    case "managed": {
      return {
        provider: "browser",
        evidence: "Managed mode delegates capture to a browser-capable provider.",
      };
    }
    case "hybrid": {
      if (input.accessPolicy.render === "always") {
        return {
          provider: "browser",
          evidence: 'Hybrid mode with `render: "always"` requires browser-backed capture.',
        };
      }

      const failureEscalation = describeFailureEscalation(input);
      const highFrictionTarget = isHighFrictionTarget(input.target);
      if (failureEscalation !== undefined && highFrictionTarget) {
        return {
          provider: "browser",
          evidence: `Hybrid mode escalated to browser for high-friction ${input.target.kind} targets after ${failureEscalation}.`,
        };
      }

      if (failureEscalation !== undefined) {
        return {
          provider: "browser",
          evidence: `Hybrid mode escalated to browser after ${failureEscalation}.`,
        };
      }

      if (highFrictionTarget) {
        return {
          provider: "browser",
          evidence: `Hybrid mode escalated to browser for high-friction ${input.target.kind} targets.`,
        };
      }

      return {
        provider: "http",
        evidence: `Hybrid mode kept the HTTP-first path for ${input.target.kind} targets without browser escalation signals.`,
      };
    }
  }
}

function buildPlanRationale(input: PlannerInput, providerSelection: ProviderSelection) {
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
      message: `Capture step selected ${providerSelection.provider} provider. ${providerSelection.evidence}`,
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

    const providerSelection = selectCaptureProvider(decoded);
    const requiresBrowser = providerSelection.provider === "browser";
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
      timeoutMs: decoded.accessPolicy.timeoutMs,
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
      rationale: buildPlanRationale(decoded, providerSelection),
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
