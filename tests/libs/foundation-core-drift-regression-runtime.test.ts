import { describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import {
  BaselineCorpusArtifactSchema,
  runBaselineCorpus,
} from "../../libs/foundation/core/src/baseline-corpus-runtime.ts";
import {
  analyzeDriftRegression,
  DriftRegressionArtifactSchema,
} from "../../libs/foundation/core/src/drift-regression-runtime.ts";
import { runIncumbentComparison } from "../../libs/foundation/core/src/incumbent-comparison-runtime.ts";
import { createDefaultBaselineCorpus } from "../../scripts/benchmarks/e7-baseline-corpus.ts";

async function makeBaselineArtifact() {
  return await Effect.runPromise(runBaselineCorpus(await createDefaultBaselineCorpus()));
}

function mutateCandidateArtifact(
  artifact: Awaited<ReturnType<typeof makeBaselineArtifact>>,
  update:
    | {
        readonly kind: "changePrice";
        readonly caseId: string;
        readonly amount: number;
      }
    | {
        readonly kind: "removePrice";
        readonly caseId: string;
      }
    | {
        readonly kind: "dropConfidence";
        readonly caseId: string;
        readonly confidence: number;
      },
) {
  const encoded = Schema.encodeSync(BaselineCorpusArtifactSchema)(artifact);

  return Schema.decodeUnknownSync(BaselineCorpusArtifactSchema)({
    ...encoded,
    results: encoded.results.map((result) => {
      if (result.caseId !== update.caseId) {
        return result;
      }

      const observations =
        update.kind === "removePrice"
          ? result.orchestration.snapshotAssembly.snapshot.observations.filter(
              (observation) => observation.field !== "price",
            )
          : result.orchestration.snapshotAssembly.snapshot.observations.map((observation) => {
              if (observation.field !== "price") {
                return observation;
              }

              if (update.kind === "changePrice") {
                return {
                  ...observation,
                  normalizedValue: {
                    amount: update.amount,
                    currency: "USD",
                  },
                };
              }

              return {
                ...observation,
                confidence: update.confidence,
              };
            });
      const fields =
        update.kind === "removePrice"
          ? result.canonicalSnapshot.fields.filter((field) => field.field !== "price")
          : result.canonicalSnapshot.fields.map((field) => {
              if (field.field !== "price") {
                return field;
              }

              if (update.kind === "changePrice") {
                return {
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
                };
              }

              return {
                ...field,
                observation: {
                  ...field.observation,
                  confidence: update.confidence,
                },
              };
            });

      return {
        ...result,
        orchestration: {
          ...result.orchestration,
          snapshotAssembly: {
            ...result.orchestration.snapshotAssembly,
            snapshot: {
              ...result.orchestration.snapshotAssembly.snapshot,
              observations,
            },
          },
        },
        canonicalSnapshot: {
          ...result.canonicalSnapshot,
          fields,
          confidenceScore:
            update.kind === "dropConfidence"
              ? update.confidence
              : result.canonicalSnapshot.confidenceScore,
        },
      };
    }),
  });
}

async function makeComparisonArtifact(candidate: Awaited<ReturnType<typeof makeBaselineArtifact>>) {
  const incumbent = await makeBaselineArtifact();

  return await Effect.runPromise(
    runIncumbentComparison({
      id: "comparison-retail-smoke",
      createdAt: "2026-03-08T16:00:00.000Z",
      incumbent,
      candidate,
    }),
  );
}

describe("foundation-core drift regression runtime", () => {
  it("keeps pack summaries stable when incumbent and candidate outputs match", async () => {
    const comparison = await makeComparisonArtifact(await makeBaselineArtifact());
    const artifact = await Effect.runPromise(
      analyzeDriftRegression({
        id: "analysis-retail-smoke",
        createdAt: "2026-03-08T16:05:00.000Z",
        comparison,
      }),
    );

    expect(Schema.is(DriftRegressionArtifactSchema)(artifact)).toBe(true);
    expect(artifact.findings).toEqual([]);
    expect(artifact.packSummaries.map(({ severity }) => severity)).toEqual(["none", "none"]);
  });

  it("flags changed fields with deterministic signatures and typed severities", async () => {
    const candidate = mutateCandidateArtifact(await makeBaselineArtifact(), {
      kind: "changePrice",
      caseId: "case-catalog-example-com",
      amount: 1499,
    });
    const artifact = await Effect.runPromise(
      analyzeDriftRegression({
        id: "analysis-retail-smoke",
        createdAt: "2026-03-08T16:05:00.000Z",
        comparison: await makeComparisonArtifact(candidate),
      }),
    );

    expect(artifact.findings).toMatchObject([
      {
        caseId: "case-catalog-example-com",
        field: "price",
        kind: "fieldChanged",
        severity: "high",
        signature: "price:fieldChanged:high",
      },
    ]);
    expect(
      artifact.packSummaries.find(({ packId }) => packId === "pack-catalog-example-com"),
    ).toMatchObject({
      severity: "high",
      regressedCaseCount: 1,
      findingCount: 1,
    });
  });

  it("flags removed fields as critical regressions", async () => {
    const candidate = mutateCandidateArtifact(await makeBaselineArtifact(), {
      kind: "removePrice",
      caseId: "case-catalog-example-com",
    });
    const artifact = await Effect.runPromise(
      analyzeDriftRegression({
        id: "analysis-retail-smoke",
        createdAt: "2026-03-08T16:05:00.000Z",
        comparison: await makeComparisonArtifact(candidate),
      }),
    );

    expect(artifact.findings[0]).toMatchObject({
      caseId: "case-catalog-example-com",
      field: "price",
      kind: "fieldRemoved",
      severity: "critical",
    });
  });

  it("flags confidence-only regressions even when the value fingerprint stays stable", async () => {
    const candidate = mutateCandidateArtifact(await makeBaselineArtifact(), {
      kind: "dropConfidence",
      caseId: "case-catalog-example-com",
      confidence: 0.35,
    });
    const artifact = await Effect.runPromise(
      analyzeDriftRegression({
        id: "analysis-retail-smoke",
        createdAt: "2026-03-08T16:05:00.000Z",
        comparison: await makeComparisonArtifact(candidate),
      }),
    );

    expect(artifact.findings).toMatchObject([
      {
        caseId: "case-catalog-example-com",
        kind: "confidenceDrop",
        severity: "critical",
      },
    ]);
  });

  it("rejects malformed severity threshold ordering", async () => {
    const comparison = await makeComparisonArtifact(await makeBaselineArtifact());

    await expect(
      Effect.runPromise(
        analyzeDriftRegression({
          id: "analysis-retail-smoke",
          createdAt: "2026-03-08T16:05:00.000Z",
          comparison,
          policy: {
            lowDriftThreshold: 0.2,
            moderateDriftThreshold: 0.1,
            highDriftThreshold: 0.2,
            criticalDriftThreshold: 0.3,
            lowConfidenceDropThreshold: 0.01,
            moderateConfidenceDropThreshold: 0.02,
            highConfidenceDropThreshold: 0.03,
            criticalConfidenceDropThreshold: 0.04,
          },
        }),
      ),
    ).rejects.toThrow("ordered from low to critical");
  });
});
