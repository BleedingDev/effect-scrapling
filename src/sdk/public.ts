import { Effect } from "effect";
import { toExecutionMetadata } from "./access-runtime.ts";
import {
  AccessEngineClosedError,
  createEngine as createInternalEngine,
  type AccessEngine as InternalAccessEngine,
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

export type PublicAccessProviderCapabilities = {
  readonly mode: AccessMode;
  readonly rendersDom: boolean;
};

export type PublicAccessProviderExecutionContext = {
  readonly providerId: string;
  readonly mode: AccessMode;
};

export type PublicAccessProviderExecutionTimings = {
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

export type PublicAccessProviderExecutionResult = {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly contentLength: number;
  readonly html: string;
  readonly durationMs: number;
  readonly timings: PublicAccessProviderExecutionTimings;
  readonly warnings: ReadonlyArray<string>;
};

export type PublicAccessProvider = {
  readonly id: string;
  readonly capabilities: PublicAccessProviderCapabilities;
  readonly execute: (input: {
    readonly url: string;
    readonly context: PublicAccessProviderExecutionContext;
  }) => Effect.Effect<PublicAccessProviderExecutionResult, NetworkError | BrowserError, never>;
};

export type AccessModuleManifest = {
  readonly id: string;
  readonly providers?: Readonly<Record<string, PublicAccessProvider>> | undefined;
};

export type CreateAccessEngineOptions = {
  readonly fetchClient?: FetchClient | undefined;
  readonly modules?: ReadonlyArray<AccessModuleManifest> | undefined;
};

export type AccessEngine = Pick<
  InternalAccessEngine,
  "normalizeInput" | "accessPreview" | "renderPreview" | "extractRun" | "runDoctor" | "close"
>;

function toInternalAccessModule(module: AccessModuleManifest): InternalAccessModuleManifest {
  return {
    id: module.id,
    ...(module.providers === undefined
      ? {}
      : {
          providers: Object.fromEntries(
            Object.entries(module.providers).map(([providerId, provider]) => [
              providerId,
              {
                id: provider.id,
                capabilities: provider.capabilities,
                execute: ({ url, context }) =>
                  provider
                    .execute({
                      url,
                      context: {
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
  };
}

function toPublicAccessEngine(engine: InternalAccessEngine): AccessEngine {
  return {
    normalizeInput: engine.normalizeInput,
    accessPreview: engine.accessPreview,
    renderPreview: engine.renderPreview,
    extractRun: engine.extractRun,
    runDoctor: engine.runDoctor,
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
