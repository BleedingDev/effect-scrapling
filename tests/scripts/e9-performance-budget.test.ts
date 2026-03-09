import { describe, expect, it, setDefaultTimeout } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  E9PerformanceBudgetArtifactSchema,
  runE9PerformanceBudget,
} from "../../src/e9-performance-budget.ts";
import {
  parseOptions,
  runDefaultE9PerformanceBudget,
} from "../../scripts/benchmarks/e9-performance-budget.ts";

setDefaultTimeout(20_000);

describe("e9 performance budget benchmark", () => {
  it("parses supported benchmark options", () => {
    expect(parseOptions([]).sampleSize).toBe(1);
    expect(parseOptions(["--sample-size", "2", "--warmup", "1"]).sampleSize).toBe(2);
    expect(() => parseOptions(["--sample-size", "0"])).toThrow();
    expect(() => parseOptions(["--warmup", "-1"])).toThrow();
    expect(() => parseOptions(["--bogus"])).toThrow("Unknown argument: --bogus");
  });

  it("produces a schema-valid E9 performance artifact", async () => {
    const artifact = await runE9PerformanceBudget({
      benchmarkId: "e9-performance-budget-test",
      generatedAt: "2026-03-08T22:55:00.000Z",
      sampleSize: 1,
      warmupIterations: 0,
    });
    const decoded = Schema.decodeUnknownSync(E9PerformanceBudgetArtifactSchema)(artifact);

    expect(decoded.profile.caseCount).toBe(10);
    expect(decoded.profile.scenarioCount).toBe(10);
    expect(decoded.measurements.scraplingParity.samples).toBe(1);
    expect(decoded.measurements.total.samples).toBe(1);
  });

  it("writes the scorecard through the CLI harness", async () => {
    const artifact = await runDefaultE9PerformanceBudget([]);
    expect(artifact.profile.caseCount).toBe(10);
    expect(artifact.measurements.total.samples).toBe(1);
  });
});
