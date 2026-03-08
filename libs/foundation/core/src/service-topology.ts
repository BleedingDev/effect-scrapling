import { Effect, Option, ServiceMap } from "effect";
import type { AccessPolicy } from "./access-policy.ts";
import type { ArtifactMetadataRecord, StorageLocator } from "./config-storage.ts";
import {
  CheckpointCorruption,
  DriftDetected,
  DuplicateWorkClaim,
  ExtractionMismatch,
  ParserFailure,
  PolicyViolation,
  ProviderUnavailable,
  RenderCrashError,
  TimeoutError,
} from "./tagged-errors.ts";
import type { SitePack } from "./site-pack.ts";
import type { Snapshot } from "./observation-snapshot.ts";
import type { TargetProfile } from "./target-profile.ts";
import type { CanonicalDomain, CanonicalIdentifier } from "./schema-primitives.ts";
import type { PackPromotionDecisionEncoded, QualityVerdict, SnapshotDiff } from "./diff-verdict.ts";
import type {
  RunCheckpointEncoded,
  RunPlan,
  WorkflowControlResult,
  WorkflowInspectionSnapshot,
} from "./run-state.ts";

export class TargetRegistry extends ServiceMap.Service<
  TargetRegistry,
  {
    readonly getById: (
      targetId: CanonicalIdentifier,
    ) => Effect.Effect<Option.Option<TargetProfile>, ProviderUnavailable>;
  }
>()("@effect-scrapling/foundation/TargetRegistry") {}

export class PackRegistry extends ServiceMap.Service<
  PackRegistry,
  {
    readonly getByDomain: (
      domain: CanonicalDomain,
    ) => Effect.Effect<Option.Option<SitePack>, ProviderUnavailable>;
    readonly getById: (
      packId: CanonicalIdentifier,
    ) => Effect.Effect<Option.Option<SitePack>, ProviderUnavailable>;
  }
>()("@effect-scrapling/foundation/PackRegistry") {}

export class AccessPlanner extends ServiceMap.Service<
  AccessPlanner,
  {
    readonly plan: (
      target: TargetProfile,
      pack: SitePack,
      accessPolicy: AccessPolicy,
    ) => Effect.Effect<RunPlan, PolicyViolation | ProviderUnavailable>;
  }
>()("@effect-scrapling/foundation/AccessPlanner") {}

export class HttpAccess extends ServiceMap.Service<
  HttpAccess,
  {
    readonly capture: (
      plan: RunPlan,
    ) => Effect.Effect<
      ReadonlyArray<ArtifactMetadataRecord>,
      PolicyViolation | ProviderUnavailable | TimeoutError
    >;
  }
>()("@effect-scrapling/foundation/HttpAccess") {}

export class BrowserAccess extends ServiceMap.Service<
  BrowserAccess,
  {
    readonly capture: (
      plan: RunPlan,
    ) => Effect.Effect<
      ReadonlyArray<ArtifactMetadataRecord>,
      PolicyViolation | ProviderUnavailable | RenderCrashError | TimeoutError
    >;
  }
>()("@effect-scrapling/foundation/BrowserAccess") {}

export class CaptureStore extends ServiceMap.Service<
  CaptureStore,
  {
    readonly persist: (
      artifacts: ReadonlyArray<ArtifactMetadataRecord>,
    ) => Effect.Effect<ReadonlyArray<ArtifactMetadataRecord>, ProviderUnavailable>;
  }
>()("@effect-scrapling/foundation/CaptureStore") {}

export class Extractor extends ServiceMap.Service<
  Extractor,
  {
    readonly extract: (
      plan: RunPlan,
      artifacts: ReadonlyArray<ArtifactMetadataRecord>,
    ) => Effect.Effect<Snapshot, ExtractionMismatch | ParserFailure>;
  }
>()("@effect-scrapling/foundation/Extractor") {}

