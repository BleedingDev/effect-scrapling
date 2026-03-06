import { Effect, Layer, Option, Schema } from "effect";
import {
  AccessHealthEvent,
  AccessHealthPolicy,
  AccessHealthSnapshot,
  makeInMemoryAccessHealthRuntime,
} from "../libs/foundation/core/src/access-health-runtime.ts";
import {
  AccessBudgetEvent,
  AccessBudgetSnapshot,
  makeInMemoryAccessBudgetManager,
} from "../libs/foundation/core/src/access-budget-runtime.ts";
import { AccessPolicySchema } from "../libs/foundation/core/src/access-policy.ts";
import {
  AccessPlannerDecisionSchema,
  AccessPlannerLive,
  planAccessExecution,
} from "../libs/foundation/core/src/access-planner-runtime.ts";
import {
  StoredCaptureBundleSchema,
  makeInMemoryCaptureBundleStore,
} from "../libs/foundation/core/src/capture-store-runtime.ts";
import { ArtifactMetadataRecordSchema } from "../libs/foundation/core/src/config-storage.ts";
import {
  EgressLeaseLifecycleEvent,
  EgressLeaseScopeSnapshot,
  makeInMemoryEgressLeaseManager,
} from "../libs/foundation/core/src/egress-lease-runtime.ts";
import {
  IdentityLeaseLifecycleEvent,
  IdentityLeaseScopeSnapshot,
  makeInMemoryIdentityLeaseManager,
} from "../libs/foundation/core/src/identity-lease-runtime.ts";
import {
  HttpCaptureBundleSchema,
  HttpAccessLive,
  captureHttpArtifacts,
} from "../libs/foundation/core/src/http-access-runtime.ts";
import {
  EgressLeaseSchema,
  IdentityLeaseSchema,
} from "../libs/foundation/core/src/budget-lease-artifact.ts";
import { RunPlanSchema } from "../libs/foundation/core/src/run-state.ts";
import { AccessPlanner, HttpAccess } from "../libs/foundation/core/src/service-topology.ts";
import { SitePackSchema } from "../libs/foundation/core/src/site-pack.ts";
import { TargetProfileSchema } from "../libs/foundation/core/src/target-profile.ts";

const target = Schema.decodeUnknownSync(TargetProfileSchema)({
  id: "target-product-001",
  tenantId: "tenant-main",
  domain: "example.com",
  kind: "productPage",
  canonicalKey: "catalog/product-001",
  seedUrls: ["https://example.com/products/001"],
  accessPolicyId: "policy-http",
  packId: "pack-example-com",
  priority: 10,
});

const pack = Schema.decodeUnknownSync(SitePackSchema)({
  id: "pack-example-com",
  domainPattern: "*.example.com",
  state: "shadow",
  accessPolicyId: "policy-http",
  version: "2026.03.06",
});

const accessPolicy = Schema.decodeUnknownSync(AccessPolicySchema)({
  id: "policy-http",
  mode: "http",
  perDomainConcurrency: 2,
  globalConcurrency: 4,
  timeoutMs: 5_000,
  maxRetries: 1,
  render: "never",
});

const healthPolicy = Schema.decodeUnknownSync(AccessHealthPolicy)({
  failureThreshold: 2,
  recoveryThreshold: 2,
  quarantineMs: 1_000,
});

const timeline = {
  plannedAt: "2026-03-06T18:00:00.000Z",
  budgetPermitAcquiredAt: "2026-03-06T18:00:01.000Z",
  identityLeaseAcquiredAt: "2026-03-06T18:00:02.000Z",
  egressLeaseAcquiredAt: "2026-03-06T18:00:03.000Z",
  captureAt: "2026-03-06T18:00:04.000Z",
  healthRecordedAt: "2026-03-06T18:00:05.000Z",
  identityLeaseReleasedAt: "2026-03-06T18:00:06.000Z",
  egressLeaseReleasedAt: "2026-03-06T18:00:07.000Z",
  budgetPermitReleasedAt: "2026-03-06T18:00:08.000Z",
} as const;

const domainHealthSubject = {
  kind: "domain",
  domain: target.domain,
} as const;

const providerHealthSubject = {
  kind: "provider",
  providerId: "provider-http-main",
} as const;

const identityKey = "identity-main";
const identityHealthSubject = {
  kind: "identity",
  tenantId: target.tenantId,
  domain: target.domain,
  identityKey,
} as const;

const identityLeaseScope = {
  ownerId: `run-${target.id}`,
  tenantId: target.tenantId,
  domain: target.domain,
} as const;

const egressLeaseScope = {
  ownerId: `run-${target.id}`,
  poolId: "pool-main",
  routePolicyId: "route-example-com",
} as const;

const responseBody = "<html><body><h1>Example Product</h1><p>$19.99</p></body></html>";

