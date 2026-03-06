import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const TRIAGE_ARTIFACT_PATH = join(REPO_ROOT, "docs", "artifacts", "e0-post-validation-triage.md");

describe("E0 post-validation triage verification", () => {
  it("captures residual and deferred findings without inventing new blockers", async () => {
    const artifact = await readFile(TRIAGE_ARTIFACT_PATH, "utf8");

    expect(artifact).toContain(
      "New E0-blocking defects discovered during post-validation triage: none",
    );
    expect(artifact).toContain("New follow-up beads required from this triage pass: none");
    expect(artifact).toContain("docs/runbooks/e0-security-review.md");
    expect(artifact).toContain("docs/guardrail-parity.md");
    expect(artifact).toContain("DNS rebinding / resolver drift");
    expect(artifact).toContain("Full enterprise check suite parity");
    expect(artifact).toContain("Richer Nx project-tag taxonomy");
    expect(artifact).toContain("No new child beads were created by `bd-onp.36`.");
  });
});
