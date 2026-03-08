import { describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import {
  BaselineCorpusArtifactSchema,
  runBaselineCorpus,
} from "../../libs/foundation/core/src/baseline-corpus-runtime.ts";
import {
  IncumbentComparisonArtifactSchema,
  runIncumbentComparison,
} from "../../libs/foundation/core/src/incumbent-comparison-runtime.ts";
import { createDefaultBaselineCorpus } from "../../scripts/benchmarks/e7-baseline-corpus.ts";

async function makeBaselineArtifact() {
  return await Effect.runPromise(runBaselineCorpus(await createDefaultBaselineCorpus()));
}

function mutateCandidateArtifact(
  artifact: Awaited<ReturnType<typeof makeBaselineArtifact>>,
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

describe("foundation-core incumbent comparison runtime", () => {
  it("produces per-pack match verdicts for identical baseline artifacts", async () => {
    const incumbent = await makeBaselineArtifact();
    const candidate = await makeBaselineArtifact();
    const artifact = await Effect.runPromise(
      runIncumbentComparison({
        id: "comparison-retail-smoke",
        createdAt: "2026-03-08T15:00:00.000Z",
        incumbent,
        candidate,
      }),
    );

    expect(Schema.is(IncumbentComparisonArtifactSchema)(artifact)).toBe(true);
    expect(artifact.caseCount).toBe(2);
    expect(artifact.packCount).toBe(2);
    expect(artifact.packSummaries.map(({ verdict }) => verdict)).toEqual(["match", "match"]);
    expect(artifact.results.every(({ verdict }) => verdict === "match")).toBe(true);
  });

  it("produces per-pack diff summaries when the candidate drifts on one case", async () => {
    const incumbent = await makeBaselineArtifact();
    const candidate = mutateCandidateArtifact(incumbent, {
      caseId: "case-catalog-example-com",
      amount: 1399,
    });
    const artifact = await Effect.runPromise(
      runIncumbentComparison({
        id: "comparison-retail-smoke",
        createdAt: "2026-03-08T15:00:00.000Z",
        incumbent,
        candidate,
      }),
    );

    expect(
      artifact.packSummaries.find(({ packId }) => packId === "pack-catalog-example-com"),
    ).toMatchObject({
      verdict: "diff",
      deltaSummary: {
        caseCount: 1,
        changedCaseCount: 1,
        totalChangedFieldCount: 1,
      },
    });
    expect(
      artifact.results.find(({ caseId }) => caseId === "case-catalog-example-com")?.verdict,
    ).toBe("diff");
  });

  it("rejects incumbent and candidate artifacts built from different corpora", async () => {
    const incumbent = await makeBaselineArtifact();
    const candidate = Schema.decodeUnknownSync(BaselineCorpusArtifactSchema)({
      ...Schema.encodeSync(BaselineCorpusArtifactSchema)(incumbent),
      corpusId: "corpus-other",
    });

    await expect(
      Effect.runPromise(
        runIncumbentComparison({
          id: "comparison-retail-smoke",
          createdAt: "2026-03-08T15:00:00.000Z",
          incumbent,
          candidate,
        }),
      ),
    ).rejects.toThrow("same corpus id");
  });
});
