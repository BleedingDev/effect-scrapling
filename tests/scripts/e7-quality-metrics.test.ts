import { readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import { QualityMetricsArtifactSchema } from "../../libs/foundation/core/src/quality-metrics-runtime.ts";
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

  it("writes the deterministic quality metrics artifact to disk", async () => {
    const artifactPath = "tmp/e7-quality-metrics-artifact.json";

    try {
      const artifact = await runDefaultQualityMetrics({
        artifactPath,
      });
      const persisted = Schema.decodeUnknownSync(QualityMetricsArtifactSchema)(
        JSON.parse(await readFile(artifactPath, "utf8")),
      );

      expect(persisted).toEqual(artifact);
      expect(artifact.benchmark).toBe("e7-quality-metrics");
      expect(artifact.overall).toEqual({
        caseCount: 2,
        baselineFieldCount: 4,
        candidateFieldCount: 4,
        recalledFieldCount: 4,
        missingFieldCount: 0,
        unexpectedFieldCount: 0,
        changedFieldCount: 0,
        fieldRecallRate: 1,
        falsePositiveRate: 0,
      });
      expect(artifact.packSummaries).toEqual([
        {
          packId: "pack-catalog-example-com",
          caseIds: ["case-catalog-example-com"],
          summary: {
            caseCount: 1,
            baselineFieldCount: 2,
            candidateFieldCount: 2,
            recalledFieldCount: 2,
            missingFieldCount: 0,
            unexpectedFieldCount: 0,
            changedFieldCount: 0,
            fieldRecallRate: 1,
            falsePositiveRate: 0,
          },
        },
        {
          packId: "pack-offers-example-com",
          caseIds: ["case-offers-example-com"],
          summary: {
            caseCount: 1,
            baselineFieldCount: 2,
            candidateFieldCount: 2,
            recalledFieldCount: 2,
            missingFieldCount: 0,
            unexpectedFieldCount: 0,
            changedFieldCount: 0,
            fieldRecallRate: 1,
            falsePositiveRate: 0,
          },
        },
      ]);
    } finally {
      await rm("tmp", { force: true, recursive: true });
    }
  });

  it("prints the artifact on success and surfaces CLI failures with exit code 1", async () => {
    const artifactPath = "tmp/e7-quality-metrics-artifact.json";

    try {
      const lines = new Array<string>();
      const exitCodes = new Array<number>();
      const artifact = await runQualityMetricsCli(["--artifact", artifactPath], {
        setExitCode: (code) => {
          exitCodes.push(code);
        },
        writeLine: (line) => {
          lines.push(line);
        },
      });

      expect(exitCodes).toEqual([]);
      expect(lines).toHaveLength(1);
      expect(
        Schema.decodeUnknownSync(QualityMetricsArtifactSchema)(JSON.parse(lines[0] ?? "")),
      ).toEqual(artifact);

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
