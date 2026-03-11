import { Data, Effect, Exit, Layer, Scope, Schema } from "effect";
import {
  AccessModuleComposition,
  AccessModuleRegistry,
  makeStaticAccessModuleRegistry,
  type AccessRuntimeModule,
} from "./access-module-runtime.ts";
import { makeBuiltinAccessRuntimeModules } from "./access-builtin-modules.ts";
import { AccessProfileRegistry } from "./access-profile-runtime.ts";
import { AccessProviderRegistry } from "./access-provider-runtime.ts";
import { AccessProgramLinker } from "./access-program-linker.ts";
import { FetchService, type FetchClient } from "./fetch-service.ts";
import {
  EgressLeaseManagerService,
  IdentityLeaseManagerService,
} from "./access-allocation-plugin-runtime.ts";
import {
  AccessQuarantinedError,
  AccessResourceError,
  BrowserError,
  ExtractionError,
  InvalidInputError,
  NetworkError,
} from "./errors.ts";
import { accessPreview, extractRun, renderPreview, runDoctor } from "./scraper.ts";
import { makeSdkRuntimeHandle } from "./runtime-layer.ts";
import type {
  AccessPreviewRequest,
  AccessPreviewResponse,
  ExtractRunRequest,
  ExtractRunResponse,
  RenderPreviewRequest,
  RenderPreviewResponse,
} from "./schemas.ts";
import {
  AccessPreviewRequestSchema,
  ExtractRunRequestSchema,
  RenderPreviewRequestSchema,
} from "./schemas.ts";
import {
  DEFAULT_BROWSER_PROVIDER_ID,
  DEFAULT_HTTP_PROVIDER_ID,
  type ResolvedExecutionIntent,
} from "./access-runtime.ts";
import {
  normalizeAuthoringPayload,
  type AccessAuthoringCommandKind,
  type JsonObject,
} from "./authoring.ts";
import { parseUserFacingUrl } from "./url-policy.ts";

export type AccessModuleManifest = AccessRuntimeModule;

type AccessCommandFailure =
  | InvalidInputError
  | AccessResourceError
  | AccessQuarantinedError
  | NetworkError
  | BrowserError
  | ExtractionError;

type RenderCommandFailure =
  | InvalidInputError
  | AccessResourceError
  | AccessQuarantinedError
  | BrowserError
  | ExtractionError;

export class AccessEngineClosedError extends Data.TaggedError("AccessEngineClosedError")<{
  readonly message: string;
  readonly details?: string;
}> {}

export type CreateAccessEngineOptions = {
  readonly fetchClient?: FetchClient | undefined;
  readonly modules?: ReadonlyArray<AccessModuleManifest> | undefined;
  readonly includeBuiltinModules?: boolean | undefined;
};

export type AccessEngineDoctorReport = {
  readonly ok: boolean;
  readonly command: "doctor";
  readonly data: {
    readonly ok: boolean;
    readonly runtime: {
      readonly bun: string;
      readonly platform: NodeJS.Platform;
      readonly arch: string;
    };
    readonly checks: ReadonlyArray<{
      readonly name: string;
      readonly ok: boolean;
      readonly details: string;
    }>;
  };
  readonly warnings: ReadonlyArray<string>;
};

export type AccessEngineDecisionTrace = {
  readonly command: "access preview" | "render preview" | "extract run";
  readonly programId: string;
  readonly normalizedPayload: JsonObject;
  readonly validatedUrl: string;
  readonly defaultProviderId: string;
  readonly candidateProviderIds: ReadonlyArray<string>;
  readonly rejectedProviderIds: ReadonlyArray<string>;
  readonly appliedFallbackEdgeIds: ReadonlyArray<string>;
  readonly resolved: ResolvedExecutionIntent;
};

export type AccessEngineLinkSnapshot = {
  readonly moduleIds: ReadonlyArray<string>;
  readonly providers: ReadonlyArray<{
    readonly id: string;
    readonly mode: "http" | "browser";
    readonly rendersDom: boolean;
  }>;
  readonly providerIds: ReadonlyArray<string>;
  readonly egressPluginIds: ReadonlyArray<string>;
  readonly identityPluginIds: ReadonlyArray<string>;
  readonly egressProfileIds: ReadonlyArray<string>;
  readonly identityProfileIds: ReadonlyArray<string>;
  readonly linkedProgramIds: ReadonlyArray<string>;
};

