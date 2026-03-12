import { Effect } from "effect";
import {
  type EgressAllocationPlugin,
  type IdentityAllocationPlugin,
} from "./access-allocation-plugin-runtime.ts";
import {
  type ResolvedEgressProfile,
  type ResolvedIdentityProfile,
} from "./access-profile-runtime.ts";
import { toExecutionMetadata } from "./access-runtime.ts";
import {
  AccessEngineClosedError,
  createEngine as createInternalEngine,
  type AccessEngine as InternalAccessEngine,
  type AccessEngineDecisionTrace as InternalAccessEngineDecisionTrace,
  type AccessEngineLinkSnapshot as InternalAccessEngineLinkSnapshot,
  type AccessModuleManifest as InternalAccessModuleManifest,
  type AccessEngineDoctorReport,
} from "./engine.ts";
import {
  BrowserError,
  ExtractionError,
  InvalidInputError,
  NetworkError,
  AccessQuarantinedError,
  AccessResourceError,
} from "./errors.ts";
import { type FetchClient } from "./scraper.ts";
import { type BrowserMediationOutcome } from "./browser-mediation-model.ts";
import {
  AccessExecutionFallbackSchema,
  AccessExecutionMetadataSchema,
  AccessExecutionProfileSchema,
  AccessModeSchema,
  AccessPreviewRequestSchema,
  AccessPreviewResponseSchema,
  ExtractRunRequestSchema,
  ExtractRunResponseSchema,
  RenderPreviewRequestSchema,
  RenderPreviewResponseSchema,
  type AccessExecutionMetadata,
  type AccessExecutionProfile,
  type AccessMode,
  type AccessPreviewRequest,
  type AccessPreviewResponse,
  type ExtractRunRequest,
  type ExtractRunResponse,
  type RenderPreviewRequest,
  type RenderPreviewResponse,
} from "./schemas.ts";
import {
  normalizeAccessPreviewPayload,
  normalizeAuthoringPayload,
  normalizeExtractRunPayload,
  normalizeRenderPreviewPayload,
  type AccessAuthoringCommandKind,
  type JsonObject,
} from "./authoring.ts";
import {
  isAccessQuarantinedError,
  isAccessResourceError,
  isBrowserError,
  isExtractionError,
  isInvalidInputError,
  isNetworkError,
} from "./error-guards.ts";

export type AccessDriverCapabilities = {
  readonly mode: AccessMode;
  readonly rendersDom: boolean;
};

export type AccessDriverExecutionContext = {
  readonly driverId: string;
  readonly providerId: string;
  readonly mode: AccessMode;
};

export type AccessDriverExecutionTimings = {
  readonly requestCount: number;
  readonly redirectCount: number;
  readonly blockedRequestCount: number;
  readonly responseHeadersDurationMs?: number | undefined;
  readonly bodyReadDurationMs?: number | undefined;
  readonly routeRegistrationDurationMs?: number | undefined;
  readonly gotoDurationMs?: number | undefined;
  readonly loadStateDurationMs?: number | undefined;
  readonly domReadDurationMs?: number | undefined;
  readonly headerReadDurationMs?: number | undefined;
};

export type AccessDriverExecutionResult = {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly contentLength: number;
  readonly html: string;
  readonly durationMs: number;
  readonly timings: AccessDriverExecutionTimings;
  readonly mediation?: BrowserMediationOutcome | undefined;
  readonly warnings: ReadonlyArray<string>;
};

export type AccessDriver = {
  readonly id: string;
  readonly capabilities: AccessDriverCapabilities;
  readonly execute: (input: {
    readonly url: string;
    readonly context: AccessDriverExecutionContext;
  }) => Effect.Effect<AccessDriverExecutionResult, NetworkError | BrowserError, never>;
};

export type PublicAccessProviderCapabilities = AccessDriverCapabilities;
export type PublicAccessProviderExecutionContext = AccessDriverExecutionContext;
export type PublicAccessProviderExecutionTimings = AccessDriverExecutionTimings;
export type PublicAccessProviderExecutionResult = AccessDriverExecutionResult;
export type PublicAccessProvider = AccessDriver;

