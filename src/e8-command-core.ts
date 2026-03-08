import { Effect, Schema } from "effect";
import {
  RunConfigSourceSchema,
  RunExecutionConfigSchema,
  resolveRunExecutionConfig,
} from "@effect-scrapling/foundation-core";
import { readBrowserPoolLimits } from "./sdk/browser-pool.ts";
import { runDoctor } from "./sdk/scraper.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));

const WORKSPACE_PACKAGE_INFO = {
  name: "effect-scrapling",
  version: "0.0.1",
} as const;

const WORKSPACE_CONFIG_SOURCE_ORDER = ["defaults", "sitePack", "targetProfile", "run"] as const;

const WORKSPACE_CONFIG_CASCADE = {
  defaults: {
    targetId: "workspace-target-default",
    targetDomain: "example.com",
    packId: "workspace-pack-default",
    accessPolicyId: "workspace-access-default",
    entryUrl: "https://example.com/workspace/default",
    mode: "http",
    render: "never",
    perDomainConcurrency: 2,
    globalConcurrency: 8,
    timeoutMs: 30_000,
    maxRetries: 1,
    checkpointInterval: 3,
    artifactNamespace: "artifacts/workspace-default",
    checkpointNamespace: "checkpoints/workspace-default",
  },
} as const;

export const WorkspaceCommandNameSchema = Schema.Literals(["doctor", "config-show"] as const);
export type WorkspaceCommandName = Schema.Schema.Type<typeof WorkspaceCommandNameSchema>;

export const WorkspacePackageInfoSchema = Schema.Struct({
  name: NonEmptyStringSchema,
  version: NonEmptyStringSchema,
});

export const WorkspaceRuntimeSchema = Schema.Struct({
  bun: NonEmptyStringSchema,
  platform: NonEmptyStringSchema,
  arch: NonEmptyStringSchema,
});

export const WorkspaceDoctorCheckSchema = Schema.Struct({
  name: NonEmptyStringSchema,
  ok: Schema.Boolean,
  details: NonEmptyStringSchema,
});

export const WorkspaceDoctorDataSchema = Schema.Struct({
  ok: Schema.Boolean,
  runtime: WorkspaceRuntimeSchema,
  checks: Schema.Array(WorkspaceDoctorCheckSchema),
});

export const WorkspaceDoctorEnvelopeSchema = Schema.Struct({
  ok: Schema.Boolean,
  command: Schema.Literal("doctor"),
  data: WorkspaceDoctorDataSchema,
  warnings: Schema.Array(NonEmptyStringSchema),
});

export const BrowserPoolLimitsSchema = Schema.Struct({
  maxContexts: PositiveIntSchema,
  maxPages: PositiveIntSchema,
  maxQueue: PositiveIntSchema,
});

export const WorkspaceConfigShowDataSchema = Schema.Struct({
  package: WorkspacePackageInfoSchema,
  runtime: WorkspaceRuntimeSchema,
  browserPool: BrowserPoolLimitsSchema,
  sourceOrder: Schema.Array(RunConfigSourceSchema),
  runConfigDefaults: RunExecutionConfigSchema,
});

export const WorkspaceConfigShowEnvelopeSchema = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("config show"),
  data: WorkspaceConfigShowDataSchema,
  warnings: Schema.Array(NonEmptyStringSchema),
});

export const runWorkspaceDoctor = Effect.fn("E8.runWorkspaceDoctor")(function* () {
  const report = yield* runDoctor();

  return Schema.decodeUnknownSync(WorkspaceDoctorEnvelopeSchema)({
    ok: report.ok,
    command: "doctor",
    data: report,
    warnings: report.ok ? [] : ["One or more runtime checks failed"],
  });
});

export const showWorkspaceConfig = Effect.fn("E8.showWorkspaceConfig")(function* () {
  const report = yield* runDoctor();
  const runConfigDefaults = resolveRunExecutionConfig(WORKSPACE_CONFIG_CASCADE);

  return Schema.decodeUnknownSync(WorkspaceConfigShowEnvelopeSchema)({
    ok: true,
    command: "config show",
    data: {
      package: WORKSPACE_PACKAGE_INFO,
      runtime: report.runtime,
      browserPool: readBrowserPoolLimits(),
      sourceOrder: WORKSPACE_CONFIG_SOURCE_ORDER,
      runConfigDefaults,
    },
    warnings: [],
  });
});

export const executeWorkspaceCommand = Effect.fn("E8.executeWorkspaceCommand")(function* (
  command: WorkspaceCommandName,
) {
  switch (command) {
    case "doctor":
      return yield* runWorkspaceDoctor();
    case "config-show":
      return yield* showWorkspaceConfig();
  }
});
