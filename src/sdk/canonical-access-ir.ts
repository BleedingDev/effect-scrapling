import { type AccessRuntimeModule } from "./access-module-runtime.ts";
import {
  type ResolvedEgressProfile,
  type ResolvedIdentityProfile,
} from "./access-profile-runtime.ts";
import { type AccessProviderDescriptor } from "./access-provider-runtime.ts";
import { type AccessExecutionProfile, type AccessProviderId } from "./schemas.ts";

export type AccessProgramCommandKind = "access" | "render" | "extract";

export type AccessProgramFallbackEdge = {
  readonly edgeId: string;
  readonly kind: "browser-on-access-wall";
  readonly fromMode: "http";
  readonly toMode: "browser";
  readonly defaultTargetProviderId: AccessProviderId;
};

export type ParameterizedAccessProgram = {
  readonly programId: string;
  readonly command: AccessProgramCommandKind;
  readonly defaultProviderId: AccessProviderId;
  readonly candidateProviderIdsByMode: Readonly<{
    readonly http: ReadonlyArray<AccessProviderId>;
    readonly browser: ReadonlyArray<AccessProviderId>;
  }>;
  readonly egressProfileIds: ReadonlyArray<string>;
  readonly identityProfileIds: ReadonlyArray<string>;
  readonly fallbackEdges: ReadonlyArray<AccessProgramFallbackEdge>;
  readonly scoringDimensions: ReadonlyArray<
    "selection-health" | "profile-health" | "lease-availability" | "host-load"
  >;
};

export type CanonicalAccessIr = {
  readonly irVersion: "v1";
  readonly moduleIds: ReadonlyArray<string>;
  readonly providers: ReadonlyArray<AccessProviderDescriptor>;
  readonly egressProfiles: ReadonlyArray<ResolvedEgressProfile>;
  readonly identityProfiles: ReadonlyArray<ResolvedIdentityProfile>;
  readonly programs: ReadonlyArray<ParameterizedAccessProgram>;
};

export type AccessProgramDecisionTrace = {
  readonly programId: string;
  readonly command: AccessProgramCommandKind;
  readonly selectedProviderId: AccessProviderId;
  readonly selectedMode: "http" | "browser";
  readonly candidateProviderIds: ReadonlyArray<AccessProviderId>;
  readonly rejectedProviderIds: ReadonlyArray<AccessProviderId>;
  readonly appliedFallbackEdgeIds: ReadonlyArray<string>;
  readonly scoringDimensions: ReadonlyArray<string>;
};

export type AccessProgramSpecializationInput = {
  readonly command: AccessProgramCommandKind;
  readonly url: string;
  readonly defaultTimeoutMs: number;
  readonly defaultProviderId: AccessProviderId;
  readonly execution?: AccessExecutionProfile | undefined;
};

export type LinkedAccessProgram = {
  readonly ir: CanonicalAccessIr;
  readonly program: ParameterizedAccessProgram;
};

export function buildCanonicalAccessIr(input: {
  readonly modules: ReadonlyArray<AccessRuntimeModule>;
  readonly providers: ReadonlyArray<AccessProviderDescriptor>;
  readonly egressProfiles: ReadonlyArray<ResolvedEgressProfile>;
  readonly identityProfiles: ReadonlyArray<ResolvedIdentityProfile>;
  readonly programs: ReadonlyArray<ParameterizedAccessProgram>;
}): CanonicalAccessIr {
  return {
    irVersion: "v1",
    moduleIds: input.modules.map((module) => module.id).sort(),
    providers: [...input.providers].sort((left, right) => left.id.localeCompare(right.id)),
    egressProfiles: [...input.egressProfiles].sort((left, right) =>
      left.profileId.localeCompare(right.profileId),
    ),
    identityProfiles: [...input.identityProfiles].sort((left, right) =>
      left.profileId.localeCompare(right.profileId),
    ),
    programs: [...input.programs].sort((left, right) =>
      left.programId.localeCompare(right.programId),
    ),
  };
}
