import { Effect, Schema } from "effect";
import {
  AccessBudgetEvent,
  AccessBudgetSnapshot,
  BudgetExceededError,
  makeInMemoryAccessBudgetManager,
} from "./access-budget-runtime.ts";
import { ConcurrencyBudgetSchema } from "./budget-lease-artifact.ts";
import { RunPlanSchema } from "./run-state.ts";
import { CanonicalDomainSchema, CanonicalIdentifierSchema } from "./schema-primitives.ts";
import { PolicyViolation } from "./tagged-errors.ts";

export class WorkflowBudgetRegistration extends Schema.Class<WorkflowBudgetRegistration>(
  "WorkflowBudgetRegistration",
)({
  concurrencyBudgetId: CanonicalIdentifierSchema,
  accessPolicyId: CanonicalIdentifierSchema,
  concurrencyBudget: ConcurrencyBudgetSchema,
}) {}

export const WorkflowBudgetRegistrationSchema = WorkflowBudgetRegistration;

const WorkflowBudgetRegistrationsSchema = Schema.Array(WorkflowBudgetRegistration).pipe(
  Schema.refine(
    (registrations): registrations is ReadonlyArray<WorkflowBudgetRegistration> =>
      new Set(registrations.map(({ concurrencyBudgetId }) => concurrencyBudgetId)).size ===
      registrations.length,
    {
      message: "Expected workflow budget registrations with unique concurrency budget ids.",
    },
  ),
);

type WorkflowBudgetEvent = Schema.Schema.Type<typeof AccessBudgetEvent>;
type WorkflowBudget = Schema.Schema.Type<typeof ConcurrencyBudgetSchema>;
type WorkflowBudgetSnapshot = Schema.Schema.Type<typeof AccessBudgetSnapshot>;

export type WorkflowBudgetScheduler = {
  readonly events: () => Effect.Effect<ReadonlyArray<WorkflowBudgetEvent>>;
  readonly inspect: (plan: unknown) => Effect.Effect<WorkflowBudgetSnapshot, PolicyViolation>;
  readonly withPermit: <A, E, R>(
    plan: unknown,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | BudgetExceededError | PolicyViolation, R>;
};

function decodeRunPlan(input: unknown) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(RunPlanSchema)(input),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode workflow budget plan through shared contracts.",
      }),
  });
}

function decodeRegistrations(input: unknown) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(WorkflowBudgetRegistrationsSchema)(input),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode workflow budget registrations through shared contracts.",
      }),
  });
}

function derivePlanDomain(plan: Schema.Schema.Type<typeof RunPlanSchema>) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(CanonicalDomainSchema)(new URL(plan.entryUrl).hostname),
    catch: () =>
      new PolicyViolation({
        message: `Workflow budget scheduling requires a canonical domain host for ${plan.entryUrl}.`,
      }),
  });
}

function toSharedWorkflowBudget(
  plan: Schema.Schema.Type<typeof RunPlanSchema>,
  budget: WorkflowBudget,
) {
  return Schema.decodeUnknownSync(ConcurrencyBudgetSchema)({
    id: `workflow-budget-${plan.accessPolicyId}-${budget.globalConcurrency}-${budget.maxPerDomain}`,
    ownerId: plan.accessPolicyId,
    globalConcurrency: budget.globalConcurrency,
    maxPerDomain: budget.maxPerDomain,
  });
}

export function createWorkflowBudgetRegistrations(
  compiledPlans: ReadonlyArray<{
    readonly concurrencyBudget: WorkflowBudget;
    readonly plan: Schema.Schema.Type<typeof RunPlanSchema>;
  }>,
) {
  return Schema.decodeUnknownSync(WorkflowBudgetRegistrationsSchema)(
    compiledPlans.map(({ concurrencyBudget, plan }) => ({
      concurrencyBudgetId: plan.concurrencyBudgetId,
      accessPolicyId: plan.accessPolicyId,
      concurrencyBudget,
    })),
  );
}

export function makeInMemoryWorkflowBudgetScheduler(
  registrationsInput: unknown,
  now: () => Date = () => new Date(),
) {
  return Effect.gen(function* () {
    const registrations = yield* decodeRegistrations(registrationsInput);
    const registrationsByBudgetId = new Map(
      registrations.map(
        (registration) => [registration.concurrencyBudgetId, registration] as const,
      ),
    );
    const accessBudgetManager = yield* makeInMemoryAccessBudgetManager(now);

    const resolveSharedBudget = Effect.fn("WorkflowBudgetScheduler.resolveSharedBudget")(function* (
      planInput: unknown,
    ) {
      const plan = yield* decodeRunPlan(planInput);
      const registration = registrationsByBudgetId.get(plan.concurrencyBudgetId);

      if (registration === undefined) {
        return yield* Effect.fail(
          new PolicyViolation({
            message: `Workflow budget scheduler could not resolve concurrency budget ${plan.concurrencyBudgetId} for run plan ${plan.id}.`,
          }),
        );
      }

      if (registration.accessPolicyId !== plan.accessPolicyId) {
        return yield* Effect.fail(
          new PolicyViolation({
            message:
              "Workflow budget registration must preserve the access policy identity from the run plan.",
          }),
        );
      }

      return toSharedWorkflowBudget(plan, registration.concurrencyBudget);
    });

    const withPermit = Effect.fn("WorkflowBudgetScheduler.withPermit")(function* <A, E, R>(
      planInput: unknown,
      effect: Effect.Effect<A, E, R>,
    ) {
      const plan = yield* decodeRunPlan(planInput);
      const budget = yield* resolveSharedBudget(plan);
      const domain = yield* derivePlanDomain(plan);
      return yield* accessBudgetManager.withPermit(budget, domain, effect);
    });

    const inspect = Effect.fn("WorkflowBudgetScheduler.inspect")(function* (planInput: unknown) {
      const budget = yield* resolveSharedBudget(planInput);
      return yield* accessBudgetManager.inspect(budget);
    });

    const events = Effect.fn("WorkflowBudgetScheduler.events")(function* () {
      return yield* accessBudgetManager.events();
    });

    return {
      events,
      inspect,
      withPermit,
    } satisfies WorkflowBudgetScheduler;
  });
}
