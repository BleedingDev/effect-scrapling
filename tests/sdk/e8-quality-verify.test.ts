import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { runIncumbentComparison } from "@effect-scrapling/foundation-core/incumbent-comparison-runtime";
import {
  QualityCompareEnvelopeSchema,
  QualityVerifyEnvelopeSchema,
  SnapshotDiffEnvelopeSchema,
  runExtractRunOperation,
  runQualityCompareOperation,
  runQualityVerifyOperation,
  runSnapshotDiffOperation,
} from "effect-scrapling/e8";
import { executeCli } from "../../src/standalone.ts";
import { InvalidInputError } from "../../src/sdk/errors.ts";
import { runDefaultBaselineCorpus } from "../../scripts/benchmarks/e7-baseline-corpus.ts";

function makePack() {
  return {
    id: "pack-shop-example-com",
    tenantId: "tenant-main",
    domainPattern: "*.example.com",
    state: "shadow",
    accessPolicyId: "policy-default",
    version: "2026.03.08",
  };
}

function makeSnapshot(input: {
  readonly id: string;
  readonly targetId: string;
  readonly title: string;
  readonly price: number;
}) {
  return {
    id: input.id,
    targetId: input.targetId,
    observations: [
      {
        field: "title",
        normalizedValue: input.title,
        confidence: 0.98,
        evidenceRefs: [`artifact-${input.id}`],
      },
      {
        field: "price",
        normalizedValue: {
          amount: input.price,
          currency: "CZK",
        },
        confidence: 0.95,
        evidenceRefs: [`artifact-${input.id}`],
      },
    ],
    qualityScore: 0.96,
    createdAt: "2026-03-09T10:00:00.000Z",
  };
}

function mockHtmlFetch(body: string) {
  return async (input: string | URL | Request) => {
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    Object.defineProperty(response, "url", {
      value: new Request(input).url,
      configurable: true,
    });
    return response;
  };
}

