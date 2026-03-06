import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  PackPromotionDecisionSchema,
  RunExecutionConfigSchema,
  TargetProfileSchema,
} from "@effect-scrapling/foundation-core";
import { join } from "node:path";
import { runFoundationCoreConsumerExample } from "../../examples/e1-foundation-core-consumer.ts";

const REPO_ROOT = import.meta.dir ? join(import.meta.dir, "..", "..") : process.cwd();

describe("E1 foundation-core consumer example", () => {
  it.effect("runs successfully through the public foundation-core contract", () =>
    Effect.gen(function* () {
      const result = yield* runFoundationCoreConsumerExample();

      const targetProfile = Schema.decodeUnknownSync(TargetProfileSchema)(
        result.payload.targetProfile,
      );
      const runConfig = Schema.decodeUnknownSync(RunExecutionConfigSchema)(
        result.payload.runConfig,
      );
      const promotionDecision = Schema.decodeUnknownSync(PackPromotionDecisionSchema)(
        result.payload.promotionDecision,
      );

      expect(targetProfile.kind).toBe("productPage");
      expect(runConfig.mode).toBe("browser");
      expect(promotionDecision.action).toBe("promote-shadow");
      expect(result.payload.expectedError.tag).toBe("SchemaBoundaryError");
      expect(result.payload.expectedError.message).toContain("StorageLocator rejected");
    }),
  );

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
    const targetProfile = Schema.decodeUnknownSync(TargetProfileSchema)(
      payload.payload.targetProfile,
    );
    const runConfig = Schema.decodeUnknownSync(RunExecutionConfigSchema)(payload.payload.runConfig);
    const promotionDecision = Schema.decodeUnknownSync(PackPromotionDecisionSchema)(
      payload.payload.promotionDecision,
    );

    expect(targetProfile.domain).toBe("example.com");
    expect(runConfig.timeoutMs).toBe(10_000);
    expect(promotionDecision.toState).toBe("shadow");
    expect(payload.payload.expectedError.tag).toBe("SchemaBoundaryError");
  });
});
