import { Effect, Schema } from "effect";
import {
  E8ArtifactExportEnvelopeSchema,
  E8BenchmarkRunEnvelopeSchema,
  WorkspaceConfigShowEnvelopeSchema,
  WorkspaceDoctorEnvelopeSchema,
  runArtifactExportOperation,
  runBenchmarkOperation,
  runWorkspaceDoctor,
  showWorkspaceConfig,
} from "effect-scrapling/e8";

export const e8SdkConsumerPrerequisites = [
  "Bun >= 1.3.10",
  'Run from repository root with "bun run example:e8-sdk-consumer".',
  "Use only the public effect-scrapling/e8 package subpath for E8 workspace and control-plane consumers.",
] as const;

export const e8SdkConsumerPitfalls = [
  "Do not import repository-private benchmark scripts or src files from downstream consumers.",
  "Artifact export sanitizes persisted benchmark paths; treat the exported bundle as the public transport surface, not the raw docs artifact files.",
  "Benchmark metadata and exported bundle serve different purposes: one summarizes executed commands, the other transports sanitized evidence.",
] as const;

export function runE8SdkConsumerExample() {
  return Effect.gen(function* () {
    const doctor = yield* runWorkspaceDoctor();
    const config = yield* showWorkspaceConfig();
    const benchmarkRun = yield* runBenchmarkOperation();
    const artifactExport = yield* runArtifactExportOperation();

    return {
      importPath: "effect-scrapling/e8" as const,
      prerequisites: e8SdkConsumerPrerequisites,
      pitfalls: e8SdkConsumerPitfalls,
      payload: {
        doctor: Schema.encodeSync(WorkspaceDoctorEnvelopeSchema)(doctor),
        config: Schema.encodeSync(WorkspaceConfigShowEnvelopeSchema)(config),
        benchmarkRun: Schema.encodeSync(E8BenchmarkRunEnvelopeSchema)(benchmarkRun),
        artifactExport: Schema.encodeSync(E8ArtifactExportEnvelopeSchema)(artifactExport),
      },
    };
  });
}

if (import.meta.main) {
  const result = await Effect.runPromise(runE8SdkConsumerExample());
  console.log(JSON.stringify(result, null, 2));
}
