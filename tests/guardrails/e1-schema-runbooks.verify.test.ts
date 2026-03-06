import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const TARGET_RUNBOOK_PATH = join(REPO_ROOT, "docs", "runbooks", "e1-target-profile.md");
const ACCESS_RUNBOOK_PATH = join(REPO_ROOT, "docs", "runbooks", "e1-access-policy.md");
const SITE_PACK_RUNBOOK_PATH = join(REPO_ROOT, "docs", "runbooks", "e1-site-pack-state.md");
const OBSERVATION_RUNBOOK_PATH = join(REPO_ROOT, "docs", "runbooks", "e1-observation-snapshot.md");

async function readRunbook(path: string): Promise<string> {
  const runbook = await readFile(path, "utf8");

  expect(runbook.trim().length).toBeGreaterThan(0);
  expect(runbook).toContain("## Troubleshooting");
  expect(runbook).toContain("## Rollback Guidance");
  expect(runbook).toContain("Effect v4 only");

  return runbook;
}

describe("E1 schema runbooks verification", () => {
  it("keeps the target profile runbook present for operators", async () => {
    const runbook = await readRunbook(TARGET_RUNBOOK_PATH);

    expect(runbook).toContain("TargetProfile");
    expect(runbook).toContain("TargetKind");
  });

  it("keeps the access policy runbook present for operators", async () => {
    const runbook = await readRunbook(ACCESS_RUNBOOK_PATH);

    expect(runbook).toContain("AccessPolicy");
    expect(runbook).toContain("AccessMode");
    expect(runbook).toContain("RenderingPolicy");
  });

  it("keeps the site pack runbook present for operators", async () => {
    const runbook = await readRunbook(SITE_PACK_RUNBOOK_PATH);

    expect(runbook).toContain("SitePack");
    expect(runbook).toContain("PackState");
    expect(runbook).toContain("PackLifecycleTransition");
  });

  it("keeps the observation runbook present for operators", async () => {
    const runbook = await readRunbook(OBSERVATION_RUNBOOK_PATH);

    expect(runbook).toContain("Observation");
    expect(runbook).toContain("Snapshot");
    expect(runbook).toContain("evidence");
  });
});
