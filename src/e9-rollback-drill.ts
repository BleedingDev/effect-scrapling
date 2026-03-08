import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "@effect-scrapling/foundation-core";
import { E9HighFrictionCanaryArtifactSchema } from "./e9-high-friction-canary.ts";
import { E9LaunchReadinessArtifactSchema } from "./e9-launch-readiness.ts";
import { E9ReferencePackValidationArtifactSchema } from "./e9-reference-pack-validation.ts";
import { E9ScraplingParityArtifactSchema } from "./e9-scrapling-parity.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const GENERATED_AT = "2026-03-08T22:45:00.000Z";

const E9RollbackTargetSchema = Schema.Struct({
  domain: Schema.Literals(["alza", "datart", "tsbohemia"] as const),
  rollbackVersion: NonEmptyStringSchema,
});

export const E9RollbackDrillArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e9-rollback-drill"),
  drillId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  status: Schema.Literals(["pass", "fail"] as const),
  executedChecks: Schema.Array(NonEmptyStringSchema),
  rollbackTargets: Schema.Array(E9RollbackTargetSchema),
  recoveryReady: Schema.Boolean,
  missingDocs: Schema.Array(NonEmptyStringSchema),
});

const REQUIRED_DOCS = [
  "docs/runbooks/e9-reference-pack-validation.md",
  "docs/runbooks/e9-scrapling-parity-benchmark.md",
  "docs/runbooks/e9-high-friction-canary.md",
  "docs/runbooks/e9-launch-readiness.md",
  "docs/runbooks/e9-operations-rollback-drill.md",
] as const;

type RollbackDependencies = {
  readonly readJson?: (path: string) => Promise<unknown>;
  readonly pathExists?: (path: string) => Promise<boolean>;
};

export async function runE9RollbackDrill(dependencies: RollbackDependencies = {}) {
  const readJson =
    dependencies.readJson ??
    (async (path: string) => JSON.parse(await Bun.file(resolve(REPO_ROOT, path)).text()));
  const pathExists =
    dependencies.pathExists ??
    (async (path: string) => {
      try {
        await access(resolve(REPO_ROOT, path));
        return true;
      } catch {
        return false;
      }
    });

  const [referencePacks, parity, canary, readiness, docPresence] = await Promise.all([
    readJson("docs/artifacts/e9-reference-pack-validation-artifact.json"),
    readJson("docs/artifacts/e9-scrapling-parity-artifact.json"),
    readJson("docs/artifacts/e9-high-friction-canary-artifact.json"),
    readJson("docs/artifacts/e9-launch-readiness-artifact.json"),
    Promise.all(REQUIRED_DOCS.map((path) => pathExists(path))),
  ]);

  const referencePackArtifact = Schema.decodeUnknownSync(E9ReferencePackValidationArtifactSchema)(
    referencePacks,
  );
  const parityArtifact = Schema.decodeUnknownSync(E9ScraplingParityArtifactSchema)(parity);
  const canaryArtifact = Schema.decodeUnknownSync(E9HighFrictionCanaryArtifactSchema)(canary);
  const readinessArtifact = Schema.decodeUnknownSync(E9LaunchReadinessArtifactSchema)(readiness);
  const missingDocs = REQUIRED_DOCS.filter((_path, index) => !docPresence[index]);
  const rollbackTargets = referencePackArtifact.results.map(({ domain, governanceResult }) => ({
    domain,
    rollbackVersion:
      governanceResult.activeArtifact?.replacedActiveVersion ??
      governanceResult.activeArtifact?.derivedFromVersion ??
      governanceResult.catalog.at(0)?.definition.pack.version ??
      "unknown",
  }));
  const executedChecks = [
    "bun run check:e9-reference-packs",
    "bun run check:e9-scrapling-parity",
    "bun run check:e9-high-friction-canary",
    "bun run check:e9-launch-readiness",
  ] as const;
  const recoveryReady =
    referencePackArtifact.status === "pass" &&
    parityArtifact.status === "pass" &&
    canaryArtifact.status === "pass" &&
    readinessArtifact.status === "pass";

  return Schema.decodeUnknownSync(E9RollbackDrillArtifactSchema)({
    benchmark: "e9-rollback-drill",
    drillId: "drill-e9-rollback",
    generatedAt: GENERATED_AT,
    status: recoveryReady && missingDocs.length === 0 ? "pass" : "fail",
    executedChecks: [...executedChecks],
    rollbackTargets,
    recoveryReady,
    missingDocs,
  });
}
