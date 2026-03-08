import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  E9HighFrictionCanaryArtifactSchema,
  runE9HighFrictionCanary,
} from "../../src/e9-high-friction-canary.ts";
import {
  parseOptions,
  runDefaultE9HighFrictionCanary,
} from "../../scripts/benchmarks/e9-high-friction-canary.ts";

describe("e9 high-friction canary suite", () => {
  it("parses only the supported artifact option", () => {
    expect(parseOptions([])).toEqual({
      artifactPath: undefined,
    });
    expect(parseOptions(["--artifact", "tmp/e9-high-friction-canary.json"])).toEqual({
      artifactPath: "tmp/e9-high-friction-canary.json",
    });
    expect(() => parseOptions(["--artifact"])).toThrow("Missing value for argument: --artifact");
    expect(() => parseOptions(["--bogus"])).toThrow("Unknown argument: --bogus");
  });

  it("produces deterministic browser-escalated canary evidence for all 10 retailer scenarios", async () => {
    const artifact = await runDefaultE9HighFrictionCanary();
    const decoded = Schema.decodeUnknownSync(E9HighFrictionCanaryArtifactSchema)(artifact);

    expect(decoded.status).toBe("pass");
    expect(decoded.summary.scenarioCount).toBe(10);
    expect(decoded.summary.browserEscalationRate).toBe(1);
    expect(decoded.summary.bypassSuccessRate).toBe(1);
    expect(decoded.summary.policyViolationCount).toBe(0);
    expect(decoded.results.every(({ provider }) => provider === "browser")).toBe(true);
  });

  it("fails when a scenario escapes the authorized https host policy", async () => {
    await expect(
      runE9HighFrictionCanary({
        mutateInput: (input) =>
          Schema.decodeUnknownSync(input.constructor as never)({
            ...input,
            scenarios: input.scenarios.map((scenario, index) =>
              index === 0
                ? {
                    ...scenario,
                    target: {
                      ...scenario.target,
                      seedUrls: ["http://evil.example/escape"],
                    },
                  }
                : scenario,
            ),
          }),
      }),
    ).rejects.toThrow("authorized https targets");
  });
});
