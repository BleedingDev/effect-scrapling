import { describe, expect, it } from "@effect-native/bun-test";
import { Effect } from "effect";
import { runConsumerExample } from "../../examples/sdk-consumer.ts";

describe("sdk consumer example", () => {
  it.effect("runs successfully through the public sdk contract", () =>
    Effect.gen(function* () {
      const result = yield* runConsumerExample();

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
});
