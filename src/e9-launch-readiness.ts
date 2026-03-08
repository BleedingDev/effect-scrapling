import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "@effect-scrapling/foundation-core";
import { E9HighFrictionCanaryArtifactSchema } from "./e9-high-friction-canary.ts";
import { E9ScraplingParityArtifactSchema } from "./e9-scrapling-parity.ts";
import { E9ReferencePackValidationArtifactSchema } from "./e9-reference-pack-validation.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

export const E9LaunchReadinessArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e9-launch-readiness"),
  readinessId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  status: Schema.Literals(["pass", "fail"] as const),
  sections: Schema.Struct({
    referencePacks: Schema.Boolean,
    parity: Schema.Boolean,
    canary: Schema.Boolean,
    docs: Schema.Boolean,
    rollbackReady: Schema.Boolean,
    promotionReady: Schema.Boolean,
  }),
  missingItems: Schema.Array(NonEmptyStringSchema),
  requiredDocs: Schema.Array(NonEmptyStringSchema),
});

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GENERATED_AT = "2026-03-08T22:35:00.000Z";

const REQUIRED_DOCS = [
  "docs/runbooks/e9-reference-pack-validation.md",
  "docs/runbooks/e9-scrapling-parity-benchmark.md",
  "docs/runbooks/e9-high-friction-canary.md",
  "docs/runbooks/e9-launch-migration.md",
  "docs/runbooks/e9-launch-readiness.md",
  "docs/runbooks/e9-operations-rollback-drill.md",
] as const;

type LaunchReadinessDependencies = {
  readonly readJson?: (path: string) => Promise<unknown>;
  readonly pathExists?: (path: string) => Promise<boolean>;
};

export async function runE9LaunchReadiness(dependencies: LaunchReadinessDependencies = {}) {
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

  const [referencePacks, parity, canary] = await Promise.all([
    readJson("docs/artifacts/e9-reference-pack-validation-artifact.json"),
    readJson("docs/artifacts/e9-scrapling-parity-artifact.json"),
    readJson("docs/artifacts/e9-high-friction-canary-artifact.json"),
  ]);
  const referencePackArtifact = Schema.decodeUnknownSync(E9ReferencePackValidationArtifactSchema)(
    referencePacks,
  );
  const parityArtifact = Schema.decodeUnknownSync(E9ScraplingParityArtifactSchema)(parity);
  const canaryArtifact = Schema.decodeUnknownSync(E9HighFrictionCanaryArtifactSchema)(canary);
  const docPresence = await Promise.all(REQUIRED_DOCS.map((path) => pathExists(path)));
  const missingItems = REQUIRED_DOCS.filter((_path, index) => !docPresence[index]);
  const sections = {
    referencePacks: referencePackArtifact.status === "pass",
    parity: parityArtifact.status === "pass",
    canary: canaryArtifact.status === "pass",
    docs: missingItems.length === 0,
    rollbackReady: missingItems.every(
      (path) => path !== "docs/runbooks/e9-operations-rollback-drill.md",
    ),
    promotionReady: referencePackArtifact.results.every(
      ({ governanceResult }) => governanceResult.activeArtifact?.definition.pack.state === "active",
    ),
  };
  const status =
    sections.referencePacks &&
    sections.parity &&
    sections.canary &&
    sections.docs &&
    sections.rollbackReady &&
    sections.promotionReady
      ? "pass"
      : "fail";

  return Schema.decodeUnknownSync(E9LaunchReadinessArtifactSchema)({
    benchmark: "e9-launch-readiness",
    readinessId: "readiness-e9-launch",
    generatedAt: GENERATED_AT,
    status,
    sections,
    missingItems,
    requiredDocs: [...REQUIRED_DOCS],
  });
}
