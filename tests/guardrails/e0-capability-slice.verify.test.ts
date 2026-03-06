import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";

type PackageJson = {
  readonly scripts?: Record<string, string>;
};

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json");
const E0_CAPABILITY_SLICE_STEPS = [
  'TARGET_BRANCH="${TARGET_BRANCH:-origin/master}"',
  'NX_BASE="${NX_BASE:-$(git rev-parse "$TARGET_BRANCH")}"',
  'NX_HEAD="${NX_HEAD:-$(git rev-parse HEAD)}"',
  "bun run scripts/preflight-bootstrap.ts",
  "bun run scripts/bootstrap-doctor.ts",
  "bun run nx:show-projects",
  "bun run nx:graph",
  "bun run nx:lint",
  "bun run nx:typecheck",
  "bun run nx:build",
  'bun run nx affected -t lint --base="$NX_BASE" --head="$NX_HEAD" --parallel=1',
  'bun run nx affected -t test --base="$NX_BASE" --head="$NX_HEAD" --parallel=1',
  'bun run nx affected -t typecheck --base="$NX_BASE" --head="$NX_HEAD" --parallel=1',
  'bun run nx affected -t build --base="$NX_BASE" --head="$NX_HEAD" --parallel=1',
  "bun test tests/guardrails/ci-affected-gates.verify.test.ts",
  "bun test tests/guardrails/nx-compliant-module-generator.verify.test.ts",
  "bun test tests/guardrails/bootstrap-doctor.verify.test.ts",
  "bun test tests/guardrails/nx-workspace.verify.test.ts",
  "bun test tests/guardrails/e0-security-review.verify.test.ts",
  "bun test tests/guardrails/e0-performance-budget.verify.test.ts",
  "bun test tests/guardrails/e0-operations-rollback-drill.verify.test.ts",
  "bun test tests/sdk/consumer-example.test.ts",
  "bun test tests/guardrails/e0-capability-slice.verify.test.ts",
  "bun run check",
] as const;

async function readPackageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8")) as PackageJson;
}

describe("E0 capability slice verification", () => {
  it("keeps a deterministic end-to-end workspace foundation command contract", async () => {
    const packageJson = await readPackageJson();
    const command = packageJson.scripts?.["check:e0-capability-slice"];

    expect(command).toBeDefined();

    if (command === undefined) {
      return;
    }

    expect(command.split(" && ")).toEqual([...E0_CAPABILITY_SLICE_STEPS]);
  });
});
