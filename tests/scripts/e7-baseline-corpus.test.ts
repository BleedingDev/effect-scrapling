import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { BaselineCorpusArtifactSchema } from "../../libs/foundation/core/src/baseline-corpus-runtime.ts";
import {
  createDefaultBaselineCorpus,
  parseOptions,
  runBaselineCorpusCli,
  runDefaultBaselineCorpus,
} from "../../scripts/benchmarks/e7-baseline-corpus.ts";

describe("e7 baseline corpus benchmark harness", () => {
  afterEach(() => {
    mock.restore();
  });

  it("parses only the supported --artifact option", () => {
    expect(parseOptions([])).toEqual({});
    expect(parseOptions(["--artifact", "tmp/e7-baseline.json"])).toEqual({
      artifactPath: "tmp/e7-baseline.json",
    });
    expect(() => parseOptions(["--artifact"])).toThrow("Missing value for argument: --artifact");
    expect(() => parseOptions(["--unexpected"])).toThrow("Unknown argument: --unexpected");
  });

  it("builds a deterministic default corpus fixture", async () => {
    const corpus = await createDefaultBaselineCorpus();

    expect(corpus.id).toBe("corpus-retail-smoke");
    expect(corpus.cases).toHaveLength(2);
    expect(corpus.cases.map(({ caseId }) => caseId)).toEqual([
      "case-catalog-example-com",
      "case-offers-example-com",
    ]);
  });

  it("runs the default corpus and persists a reproducible artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e7-baseline-corpus-"));
    const artifactPath = join(directory, "artifact.json");
    const writes = new Array<string>();

    const artifact = await runBaselineCorpusCli(["--artifact", artifactPath], {
      writeLine: (line) => {
        writes.push(line);
      },
    });
    const persistedPayload = JSON.parse(await readFile(artifactPath, "utf8"));
    const persistedArtifact = Schema.decodeUnknownSync(BaselineCorpusArtifactSchema)(
      persistedPayload,
    );

    expect(Schema.is(BaselineCorpusArtifactSchema)(artifact)).toBe(true);
    expect(Schema.encodeSync(BaselineCorpusArtifactSchema)(artifact)).toEqual(
      Schema.encodeSync(BaselineCorpusArtifactSchema)(persistedArtifact),
    );
    expect(artifact.caseCount).toBe(2);
    expect(artifact.packCount).toBe(2);
    expect(writes).toHaveLength(1);
  });

  it("returns the same deterministic artifact through the direct helper", async () => {
    const artifact = await runDefaultBaselineCorpus();

    expect(artifact.results.map(({ caseId }) => caseId)).toEqual([
      "case-catalog-example-com",
      "case-offers-example-com",
    ]);
    expect(
      artifact.results.every(
        ({ orchestration }) => orchestration.assertionReport.evaluatedRuleCount === 2,
      ),
    ).toBe(true);
  });
});
