import { describe, expect, it, setDefaultTimeout } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  E8ParityArtifactSchema,
  parseOptions,
  runE8ParityDryRunSuite,
} from "../../scripts/benchmarks/e8-parity-dry-run.ts";

setDefaultTimeout(20000);

describe("e8 parity dry-run suite", () => {
  it("replays deterministic SDK and CLI envelopes without mismatches", async () => {
    const artifact = await runE8ParityDryRunSuite();
    const decoded = Schema.decodeUnknownSync(E8ParityArtifactSchema)(artifact);

    expect(decoded.status).toBe("pass");
    expect(decoded.mismatches).toEqual([]);
    expect(decoded.caseCount).toBe(decoded.cases.length);
    expect(decoded.cases.some(({ command }) => command === "workspace doctor")).toBe(true);
    expect(decoded.cases.some(({ command }) => command === "artifact export")).toBe(true);
  });

  it("rejects malformed parity cli arguments", () => {
    expect(() => parseOptions(["--artifact"])).toThrow("Missing value");
    expect(() => parseOptions(["--bogus"])).toThrow("Unknown argument");
  });
});
