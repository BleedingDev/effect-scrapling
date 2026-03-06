import { Effect, Option, Schema, ServiceMap } from "effect";
import { AccessModeSchema, RenderingPolicySchema } from "./access-policy.ts";
import { ArtifactKindSchema, ArtifactVisibilitySchema } from "./budget-lease-artifact.ts";
import { CheckpointCorruption, ProviderUnavailable } from "./tagged-errors.ts";
import { RunCheckpointSchema } from "./run-state.ts";
import {
  CanonicalHttpUrlSchema,
  CanonicalIdentifierSchema,
  CanonicalKeySchema,
  IsoDateTimeSchema,
  TimeoutMsSchema,
  type CanonicalIdentifier,
} from "./schema-primitives.ts";

const PerDomainConcurrencySchema = Schema.Int.check(Schema.isGreaterThan(0)).check(
  Schema.isLessThanOrEqualTo(128),
);
const GlobalConcurrencySchema = Schema.Int.check(Schema.isGreaterThan(0)).check(
  Schema.isLessThanOrEqualTo(4096),
);
const MaxRetriesSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(10),
);
const CheckpointIntervalSchema = Schema.Int.check(Schema.isGreaterThan(0)).check(
  Schema.isLessThanOrEqualTo(10_000),
);
const SizeBytesSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const MediaTypeSchema = Schema.Trim.check(Schema.isNonEmpty());

export const RunConfigSourceSchema = Schema.Literals([
  "defaults",
  "sitePack",
  "targetProfile",
  "run",
] as const);

export class RunExecutionConfig extends Schema.Class<RunExecutionConfig>("RunExecutionConfig")({
  targetId: CanonicalIdentifierSchema,
  packId: CanonicalIdentifierSchema,
  accessPolicyId: CanonicalIdentifierSchema,
  entryUrl: CanonicalHttpUrlSchema,
  mode: AccessModeSchema,
  render: RenderingPolicySchema,
  perDomainConcurrency: PerDomainConcurrencySchema,
  globalConcurrency: GlobalConcurrencySchema,
  timeoutMs: TimeoutMsSchema,
  maxRetries: MaxRetriesSchema,
  checkpointInterval: CheckpointIntervalSchema,
  artifactNamespace: CanonicalKeySchema,
  checkpointNamespace: CanonicalKeySchema,
}) {}

export const RunExecutionConfigSchema = RunExecutionConfig;

export const RunExecutionConfigOverrideSchema = Schema.Struct({
  targetId: Schema.optional(CanonicalIdentifierSchema),
  packId: Schema.optional(CanonicalIdentifierSchema),
  accessPolicyId: Schema.optional(CanonicalIdentifierSchema),
  entryUrl: Schema.optional(CanonicalHttpUrlSchema),
  mode: Schema.optional(AccessModeSchema),
  render: Schema.optional(RenderingPolicySchema),
  perDomainConcurrency: Schema.optional(PerDomainConcurrencySchema),
  globalConcurrency: Schema.optional(GlobalConcurrencySchema),
  timeoutMs: Schema.optional(TimeoutMsSchema),
  maxRetries: Schema.optional(MaxRetriesSchema),
  checkpointInterval: Schema.optional(CheckpointIntervalSchema),
  artifactNamespace: Schema.optional(CanonicalKeySchema),
  checkpointNamespace: Schema.optional(CanonicalKeySchema),
});

export const RunConfigCascadeInputSchema = Schema.Struct({
  defaults: RunExecutionConfigOverrideSchema,
  sitePack: Schema.optional(RunExecutionConfigOverrideSchema),
  targetProfile: Schema.optional(RunExecutionConfigOverrideSchema),
  run: Schema.optional(RunExecutionConfigOverrideSchema),
});

export function resolveRunExecutionConfig(input: unknown): RunExecutionConfig {
  const decoded = Schema.decodeUnknownSync(RunConfigCascadeInputSchema)(input);

  return Schema.decodeUnknownSync(RunExecutionConfigSchema)({
    ...decoded.defaults,
    ...decoded.sitePack,
    ...decoded.targetProfile,
    ...decoded.run,
  });
}

export class StorageLocator extends Schema.Class<StorageLocator>("StorageLocator")({
  namespace: CanonicalKeySchema,
  key: CanonicalKeySchema,
}) {}

export const StorageLocatorSchema = StorageLocator;

export class ArtifactMetadataRecord extends Schema.Class<ArtifactMetadataRecord>(
  "ArtifactMetadataRecord",
)({
  id: CanonicalIdentifierSchema,
  runId: CanonicalIdentifierSchema,
  artifactId: CanonicalIdentifierSchema,
  kind: ArtifactKindSchema,
  visibility: ArtifactVisibilitySchema,
  locator: StorageLocatorSchema,
  sha256: Sha256Schema,
  sizeBytes: SizeBytesSchema,
  mediaType: MediaTypeSchema,
  storedAt: IsoDateTimeSchema,
}) {}

export const ArtifactMetadataRecordSchema = ArtifactMetadataRecord;
export const StorageEncodingSchema = Schema.Literals(["json"] as const);
export const StorageCompressionSchema = Schema.Literals(["none", "gzip"] as const);

export class CheckpointRecord extends Schema.Class<CheckpointRecord>("CheckpointRecord")({
  id: CanonicalIdentifierSchema,
  runId: CanonicalIdentifierSchema,
  planId: CanonicalIdentifierSchema,
  locator: StorageLocatorSchema,
  checkpoint: RunCheckpointSchema,
  sha256: Sha256Schema,
  encoding: StorageEncodingSchema,
  compression: StorageCompressionSchema,
  storedAt: IsoDateTimeSchema,
}) {}

export const CheckpointRecordSchema = CheckpointRecord;

export class ArtifactMetadataStore extends ServiceMap.Service<
  ArtifactMetadataStore,
  {
    readonly getById: (
      artifactId: CanonicalIdentifier,
    ) => Effect.Effect<Option.Option<ArtifactMetadataRecord>, ProviderUnavailable>;
    readonly listByRun: (
      runId: CanonicalIdentifier,
    ) => Effect.Effect<ReadonlyArray<ArtifactMetadataRecord>, ProviderUnavailable>;
    readonly put: (
      record: ArtifactMetadataRecord,
    ) => Effect.Effect<ArtifactMetadataRecord, ProviderUnavailable>;
  }
>()("@effect-scrapling/foundation/ArtifactMetadataStore") {}

export class RunCheckpointStore extends ServiceMap.Service<
  RunCheckpointStore,
  {
    readonly getById: (
      checkpointId: CanonicalIdentifier,
    ) => Effect.Effect<Option.Option<CheckpointRecord>, CheckpointCorruption | ProviderUnavailable>;
    readonly latest: (
      runId: CanonicalIdentifier,
    ) => Effect.Effect<Option.Option<CheckpointRecord>, CheckpointCorruption | ProviderUnavailable>;
    readonly put: (
      record: CheckpointRecord,
    ) => Effect.Effect<CheckpointRecord, CheckpointCorruption | ProviderUnavailable>;
  }
>()("@effect-scrapling/foundation/RunCheckpointStore") {}

export type RunConfigSource = Schema.Schema.Type<typeof RunConfigSourceSchema>;
export type RunExecutionConfigEncoded = Schema.Codec.Encoded<typeof RunExecutionConfigSchema>;
export type ArtifactMetadataRecordEncoded = Schema.Codec.Encoded<
  typeof ArtifactMetadataRecordSchema
>;
export type CheckpointRecordEncoded = Schema.Codec.Encoded<typeof CheckpointRecordSchema>;
