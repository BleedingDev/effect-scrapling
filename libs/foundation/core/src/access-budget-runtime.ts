import { Data, Effect, Ref, Schema, TxSemaphore } from "effect";
import { ConcurrencyBudgetSchema } from "./budget-lease-artifact.ts";
import {
  CanonicalDomainSchema,
  CanonicalIdentifierSchema,
  IsoDateTimeSchema,
} from "./schema-primitives.ts";
import { PolicyViolation } from "./tagged-errors.ts";

const UtilizationCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const BudgetEventKindSchema = Schema.Literals(["acquired", "released", "rejected"] as const);

export class DomainBudgetUtilization extends Schema.Class<DomainBudgetUtilization>(
  "DomainBudgetUtilization",
)({
  domain: CanonicalDomainSchema,
  capacity: Schema.Int,
  available: UtilizationCountSchema,
  inUse: UtilizationCountSchema,
}) {}

const DomainBudgetUtilizationsSchema = Schema.Array(DomainBudgetUtilization).pipe(
  Schema.refine(
    (entries): entries is ReadonlyArray<DomainBudgetUtilization> =>
      new Set(entries.map(({ domain }) => domain)).size === entries.length,
    { message: "Expected unique domain utilization rows in access-budget snapshot." },
  ),
);

export class AccessBudgetSnapshot extends Schema.Class<AccessBudgetSnapshot>(
  "AccessBudgetSnapshot",
)({
  budget: ConcurrencyBudgetSchema,
  globalCapacity: Schema.Int,
  globalAvailable: UtilizationCountSchema,
  globalInUse: UtilizationCountSchema,
  domains: DomainBudgetUtilizationsSchema,
}) {}

export class AccessBudgetEvent extends Schema.Class<AccessBudgetEvent>("AccessBudgetEvent")({
  kind: BudgetEventKindSchema,
  budgetId: CanonicalIdentifierSchema,
  domain: CanonicalDomainSchema,
  recordedAt: IsoDateTimeSchema,
  snapshot: AccessBudgetSnapshot,
}) {}

export class BudgetExceededError extends Data.TaggedError("BudgetExceededError")<{
  readonly budgetId: string;
  readonly domain: string;
  readonly message: string;
}> {}

type Budget = Schema.Schema.Type<typeof ConcurrencyBudgetSchema>;
type BudgetState = {
  readonly budget: Budget;
  readonly globalSemaphore: TxSemaphore.TxSemaphore;
  readonly domainSemaphores: Ref.Ref<Map<string, TxSemaphore.TxSemaphore>>;
};

const decodeBudgetSync = Schema.decodeUnknownSync(ConcurrencyBudgetSchema);
const decodeDomainSync = Schema.decodeUnknownSync(CanonicalDomainSchema);

function decodeBudget(input: unknown) {
  return Effect.try({
    try: () => decodeBudgetSync(input),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode access-budget input through shared contracts.",
      }),
  });
}

function decodeDomain(input: unknown) {
  return Effect.try({
    try: () => decodeDomainSync(input),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode access-budget domain through shared contracts.",
      }),
  });
}

function makeBudgetState(budget: Budget) {
  return Effect.transaction(
    Effect.gen(function* () {
      const globalSemaphore = yield* TxSemaphore.make(budget.globalConcurrency);
      return {
        budget,
        globalSemaphore,
        domainSemaphores: yield* Ref.make(new Map<string, TxSemaphore.TxSemaphore>()),
      } satisfies BudgetState;
    }),
  );
}

