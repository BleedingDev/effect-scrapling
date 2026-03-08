import { afterEach, describe, expect, it, mock } from "@effect-native/bun-test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { PromotionGateEvaluationSchema } from "../../libs/foundation/core/src/promotion-gate-policy-runtime.ts";
import {
  createDefaultPromotionGateInput,
  parseOptions,
  runDefaultPromotionGatePolicy,
  runPromotionGatePolicyCli,
} from "../../scripts/benchmarks/e7-promotion-gate-policy.ts";

describe("e7 promotion gate policy harness", () => {
  afterEach(() => {
    mock.restore();
  });

  it("parses only the supported --artifact option", () => {
    expect(parseOptions([])).toEqual({});
    expect(parseOptions(["--artifact", "tmp/e7-promotion-gate-policy.json"])).toEqual({
      artifactPath: "tmp/e7-promotion-gate-policy.json",
    });
    expect(() => parseOptions(["--artifact"])).toThrow("Missing value for argument: --artifact");
    expect(() => parseOptions(["--unknown"])).toThrow("Unknown argument: --unknown");
  });

  it("builds a deterministic default promotion-gate input bundle", async () => {
    const input = await createDefaultPromotionGateInput();

    expect(input.quality.analysisId).toBe("analysis-e7-promotion-gate");
    expect(input.performance.benchmarkId).toBe("e7-performance-budget");
    expect(input.canary.suiteId).toBe("suite-e7-live-canary");
    expect(input.quality.packCount).toBe(input.performance.profile.packCount);
  });

  it("runs the default evaluator and persists a reproducible artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e7-promotion-gate-policy-"));
    const artifactPath = join(directory, "artifact.json");
    const writes = new Array<string>();

    try {
      const artifact = await runPromotionGatePolicyCli(["--artifact", artifactPath], {
        writeLine: (line) => {
          writes.push(line);
        },
      });
      const persisted = Schema.decodeUnknownSync(PromotionGateEvaluationSchema)(
        JSON.parse(await readFile(artifactPath, "utf8")),
      );

      expect(persisted).toEqual(artifact);
      expect(artifact.benchmark).toBe("e7-promotion-gate-policy");
      expect(artifact.verdict).toBe("hold");
      expect(artifact.canary?.verdict).toBe("promote");
      expect(artifact.rationale.map(({ code }) => code)).toEqual([
        "quality-clean",
        "performance-hold",
        "canary-clean",
      ]);
      expect(writes).toHaveLength(1);
      expect((await runDefaultPromotionGatePolicy()).evaluationId).toBe("promotion-e7-policy");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("fails the CLI deterministically on unsupported arguments", async () => {
    const exitCodes = new Array<number>();
    const writes = new Array<string>();

    await expect(
      runPromotionGatePolicyCli(["--unknown"], {
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
