import { rm } from "node:fs/promises";
import { describe, expect, it } from "@effect-native/bun-test";
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

  it("fails the CLI deterministically on unsupported arguments", async () => {
    const exitCodes = new Array<number>();

    await expect(
      runLiveCanaryCli(["--unknown"], {
        setExitCode: (code) => {
          exitCodes.push(code);
        },
        writeLine: () => undefined,
      }),
    ).rejects.toThrow("Unknown argument: --unknown");
    expect(exitCodes).toEqual([1]);
  });
});