function makePerfNow() {
  const marks: ReadonlyArray<number> = [100, 112.5];
  let index = 0;
  return () => {
    const mark = marks[index] ?? 112.5;
    index += 1;
    return mark;
  };
}

function ensureEqual(label: string, left: unknown, right: unknown) {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`Expected ${label} to remain aligned across the E3 capability slice.`);
  }
}

function expectSome<A>(label: string, option: Option.Option<A>) {
  return Option.match(option, {
    onNone: () =>
      Effect.die(new Error(`Expected ${label} to resolve during the E3 capability slice.`)),
    onSome: Effect.succeed,
  });
}

export class E3CapabilitySliceEvidence extends Schema.Class<E3CapabilitySliceEvidence>(
  "E3CapabilitySliceEvidence",
)({
  target: TargetProfileSchema,
  pack: SitePackSchema,
  accessPolicy: AccessPolicySchema,
  plannerDecision: AccessPlannerDecisionSchema,
  servicePlan: RunPlanSchema,
  budgetBefore: AccessBudgetSnapshot,
  budgetAfter: AccessBudgetSnapshot,
  budgetEvents: Schema.Array(AccessBudgetEvent),
  identityLease: IdentityLeaseSchema,
  identityScopeDuringRun: IdentityLeaseScopeSnapshot,
  identityScopeAfterRun: IdentityLeaseScopeSnapshot,
  identityEvents: Schema.Array(IdentityLeaseLifecycleEvent),
  egressLease: EgressLeaseSchema,
  egressScopeDuringRun: EgressLeaseScopeSnapshot,
  egressScopeAfterRun: EgressLeaseScopeSnapshot,
  egressEvents: Schema.Array(EgressLeaseLifecycleEvent),
  captureBundle: HttpCaptureBundleSchema,
  storedCapture: StoredCaptureBundleSchema,
  reloadedCapture: StoredCaptureBundleSchema,
  serviceArtifacts: Schema.Array(ArtifactMetadataRecordSchema),
  healthPolicy: AccessHealthPolicy,
  domainHealth: AccessHealthSnapshot,
  providerHealth: AccessHealthSnapshot,
  identityHealth: AccessHealthSnapshot,
  healthEvents: Schema.Array(AccessHealthEvent),
}) {}

export const E3CapabilitySliceEvidenceSchema = E3CapabilitySliceEvidence;