export type AccessEgressDriver<Config = Record<string, never>> = EgressAllocationPlugin<Config>;
export type AccessIdentityDriver<Config = Record<string, never>> = IdentityAllocationPlugin<Config>;
export type AccessEgressProfile = ResolvedEgressProfile;
export type AccessIdentityProfile = ResolvedIdentityProfile;

export type AccessModuleManifest = {
  readonly id: string;
  readonly drivers?: Readonly<Record<string, AccessDriver>> | undefined;
  readonly providers?: Readonly<Record<string, AccessDriver>> | undefined;
  readonly egressPlugins?: Readonly<Record<string, AccessEgressDriver<unknown>>> | undefined;
  readonly identityPlugins?: Readonly<Record<string, AccessIdentityDriver<unknown>>> | undefined;
  readonly egressProfiles?: Readonly<Record<string, AccessEgressProfile>> | undefined;
  readonly identityProfiles?: Readonly<Record<string, AccessIdentityProfile>> | undefined;
};

export type CreateAccessEngineOptions = {
  readonly fetchClient?: FetchClient | undefined;
  readonly modules?: ReadonlyArray<AccessModuleManifest> | undefined;
};

type InternalResolvedExecutionIntent = InternalAccessEngineDecisionTrace["resolved"];
type InternalResolvedFallback = NonNullable<InternalResolvedExecutionIntent["fallback"]>;

export type AccessResolvedExecutionFallback = {
  readonly browserOnAccessWall?: Omit<
    NonNullable<InternalResolvedFallback["browserOnAccessWall"]>,
    "providerId"
  > & {
    readonly driverId: NonNullable<InternalResolvedFallback["browserOnAccessWall"]>["providerId"];
  };
};

export type AccessResolvedExecution = Omit<
  InternalResolvedExecutionIntent,
  "providerId" | "fallback"
> & {
  readonly driverId: InternalResolvedExecutionIntent["providerId"];
  readonly fallback?: AccessResolvedExecutionFallback | undefined;
};

export type AccessEngineDecisionTrace = {
  readonly command: InternalAccessEngineDecisionTrace["command"];
  readonly programId: string;
  readonly normalizedPayload: JsonObject;
  readonly validatedUrl: string;
  readonly defaultDriverId: string;
  readonly candidateDriverIds: ReadonlyArray<string>;
  readonly rejectedDriverIds: ReadonlyArray<string>;
  readonly appliedFallbackEdgeIds: ReadonlyArray<string>;
  readonly resolved: AccessResolvedExecution;
};

export type AccessEngineLinkSnapshot = Omit<
  InternalAccessEngineLinkSnapshot,
  "providers" | "providerIds"
> & {
  readonly drivers: ReadonlyArray<{
    readonly id: string;
    readonly mode: "http" | "browser";
    readonly rendersDom: boolean;
  }>;
  readonly driverIds: ReadonlyArray<string>;
};

type PublicExplainCommand<Input> = {
  (
    input: Input,
  ): Effect.Effect<AccessEngineDecisionTrace, InvalidInputError | AccessEngineClosedError, never>;
  (
    input: unknown,
  ): Effect.Effect<AccessEngineDecisionTrace, InvalidInputError | AccessEngineClosedError, never>;
};

type PublicCommand<Input, Output, Error> = {
  (input: Input): Effect.Effect<Output, Error | AccessEngineClosedError, never>;
  (input: unknown): Effect.Effect<Output, Error | AccessEngineClosedError, never>;
};

