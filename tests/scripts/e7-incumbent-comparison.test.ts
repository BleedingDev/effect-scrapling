import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { BaselineCorpusArtifactSchema } from "../../libs/foundation/core/src/baseline-corpus-runtime.ts";
import { IncumbentComparisonArtifactSchema } from "../../libs/foundation/core/src/incumbent-comparison-runtime.ts";
import {
  parseOptions,
  runDefaultIncumbentComparison,
  runIncumbentComparisonCli,
} from "../../scripts/benchmarks/e7-incumbent-comparison.ts";
import { runDefaultBaselineCorpus } from "../../scripts/benchmarks/e7-baseline-corpus.ts";

function mutateCandidateArtifact(
  artifact: Awaited<ReturnType<typeof runDefaultBaselineCorpus>>,
  update: {
    readonly caseId: string;
    readonly amount: number;
  },
) {
  const encoded = Schema.encodeSync(BaselineCorpusArtifactSchema)(artifact);

  return Schema.decodeUnknownSync(BaselineCorpusArtifactSchema)({
    ...encoded,
    results: encoded.results.map((result) => {
      if (result.caseId !== update.caseId) {
        return result;
      }

      return {
        ...result,
        orchestration: {
          ...result.orchestration,
          snapshotAssembly: {
            ...result.orchestration.snapshotAssembly,
            snapshot: {
              ...result.orchestration.snapshotAssembly.snapshot,
              observations: result.orchestration.snapshotAssembly.snapshot.observations.map(
                (observation) =>
                  observation.field === "price"
                    ? {
                        ...observation,
                        normalizedValue: {
                          amount: update.amount,
                          currency: "USD",
                        },
                      }
                    : observation,
              ),
            },
          },
        },
        canonicalSnapshot: {
          ...result.canonicalSnapshot,
          fields: result.canonicalSnapshot.fields.map((field) =>
            field.field === "price"
              ? {
                  ...field,
                  observation: {
                    ...field.observation,
                    normalizedValue: {
                      amount: update.amount,
                      currency: "USD",
                    },
                  },
                  valueFingerprint: JSON.stringify({
                    amount: update.amount,
                    currency: "USD",
                  }),
                }
              : field,
          ),
        },
      };
    }),
  });
}

describe("e7 incumbent comparison benchmark harness", () => {
  afterEach(() => {
    mock.restore();
  });

  it("parses supported comparison options and rejects incomplete file pairs", () => {
    expect(parseOptions([])).toEqual({});
    expect(
      parseOptions([
        "--incumbent",
        "tmp/incumbent.json",
        "--candidate",
        "tmp/candidate.json",
        "--artifact",
        "tmp/comparison.json",
      ]),
    ).toEqual({
      incumbentPath: "tmp/incumbent.json",
      candidatePath: "tmp/candidate.json",
      artifactPath: "tmp/comparison.json",
    });
    expect(() => parseOptions(["--candidate", "tmp/candidate.json"])).toThrow(
      "Expected --incumbent and --candidate to be provided together.",
    );
  });

  it("runs a deterministic default comparison with per-pack match verdicts", async () => {
    const artifact = await runDefaultIncumbentComparison();

    expect(Schema.is(IncumbentComparisonArtifactSchema)(artifact)).toBe(true);
    expect(artifact.caseCount).toBe(2);
    expect(artifact.packSummaries.map(({ verdict }) => verdict)).toEqual(["match", "match"]);
  });

  it("loads incumbent and candidate artifacts, persists the comparison artifact, and reports pack diffs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e7-incumbent-comparison-"));
    const incumbentPath = join(directory, "incumbent.json");
    const candidatePath = join(directory, "candidate.json");
    const artifactPath = join(directory, "comparison.json");
    const incumbent = await runDefaultBaselineCorpus();
    const candidate = mutateCandidateArtifact(incumbent, {
      caseId: "case-catalog-example-com",
      amount: 1399,
    });
    const writes = new Array<string>();

    await writeFile(
      incumbentPath,
      `${JSON.stringify(Schema.encodeSync(BaselineCorpusArtifactSchema)(incumbent), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      candidatePath,
      `${JSON.stringify(Schema.encodeSync(BaselineCorpusArtifactSchema)(candidate), null, 2)}\n`,
      "utf8",
    );

    const artifact = await runIncumbentComparisonCli(
      ["--incumbent", incumbentPath, "--candidate", candidatePath, "--artifact", artifactPath],
      {
        writeLine: (line) => {
          writes.push(line);
        },
      },
    );
    const persistedPayload = JSON.parse(await readFile(artifactPath, "utf8"));
    const persistedArtifact = Schema.decodeUnknownSync(IncumbentComparisonArtifactSchema)(
      persistedPayload,
    );

    expect(Schema.encodeSync(IncumbentComparisonArtifactSchema)(artifact)).toEqual(
      Schema.encodeSync(IncumbentComparisonArtifactSchema)(persistedArtifact),
    );
    expect(
      artifact.packSummaries.find(({ packId }) => packId === "pack-catalog-example-com")?.verdict,
    ).toBe("diff");
    expect(
      artifact.packSummaries.find(({ packId }) => packId === "pack-catalog-example-com")
        ?.deltaSummary.totalChangedFieldCount,
    ).toBe(1);
    expect(writes).toHaveLength(1);
  });
});
