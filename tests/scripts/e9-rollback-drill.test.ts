import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import { E9RollbackDrillArtifactSchema, runE9RollbackDrill } from "../../src/e9-rollback-drill.ts";
import {
  parseOptions,
  runDefaultE9RollbackDrill,
} from "../../scripts/benchmarks/e9-rollback-drill.ts";

describe("e9 rollback drill replay", () => {
  it("parses only the supported artifact option", () => {
    expect(
      parseOptions([]).artifactPath.endsWith("docs/artifacts/e9-rollback-drill-artifact.json"),
    ).toBe(true);
    expect(
      parseOptions(["--artifact", "tmp/e9-rollback-drill.json"]).artifactPath.endsWith(
        "tmp/e9-rollback-drill.json",
      ),
    ).toBe(true);
    expect(() => parseOptions(["--artifact"])).toThrow("Missing value for argument: --artifact");
    expect(() => parseOptions(["--bogus"])).toThrow("Unknown argument: --bogus");
  });

  it("passes when all supporting E9 artifacts and docs are present", async () => {
    const artifact = await runE9RollbackDrill();
    const decoded = Schema.decodeUnknownSync(E9RollbackDrillArtifactSchema)(artifact);

    expect(decoded.status).toBe("pass");
    expect(decoded.recoveryReady).toBe(true);
    expect(decoded.executedChecks).toEqual([
      "bun run check:e9-reference-packs",
      "bun run check:e9-scrapling-parity",
      "bun run check:e9-high-friction-canary",
      "bun run check:e9-launch-readiness",
    ]);
    expect(decoded.rollbackTargets).toHaveLength(3);
    expect(decoded.missingDocs).toEqual([]);
  });

  it("fails when the rollback drill doc is missing", async () => {
    const artifact = await runE9RollbackDrill({
      pathExists: async (path) => path !== "docs/runbooks/e9-operations-rollback-drill.md",
    });

    expect(artifact.status).toBe("fail");
    expect(artifact.missingDocs).toContain("docs/runbooks/e9-operations-rollback-drill.md");
  });

  it("writes the rollback drill artifact through the CLI harness", async () => {
    const artifact = await runDefaultE9RollbackDrill([]);
    expect(artifact.status).toBe("pass");
  });
});
