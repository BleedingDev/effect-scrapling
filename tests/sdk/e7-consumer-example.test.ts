import { join } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { PromotionGateEvaluationSchema } from "effect-scrapling/e7";
import { runE7SdkConsumerExample } from "../../examples/e7-sdk-consumer.ts";

const REPO_ROOT = import.meta.dir ? join(import.meta.dir, "..", "..") : process.cwd();
const EXAMPLE_PATH = join(REPO_ROOT, "examples", "e7-sdk-consumer.ts");

describe("E7 SDK consumer example", () => {
  it.effect("runs the E7 public consumer flow through the shared package subpath", () =>
    Effect.gen(function* () {
      const result = yield* runE7SdkConsumerExample();
      const evaluation = Schema.decodeUnknownSync(PromotionGateEvaluationSchema)(
        result.payload.evaluation,
      );

      expect(result.importPaths).toEqual(["effect-scrapling/e7"]);
      expect(
        result.prerequisites.some((entry: string) => entry.includes("effect-scrapling/e7")),
      ).toBe(true);
      expect(result.pitfalls.some((entry: string) => entry.includes("public E7 surface"))).toBe(
        true,
      );
      expect(evaluation.verdict).toBe("promote");
      expect(evaluation.rationale.map(({ code }) => code)).toEqual([
        "quality-clean",
        "performance-clean",
        "canary-clean",
      ]);
      expect(result.payload.expectedError.code).toBe("ParserFailure");
      expect(result.payload.expectedError.message).toContain("same pack count");
    }),
  );

  it("keeps the example on the public E7 package subpath only", async () => {
    const source = await Bun.file(EXAMPLE_PATH).text();
    const importSpecifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].flatMap((match) => {
      const specifier = match[1];
      return specifier === undefined ? [] : [specifier];
    });

    expect(importSpecifiers.sort()).toEqual(["effect", "effect-scrapling/e7"]);
    expect(source.includes("../libs/foundation/core")).toBeFalse();
    expect(source.includes("../../libs/foundation/core")).toBeFalse();
    expect(source.includes("../scripts/")).toBeFalse();
    expect(source.includes("../../scripts/")).toBeFalse();
  });
});
