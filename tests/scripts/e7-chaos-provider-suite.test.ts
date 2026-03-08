import { afterEach, describe, expect, it, mock } from "@effect-native/bun-test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { ChaosProviderSuiteArtifactSchema } from "../../libs/foundation/core/src/chaos-provider-suite-runtime.ts";
import {
  createDefaultChaosProviderSuite,
  parseOptions,
  runChaosProviderSuiteCli,
  runDefaultChaosProviderSuite,
} from "../../scripts/benchmarks/e7-chaos-provider-suite.ts";

describe("e7 chaos provider suite benchmark harness", () => {
  afterEach(() => {
    mock.restore();
  });

  it("parses only the supported --artifact option", () => {
    expect(parseOptions([])).toEqual({});
    expect(parseOptions(["--artifact", "tmp/e7-chaos-provider-suite.json"])).toEqual({
      artifactPath: "tmp/e7-chaos-provider-suite.json",
    });
    expect(() => parseOptions(["--artifact"])).toThrow("Missing value for argument: --artifact");
    expect(() => parseOptions(["--unexpected"])).toThrow("Unknown argument: --unexpected");
  });

  it("builds a deterministic default chaos provider suite fixture", () => {
    const suite = createDefaultChaosProviderSuite();

    expect(suite.suiteId).toBe("suite-e7-chaos-provider");
    expect(suite.scenarios.map(({ scenarioId }) => scenarioId)).toEqual([
      "scenario-provider-outage",
      "scenario-network-timeout",
      "scenario-throttling-window",
    ]);
  });

  it("runs the default chaos provider suite and persists the reproducible artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e7-chaos-provider-suite-"));
    const artifactPath = join(directory, "artifact.json");
    const writes = new Array<string>();

    try {
      const artifact = await runChaosProviderSuiteCli(["--artifact", artifactPath], {
        writeLine: (line) => {
          writes.push(line);
        },
      });
      const persistedArtifact = Schema.decodeUnknownSync(ChaosProviderSuiteArtifactSchema)(
        JSON.parse(await readFile(artifactPath, "utf8")),
      );

      expect(Schema.encodeSync(ChaosProviderSuiteArtifactSchema)(artifact)).toEqual(
        Schema.encodeSync(ChaosProviderSuiteArtifactSchema)(persistedArtifact),
      );
      expect(artifact.status).toBe("pass");
      expect(artifact.failedScenarioIds).toEqual([]);
      expect(artifact.results.map(({ actualFailedStages }) => actualFailedStages)).toEqual([
        ["canary"],
        ["chaos"],
        ["canary"],
      ]);
      expect(writes).toHaveLength(1);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("returns the same deterministic artifact through the direct helper", async () => {
    const artifact = await runDefaultChaosProviderSuite();

    expect(artifact.status).toBe("pass");
    expect(artifact.results.map(({ actualProvider }) => actualProvider)).toEqual([
      "browser",
      "browser",
      "browser",
    ]);
  });
});