describe("E8 extraction and quality verification", () => {
  it.effect("keeps extract, diff, verify, and compare envelopes aligned across SDK and CLI", () =>
    Effect.gen(function* () {
      const baseline = makeSnapshot({
        id: "snapshot-baseline-001",
        targetId: "target-quality-001",
        title: "Effect Scrapling",
        price: 199.9,
      });
      const candidate = makeSnapshot({
        id: "snapshot-candidate-001",
        targetId: "target-quality-001",
        title: "Effect Scrapling v2",
        price: 219.9,
      });
      const baselineCorpus = yield* Effect.promise(() => runDefaultBaselineCorpus());
      const comparison = yield* runIncumbentComparison({
        id: "comparison-e8-quality",
        createdAt: "2026-03-09T15:00:00.000Z",
        incumbent: baselineCorpus,
        candidate: baselineCorpus,
      });
      const extract = yield* runExtractRunOperation(
        {
          url: "https://example.com/e8-extract",
          selector: "h1",
          all: true,
          limit: 5,
        },
        mockHtmlFetch("<html><body><h1>Effect</h1><h1>Scrapling</h1></body></html>"),
      );
      const diff = yield* runSnapshotDiffOperation({
        baseline,
        candidate,
        createdAt: "2026-03-09T14:00:00.000Z",
        latencyDeltaMs: 20,
        memoryDelta: 2,
      });
      const greenDiff = yield* runSnapshotDiffOperation({
        baseline,
        candidate: {
          ...baseline,
          id: "snapshot-candidate-green-001",
        },
        createdAt: "2026-03-09T14:15:00.000Z",
      });
      const verify = yield* runQualityVerifyOperation({
        pack: makePack(),
        snapshotDiff: greenDiff.data.diff,
        checks: {
          replayDeterminism: true,
          workflowResume: true,
          canary: true,
          chaos: true,
          securityRedaction: true,
          soakStability: true,
        },
        createdAt: "2026-03-09T14:30:00.000Z",
      });
      const compare = yield* runQualityCompareOperation({
        metricsId: "metrics-e8-quality",
        generatedAt: "2026-03-09T15:30:00.000Z",
        baseline: baselineCorpus,
        comparison,
      });
      const cliExtract = yield* Effect.promise(() =>
        executeCli(
          [
            "extract",
            "run",
            "--url",
            "https://example.com/e8-extract",
            "--selector",
            "h1",
            "--all",
            "--limit",
            "5",
          ],
          mockHtmlFetch("<html><body><h1>Effect</h1><h1>Scrapling</h1></body></html>"),
        ),
      );
      const cliDiff = yield* Effect.promise(() =>
        executeCli([
          "quality",
          "diff",
          "--input",
          JSON.stringify({
            baseline,
            candidate,
            createdAt: "2026-03-09T14:00:00.000Z",
            latencyDeltaMs: 20,
            memoryDelta: 2,
          }),
        ]),
      );
      const cliVerify = yield* Effect.promise(() =>
        executeCli([
          "quality",
          "verify",
          "--input",
          JSON.stringify({
            pack: makePack(),
            snapshotDiff: greenDiff.data.diff,
            checks: {
              replayDeterminism: true,
              workflowResume: true,
              canary: true,
              chaos: true,
              securityRedaction: true,
              soakStability: true,
            },
            createdAt: "2026-03-09T14:30:00.000Z",
          }),
        ]),
      );
      const cliCompare = yield* Effect.promise(() =>
        executeCli([
          "quality",
          "compare",
          "--input",
          JSON.stringify({
            metricsId: "metrics-e8-quality",
            generatedAt: "2026-03-09T15:30:00.000Z",
            baseline: baselineCorpus,
            comparison,
          }),
        ]),
      );

      expect(extract.data.values).toEqual(["Effect", "Scrapling"]);
      expect(extract).toEqual(JSON.parse(cliExtract.output));
      expect(Schema.decodeUnknownSync(SnapshotDiffEnvelopeSchema)(diff)).toEqual(
        Schema.decodeUnknownSync(SnapshotDiffEnvelopeSchema)(JSON.parse(cliDiff.output)),
      );
      expect(diff.data.diff.id).toBe(`diff-${candidate.targetId}-${baseline.id}-${candidate.id}`);
      expect(Schema.decodeUnknownSync(QualityVerifyEnvelopeSchema)(verify)).toEqual(
        Schema.decodeUnknownSync(QualityVerifyEnvelopeSchema)(JSON.parse(cliVerify.output)),
      );
      expect(Schema.decodeUnknownSync(QualityCompareEnvelopeSchema)(compare)).toEqual(
        Schema.decodeUnknownSync(QualityCompareEnvelopeSchema)(JSON.parse(cliCompare.output)),
      );
      expect(compare.data.metrics.overall.fieldRecallRate).toBe(1);
    }),
  );

  it.effect("rejects inconsistent quality evidence across SDK and CLI", () =>
    Effect.gen(function* () {
      const baselineCorpus = yield* Effect.promise(() => runDefaultBaselineCorpus());
      const comparison = yield* runIncumbentComparison({
        id: "comparison-e8-quality-invalid",
        createdAt: "2026-03-09T15:00:00.000Z",
        incumbent: baselineCorpus,
        candidate: baselineCorpus,
      });
      const invalidCompareInput = {
        metricsId: "metrics-e8-quality-invalid",
        generatedAt: "2026-03-09T15:30:00.000Z",
        baseline: baselineCorpus,
        comparison: {
          ...comparison,
          candidateCorpusId: "corpus-other",
        },
      };

      const compareSdkError = yield* Effect.flip(runQualityCompareOperation(invalidCompareInput));
      const compareCli = yield* Effect.promise(() =>
        executeCli(["quality", "compare", "--input", JSON.stringify(invalidCompareInput)]),
      );
      const verifyCli = yield* Effect.promise(() =>
        executeCli([
          "quality",
          "verify",
          "--input",
          JSON.stringify({
            pack: makePack(),
            snapshotDiff: {
              id: "diff-invalid",
              baselineSnapshotId: "snapshot-baseline-001",
              candidateSnapshotId: "snapshot-candidate-001",
              metrics: {
                fieldRecallDelta: 0.01,
                falsePositiveDelta: 0.01,
                driftDelta: 0.02,
                latencyDeltaMs: 20,
                memoryDelta: 2,
              },
              createdAt: "not-a-date",
            },
            checks: {
              replayDeterminism: true,
              workflowResume: true,
              canary: true,
              chaos: true,
              securityRedaction: true,
              soakStability: true,
            },
            createdAt: "2026-03-09T14:30:00.000Z",
          }),
        ]),
      );

      expect(compareSdkError).toBeInstanceOf(InvalidInputError);
      expect(compareSdkError.message).toContain("Failed to compare quality evidence.");
      expect(compareCli.exitCode).toBe(2);
      expect(JSON.parse(compareCli.output)).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });
      expect(verifyCli.exitCode).toBe(2);
      expect(JSON.parse(verifyCli.output)).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });
    }),
  );
});