export class SnapshotStore extends ServiceMap.Service<
  SnapshotStore,
  {
    readonly getById: (
      snapshotId: CanonicalIdentifier,
    ) => Effect.Effect<Option.Option<Snapshot>, ProviderUnavailable>;
    readonly put: (snapshot: Snapshot) => Effect.Effect<Snapshot, ProviderUnavailable>;
  }
>()("@effect-scrapling/foundation/SnapshotStore") {}

export class DiffEngine extends ServiceMap.Service<
  DiffEngine,
  {
    readonly compare: (
      baseline: Snapshot,
      candidate: Snapshot,
    ) => Effect.Effect<SnapshotDiff, DriftDetected>;
  }
>()("@effect-scrapling/foundation/DiffEngine") {}

export class QualityGate extends ServiceMap.Service<
  QualityGate,
  {
    readonly evaluate: (
      diff: SnapshotDiff,
    ) => Effect.Effect<QualityVerdict, DriftDetected | PolicyViolation>;
  }
>()("@effect-scrapling/foundation/QualityGate") {}

export class ReflectionEngine extends ServiceMap.Service<
  ReflectionEngine,
  {
    readonly decide: (
      pack: SitePack,
      verdict: QualityVerdict,
    ) => Effect.Effect<PackPromotionDecisionEncoded, DriftDetected | PolicyViolation>;
  }
>()("@effect-scrapling/foundation/ReflectionEngine") {}

export class WorkflowRunner extends ServiceMap.Service<
  WorkflowRunner,
  {
    readonly inspect: (
      runId: CanonicalIdentifier,
    ) => Effect.Effect<
      Option.Option<WorkflowInspectionSnapshot>,
      CheckpointCorruption | ProviderUnavailable
    >;
    readonly cancelRun: (
      runId: CanonicalIdentifier,
    ) => Effect.Effect<
      Option.Option<WorkflowControlResult>,
      CheckpointCorruption | ProviderUnavailable | PolicyViolation
    >;
    readonly deferRun: (
      runId: CanonicalIdentifier,
    ) => Effect.Effect<
      Option.Option<WorkflowControlResult>,
      CheckpointCorruption | ProviderUnavailable | PolicyViolation
    >;
    readonly resume: (
      checkpoint: RunCheckpointEncoded,
    ) => Effect.Effect<
      RunCheckpointEncoded,
      CheckpointCorruption | DuplicateWorkClaim | ProviderUnavailable | PolicyViolation
    >;
    readonly replayRun: (
      runId: CanonicalIdentifier,
    ) => Effect.Effect<
      Option.Option<WorkflowControlResult>,
      CheckpointCorruption | DuplicateWorkClaim | ProviderUnavailable | PolicyViolation
    >;
    readonly resumeRun: (
      runId: CanonicalIdentifier,
    ) => Effect.Effect<
      Option.Option<WorkflowControlResult>,
      CheckpointCorruption | DuplicateWorkClaim | ProviderUnavailable | PolicyViolation
    >;
    readonly retryRun: (
      runId: CanonicalIdentifier,
    ) => Effect.Effect<
      Option.Option<WorkflowControlResult>,
      CheckpointCorruption | DuplicateWorkClaim | ProviderUnavailable | PolicyViolation
    >;
    readonly start: (
      plan: RunPlan,
    ) => Effect.Effect<
      RunCheckpointEncoded,
      CheckpointCorruption | DuplicateWorkClaim | ProviderUnavailable | PolicyViolation
    >;
  }
>()("@effect-scrapling/foundation/WorkflowRunner") {}

export class ArtifactExporter extends ServiceMap.Service<
  ArtifactExporter,
  {
    readonly exportArtifact: (
      artifact: ArtifactMetadataRecord,
    ) => Effect.Effect<StorageLocator, PolicyViolation | ProviderUnavailable>;
  }
>()("@effect-scrapling/foundation/ArtifactExporter") {}
