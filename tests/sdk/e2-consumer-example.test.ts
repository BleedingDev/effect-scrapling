import { join } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  E2SdkConsumerExampleResultSchema,
  runE2SdkConsumerExample,
} from "../../examples/e2-sdk-consumer.ts";

const REPO_ROOT = import.meta.dir ? join(import.meta.dir, "..", "..") : process.cwd();
const EXAMPLE_PATH = join(REPO_ROOT, "examples", "e2-sdk-consumer.ts");

describe("E2 SDK consumer example", () => {
  it.effect(
    "runs successfully through the public extraction contract and documents expected pitfalls",
    () =>
      Effect.gen(function* () {
        const result = Schema.decodeUnknownSync(E2SdkConsumerExampleResultSchema)(
          yield* runE2SdkConsumerExample(),
        );

        expect(result.importPath).toBe("effect-scrapling/sdk");
        expect(result.payload.request.url).toBe("https://consumer.example/products/sku-42");
        expect(result.payload.request.selector).toBe('[data-field="price"]');
        expect(result.payload.request.mode).toBe("http");
        expect(result.payload.request.timeoutMs).toBe(600);

        expect(result.payload.response.command).toBe("extract run");
        expect(result.payload.response.data.values).toEqual(["$21.49"]);
        expect(result.payload.response.data.count).toBe(1);
        expect(result.payload.response.warnings).toEqual([]);

        expect(result.payload.noMatchWarning.data.selector).toBe('[data-field="inventory"]');
        expect(result.payload.noMatchWarning.data.values).toEqual([]);
        expect(result.payload.noMatchWarning.warnings).toEqual([
          'No values matched selector "[data-field="inventory"]"',
        ]);

        expect(result.payload.invalidInputError.caughtTag).toBe("InvalidInputError");
        expect(result.payload.invalidInputError.message).toContain("Invalid extract run payload");
        expect(result.payload.invalidInputError.details).toBeTruthy();

        expect(result.payload.invalidSelectorError.caughtTag).toBe("ExtractionError");
        expect(result.payload.invalidSelectorError.message).toContain(
          'Failed to extract with selector "["',
        );
        expect(result.payload.invalidSelectorError.details).toBeTruthy();

        expect(result.pitfalls).toContain(
          "Handle SDK failures with Effect.catchTag instead of manual tag-property branching.",
        );
      }),
  );

  it("executes as a standalone example script", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", EXAMPLE_PATH],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stderr).trim()).toBe("");

    const payload = Schema.decodeUnknownSync(E2SdkConsumerExampleResultSchema)(
      JSON.parse(new TextDecoder().decode(result.stdout)),
    );

    expect(payload.importPath).toBe("effect-scrapling/sdk");
    expect(payload.payload.response.data.values).toEqual(["$21.49"]);
    expect(payload.payload.noMatchWarning.warnings).toEqual([
      'No values matched selector "[data-field="inventory"]"',
    ]);
    expect(payload.payload.invalidInputError.caughtTag).toBe("InvalidInputError");
    expect(payload.payload.invalidSelectorError.caughtTag).toBe("ExtractionError");
  });

  it("keeps the example on the public SDK import path", async () => {
    const source = await Bun.file(EXAMPLE_PATH).text();
    const importSpecifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].flatMap((match) => {
      const specifier = match[1];
      return specifier === undefined ? [] : [specifier];
    });

    expect(importSpecifiers).toContain("effect-scrapling/sdk");
    expect(importSpecifiers.some((specifier) => specifier.includes("src/sdk/"))).toBeFalse();
  });
});
