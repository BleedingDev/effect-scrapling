import { Effect, Schema } from "effect";
import {
  E8ArtifactExportEnvelopeSchema,
  E8BenchmarkRunEnvelopeSchema,
  TargetImportEnvelopeSchema,
  TargetListEnvelopeSchema,
  WorkspaceConfigShowEnvelopeSchema,
  WorkspaceDoctorEnvelopeSchema,
  withE8Runtime,
  runArtifactExportOperation,
  runBenchmarkOperation,
  runTargetImportOperation,
  runTargetListOperation,
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
  "Target catalogs must preserve canonical ids and deterministic ordering; malformed catalogs fail at the public E8 boundary instead of being patched implicitly.",
] as const;

function makeTarget(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly domain: string;
  readonly kind: "productPage" | "productListing";
  readonly priority: number;
}) {
  return {
    id: input.id,
    tenantId: input.tenantId,
    domain: input.domain,
    kind: input.kind,
    canonicalKey: `${input.kind}/${input.id}`,
    seedUrls: [`https://${input.domain}/${input.id}`],
    accessPolicyId: "policy-default",
    packId: "pack-shop-example-com",
    priority: input.priority,
  };
}

export function runE8SdkConsumerExample() {
  return withE8Runtime(
    Effect.gen(function* () {
      const targets = [
        makeTarget({
          id: "target-sdk-consumer-product-001",
          tenantId: "tenant-main",
          domain: "shop.example.com",
          kind: "productPage",
          priority: 20,
        }),
        makeTarget({
          id: "target-sdk-consumer-listing-001",
          tenantId: "tenant-main",
          domain: "shop.example.com",
          kind: "productListing",
          priority: 10,
        }),
      ];
      const doctor = yield* runWorkspaceDoctor();
      const config = yield* showWorkspaceConfig();
      const targetImport = yield* runTargetImportOperation({ targets });
      const targetList = yield* runTargetListOperation({
        targets,
        filters: {
          domain: "shop.example.com",
        },
      });
      const benchmarkRun = yield* runBenchmarkOperation();
      const artifactExport = yield* runArtifactExportOperation();

      return {
        importPath: "effect-scrapling/e8" as const,
        prerequisites: e8SdkConsumerPrerequisites,
        pitfalls: e8SdkConsumerPitfalls,
        payload: {
          doctor: Schema.encodeSync(WorkspaceDoctorEnvelopeSchema)(doctor),
          config: Schema.encodeSync(WorkspaceConfigShowEnvelopeSchema)(config),
          targetImport: Schema.encodeSync(TargetImportEnvelopeSchema)(targetImport),
          targetList: Schema.encodeSync(TargetListEnvelopeSchema)(targetList),
          benchmarkRun: Schema.encodeSync(E8BenchmarkRunEnvelopeSchema)(benchmarkRun),
          artifactExport: Schema.encodeSync(E8ArtifactExportEnvelopeSchema)(artifactExport),
        },
      };
    }),
  );
}

if (import.meta.main) {
  const result = await Effect.runPromise(runE8SdkConsumerExample());
  console.log(JSON.stringify(result, null, 2));
}
