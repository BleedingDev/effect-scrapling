import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Exit, Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import {
  DomainNormalizationError,
  NormalizedAvailabilitySchema,
  NormalizedPriceSchema,
  NormalizedProductIdentifierSchema,
  normalizeAvailability,
  normalizeCurrency,
  normalizeDate,
  normalizePrice,
  normalizeProductIdentifier,
  normalizeText,
} from "../../libs/foundation/core/src/domain-normalizers.ts";

function runEither<A>(effect: Effect.Effect<A, DomainNormalizationError>) {
  return Effect.runSyncExit(effect);
}

function buildInvalidUpc(bodyDigits: ReadonlyArray<number>): string {
  const body = bodyDigits.slice(0, 11).join("");
  let total = 0;

  for (let index = 0; index < body.length; index += 1) {
    const digitText = body[index];
    if (digitText === undefined) {
      continue;
    }

    const digit = Number(digitText);
    const isOddFromRight = (body.length - index) % 2 === 1;
    total += digit * (isOddFromRight ? 3 : 1);
  }

  const validCheckDigit = (10 - (total % 10)) % 10;
  const invalidCheckDigit = (validCheckDigit + 1) % 10;
  return `${body}${invalidCheckDigit}`;
}

const whitespaceOnlyArbitrary = FastCheck.array(
  FastCheck.constantFrom(" ", "\t", "\n", "\u00a0", "\u200b"),
  {
    minLength: 1,
    maxLength: 12,
  },
).map((segments) => segments.join(""));

describe("foundation-core domain normalizers", () => {
  it.effect(
    "normalizes canonical text, currency, price, availability, dates, and product identifiers",
    () =>
      Effect.gen(function* () {
        const normalizedText = yield* normalizeText("  Fresh\u00a0deal\u200b \n  today  ");
        expect(normalizedText).toBe("Fresh deal today");

        const usd = yield* normalizeCurrency(" us dollars ");
        expect(usd).toBe("USD");

        const euroPrice = yield* normalizePrice("EUR 19,99");
        expect(Schema.encodeSync(NormalizedPriceSchema)(euroPrice)).toEqual({
          amount: 19.99,
          currency: "EUR",
        });

        const structuredPrice = yield* normalizePrice({
          amount: "1 299,50",
          currency: "Canadian dollars",
        });
        expect(Schema.encodeSync(NormalizedPriceSchema)(structuredPrice)).toEqual({
          amount: 1299.5,
          currency: "CAD",
        });

        const availability = yield* normalizeAvailability("Ships in 2 weeks");
        expect(Schema.encodeSync(NormalizedAvailabilitySchema)(availability)).toBe("backorder");

        const launchDate = yield* normalizeDate("2026-03-06");
        expect(launchDate).toBe("2026-03-06T00:00:00.000Z");

        const ean = yield* normalizeProductIdentifier("EAN 4006381333931");
        expect(Schema.encodeSync(NormalizedProductIdentifierSchema)(ean)).toEqual({
          kind: "ean",
          value: "4006381333931",
        });

        const sku = yield* normalizeProductIdentifier("sku: part-9_a");
        expect(Schema.encodeSync(NormalizedProductIdentifierSchema)(sku)).toEqual({
          kind: "sku",
          value: "PART-9_A",
        });
      }),
  );

  it.effect(
    "handles malformed price, currency, availability, date, text, and identifier inputs deterministically",
    () =>
      Effect.gen(function* () {
        const missingCurrency = yield* normalizePrice("19.99").pipe(Effect.flip);
        expect(missingCurrency.field).toBe("price");
        expect(missingCurrency.message).toContain("currency");

        const badCurrency = yield* normalizeCurrency("store credit").pipe(Effect.flip);
        expect(badCurrency.field).toBe("currency");

        const badAvailability = yield* normalizeAvailability("maybe later").pipe(Effect.flip);
        expect(badAvailability.field).toBe("availability");

        const impossibleDate = yield* normalizeDate("not-a-date").pipe(Effect.flip);
        expect(impossibleDate.field).toBe("date");

        const emptyText = yield* normalizeText(" \n\t\u200b ").pipe(Effect.flip);
        expect(emptyText.field).toBe("text");

        const invalidUpc = yield* normalizeProductIdentifier({
          kind: "upc",
          value: "036000291453",
        }).pipe(Effect.flip);
        expect(invalidUpc.field).toBe("productIdentifier");
      }),
  );

  it.prop(
    "normalizes successful text outputs idempotently across generated inputs",
    {
      value: FastCheck.string(),
    },
    ({ value }) =>
      Effect.sync(() => {
        const first = runEither(normalizeText(value));
        if (Exit.isFailure(first)) {
          return;
        }

        const second = runEither(normalizeText(first.value));
        expect(Exit.isSuccess(second)).toBe(true);
        if (Exit.isSuccess(second)) {
          expect(second.value).toBe(first.value);
        }
        expect(first.value).toBe(first.value.trim());
        expect(/\s{2,}/u.test(first.value)).toBe(false);
      }),
  );

  it.prop(
    "rejects whitespace-only malformed text inputs",
    {
      value: whitespaceOnlyArbitrary,
    },
    ({ value }) =>
      Effect.sync(() => {
        const result = runEither(normalizeText(value));
        expect(Exit.isFailure(result)).toBe(true);
      }),
  );

  it.prop(
    "rejects generated UPC identifiers with an invalid checksum digit",
    {
      bodyDigits: FastCheck.array(FastCheck.integer({ min: 0, max: 9 }), {
        minLength: 11,
        maxLength: 11,
      }),
    },
    ({ bodyDigits }) =>
      Effect.sync(() => {
        const invalidUpc = buildInvalidUpc(bodyDigits);
        const result = runEither(
          normalizeProductIdentifier({
            kind: "upc",
            value: invalidUpc,
          }),
        );
        expect(Exit.isFailure(result)).toBe(true);
      }),
  );
});