export type AccessEngine = {
  readonly normalizeInput: (
    kind: AccessAuthoringCommandKind,
    rawPayload: unknown,
  ) => Effect.Effect<JsonObject, InvalidInputError, never>;
  readonly traceInput: (
    kind: AccessAuthoringCommandKind,
    rawPayload: unknown,
  ) => Effect.Effect<AccessEngineDecisionTrace, InvalidInputError | AccessEngineClosedError, never>;
  readonly explainAccessPreview: (
    input: AccessPreviewRequest | unknown,
  ) => Effect.Effect<AccessEngineDecisionTrace, InvalidInputError | AccessEngineClosedError, never>;
  readonly explainRenderPreview: (
    input: RenderPreviewRequest | unknown,
  ) => Effect.Effect<AccessEngineDecisionTrace, InvalidInputError | AccessEngineClosedError, never>;
  readonly explainExtractRun: (
    input: ExtractRunRequest | unknown,
  ) => Effect.Effect<AccessEngineDecisionTrace, InvalidInputError | AccessEngineClosedError, never>;
  readonly accessPreview: (
    input: AccessPreviewRequest | unknown,
  ) => Effect.Effect<AccessPreviewResponse, AccessCommandFailure | AccessEngineClosedError, never>;
  readonly renderPreview: (
    input: RenderPreviewRequest | unknown,
  ) => Effect.Effect<RenderPreviewResponse, RenderCommandFailure | AccessEngineClosedError, never>;
  readonly extractRun: (
    input: ExtractRunRequest | unknown,
  ) => Effect.Effect<ExtractRunResponse, AccessCommandFailure | AccessEngineClosedError, never>;
  readonly runDoctor: () => Effect.Effect<AccessEngineDoctorReport, AccessEngineClosedError, never>;
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
  readonly close: Effect.Effect<void, never, never>;
};

export function defineAccessModule(module: AccessModuleManifest): AccessModuleManifest {
  return module;
}

export type CreateSdkEngineOptions = CreateAccessEngineOptions;
export type SdkEngine = AccessEngine;
export type SdkLinkReport = AccessEngineLinkSnapshot;

function makeEngineOverrides(
  options: CreateAccessEngineOptions,
):
  | Layer.Layer<
      AccessModuleRegistry,
      never,
      EgressLeaseManagerService | IdentityLeaseManagerService
    >
  | undefined {
  if (options.modules === undefined && options.includeBuiltinModules !== false) {
    return undefined;
  }

  return Layer.effect(
    AccessModuleRegistry,
    Effect.gen(function* () {
      const builtinModules =
        options.includeBuiltinModules === false
          ? []
          : yield* makeBuiltinAccessRuntimeModules({
              egressLeaseManager: yield* EgressLeaseManagerService,
              identityLeaseManager: yield* IdentityLeaseManagerService,
            });

      return makeStaticAccessModuleRegistry({
        modules: [...builtinModules, ...(options.modules ?? [])],
      });
    }),
  );
}

function provideFetchClient<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fetchClient: FetchClient | undefined,
): Effect.Effect<A, E, Exclude<R, FetchService>> {
  if (fetchClient === undefined) {
    return effect as Effect.Effect<A, E, Exclude<R, FetchService>>;
  }

  return effect.pipe(
    Effect.provideService(FetchService, {
      fetch: fetchClient,
    }),
  ) as Effect.Effect<A, E, Exclude<R, FetchService>>;
}

function normalizeAuthoringPayloadEffect(
  kind: AccessAuthoringCommandKind,
  rawPayload: unknown,
): Effect.Effect<JsonObject, InvalidInputError, never> {
  return Effect.try({
    try: () => normalizeAuthoringPayload(kind, rawPayload),
    catch: (error) =>
      error instanceof InvalidInputError
        ? error
        : new InvalidInputError({
            message: `Invalid ${kind} request payload`,
            details: String(error),
          }),
  });
}