export function makeInMemoryAccessBudgetManager(now: () => Date = () => new Date()) {
  return Effect.gen(function* () {
    const statesRef = yield* Ref.make(new Map<string, BudgetState>());
    const eventsRef = yield* Ref.make(new Array<Schema.Schema.Type<typeof AccessBudgetEvent>>());

    const ensureBudgetState = Effect.fn("InMemoryAccessBudgetManager.ensureBudgetState")(function* (
      budget: Budget,
    ) {
      const existing = (yield* Ref.get(statesRef)).get(budget.id);
      if (existing !== undefined) {
        return existing;
      }

      const created = yield* makeBudgetState(budget);
      return yield* Ref.modify(statesRef, (current) => {
        const present = current.get(budget.id);
        if (present !== undefined) {
          return [present, current] as const;
        }

        const next = new Map(current);
        next.set(budget.id, created);
        return [created, next] as const;
      });
    });

    const ensureDomainSemaphore = Effect.fn("InMemoryAccessBudgetManager.ensureDomainSemaphore")(
      function* (state: BudgetState, domain: string) {
        const existing = (yield* Ref.get(state.domainSemaphores)).get(domain);
        if (existing !== undefined) {
          return existing;
        }

        const created = yield* Effect.transaction(TxSemaphore.make(state.budget.maxPerDomain));
        return yield* Ref.modify(state.domainSemaphores, (current) => {
          const present = current.get(domain);
          if (present !== undefined) {
            return [present, current] as const;
          }

          const next = new Map(current);
          next.set(domain, created);
          return [created, next] as const;
        });
      },
    );

    const inspectState = Effect.fn("InMemoryAccessBudgetManager.inspectState")(function* (
      state: BudgetState,
    ) {
      const globalAvailable = yield* Effect.transaction(
        TxSemaphore.available(state.globalSemaphore),
      );
      const domainSemaphores = yield* Ref.get(state.domainSemaphores);
      const domains = yield* Effect.forEach(
        [...domainSemaphores.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
        ([domain, semaphore]) =>
          Effect.transaction(TxSemaphore.available(semaphore)).pipe(
            Effect.map((available) =>
              Schema.decodeUnknownSync(DomainBudgetUtilization)({
                domain,
                capacity: state.budget.maxPerDomain,
                available,
                inUse: state.budget.maxPerDomain - available,
              }),
            ),
          ),
      );

      return Schema.decodeUnknownSync(AccessBudgetSnapshot)({
        budget: state.budget,
        globalCapacity: state.budget.globalConcurrency,
        globalAvailable,
        globalInUse: state.budget.globalConcurrency - globalAvailable,
        domains,
      });
    });

    const recordEvent = Effect.fn("InMemoryAccessBudgetManager.recordEvent")(function* (
      kind: Schema.Schema.Type<typeof BudgetEventKindSchema>,
      state: BudgetState,
      domain: string,
    ) {
      const snapshot = yield* inspectState(state);
      yield* Ref.update(eventsRef, (current) =>
        current.concat(
          Schema.decodeUnknownSync(AccessBudgetEvent)({
            kind,
            budgetId: state.budget.id,
            domain,
            recordedAt: now().toISOString(),
            snapshot,
          }),
        ),
      );
    });

    const withPermit = Effect.fn("InMemoryAccessBudgetManager.withPermit")(function* <A, E, R>(
      budgetInput: unknown,
      domainInput: unknown,
      effect: Effect.Effect<A, E, R>,
    ) {
      const budget = yield* decodeBudget(budgetInput);
      const domain = yield* decodeDomain(domainInput);
      const state = yield* ensureBudgetState(budget);

      const acquire = Effect.gen(function* () {
        const globalAcquired = yield* Effect.transaction(
          TxSemaphore.tryAcquire(state.globalSemaphore),
        );
        if (!globalAcquired) {
          yield* recordEvent("rejected", state, domain);
          return yield* Effect.fail(
            new BudgetExceededError({
              budgetId: state.budget.id,
              domain,
              message: `Concurrency budget ${state.budget.id} denied access for ${domain}.`,
            }),
          );
        }

        const domainSemaphore = yield* ensureDomainSemaphore(state, domain);
        const domainAcquired = yield* Effect.transaction(TxSemaphore.tryAcquire(domainSemaphore));
        if (!domainAcquired) {
          yield* Effect.transaction(TxSemaphore.release(state.globalSemaphore));
          yield* recordEvent("rejected", state, domain);
          return yield* Effect.fail(
            new BudgetExceededError({
              budgetId: state.budget.id,
              domain,
              message: `Concurrency budget ${state.budget.id} denied access for ${domain}.`,
            }),
          );
        }

        yield* recordEvent("acquired", state, domain);
        return domainSemaphore;
      });

      const release = (domainSemaphore: TxSemaphore.TxSemaphore) =>
        Effect.gen(function* () {
          yield* Effect.transaction(
            Effect.gen(function* () {
              yield* TxSemaphore.release(domainSemaphore);
              yield* TxSemaphore.release(state.globalSemaphore);
            }),
          );
          yield* recordEvent("released", state, domain);
        });

      return yield* Effect.acquireUseRelease(acquire, () => effect, release);
    });

    const inspect = Effect.fn("InMemoryAccessBudgetManager.inspect")(function* (
      budgetInput: unknown,
    ) {
      const budget = yield* decodeBudget(budgetInput);
      const state = yield* ensureBudgetState(budget);
      return yield* inspectState(state);
    });

    const events = Effect.fn("InMemoryAccessBudgetManager.events")(function* () {
      return yield* Ref.get(eventsRef);
    });

    return {
      withPermit,
      inspect,
      events,
    };
  });
}
