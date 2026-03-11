import { Layer, ServiceMap } from "effect";
import { type AccessHealthPolicy } from "@effect-scrapling/foundation-core/access-health-runtime";
import { type AccessHealthContext } from "./access-health-gateway.ts";

export type AccessHealthSubjectInput =
  | {
      readonly kind: "domain";
      readonly domain: string;
    }
  | {
      readonly kind: "provider";
      readonly providerId: string;
    }
  | {
      readonly kind: "egress";
      readonly poolId: string;
      readonly routePolicyId: string;
      readonly egressKey: string;
    }
  | {
      readonly kind: "egress-profile";
      readonly poolId: string;
      readonly routePolicyId: string;
      readonly profileId: string;
    }
  | {
      readonly kind: "egress-plugin";
      readonly poolId: string;
      readonly routePolicyId: string;
      readonly pluginId: string;
    }
  | {
      readonly kind: "identity";
      readonly tenantId: string;
      readonly domain: string;
      readonly identityKey: string;
    }
  | {
      readonly kind: "identity-profile";
      readonly tenantId: string;
      readonly domain: string;
      readonly profileId: string;
    }
  | {
      readonly kind: "identity-plugin";
      readonly tenantId: string;
      readonly domain: string;
      readonly pluginId: string;
    };

const DEFAULT_ACCESS_HEALTH_POLICY = {
  domain: {
    failureThreshold: 3,
    recoveryThreshold: 2,
    quarantineMs: 90_000,
  },
  provider: {
    failureThreshold: 4,
    recoveryThreshold: 2,
    quarantineMs: 60_000,
  },
  egress: {
    failureThreshold: 2,
    recoveryThreshold: 2,
    quarantineMs: 180_000,
  },
  "egress-profile": {
    failureThreshold: 2,
    recoveryThreshold: 2,
    quarantineMs: 180_000,
  },
  "egress-plugin": {
    failureThreshold: 2,
    recoveryThreshold: 2,
    quarantineMs: 180_000,
  },
  identity: {
    failureThreshold: 2,
    recoveryThreshold: 2,
    quarantineMs: 180_000,
  },
  "identity-profile": {
    failureThreshold: 2,
    recoveryThreshold: 2,
    quarantineMs: 180_000,
  },
  "identity-plugin": {
    failureThreshold: 2,
    recoveryThreshold: 2,
    quarantineMs: 180_000,
  },
} as const satisfies Record<AccessHealthSubjectInput["kind"], AccessHealthPolicy>;

export function makeStaticAccessHealthSubjectStrategy() {
  return {
    subjectsFor: (context: AccessHealthContext) => {
      const domain = context.context.targetDomain;

      return [
        {
          kind: "domain",
          domain,
        },
        {
          kind: "provider",
          providerId: context.context.providerId,
        },
        {
          kind: "egress-profile",
          poolId: context.context.egress.poolId,
          routePolicyId: context.context.egress.routePolicyId,
          profileId: context.context.egress.profileId,
        },
        {
          kind: "egress-plugin",
          poolId: context.context.egress.poolId,
          routePolicyId: context.context.egress.routePolicyId,
          pluginId: context.context.egress.pluginId,
        },
        {
          kind: "egress",
          poolId: context.context.egress.poolId,
          routePolicyId: context.context.egress.routePolicyId,
          egressKey: context.context.egress.egressKey,
        },
        {
          kind: "identity-profile",
          tenantId: context.context.identity.tenantId,
          domain,
          profileId: context.context.identity.profileId,
        },
        {
          kind: "identity-plugin",
          tenantId: context.context.identity.tenantId,
          domain,
          pluginId: context.context.identity.pluginId,
        },
        {
          kind: "identity",
          tenantId: context.context.identity.tenantId,
          domain,
          identityKey: context.context.identity.identityKey,
        },
      ] satisfies ReadonlyArray<AccessHealthSubjectInput>;
    },
  } satisfies {
    readonly subjectsFor: (context: AccessHealthContext) => ReadonlyArray<AccessHealthSubjectInput>;
  };
}

export function makeStaticAccessHealthPolicyRegistry(input?: {
  readonly policies?:
    | Partial<Record<AccessHealthSubjectInput["kind"], AccessHealthPolicy>>
    | undefined;
}) {
  const policies = {
    ...DEFAULT_ACCESS_HEALTH_POLICY,
    ...input?.policies,
  } satisfies Record<AccessHealthSubjectInput["kind"], AccessHealthPolicy>;

  return {
    policyFor: (subject: AccessHealthSubjectInput) => policies[subject.kind],
  } satisfies {
    readonly policyFor: (subject: AccessHealthSubjectInput) => AccessHealthPolicy;
  };
}

export class AccessHealthSubjectStrategy extends ServiceMap.Service<
  AccessHealthSubjectStrategy,
  {
    readonly subjectsFor: (context: AccessHealthContext) => ReadonlyArray<AccessHealthSubjectInput>;
  }
>()("@effect-scrapling/sdk/AccessHealthSubjectStrategy") {}

export class AccessHealthPolicyRegistry extends ServiceMap.Service<
  AccessHealthPolicyRegistry,
  {
    readonly policyFor: (subject: AccessHealthSubjectInput) => AccessHealthPolicy;
  }
>()("@effect-scrapling/sdk/AccessHealthPolicyRegistry") {}

export const AccessHealthSubjectStrategyLive = Layer.succeed(
  AccessHealthSubjectStrategy,
  makeStaticAccessHealthSubjectStrategy(),
);

export const AccessHealthPolicyRegistryLive = Layer.succeed(
  AccessHealthPolicyRegistry,
  makeStaticAccessHealthPolicyRegistry(),
);
