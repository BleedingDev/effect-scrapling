import { createHash } from "node:crypto";
import { Effect, Option, Schema, ServiceMap } from "effect";
import { AccessModeSchema, RenderingPolicySchema } from "./access-policy.ts";
import { ArtifactKindSchema, ArtifactVisibilitySchema } from "./budget-lease-artifact.ts";
import { CheckpointCorruption, ProviderUnavailable } from "./tagged-errors.ts";
import { RunCheckpointSchema } from "./run-state.ts";
import {
  CanonicalDomainSchema,
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
  targetDomain: CanonicalDomainSchema,
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
  targetDomain: Schema.optional(CanonicalDomainSchema),
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

function legacyStableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => legacyStableSerialize(entry)).join(",")}]`;
  }

  if (typeof value === "object" && value !== null) {
    if (Object.prototype.toString.call(value) === "[object Date]") {
      return JSON.stringify(value);
    }

    return `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${legacyStableSerialize(Reflect.get(value, key))}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function normalizeStableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => (entry === undefined ? null : normalizeStableValue(entry)));
  }

  if (typeof value === "object" && value !== null) {
    if (Object.prototype.toString.call(value) === "[object Date]") {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter(([_key, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, normalizeStableValue(entryValue)]),
    );
  }

  return value;
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(normalizeStableValue(value));
}

export function checkpointPayloadSha256(
  checkpoint: Schema.Codec.Encoded<typeof RunCheckpointSchema>,
) {
  return createHash("sha256").update(stableSerialize(checkpoint), "utf8").digest("hex");
}

export function legacyCheckpointPayloadSha256(
  checkpoint: Schema.Codec.Encoded<typeof RunCheckpointSchema>,
) {
  return createHash("sha256")
    .update(legacyStableSerialize(normalizeStableValue(checkpoint)), "utf8")
    .digest("hex");
}

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
