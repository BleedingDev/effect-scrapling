import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  GoldenFixtureBankSchema,
  GoldenFixtureReplayResultSchema,
  replayGoldenFixture,
} from "../../libs/foundation/core/src/golden-fixtures.ts";

const GOLDEN_FIXTURE_BANK_URL = new URL(
  "../fixtures/foundation-core-e2-golden-fixtures.json",
  import.meta.url,
);

describe("foundation-core golden fixtures", () => {
  it.effect("replays historical extractor fixtures exactly", () =>
    Effect.gen(function* () {
      const fixtureBank = yield* Effect.tryPromise({
        try: async () => {
          const fixtureJson = await Bun.file(GOLDEN_FIXTURE_BANK_URL).json();
          return Schema.decodeUnknownSync(GoldenFixtureBankSchema)(fixtureJson);
        },
        catch: (cause) => new Error(`Failed to load golden fixture bank: ${String(cause)}`),
      });
      const replayResults = yield* Effect.forEach(fixtureBank, replayGoldenFixture, {
        concurrency: 1,
      });

      expect(
        replayResults.map((result) => Schema.encodeSync(GoldenFixtureReplayResultSchema)(result)),
      ).toEqual(
        fixtureBank.map(({ expected }) =>
          Schema.encodeSync(GoldenFixtureReplayResultSchema)(expected),
        ),
      );
    }),
  );
});