export type AccessEngine = {
  readonly normalizeInput: InternalAccessEngine["normalizeInput"];
  readonly traceInput: (
    kind: AccessAuthoringCommandKind,
    rawPayload: unknown,
  ) => Effect.Effect<AccessEngineDecisionTrace, InvalidInputError | AccessEngineClosedError, never>;
  readonly explainAccessPreview: PublicExplainCommand<AccessPreviewRequest>;
  readonly explainRenderPreview: PublicExplainCommand<RenderPreviewRequest>;
  readonly explainExtractRun: PublicExplainCommand<ExtractRunRequest>;
  readonly accessPreview: PublicCommand<
    AccessPreviewRequest,
    AccessPreviewResponse,
    | InvalidInputError
    | NetworkError
    | BrowserError
    | AccessResourceError
    | AccessQuarantinedError
    | ExtractionError
  >;
  readonly renderPreview: PublicCommand<
    RenderPreviewRequest,
    RenderPreviewResponse,
    | InvalidInputError
    | BrowserError
    | AccessResourceError
    | AccessQuarantinedError
    | ExtractionError
  >;
  readonly extractRun: PublicCommand<
    ExtractRunRequest,
    ExtractRunResponse,
    | InvalidInputError
    | NetworkError
    | BrowserError
    | AccessResourceError
    | AccessQuarantinedError
    | ExtractionError
  >;
  readonly runDoctor: InternalAccessEngine["runDoctor"];
  readonly inspectLinkSnapshot: () => Effect.Effect<
    AccessEngineLinkSnapshot,
    AccessEngineClosedError,
    never
  >;
  readonly inspectLinking: () => Effect.Effect<
    AccessEngineLinkSnapshot,
    AccessEngineClosedError,
    never
  >;
  readonly close: InternalAccessEngine["close"];
};

function resolveDeclaredDrivers(module: AccessModuleManifest) {
  if (module.drivers === undefined) {
    return module.providers;
  }

  if (module.providers === undefined) {
    return module.drivers;
  }

  return {
    ...module.providers,
    ...module.drivers,
  };
}

function toPublicNormalizedPayload(normalizedPayload: JsonObject): JsonObject {
  const execution = normalizedPayload.execution;
  if (typeof execution !== "object" || execution === null || Array.isArray(execution)) {
    return normalizedPayload;
  }

  const executionPayload = execution as JsonObject;
  const { providerId, ...restExecution } = executionPayload;

  return {
    ...normalizedPayload,
    execution: {
      ...restExecution,
      ...(providerId === undefined ? {} : { driverId: providerId }),
    },
  };
}

function toPublicResolvedFallback(
  fallback: InternalResolvedExecutionIntent["fallback"],
): AccessResolvedExecutionFallback | undefined {
  if (fallback?.browserOnAccessWall === undefined) {
    return undefined;
  }

  const { providerId, ...browserOnAccessWall } = fallback.browserOnAccessWall;

  return {
    browserOnAccessWall: {
      ...browserOnAccessWall,
      driverId: providerId,
    },
  };
}

function toPublicDecisionTrace(
  trace: InternalAccessEngineDecisionTrace,
): AccessEngineDecisionTrace {
  const fallback = toPublicResolvedFallback(trace.resolved.fallback);
  const { providerId, fallback: _ignoredFallback, ...resolved } = trace.resolved;

  return {
    command: trace.command,
    programId: trace.programId,
    normalizedPayload: toPublicNormalizedPayload(trace.normalizedPayload),
    validatedUrl: trace.validatedUrl,
    defaultDriverId: trace.defaultProviderId,
    candidateDriverIds: trace.candidateProviderIds,
    rejectedDriverIds: trace.rejectedProviderIds,
    appliedFallbackEdgeIds: trace.appliedFallbackEdgeIds,
    resolved: {
      ...resolved,
      driverId: providerId,
      ...(fallback === undefined ? {} : { fallback }),
    },
  };
}

function toPublicLinkSnapshot(
  snapshot: InternalAccessEngineLinkSnapshot,
): AccessEngineLinkSnapshot {
  return {
    moduleIds: snapshot.moduleIds,
    drivers: snapshot.providers,
    driverIds: snapshot.providerIds,
    egressPluginIds: snapshot.egressPluginIds,
    identityPluginIds: snapshot.identityPluginIds,
    egressProfileIds: snapshot.egressProfileIds,
    identityProfileIds: snapshot.identityProfileIds,
    linkedProgramIds: snapshot.linkedProgramIds,
  };
}

