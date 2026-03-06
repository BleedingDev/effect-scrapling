import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const TARGET_RUNBOOK_PATH = join(REPO_ROOT, "docs", "runbooks", "e1-target-profile.md");
const ACCESS_RUNBOOK_PATH = join(REPO_ROOT, "docs", "runbooks", "e1-access-policy.md");

describe("E1 schema runbooks verification", () => {
  it("documents target profile usage, troubleshooting, and rollback guidance", async () => {
    const runbook = await readFile(TARGET_RUNBOOK_PATH, "utf8");

    expect(runbook).toContain("TargetProfile");
    expect(runbook).toContain("TargetKind");
    expect(runbook).toContain("canonical identity");
    expect(runbook).toContain("bun test tests/libs/foundation-core.test.ts");
    expect(runbook).toContain("Schema.decodeUnknownSync(TargetProfileSchema)");
    expect(runbook).toContain("bun test tests/guardrails/e1-target-profile.verify.test.ts");
    expect(runbook).toContain("bun test tests/guardrails/e1-schema-runbooks.verify.test.ts");
    expect(runbook).toContain("bunx --bun tsc --noEmit -p libs/foundation/core/tsconfig.json");
    expect(runbook).toContain("bunx --bun tsc --noEmit -p apps/api/tsconfig.json");
    expect(runbook).toContain("bunx --bun tsc --noEmit -p apps/cli/tsconfig.json");
    expect(runbook).toContain("bun run check");
    expect(runbook).toContain("## Troubleshooting");
    expect(runbook).toContain("## Rollback Guidance");
    expect(runbook).toContain("Effect v4 only");
  });

  it("documents access policy usage, supported matrix, troubleshooting, and rollback guidance", async () => {
    const runbook = await readFile(ACCESS_RUNBOOK_PATH, "utf8");

    expect(runbook).toContain("AccessPolicy");
    expect(runbook).toContain("AccessMode");
    expect(runbook).toContain("RenderingPolicy");
    expect(runbook).toContain("| `http` | `never` |");
    expect(runbook).toContain("| `browser` | `onDemand`, `always` |");
    expect(runbook).toContain("bun test tests/libs/foundation-core.test.ts");
    expect(runbook).toContain("bun test tests/guardrails/e1-access-policy.verify.test.ts");
    expect(runbook).toContain("bun test tests/guardrails/e1-schema-runbooks.verify.test.ts");
    expect(runbook).toContain("bunx --bun tsc --noEmit -p libs/foundation/core/tsconfig.json");
    expect(runbook).toContain("bunx --bun tsc --noEmit -p apps/api/tsconfig.json");
    expect(runbook).toContain("bunx --bun tsc --noEmit -p apps/cli/tsconfig.json");
    expect(runbook).toContain("bun run check");
    expect(runbook).toContain("## Troubleshooting");
    expect(runbook).toContain("## Rollback Guidance");
    expect(runbook).toContain("Effect v4 only");
  });
});