export function runE3CapabilitySlice() {
  return Effect.gen(function* () {
    let currentTime = new Date(timeline.plannedAt);
    const mainLayer = Layer.mergeAll(
      AccessPlannerLive(() => currentTime),
      HttpAccessLive(
        async () =>
          new Response(responseBody, {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "x-egress-pool": egressLeaseScope.poolId,
              "x-identity-key": identityKey,
            },
          }),
        () => currentTime,
        makePerfNow(),
      ),
    );
    const budgetManager = yield* makeInMemoryAccessBudgetManager(() => currentTime);
    const identityLeaseManager = yield* makeInMemoryIdentityLeaseManager(() => currentTime);
    const egressLeaseManager = yield* makeInMemoryEgressLeaseManager(() => currentTime);
    const captureStore = yield* makeInMemoryCaptureBundleStore();
    const healthRuntime = yield* makeInMemoryAccessHealthRuntime(() => currentTime);

    const plannerDecision = yield* planAccessExecution({
      target,
      pack,
      accessPolicy,
      createdAt: currentTime.toISOString(),
    });

    const servicePlan = yield* Effect.gen(function* () {
      const planner = yield* AccessPlanner;
      return yield* planner.plan(target, pack, accessPolicy);
    }).pipe(Effect.provide(mainLayer));

    yield* Effect.sync(() =>
      ensureEqual(
        "planner decision and service plan",
        Schema.encodeSync(RunPlanSchema)(plannerDecision.plan),
        Schema.encodeSync(RunPlanSchema)(servicePlan),
      ),
    );

    const budgetBefore = yield* budgetManager.inspect(plannerDecision.concurrencyBudget);
    currentTime = new Date(timeline.budgetPermitAcquiredAt);

    const execution = yield* budgetManager.withPermit(
      plannerDecision.concurrencyBudget,
      target.domain,
      Effect.gen(function* () {
        currentTime = new Date(timeline.identityLeaseAcquiredAt);
        const identityLease = yield* identityLeaseManager.acquire({
          ...identityLeaseScope,
          identityKey,
          ttlMs: 10_000,
          maxActiveLeases: 1,
        });
        const identityScopeDuringRun = yield* identityLeaseManager.inspectScope(identityLeaseScope);

        currentTime = new Date(timeline.egressLeaseAcquiredAt);
        const egressLease = yield* egressLeaseManager.acquire({
          ...egressLeaseScope,
          egressKey: "egress-us-east-1",
          ttlMs: 10_000,
          maxPoolLeases: 1,
          maxRouteLeases: 1,
        });
        const egressScopeDuringRun = yield* egressLeaseManager.inspectScope(egressLeaseScope);

        currentTime = new Date(timeline.captureAt);
        yield* healthRuntime.assertHealthy(domainHealthSubject);
        yield* healthRuntime.assertHealthy(providerHealthSubject);
        yield* healthRuntime.assertHealthy(identityHealthSubject);

        const captureBundle = yield* captureHttpArtifacts(
          servicePlan,
          async () =>
            new Response(responseBody, {
              status: 200,
              headers: {
                "content-type": "text/html; charset=utf-8",
                "x-egress-pool": egressLeaseScope.poolId,
                "x-identity-key": identityKey,
              },
            }),
          () => currentTime,
          makePerfNow(),
        );
        const serviceArtifacts = yield* Effect.gen(function* () {
          const httpAccess = yield* HttpAccess;
          return yield* httpAccess.capture(servicePlan);
        }).pipe(Effect.provide(mainLayer));

        yield* Effect.sync(() =>
          ensureEqual(
            "capture bundle artifacts and service artifacts",
            Schema.encodeSync(Schema.Array(ArtifactMetadataRecordSchema))(captureBundle.artifacts),
            Schema.encodeSync(Schema.Array(ArtifactMetadataRecordSchema))(serviceArtifacts),
          ),
        );

        const storedCapture = yield* captureStore.persistBundle(servicePlan.id, captureBundle);
        const reloadedCapture = yield* captureStore
          .readBundle(servicePlan.id)
          .pipe(Effect.flatMap((option) => expectSome("reloaded capture bundle", option)));

        currentTime = new Date(timeline.healthRecordedAt);
        const domainHealth = yield* healthRuntime.recordSuccess(domainHealthSubject, healthPolicy);
        const providerHealth = yield* healthRuntime.recordSuccess(
          providerHealthSubject,
          healthPolicy,
        );
        const identityHealth = yield* healthRuntime.recordSuccess(
          identityHealthSubject,
          healthPolicy,
        );

        currentTime = new Date(timeline.identityLeaseReleasedAt);
        yield* identityLeaseManager
          .release(identityLease.id)
          .pipe(Effect.flatMap((option) => expectSome("released identity lease", option)));

        currentTime = new Date(timeline.egressLeaseReleasedAt);
        yield* egressLeaseManager
          .release(egressLease.id)
          .pipe(Effect.flatMap((option) => expectSome("released egress lease", option)));

        const identityScopeAfterRun = yield* identityLeaseManager.inspectScope(identityLeaseScope);
        const egressScopeAfterRun = yield* egressLeaseManager.inspectScope(egressLeaseScope);

        currentTime = new Date(timeline.budgetPermitReleasedAt);

        return {
          identityLease,
          identityScopeDuringRun,
          identityScopeAfterRun,
          egressLease,
          egressScopeDuringRun,
          egressScopeAfterRun,
          captureBundle,
          storedCapture,
          reloadedCapture,
          serviceArtifacts,
          domainHealth,
          providerHealth,
          identityHealth,
        };
      }),
    );

    const budgetAfter = yield* budgetManager.inspect(plannerDecision.concurrencyBudget);
    const budgetEvents = yield* budgetManager.events();
    const identityEvents = yield* identityLeaseManager.events();
    const egressEvents = yield* egressLeaseManager.events();
    const healthEvents = yield* healthRuntime.events();

    return Schema.decodeUnknownSync(E3CapabilitySliceEvidenceSchema)({
      target,
      pack,
      accessPolicy,
      plannerDecision,
      servicePlan,
      budgetBefore,
      budgetAfter,
      budgetEvents,
      identityLease: execution.identityLease,
      identityScopeDuringRun: execution.identityScopeDuringRun,
      identityScopeAfterRun: execution.identityScopeAfterRun,
      identityEvents,
      egressLease: execution.egressLease,
      egressScopeDuringRun: execution.egressScopeDuringRun,
      egressScopeAfterRun: execution.egressScopeAfterRun,
      egressEvents,
      captureBundle: execution.captureBundle,
      storedCapture: execution.storedCapture,
      reloadedCapture: execution.reloadedCapture,
      serviceArtifacts: execution.serviceArtifacts,
      healthPolicy,
      domainHealth: execution.domainHealth,
      providerHealth: execution.providerHealth,
      identityHealth: execution.identityHealth,
      healthEvents,
    });
  });
}

export function runE3CapabilitySliceEncoded() {
  return runE3CapabilitySlice().pipe(
    Effect.map((evidence) => Schema.encodeSync(E3CapabilitySliceEvidenceSchema)(evidence)),
  );
}

if (import.meta.main) {
  const payload = await Effect.runPromise(runE3CapabilitySliceEncoded());
  console.log(JSON.stringify(payload, null, 2));
}
