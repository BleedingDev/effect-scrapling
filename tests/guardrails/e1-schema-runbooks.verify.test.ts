import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const TARGET_RUNBOOK_PATH = join(REPO_ROOT, "docs", "runbooks", "e1-target-profile.md");
const ACCESS_RUNBOOK_PATH = join(REPO_ROOT, "docs", "runbooks", "e1-access-policy.md");
const SITE_PACK_RUNBOOK_PATH = join(REPO_ROOT, "docs", "runbooks", "e1-site-pack-state.md");
const OBSERVATION_RUNBOOK_PATH = join(REPO_ROOT, "docs", "runbooks", "e1-observation-snapshot.md");
const BUDGET_LEASE_RUNBOOK_PATH = join(
  REPO_ROOT,
  "docs",
  "runbooks",
  "e1-budget-lease-artifact.md",
);
const WORKFLOW_RUN_STATE_RUNBOOK_PATH = join(
  REPO_ROOT,
  "docs",
  "runbooks",
  "e1-workflow-run-state.md",
);
const DIFF_VERDICT_RUNBOOK_PATH = join(REPO_ROOT, "docs", "runbooks", "e1-diff-verdict.md");
const SERVICE_TOPOLOGY_RUNBOOK_PATH = join(REPO_ROOT, "docs", "runbooks", "e1-service-topology.md");
const CONFIG_STORAGE_RUNBOOK_PATH = join(REPO_ROOT, "docs", "runbooks", "e1-config-storage.md");
const TAGGED_ERRORS_RUNBOOK_PATH = join(REPO_ROOT, "docs", "runbooks", "e1-tagged-errors.md");

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

  it("keeps the budget and lease runbook present for operators", async () => {
    const runbook = await readRunbook(BUDGET_LEASE_RUNBOOK_PATH);

    expect(runbook).toContain("ConcurrencyBudget");
    expect(runbook).toContain("EgressLease");
    expect(runbook).toContain("IdentityLease");
    expect(runbook).toContain("ArtifactRef");
  });

  it("keeps the workflow run-state runbook present for operators", async () => {
    const runbook = await readRunbook(WORKFLOW_RUN_STATE_RUNBOOK_PATH);

    expect(runbook).toContain("RunPlan");
    expect(runbook).toContain("RunCheckpoint");
    expect(runbook).toContain("RunStats");
  });

  it("keeps the diff verdict runbook present for operators", async () => {
    const runbook = await readRunbook(DIFF_VERDICT_RUNBOOK_PATH);

    expect(runbook).toContain("SnapshotDiff");
    expect(runbook).toContain("QualityVerdict");
    expect(runbook).toContain("PackPromotionDecision");
  });

  it("keeps the service topology runbook present for operators", async () => {
    const runbook = await readRunbook(SERVICE_TOPOLOGY_RUNBOOK_PATH);

    expect(runbook).toContain("TargetRegistry");
    expect(runbook).toContain("WorkflowRunner");
    expect(runbook).toContain("Layer");
  });

  it("keeps the config and storage runbook present for operators", async () => {
    const runbook = await readRunbook(CONFIG_STORAGE_RUNBOOK_PATH);

    expect(runbook).toContain("RunExecutionConfig");
    expect(runbook).toContain("CheckpointRecord");
    expect(runbook).toContain("ArtifactMetadataStore");
  });

  it("keeps the tagged errors runbook present for operators", async () => {
    const runbook = await readRunbook(TAGGED_ERRORS_RUNBOOK_PATH);

    expect(runbook).toContain("TimeoutError");
    expect(runbook).toContain("PolicyViolation");
    expect(runbook).toContain("provider_unavailable");
  });
});
