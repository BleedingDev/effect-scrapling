import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const RUNBOOK_PATH = join(REPO_ROOT, "docs", "runbooks", "e0-operations-rollback-drill.md");
const ARTIFACT_PATH = join(REPO_ROOT, "docs", "artifacts", "e0-rollback-drill.md");

describe("E0 operations rollback drill verification", () => {
  it("documents the current operator command contract", async () => {
    const runbook = await readFile(RUNBOOK_PATH, "utf8");

    expect(runbook).toContain('TEMP_DIR="$(mktemp -d -t e0-rollback-drill.XXXXXX)"');
    expect(runbook).toContain('git clone . "$TEMP_DIR/repo"');
    expect(runbook).toContain('cd "$TEMP_DIR/repo"');
    expect(runbook).toContain("bun run scripts/preflight-bootstrap.ts");
    expect(runbook).toContain("bun install --frozen-lockfile");
    expect(runbook).toContain("bun run scripts/bootstrap-doctor.ts");
    expect(runbook).toContain("rm -rf node_modules dist");
    expect(runbook).toContain("bun run check:e0-capability-slice");
    expect(runbook).toContain("Record the actual disposable clone path");
    expect(runbook).toContain("docs/artifacts/e0-rollback-drill.md");
  });

  it("captures executed rollback drill evidence", async () => {
    const artifact = await readFile(ARTIFACT_PATH, "utf8");

    expect(artifact).toContain("/private/tmp/e0-rollback-drill.");
    expect(artifact).toContain("Preflight passed (5/5 checks).");
    expect(artifact).toContain("Bootstrap doctor passed (12 readiness gates).");
    expect(artifact).toContain("Command:");
    expect(artifact).toContain("rm -rf node_modules dist");
    expect(artifact).toContain("- `node_modules`: absent");
    expect(artifact).toContain("- `dist`: absent");
    expect(artifact).toContain("bun install --frozen-lockfile");

    const doctorPasses = artifact.match(/Bootstrap doctor passed \(12 readiness gates\)\./gu) ?? [];
    expect(doctorPasses).toHaveLength(2);
  });
});
