import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  BenchmarkArtifactSchema,
  PERFORMANCE_BUDGETS,
  buildArtifact,
  makePlan,
  roundToThree,
  runBenchmark,
  runBaselineAccess,
  runCandidateAccess,
  runRetryRecovery,
  summarizeMeasurements,
} from "../../scripts/benchmarks/e3-access-runtime.ts";

describe("e3 access runtime benchmark harness", () => {
  it.effect("runs deterministic baseline and candidate access flows against the real runtime", () =>
    Effect.gen(function* () {
      const plan = yield* makePlan();
      const firstBaseline = yield* runBaselineAccess();
      const secondBaseline = yield* runBaselineAccess();
      const candidate = yield* runCandidateAccess();

      expect(firstBaseline).toEqual(secondBaseline);
      expect(firstBaseline.runId).toBe(plan.id);
      expect(firstBaseline.bodyLength).toBeGreaterThan(0);
      expect(candidate.runId).toBe(plan.id);
      expect(candidate.artifactCount).toBe(4);
      expect(candidate.payloadCount).toBe(4);
      expect(candidate.artifactKinds).toEqual([
        "html",
        "requestMetadata",
        "responseMetadata",
        "timings",
      ]);
    }),
  );

  it.effect("recovers once from transient failures and surfaces exhausted retry budgets", () =>
    Effect.gen(function* () {
      const recovered = yield* runRetryRecovery();
      expect(recovered.attempts).toBe(2);
      expect(recovered.artifactCount).toBe(4);

      let failedAttempts = 0;
      const failureMessage = yield* runRetryRecovery({
        accessPolicy: {
          maxRetries: 0,
        },
        fetchImpl: async () => Promise.reject(new Error("persistent upstream")),
        onAttempt: (attempt) => {
          failedAttempts = attempt;
        },
      }).pipe(
        Effect.match({
          onFailure: ({ message }) => message,
          onSuccess: () => "unexpected-success",
        }),
      );

      expect(failedAttempts).toBe(1);
      expect(failureMessage).toContain("persistent upstream");
    }),
  );

  it("writes a passing scorecard artifact when the benchmark harness runs end-to-end", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e3-access-runtime-"));
    const artifactPath = join(directory, "artifact.json");

    try {
      const artifact = await runBenchmark([
        "--artifact",
        artifactPath,
        "--baseline",
        "./docs/artifacts/e3-access-runtime-baseline.json",
        "--sample-size",
        "2",
        "--warmup",
        "1",
      ]);
      const persisted = Schema.decodeUnknownSync(BenchmarkArtifactSchema)(
        JSON.parse(await readFile(artifactPath, "utf8")),
      );

      expect(artifact.status).toBe("pass");
      expect(persisted).toEqual(artifact);
      expect(persisted.comparison.baselinePath).toBe(
        resolve("./docs/artifacts/e3-access-runtime-baseline.json"),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("computes pass/fail scorecards from deterministic benchmark summaries", () => {
    const options = {
      baselinePath: resolve("./docs/artifacts/e3-access-runtime-baseline.json"),
      sampleSize: 3,
      warmupIterations: 1,
    };
    const passMeasurements = {
      baselineAccess: summarizeMeasurements([1, 2, 3]),
      candidateAccess: summarizeMeasurements([4, 5, 6]),
      retryRecovery: summarizeMeasurements([10, 12, 14]),
    };
    const baseline = buildArtifact(options, passMeasurements, undefined);

    expect(baseline.status).toBe("pass");
    expect(baseline.comparison.baselinePath).toBe(
      resolve("./docs/artifacts/e3-access-runtime-baseline.json"),
    );
    expect(baseline.comparison.deltas).toEqual({
      baselineAccessP95Ms: null,
      candidateAccessP95Ms: null,
      retryRecoveryP95Ms: null,
    });

    const failMeasurements = {
      baselineAccess: summarizeMeasurements([1, 1, PERFORMANCE_BUDGETS.baselineAccessP95Ms + 1]),
      candidateAccess: summarizeMeasurements([1, 1, PERFORMANCE_BUDGETS.candidateAccessP95Ms + 1]),
      retryRecovery: summarizeMeasurements([10, 12, PERFORMANCE_BUDGETS.retryRecoveryP95Ms + 1]),
    };
    const candidate = buildArtifact(options, failMeasurements, baseline);

    expect(candidate.status).toBe("fail");
    expect(candidate.comparison.deltas).toEqual({
      baselineAccessP95Ms: roundToThree(
        failMeasurements.baselineAccess.p95Ms - baseline.measurements.baselineAccess.p95Ms,
      ),
      candidateAccessP95Ms: roundToThree(
        failMeasurements.candidateAccess.p95Ms - baseline.measurements.candidateAccess.p95Ms,
      ),
      retryRecoveryP95Ms: roundToThree(
        failMeasurements.retryRecovery.p95Ms - baseline.measurements.retryRecovery.p95Ms,
      ),
    });
  });
});
