import { describe, expect, it } from "@effect-native/bun-test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { QualitySoakArtifactSchema } from "../../libs/foundation/core/src/quality-soak-suite-runtime.ts";
import {
  DEFAULT_ITERATIONS,
  DEFAULT_WARMUP_ITERATIONS,
  parseOptions,
  runBenchmark,
} from "../../scripts/benchmarks/e7-soak-endurance-suite.ts";

describe("e7 soak endurance suite harness", () => {
  it("parses explicit benchmark options through schema-backed integer decoding", () => {
    expect(
      parseOptions([
        "--artifact",
        "tmp/e7-soak-endurance.json",
        "--iterations",
        "2",
        "--warmup",
        "0",
      ]),
    ).toEqual({
      artifactPath: expect.stringContaining("tmp/e7-soak-endurance.json"),
      iterations: 2,
      warmupIterations: 0,
    });
    expect(parseOptions([])).toEqual({
      iterations: DEFAULT_ITERATIONS,
      warmupIterations: DEFAULT_WARMUP_ITERATIONS,
    });
  });

  it("writes a stability report with bounded growth in a passing run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e7-soak-endurance-"));
    const artifactPath = join(directory, "artifact.json");

    try {
      const artifact = await runBenchmark([
        "--artifact",
        artifactPath,
        "--iterations",
        "2",
        "--warmup",
        "0",
      ]);
      const persisted = Schema.decodeUnknownSync(QualitySoakArtifactSchema)(
        JSON.parse(await readFile(artifactPath, "utf8")),
      );

      expect(persisted).toEqual(artifact);
      expect(persisted.sampleCount).toBe(2);
      expect(persisted.stability.unboundedGrowthDetected).toBe(false);
      expect(persisted.status).toBe("pass");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
