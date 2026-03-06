import { describe, expect, it } from "@effect-native/bun-test";
import { Effect } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accessPreview } from "effect-scrapling/sdk";
import {
  consumerExamplePitfalls,
  consumerExamplePrerequisites,
  runConsumerExample,
} from "../../examples/sdk-consumer";

const REPO_ROOT = import.meta.dir ? join(import.meta.dir, "..", "..") : process.cwd();
const EXAMPLE_PATH = join(REPO_ROOT, "examples", "sdk-consumer.ts");

describe("sdk consumer example", () => {
  it.effect("runs successfully through the public sdk contract", () =>
    Effect.gen(function* () {
      const result = yield* runConsumerExample();

      expect(typeof accessPreview).toBe("function");
      expect(result.preview.command).toBe("access preview");
      expect(result.preview.data.finalUrl).toBe(
        "https://consumer.example/articles/effect-scrapling",
      );
      expect(result.extract.command).toBe("extract run");
      expect(result.extract.data.values).toEqual(["Effect Scrapling"]);
      expect(result.expectedError.tag).toBe("InvalidInputError");
      expect(result.expectedError.message).toContain("Invalid access preview payload");
    }),
  );

  it("documents prerequisites and pitfall guidance for consumers", () => {
    expect(consumerExamplePrerequisites).toContain("Bun >= 1.3.10");
    expect(consumerExamplePitfalls).toContain(
      "Malformed payloads fail with InvalidInputError and should be handled explicitly.",
    );
  });

  it("uses only the public sdk import path", () => {
    const source = readFileSync(EXAMPLE_PATH, "utf8");

    expect(source).toContain('from "effect-scrapling/sdk"');
    expect(/from\s+["'](?:\.\.?\/)+src\/sdk\//u.test(source)).toBe(false);
  });

  it("executes as a standalone example script", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", "examples/sdk-consumer.ts"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    expect(result.exitCode).toBe(0);

    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain('"importPath": "effect-scrapling/sdk"');
    expect(stdout).toContain('"tag": "InvalidInputError"');
    expect(stdout).toContain('"Effect Scrapling"');
  });
});
