import {
  type AcquiredEgressSession,
  type AcquiredIdentitySession,
} from "./access-broker-runtime.ts";
import {
  resolveTransportBinding,
  type AccessTransportBinding,
} from "./access-transport-binding.ts";
import {
  type ResolvedEgressProfile,
  type ResolvedIdentityProfile,
} from "./access-profile-runtime.ts";
import {
  type AccessExecutionMetadata,
  type AccessMode,
  type AccessProviderId,
  type BrowserRuntimeProfileId,
  type BrowserWaitUntil,
} from "./schemas.ts";

export type ResolvedHttpExecution = {
  readonly userAgent?: string | undefined;
};

export type ResolvedBrowserExecution = {
  readonly runtimeProfileId: BrowserRuntimeProfileId;
  readonly waitUntil: BrowserWaitUntil;
  readonly timeoutMs: number;
  readonly userAgent?: string | undefined;
};

export type ResolvedBrowserFallbackExecution = {
  readonly targetUrl: string;
  readonly targetDomain: string;
  readonly providerId: AccessProviderId;
  readonly mode: "browser";
  readonly timeoutMs: number;
  readonly egress: ResolvedEgressProfile;
  readonly identity: ResolvedIdentityProfile;
  readonly browser: ResolvedBrowserExecution;
  readonly warnings: ReadonlyArray<string>;
};

export type ResolvedExecutionFallback = {
  readonly browserOnAccessWall?: ResolvedBrowserFallbackExecution | undefined;
};

export type ResolvedExecutionPlan = {
  readonly targetUrl: string;
  readonly targetDomain: string;
  readonly providerId: AccessProviderId;
  readonly mode: AccessMode;
  readonly timeoutMs: number;
  readonly egress: ResolvedEgressProfile;
  readonly identity: ResolvedIdentityProfile;
  readonly http?: ResolvedHttpExecution | undefined;
  readonly browser?: ResolvedBrowserExecution | undefined;
  readonly warnings: ReadonlyArray<string>;
  readonly fallback?: ResolvedExecutionFallback | undefined;
};

export type ResolvedExecutionIntent = ResolvedExecutionPlan;

export type AccessExecutionContext = {
  readonly targetUrl: string;
  readonly targetDomain: string;
  readonly providerId: AccessProviderId;
  readonly mode: AccessMode;
  readonly timeoutMs: number;
  readonly egress: AcquiredEgressSession;
  readonly transportBinding?: AccessTransportBinding | undefined;
  readonly identity: AcquiredIdentitySession;
  readonly http?: ResolvedHttpExecution | undefined;
  readonly browser?:
    | (ResolvedBrowserExecution & {
        readonly poolKey: string;
      })
    | undefined;
  readonly warnings: ReadonlyArray<string>;
};

export function makeBrowserPoolKey(input: {
  readonly providerId: AccessProviderId;
  readonly runtimeProfileId: BrowserRuntimeProfileId;
  readonly egressKey: string;
  readonly identityKey: string;
}) {
  return [input.providerId, input.runtimeProfileId, input.egressKey, input.identityKey].join("::");
}

export function materializeExecutionContext(input: {
  readonly intent: ResolvedExecutionIntent;
  readonly egress: AcquiredEgressSession;
  readonly identity: AcquiredIdentitySession;
}): AccessExecutionContext {
  const warnings = [
    ...new Set([...input.intent.warnings, ...input.egress.warnings, ...input.identity.warnings]),
  ];

  return {
    targetUrl: input.intent.targetUrl,
    targetDomain: input.intent.targetDomain,
    providerId: input.intent.providerId,
    mode: input.intent.mode,
    timeoutMs: input.intent.timeoutMs,
    egress: input.egress,
    transportBinding: resolveTransportBinding({
      binding: input.egress.transportBinding,
      routeKind: input.egress.routeKind,
      routeConfig: input.egress.routeConfig,
    }),
    identity: input.identity,
    ...(input.intent.http === undefined ? {} : { http: input.intent.http }),
    ...(input.intent.browser === undefined
      ? {}
      : {
          browser: {
            ...input.intent.browser,
            poolKey: makeBrowserPoolKey({
              providerId: input.intent.providerId,
              runtimeProfileId: input.intent.browser.runtimeProfileId,
              egressKey: input.egress.egressKey,
              identityKey: input.identity.identityKey,
            }),
          },
        }),
    warnings,
  };
}

export function toExecutionMetadata(context: AccessExecutionContext): AccessExecutionMetadata {
  return {
    providerId: context.providerId,
    mode: context.mode,
    egressProfileId: context.egress.profileId,
    egressPluginId: context.egress.pluginId,
    egressRouteKind: context.egress.routeKind,
    egressRouteKey: context.egress.routeKey,
    egressPoolId: context.egress.poolId,
    egressRoutePolicyId: context.egress.routePolicyId,
    egressKey: context.egress.egressKey,
    identityProfileId: context.identity.profileId,
    identityPluginId: context.identity.pluginId,
    identityTenantId: context.identity.tenantId,
    identityKey: context.identity.identityKey,
    ...(context.browser === undefined
      ? {}
      : {
          browserRuntimeProfileId: context.browser.runtimeProfileId,
          browserPoolKey: context.browser.poolKey,
        }),
  };
}
