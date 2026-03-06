import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  BrowserSoakLoadArtifactSchema,
  DEFAULT_CONCURRENCY,
  DEFAULT_ROUNDS,
  DEFAULT_WARMUP_ITERATIONS,
  parseOptions,
  runBenchmark,
  runSoakLoadSuite,
} from "../../scripts/benchmarks/e4-browser-soak-load.ts";

describe("e4 browser soak/load benchmark harness", () => {
  it("parses explicit benchmark options through schema-backed integer decoding", () => {
    expect(
      parseOptions([
        "--artifact",
        "tmp/browser-soak-load.json",
        "--rounds",
        "5",
        "--concurrency",
        "3",
        "--warmup",
        "0",
      ]),
    ).toEqual({
      artifactPath: expect.stringContaining("tmp/browser-soak-load.json"),
      rounds: 5,
      concurrency: 3,
      warmupIterations: 0,
    });

    expect(parseOptions([])).toEqual({
      rounds: DEFAULT_ROUNDS,
      concurrency: DEFAULT_CONCURRENCY,
      warmupIterations: DEFAULT_WARMUP_ITERATIONS,
    });
  });

  it("produces a passing artifact for the default bounded soak/load suite", async () => {
    const artifact = await runSoakLoadSuite({
      rounds: 3,
      concurrency: 4,
      warmupIterations: 0,
    });

    expect(artifact.status).toBe("pass");
    expect(artifact.violations).toEqual([]);
    expect(artifact.finalSnapshot.openBrowsers).toBe(0);
    expect(artifact.finalSnapshot.openContexts).toBe(0);
    expect(artifact.finalSnapshot.openPages).toBe(0);
    expect(artifact.alarms).toEqual([]);
    expect(artifact.crashTelemetry).toEqual([]);
    expect(artifact.peaks).toEqual({
      openBrowsers: 1,
      openContexts: 4,
      openPages: 4,
    });
    expect(artifact.captures.totalRuns).toBe(12);
    expect(artifact.captures.totalArtifacts).toBe(48);
    expect(artifact.captures.artifactKinds).toEqual([
      "renderedDom",
      "screenshot",
      "networkSummary",
      "timings",
    ]);
  });

  it("fails deterministically when the leak policy is stricter than the requested concurrency", async () => {
    const artifact = await runSoakLoadSuite({
      rounds: 2,
      concurrency: 3,
      warmupIterations: 0,
      policy: {
        maxOpenContexts: 1,
        maxOpenPages: 1,
      },
    });

    expect(artifact.status).toBe("fail");
    expect(artifact.alarms.length).toBeGreaterThan(0);
    expect(
      artifact.violations.some((message) =>
        message.startsWith("Expected zero leak alarms, received "),
      ),
    ).toBe(true);
    expect(artifact.finalSnapshot.openBrowsers).toBe(0);
    expect(artifact.finalSnapshot.openContexts).toBe(0);
    expect(artifact.finalSnapshot.openPages).toBe(0);
  });

  it("persists the generated artifact when the benchmark runs through the CLI entrypoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e4-browser-soak-load-"));
    const artifactPath = join(directory, "artifact.json");

    try {
      const artifact = await runBenchmark([
        "--artifact",
        artifactPath,
        "--rounds",
        "2",
        "--concurrency",
        "2",
        "--warmup",
        "0",
      ]);
      const persisted = Schema.decodeUnknownSync(BrowserSoakLoadArtifactSchema)(
        JSON.parse(await readFile(artifactPath, "utf8")),
      );

      expect(artifact.status).toBe("pass");
      expect(persisted).toEqual(artifact);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
