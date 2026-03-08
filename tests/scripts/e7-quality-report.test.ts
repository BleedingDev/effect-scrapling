import { afterEach, describe, expect, it, mock } from "@effect-native/bun-test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { QualityReportArtifactSchema } from "../../libs/foundation/core/src/quality-report-runtime.ts";
import {
  createDefaultQualityReportInput,
  parseOptions,
  runDefaultQualityReport,
  runQualityReportCli,
} from "../../scripts/benchmarks/e7-quality-report.ts";

describe("e7 quality report harness", () => {
  afterEach(() => {
    mock.restore();
  });

  it("parses only the supported --artifact option", () => {
    expect(parseOptions([])).toEqual({});
    expect(parseOptions(["--artifact", "tmp/e7-quality-report.json"])).toEqual({
      artifactPath: "tmp/e7-quality-report.json",
    });
    expect(() => parseOptions(["--artifact"])).toThrow("Missing value for argument: --artifact");
    expect(() => parseOptions(["--unknown"])).toThrow("Unknown argument: --unknown");
  });

  it("builds a default evidence bundle with aligned report sources", async () => {
    const input = await createDefaultQualityReportInput();

    expect(input.evidence.baselineCorpus.corpusId).toBe(
      input.evidence.incumbentComparison.incumbentCorpusId,
    );
    expect(input.evidence.driftRegression.analysisId).toBe(
      input.evidence.promotionGate.quality.analysisId,
    );
  });

  it("runs the default quality report and persists a reproducible artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e7-quality-report-"));
    const artifactPath = join(directory, "artifact.json");
    const writes = new Array<string>();

    try {
      const artifact = await runQualityReportCli(["--artifact", artifactPath], {
        writeLine: (line) => {
          writes.push(line);
        },
      });
      const persisted = Schema.decodeUnknownSync(QualityReportArtifactSchema)(
        JSON.parse(await readFile(artifactPath, "utf8")),
      );

      expect(persisted).toEqual(artifact);
      expect(artifact.summary.decision).toBe(artifact.evidence.promotionGate.verdict);
      expect(artifact.summary.status).toBe("warn");
      expect(artifact.summary.warningSectionKeys).toEqual(["performanceBudget", "promotionGate"]);
      expect(artifact.summary.failingSectionKeys).toEqual([]);
      expect(artifact.sections).toHaveLength(6);
      expect(writes).toHaveLength(1);
      expect((await runDefaultQualityReport()).reportId).toBe("report-e7-quality");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("fails the CLI deterministically on unsupported arguments", async () => {
    const exitCodes = new Array<number>();
    const writes = new Array<string>();

    await expect(
      runQualityReportCli(["--unknown"], {
        setExitCode: (code) => {
          exitCodes.push(code);
        },
        writeLine: (line) => {
          writes.push(line);
        },
      }),
    ).rejects.toThrow("Unknown argument: --unknown");
    expect(exitCodes).toEqual([1]);
    expect(writes).toEqual([]);
  });
});