function toInternalAccessModule(module: AccessModuleManifest): InternalAccessModuleManifest {
  const drivers = resolveDeclaredDrivers(module);

  return {
    id: module.id,
    ...(drivers === undefined
      ? {}
      : {
          providers: Object.fromEntries(
            Object.entries(drivers).map(([driverId, driver]) => [
              driverId,
              {
                id: driver.id,
                capabilities: driver.capabilities,
                execute: ({ url, context }) =>
                  driver
                    .execute({
                      url,
                      context: {
                        driverId: context.providerId,
                        providerId: context.providerId,
                        mode: context.mode,
                      },
                    })
                    .pipe(
                      Effect.map((result) => ({
                        ...result,
                        execution: toExecutionMetadata(context),
                      })),
                    ),
              },
            ]),
          ),
        }),
    ...(module.egressPlugins === undefined ? {} : { egressPlugins: module.egressPlugins }),
    ...(module.identityPlugins === undefined ? {} : { identityPlugins: module.identityPlugins }),
    ...(module.egressProfiles === undefined ? {} : { egressProfiles: module.egressProfiles }),
    ...(module.identityProfiles === undefined ? {} : { identityProfiles: module.identityProfiles }),
  };
}

function toPublicAccessEngine(engine: InternalAccessEngine): AccessEngine {
  return {
    normalizeInput: engine.normalizeInput,
    traceInput: (kind, rawPayload) =>
      engine.traceInput(kind, rawPayload).pipe(Effect.map(toPublicDecisionTrace)),
    explainAccessPreview: (input) =>
      engine.explainAccessPreview(input).pipe(Effect.map(toPublicDecisionTrace)),
    explainRenderPreview: (input) =>
      engine.explainRenderPreview(input).pipe(Effect.map(toPublicDecisionTrace)),
    explainExtractRun: (input) =>
      engine.explainExtractRun(input).pipe(Effect.map(toPublicDecisionTrace)),
    accessPreview: (input) => engine.accessPreview(input),
    renderPreview: (input) => engine.renderPreview(input),
    extractRun: (input) => engine.extractRun(input),
    runDoctor: engine.runDoctor,
    inspectLinkSnapshot: () => engine.inspectLinkSnapshot().pipe(Effect.map(toPublicLinkSnapshot)),
    inspectLinking: () => engine.inspectLinking().pipe(Effect.map(toPublicLinkSnapshot)),
    close: engine.close,
  };
}

export function defineAccessModule(module: AccessModuleManifest): AccessModuleManifest {
  return module;
}

export function createEngine(
  options: CreateAccessEngineOptions = {},
): Effect.Effect<AccessEngine, never, never> {
  return createInternalEngine({
    ...(options.fetchClient === undefined ? {} : { fetchClient: options.fetchClient }),
    ...(options.modules === undefined
      ? {}
      : {
          modules: options.modules.map(toInternalAccessModule),
        }),
  }).pipe(Effect.map(toPublicAccessEngine));
}

export {
  AccessEngineClosedError,
  type AccessEngineDoctorReport,
  normalizeAccessPreviewPayload,
  normalizeAuthoringPayload,
  normalizeExtractRunPayload,
  normalizeRenderPreviewPayload,
  type AccessAuthoringCommandKind,
  type FetchClient,
  type JsonObject,
  AccessExecutionFallbackSchema,
  AccessExecutionMetadataSchema,
  AccessExecutionProfileSchema,
  AccessModeSchema,
  AccessPreviewRequestSchema,
  AccessPreviewResponseSchema,
  ExtractRunRequestSchema,
  ExtractRunResponseSchema,
  RenderPreviewRequestSchema,
  RenderPreviewResponseSchema,
  AccessQuarantinedError,
  AccessResourceError,
  BrowserError,
  ExtractionError,
  InvalidInputError,
  NetworkError,
  isAccessQuarantinedError,
  isAccessResourceError,
  isBrowserError,
  isExtractionError,
  isInvalidInputError,
  isNetworkError,
};

export type {
  AccessExecutionMetadata,
  AccessExecutionProfile,
  AccessMode,
  AccessPreviewRequest,
  AccessPreviewResponse,
  ExtractRunRequest,
  ExtractRunResponse,
  RenderPreviewRequest,
  RenderPreviewResponse,
};
