import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const TRIAGE_ARTIFACT_PATH = join(REPO_ROOT, "docs", "artifacts", "e1-post-validation-triage.md");

describe("E1 post-validation triage verification", () => {
  it("captures residual and deferred findings without inventing new blockers", async () => {
    const artifact = await readFile(TRIAGE_ARTIFACT_PATH, "utf8");

    expect(artifact).toContain(
      "New E1-blocking defects discovered during post-validation triage: none",
    );
    expect(artifact).toContain("New follow-up beads required from this triage pass: none");
    expect(artifact).toContain("docs/runbooks/e1-security-review.md");
    expect(artifact).toContain("docs/runbooks/e1-performance-budget.md");
    expect(artifact).toContain("docs/runbooks/e1-service-topology.md");
    expect(artifact).toContain("Public error envelopes intentionally preserve a human-readable");
    expect(artifact).toContain("Performance baselines are local-machine artifacts");
    expect(artifact).toContain("The E1 service-topology surface is intentionally broader");
    expect(artifact).toContain("No new child beads were created by `bd-7aw.36`.");
  });
});