function toAccessEngineDoctorReport(input: {
  readonly ok: boolean;
  readonly runtime: {
    readonly bun: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly ok: boolean;
    readonly details: string;
  }>;
}): AccessEngineDoctorReport {
  return {
    ok: input.ok,
    command: "doctor",
    data: input,
    warnings: input.ok ? [] : ["One or more runtime checks failed"],
  };
}

function decodeNormalizedRequest(
  schema:
    | typeof AccessPreviewRequestSchema
    | typeof RenderPreviewRequestSchema
    | typeof ExtractRunRequestSchema,
  payload: unknown,
  operation: string,
): Effect.Effect<ExplainableRequest, InvalidInputError, never> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema as never)(payload) as ExplainableRequest,
    catch: (error) =>
      new InvalidInputError({
        message: `Invalid ${operation} payload`,
        details: String(error),
      }),
  });
}

type ExplainableRequest = {
  readonly url: string;
  readonly timeoutMs: number;
  readonly execution?: AccessPreviewRequest["execution"] | undefined;
};

function explainExecution(input: {
  readonly command: AccessEngineDecisionTrace["command"];
  readonly kind: AccessAuthoringCommandKind;
  readonly rawPayload: unknown;
  readonly schema:
    | typeof AccessPreviewRequestSchema
    | typeof RenderPreviewRequestSchema
    | typeof ExtractRunRequestSchema;
  readonly defaultProviderId: string;
}) {
  return Effect.gen(function* () {
    const normalizedInput = yield* normalizeAuthoringPayloadEffect(input.kind, input.rawPayload);
    const request = (yield* decodeNormalizedRequest(
      input.schema,
      normalizedInput,
      input.command,
    )) as ExplainableRequest;
    const validatedUrl = yield* parseUserFacingUrl(request.url);
    const linker = yield* AccessProgramLinker;
    const linked = yield* linker.specialize({
      command: input.kind,
      url: validatedUrl,
      defaultTimeoutMs: request.timeoutMs,
      defaultProviderId: input.defaultProviderId,
      execution: request.execution,
    });

    return {
      command: input.command,
      programId: linked.trace.programId,
      normalizedPayload: normalizedInput,
      validatedUrl,
      defaultProviderId: input.defaultProviderId,
      candidateProviderIds: linked.trace.candidateProviderIds,
      rejectedProviderIds: linked.trace.rejectedProviderIds,
      appliedFallbackEdgeIds: linked.trace.appliedFallbackEdgeIds,
      resolved: linked.intent,
    } satisfies AccessEngineDecisionTrace;
  });
}

