import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const RUNBOOK_PATH = join(REPO_ROOT, "docs", "runbooks", "e1-operations-rollback-drill.md");
const ARTIFACT_PATH = join(REPO_ROOT, "docs", "artifacts", "e1-rollback-drill.md");

describe("E1 operations rollback drill verification", () => {
  it("documents the current operator command contract", async () => {
    const runbook = await readFile(RUNBOOK_PATH, "utf8");

    expect(runbook).toContain('TEMP_DIR="$(mktemp -d -t e1-rollback-drill.XXXXXX)"');
    expect(runbook).toContain('git clone . "$TEMP_DIR/repo"');
    expect(runbook).toContain("bun install --frozen-lockfile");
    expect(runbook).toContain("bun run check:e1-capability-slice");
    expect(runbook).toContain("bun run example:e1-foundation-core-consumer");
    expect(runbook).toContain(
      "bun run scripts/benchmarks/e1-performance-budget.ts --sample-size 3 --warmup 1",
    );
    expect(runbook).toContain("rm -rf node_modules dist");
    expect(runbook).toContain("Record the actual disposable clone path");
    expect(runbook).toContain("docs/artifacts/e1-rollback-drill.md");
  });

  it("captures executed rollback drill evidence", async () => {
    const artifact = await readFile(ARTIFACT_PATH, "utf8");

    expect(artifact).toContain("/private/tmp/e1-rollback-drill.");
    expect(artifact).toContain("bun install --frozen-lockfile");
    expect(artifact).toContain("bun run check:e1-capability-slice");
    expect(artifact).toContain("bun run example:e1-foundation-core-consumer");
    expect(artifact).toContain('"benchmark": "e1-performance-budget"');
    expect(artifact).toContain('"status": "pass"');
    expect(artifact).toContain("Command: rm -rf node_modules dist");
    expect(artifact).toContain("- `node_modules`: absent");
    expect(artifact).toContain("- `dist`: absent");

    const capabilityPasses =
      artifact.match(
        /E1 capability slice verification > executes the public foundation-core capability slice/gu,
      ) ?? [];
    expect(capabilityPasses).toHaveLength(2);
  });
});
