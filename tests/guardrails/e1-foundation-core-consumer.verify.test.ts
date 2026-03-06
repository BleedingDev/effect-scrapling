import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  PackPromotionDecisionSchema,
  RunExecutionConfigSchema,
  TargetProfileSchema,
} from "@effect-scrapling/foundation-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  foundationCoreConsumerPitfalls,
  foundationCoreConsumerPrerequisites,
  runFoundationCoreConsumerExample,
} from "../../examples/e1-foundation-core-consumer";

const REPO_ROOT = import.meta.dir ? join(import.meta.dir, "..", "..") : process.cwd();
const EXAMPLE_PATH = join(REPO_ROOT, "examples", "e1-foundation-core-consumer.ts");

describe("E1 foundation-core consumer example", () => {
  it.effect("runs successfully through the public foundation-core contract", () =>
    Effect.gen(function* () {
      const result = yield* runFoundationCoreConsumerExample();

      expect(result.importPath).toBe("@effect-scrapling/foundation-core");
      expect(
        Schema.encodeSync(TargetProfileSchema)(
          Schema.decodeUnknownSync(TargetProfileSchema)(result.payload.targetProfile),
        ),
      ).toEqual(result.payload.targetProfile);
      expect(
        Schema.encodeSync(RunExecutionConfigSchema)(
          Schema.decodeUnknownSync(RunExecutionConfigSchema)(result.payload.runConfig),
        ),
      ).toEqual(result.payload.runConfig);
      expect(
        Schema.encodeSync(PackPromotionDecisionSchema)(
          Schema.decodeUnknownSync(PackPromotionDecisionSchema)(result.payload.promotionDecision),
        ),
      ).toEqual(result.payload.promotionDecision);
      expect(result.payload.expectedError.tag).toBe("SchemaBoundaryError");
      expect(result.payload.expectedError.message).toContain("StorageLocator rejected");
    }),
  );

  it("documents prerequisites and pitfall guidance for downstream teams", () => {
    expect(foundationCoreConsumerPrerequisites).toContain("Bun >= 1.3.10");
    expect(foundationCoreConsumerPitfalls).toContain(
      "Handle schema rejections explicitly when user input can affect config or locator payloads.",
    );
  });

  it("uses only the public foundation-core import path", () => {
    const source = readFileSync(EXAMPLE_PATH, "utf8");

    expect(source).toContain('from "@effect-scrapling/foundation-core"');
    expect(/from\s+["'](?:\.\.?\/)+libs\/foundation\/core\//u.test(source)).toBe(false);
  });

  it("executes as a standalone example script", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", "examples/e1-foundation-core-consumer.ts"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(new TextDecoder().decode(result.stdout));

    expect(payload.importPath).toBe("@effect-scrapling/foundation-core");
    expect(
      Schema.encodeSync(TargetProfileSchema)(
        Schema.decodeUnknownSync(TargetProfileSchema)(payload.payload.targetProfile),
      ),
    ).toEqual(payload.payload.targetProfile);
    expect(
      Schema.encodeSync(RunExecutionConfigSchema)(
        Schema.decodeUnknownSync(RunExecutionConfigSchema)(payload.payload.runConfig),
      ),
    ).toEqual(payload.payload.runConfig);
    expect(
      Schema.encodeSync(PackPromotionDecisionSchema)(
        Schema.decodeUnknownSync(PackPromotionDecisionSchema)(payload.payload.promotionDecision),
      ),
    ).toEqual(payload.payload.promotionDecision);
    expect(payload.payload.expectedError.tag).toBe("SchemaBoundaryError");
  });
});