export function createEngine(
  options: CreateAccessEngineOptions = {},
): Effect.Effect<AccessEngine, never, never> {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const handle = yield* makeSdkRuntimeHandle(makeEngineOverrides(options)).pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    let closed = false;

    const ensureOpen = Effect.suspend(() =>
      closed
        ? Effect.fail(
            new AccessEngineClosedError({
              message: "SDK engine is closed",
              details: "Create a new engine before executing additional access operations.",
            }),
          )
        : Effect.void,
    );

    const provideRuntime = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | AccessEngineClosedError, never> =>
      Effect.gen(function* () {
        yield* ensureOpen;
        return yield* handle.provideRuntime(effect);
      }) as Effect.Effect<A, E | AccessEngineClosedError, never>;

    const provideEnvironment = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | AccessEngineClosedError, never> =>
      Effect.gen(function* () {
        yield* ensureOpen;
        return yield* handle.provideEnvironment(provideFetchClient(effect, options.fetchClient));
      }) as Effect.Effect<A, E | AccessEngineClosedError, never>;

    const runNormalizedCommand = <A, E, R>(
      kind: AccessAuthoringCommandKind,
      rawPayload: unknown,
      execute: (payload: JsonObject) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | InvalidInputError | AccessEngineClosedError, never> =>
      normalizeAuthoringPayloadEffect(kind, rawPayload).pipe(
        Effect.flatMap((payload) => provideEnvironment(execute(payload))),
      );

    const inspectLinkSnapshot = () =>
      provideRuntime(
        Effect.gen(function* () {
          const moduleRegistry = yield* AccessModuleRegistry;
          const composition = yield* AccessModuleComposition;
          const providerRegistry = yield* AccessProviderRegistry;
          const profileRegistry = yield* AccessProfileRegistry;
          const linker = yield* AccessProgramLinker;
          const modules = yield* moduleRegistry.listModules();
          const providers = yield* providerRegistry.listDescriptors();
          const egressProfiles = yield* profileRegistry.listEgressProfiles();
          const identityProfiles = yield* profileRegistry.listIdentityProfiles();
          const linkedPrograms = yield* linker.listPrograms();

          return {
            moduleIds: modules.map((module) => module.id).sort(),
            providers: providers
              .map((provider) => ({
                id: provider.id,
                mode: provider.capabilities.mode,
                rendersDom: provider.capabilities.rendersDom,
              }))
              .sort((left, right) => left.id.localeCompare(right.id)),
            providerIds: providers.map((provider) => provider.id).sort(),
            egressPluginIds: Object.keys(composition.egressPlugins).sort(),
            identityPluginIds: Object.keys(composition.identityPlugins).sort(),
            egressProfileIds: egressProfiles.map((profile) => profile.profileId).sort(),
            identityProfileIds: identityProfiles.map((profile) => profile.profileId).sort(),
            linkedProgramIds: linkedPrograms.map(({ program }) => program.programId).sort(),
          } satisfies AccessEngineLinkSnapshot;
        }),
      );

    return {
      normalizeInput: normalizeAuthoringPayloadEffect,
      traceInput: (kind, rawPayload) =>
        provideRuntime(
          explainExecution({
            command:
              kind === "access"
                ? "access preview"
                : kind === "render"
                  ? "render preview"
                  : "extract run",
            kind,
            rawPayload,
            schema:
              kind === "access"
                ? AccessPreviewRequestSchema
                : kind === "render"
                  ? RenderPreviewRequestSchema
                  : ExtractRunRequestSchema,
            defaultProviderId:
              kind === "render" ? DEFAULT_BROWSER_PROVIDER_ID : DEFAULT_HTTP_PROVIDER_ID,
          }),
        ),
      explainAccessPreview: (input) =>
        provideRuntime(
          explainExecution({
            command: "access preview",
            kind: "access",
            rawPayload: input,
            schema: AccessPreviewRequestSchema,
            defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
          }),
        ),
      explainRenderPreview: (input) =>
        provideRuntime(
          explainExecution({
            command: "render preview",
            kind: "render",
            rawPayload: input,
            schema: RenderPreviewRequestSchema,
            defaultProviderId: DEFAULT_BROWSER_PROVIDER_ID,
          }),
        ),
      explainExtractRun: (input) =>
        provideRuntime(
          explainExecution({
            command: "extract run",
            kind: "extract",
            rawPayload: input,
            schema: ExtractRunRequestSchema,
            defaultProviderId: DEFAULT_HTTP_PROVIDER_ID,
          }),
        ),
      accessPreview: (input) =>
        runNormalizedCommand("access", input, (payload) => accessPreview(payload)),
      renderPreview: (input) =>
        runNormalizedCommand("render", input, (payload) => renderPreview(payload)),
      extractRun: (input) =>
        runNormalizedCommand("extract", input, (payload) => extractRun(payload)),
      runDoctor: () => provideRuntime(runDoctor().pipe(Effect.map(toAccessEngineDoctorReport))),
      inspectLinkSnapshot,
      inspectLinking: inspectLinkSnapshot,
      close: Effect.suspend(() => {
        if (closed) {
          return Effect.void;
        }

        closed = true;
        return Scope.close(scope, Exit.void);
      }),
    } satisfies AccessEngine;
  });
}

export function createSdkEngine(
  options: CreateAccessEngineOptions = {},
): Effect.Effect<AccessEngine, never, never> {
  return createEngine(options);
}

export function withEngine<A, E>(
  options: CreateAccessEngineOptions,
  use: (engine: AccessEngine) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> {
  return Effect.acquireUseRelease(createEngine(options), use, (engine) => engine.close);
}
