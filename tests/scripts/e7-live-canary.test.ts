import { rm } from "node:fs/promises";
import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import { LiveCanaryArtifactSchema } from "../../libs/foundation/core/src/live-canary-runtime.ts";
import {
  createDefaultLiveCanaryInput,
  parseOptions,
  runDefaultLiveCanary,
  runLiveCanaryCli,
} from "../../scripts/benchmarks/e7-live-canary.ts";

describe("e7 live canary harness", () => {
  it("parses only the supported --artifact option", () => {
    expect(parseOptions([])).toEqual({
      artifactPath: undefined,
    });
    expect(parseOptions(["--artifact", "tmp/e7-live-canary.json"])).toEqual({
      artifactPath: "tmp/e7-live-canary.json",
    });
    expect(() => parseOptions(["--artifact"])).toThrow("Missing value for argument: --artifact");
    expect(() => parseOptions(["--unknown"])).toThrow("Unknown argument: --unknown");
  });

  it("writes a passing canary artifact and feeds promotion impact through the harness", async () => {
    const artifactPath = "tmp/e7-live-canary-artifact.json";

    try {
      const artifact = await runDefaultLiveCanary({
        artifactPath,
      });

      expect(artifact.benchmark).toBe("e7-live-canary");
      expect(artifact.summary.verdict).toBe("promote");
      expect(createDefaultLiveCanaryInput().scenarios).toHaveLength(2);
    } finally {
      await rm("tmp", { force: true, recursive: true });
    }
  });

  it("persists the same deterministic artifact that the CLI emits on success", async () => {
    const artifactPath = "tmp/e7-live-canary-cli-artifact.json";
    const exitCodes = new Array<number>();
    const output = new Array<string>();

    try {
      const artifact = await runLiveCanaryCli(["--artifact", artifactPath], {
        setExitCode: (code) => {
          exitCodes.push(code);
        },
        writeLine: (line) => {
          output.push(line);
        },
      });
      const persistedArtifact = Schema.decodeUnknownSync(LiveCanaryArtifactSchema)(
        JSON.parse(await Bun.file(artifactPath).text()),
      );

      expect(exitCodes).toEqual([]);
      expect(output).toHaveLength(1);
      const outputLine = output[0];
      if (outputLine === undefined) {
        throw new Error("Expected the live canary CLI to emit exactly one artifact line.");
      }
      expect(JSON.parse(outputLine)).toEqual(artifact);
      expect(persistedArtifact).toEqual(artifact);
      expect(
        artifact.results.map(({ scenarioId, provider, action, status }) => ({
          scenarioId,
          provider,
          action,
          status,
        })),
      ).toEqual([
        {
          scenarioId: "canary-product-browser",
          provider: "browser",
          action: "active",
          status: "pass",
        },
        {
          scenarioId: "canary-product-http",
          provider: "http",
          action: "active",
          status: "pass",
        },
      ]);
    } finally {
      await rm("tmp", { force: true, recursive: true });
    }
  });

  it("fails the CLI deterministically on unsupported arguments", async () => {
    const exitCodes = new Array<number>();
    const output = new Array<string>();

    await expect(
      runLiveCanaryCli(["--unknown"], {
        setExitCode: (code) => {
          exitCodes.push(code);
        },
        writeLine: (line) => {
          output.push(line);
        },
      }),
    ).rejects.toThrow("Unknown argument: --unknown");
    expect(exitCodes).toEqual([1]);
    expect(output).toEqual([]);
  });
});
