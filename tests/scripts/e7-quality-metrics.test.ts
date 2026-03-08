import { rm } from "node:fs/promises";
import { describe, expect, it } from "@effect-native/bun-test";
import {
  parseOptions,
  runDefaultQualityMetrics,
  runQualityMetricsCli,
} from "../../scripts/benchmarks/e7-quality-metrics.ts";

describe("e7 quality metrics harness", () => {
  it("parses only the supported --artifact option", () => {
    expect(parseOptions([])).toEqual({
      artifactPath: undefined,
    });
    expect(parseOptions(["--artifact", "tmp/e7-quality-metrics.json"])).toEqual({
      artifactPath: "tmp/e7-quality-metrics.json",
    });
    expect(() => parseOptions(["--artifact"])).toThrow("Missing value for argument: --artifact");
    expect(() => parseOptions(["--unknown"])).toThrow("Unknown argument: --unknown");
  });

  it("writes deterministic quality metrics artifacts and surfaces CLI failures", async () => {
    const artifactPath = "tmp/e7-quality-metrics-artifact.json";

    try {
      const artifact = await runDefaultQualityMetrics({
        artifactPath,
      });

      expect(artifact.benchmark).toBe("e7-quality-metrics");
      expect(artifact.overall.fieldRecallRate).toBe(1);
      expect(artifact.overall.falsePositiveRate).toBe(0);

      const exitCodes = new Array<number>();
      await expect(
        runQualityMetricsCli(["--unknown"], {
          setExitCode: (code) => {
            exitCodes.push(code);
          },
          writeLine: () => undefined,
        }),
      ).rejects.toThrow("Unknown argument: --unknown");
      expect(exitCodes).toEqual([1]);
    } finally {
      await rm("tmp", { force: true, recursive: true });
    }
  });
});
