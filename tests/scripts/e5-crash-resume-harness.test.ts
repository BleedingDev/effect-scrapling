import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  CrashResumeArtifactSchema,
  CrashResumeSampleSchema,
  parseOptions,
  runCrashResumeSample,
  runHarness,
  runHarnessCli,
} from "../../scripts/benchmarks/e5-crash-resume-harness.ts";

describe("e5 crash resume harness", () => {
  it("parses explicit crash-after sequence options through shared schema decoding", () => {
    expect(
      parseOptions([
        "--artifact",
        "tmp/e5-crash-resume.json",
        "--targets",
        "3",
        "--observations-per-target",
        "20",
        "--crash-after-sequence",
        "1",
        "--crash-after-sequence",
        "2",
      ]),
    ).toEqual({
      artifactPath: expect.stringContaining("tmp/e5-crash-resume.json"),
      targetCount: 3,
      observationsPerTarget: 20,
      crashAfterSequences: [1, 2],
    });

    expect(parseOptions([])).toEqual({
      targetCount: 4,
      observationsPerTarget: 25,
      crashAfterSequences: [1, 2],
    });

    expect(() => parseOptions(["--crash-after-sequence"])).toThrow();
    expect(() => parseOptions(["--crash-after-sequence", "3"])).toThrow();
    expect(() => parseOptions(["--targets", "0"])).toThrow();
  });

  it("reproduces matching terminal outputs across deterministic restart boundaries", async () => {
    const sample = await Effect.runPromise(
      runCrashResumeSample(
        {
          targetCount: 2,
          observationsPerTarget: 5,
          totalObservations: 10,
        },
        [1, 2],
      ),
    );

    expect(sample.restartCount).toBe(4);
    expect(sample.matchedOutputs).toBe(true);
    expect(sample.baseline).toEqual(sample.recovered);
    expect(sample.baseline[0]?.checkpointCount).toBe(3);
    expect(sample.baseline[0]?.stageFingerprint).toBe("snapshot>quality>reflect");
  });

  it("writes a passing artifact when the crash-resume harness runs end to end", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e5-crash-resume-"));
    const artifactPath = join(directory, "artifact.json");

    try {
      const artifact = await runHarness([
        "--artifact",
        artifactPath,
        "--targets",
        "2",
        "--observations-per-target",
        "5",
        "--crash-after-sequence",
        "1",
        "--crash-after-sequence",
        "2",
      ]);
      const persisted = Schema.decodeUnknownSync(CrashResumeArtifactSchema)(
        JSON.parse(await readFile(artifactPath, "utf8")),
      );

      expect(artifact.status).toBe("pass");
      expect(persisted).toEqual(artifact);
      expect(persisted.sample.matchedOutputs).toBe(true);
      expect(persisted.sample.restartCount).toBe(4);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("writes a failing artifact and signals a non-zero CLI exit when recovered outputs drift", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e5-crash-resume-"));
    const artifactPath = join(directory, "artifact.json");
    const baselineSample = await Effect.runPromise(
      runCrashResumeSample(
        {
          targetCount: 2,
          observationsPerTarget: 5,
          totalObservations: 10,
        },
        [1, 2],
      ),
    );
    const mismatchedSample = Schema.decodeUnknownSync(CrashResumeSampleSchema)({
      ...baselineSample,
      matchedOutputs: true,
      recovered: [...baselineSample.recovered].reverse(),
    });
    const stdout = new Array<string>();
    let exitCode: number | undefined;

    try {
      const artifact = await runHarnessCli(
        [
          "--artifact",
          artifactPath,
          "--targets",
          "2",
          "--observations-per-target",
          "5",
          "--crash-after-sequence",
          "1",
          "--crash-after-sequence",
          "2",
        ],
        {
          runSample: () => Effect.succeed(mismatchedSample),
          setExitCode: (code) => {
            exitCode = code;
          },
          writeLine: (line) => {
            stdout.push(line);
          },
        },
      );
      const persisted = Schema.decodeUnknownSync(CrashResumeArtifactSchema)(
        JSON.parse(await readFile(artifactPath, "utf8")),
      );

      expect(artifact.status).toBe("fail");
      expect(artifact.sample.matchedOutputs).toBe(false);
      expect(artifact.sample.baseline).not.toEqual(artifact.sample.recovered);
      expect(persisted).toEqual(artifact);
      expect(stdout).toEqual([JSON.stringify(artifact, null, 2)]);
      expect(exitCode).toBe(1);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
