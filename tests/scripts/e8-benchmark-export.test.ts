import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import { E8ArtifactExportEnvelopeSchema, E8BenchmarkRunEnvelopeSchema } from "../../src/e8.ts";
import { parseOptions, runE8BenchmarkCli } from "../../scripts/benchmarks/e8-benchmark-export.ts";

describe("e8 benchmark/export cli", () => {
  it("runs benchmark metadata and export bundle commands with persisted artifacts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "e8-benchmark-"));
    const runArtifactPath = join(tempDir, "run.json");
    const exportArtifactPath = join(tempDir, "export.json");

    const runPayload = await runE8BenchmarkCli(["run", "--artifact", runArtifactPath]);
    const exportPayload = await runE8BenchmarkCli(["export", "--artifact", exportArtifactPath]);

    expect(Schema.is(E8BenchmarkRunEnvelopeSchema)(runPayload)).toBe(true);
    expect(Schema.is(E8ArtifactExportEnvelopeSchema)(exportPayload)).toBe(true);
    expect(JSON.parse(await readFile(runArtifactPath, "utf8"))).toMatchObject({
      command: "benchmark run",
    });
    expect(JSON.parse(await readFile(exportArtifactPath, "utf8"))).toMatchObject({
      benchmark: "e8-artifact-export",
    });
  });

  it("rejects malformed benchmark/export cli arguments", () => {
    expect(() => parseOptions(["unknown"])).toThrow("Expected");
    expect(() => parseOptions(["run", "--artifact"])).toThrow("Missing value");
    expect(() => parseOptions(["export", "--bogus"])).toThrow("Unknown argument");
  });
});
