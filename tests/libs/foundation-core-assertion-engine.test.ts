import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  AssertionFailureSchema,
  AssertionReportSchema,
  runAssertionEngine,
} from "../../libs/foundation/core/src/assertion-engine.ts";
import {
  NormalizedPriceSchema,
  normalizeAvailability,
  normalizePrice,
} from "../../libs/foundation/core/src/domain-normalizers.ts";
import { SnapshotSchema } from "../../libs/foundation/core/src/observation-snapshot.ts";

describe("foundation-core assertion engine", () => {
  it.effect("passes required-field and invariant assertions for complete snapshots", () =>
    Effect.gen(function* () {
      const price = yield* normalizePrice("USD 19.99");
      const availability = yield* normalizeAvailability("In stock");
      const snapshot = Schema.decodeUnknownSync(SnapshotSchema)({
        id: "snapshot-assertion-001",
        targetId: "target-product-001",
        observations: [
          {
            field: "price",
            normalizedValue: Schema.encodeSync(NormalizedPriceSchema)(price),
            confidence: 0.98,
            evidenceRefs: ["artifact-price-001"],
          },
          {
            field: "availability",
            normalizedValue: availability,
            confidence: 0.96,
            evidenceRefs: ["artifact-availability-001"],
          },
        ],
        qualityScore: 0.93,
        createdAt: "2026-03-06T10:00:00.000Z",
      });

      const report = yield* runAssertionEngine({
        snapshot,
        requiredFields: [
          {
            field: "price",
            minimumConfidence: 0.95,
          },
          {
            field: "availability",
          },
        ],
        businessInvariants: [
          {
            kind: "numericRange",
            field: "price",
            minimum: 10,
            maximum: 30,
          },
          {
            kind: "stringOneOf",
            field: "availability",
            allowedValues: ["inStock", "preorder"],
          },
        ],
      });

      expect(Schema.encodeSync(AssertionReportSchema)(report)).toEqual({
        snapshotId: "snapshot-assertion-001",
        evaluatedRuleCount: 4,
        assertedFields: ["price", "availability"],
      });
    }),
  );

  it.effect("reports missing-field and confidence failures with concrete snapshot context", () =>
    Effect.gen(function* () {
      const price = yield* normalizePrice("$4.99");
      const snapshot = Schema.decodeUnknownSync(SnapshotSchema)({
        id: "snapshot-assertion-002",
        targetId: "target-product-001",
        observations: [
          {
            field: "price",
            normalizedValue: Schema.encodeSync(NormalizedPriceSchema)(price),
            confidence: 0.62,
            evidenceRefs: ["artifact-price-002"],
          },
        ],
        qualityScore: 0.61,
        createdAt: "2026-03-06T10:05:00.000Z",
      });

      const failure = yield* runAssertionEngine({
        snapshot,
        requiredFields: [
          {
            field: "price",
            minimumConfidence: 0.9,
          },
          {
            field: "availability",
          },
        ],
        businessInvariants: [],
      }).pipe(Effect.flip);

      expect(
        failure.failures.map((issue) => Schema.encodeSync(AssertionFailureSchema)(issue)),
      ).toEqual([
        {
          kind: "businessInvariantFailure",
          message: "Field price confidence 0.62 is below required minimum 0.9.",
          context: {
            snapshotId: "snapshot-assertion-002",
            field: "price",
            evidenceRefs: ["artifact-price-002"],
          },
        },
        {
          kind: "missingRequiredField",
          message: "Required field availability is missing from the snapshot.",
          context: {
            snapshotId: "snapshot-assertion-002",
            field: "availability",
            evidenceRefs: [],
          },
        },
      ]);
    }),
  );

  it.effect("reports invariant violations with preserved evidence references", () =>
    Effect.gen(function* () {
      const price = yield* normalizePrice("USD 4.99");
      const availability = yield* normalizeAvailability("Discontinued");
      const snapshot = Schema.decodeUnknownSync(SnapshotSchema)({
        id: "snapshot-assertion-003",
        targetId: "target-product-001",
        observations: [
          {
            field: "price",
            normalizedValue: Schema.encodeSync(NormalizedPriceSchema)(price),
            confidence: 0.97,
            evidenceRefs: ["artifact-price-003"],
          },
          {
            field: "availability",
            normalizedValue: availability,
            confidence: 0.91,
            evidenceRefs: ["artifact-availability-003"],
          },
        ],
        qualityScore: 0.82,
        createdAt: "2026-03-06T10:10:00.000Z",
      });

      const failure = yield* runAssertionEngine({
        snapshot,
        requiredFields: [],
        businessInvariants: [
          {
            kind: "numericRange",
            field: "price",
            minimum: 10,
          },
          {
            kind: "stringOneOf",
            field: "availability",
            allowedValues: ["inStock", "preorder"],
          },
        ],
      }).pipe(Effect.flip);

      expect(
        failure.failures.map((issue) => Schema.encodeSync(AssertionFailureSchema)(issue)),
      ).toEqual([
        {
          kind: "businessInvariantFailure",
          message: "Field price numeric value 4.99 is outside the allowed range [10, inf].",
          context: {
            snapshotId: "snapshot-assertion-003",
            field: "price",
            evidenceRefs: ["artifact-price-003"],
          },
        },
        {
          kind: "businessInvariantFailure",
          message:
            "Field availability normalized value discontinued is outside the allowed set inStock, preorder.",
          context: {
            snapshotId: "snapshot-assertion-003",
            field: "availability",
            evidenceRefs: ["artifact-availability-003"],
          },
        },
      ]);
    }),
  );

  it.effect("surfaces structured decode failures for invalid assertion-engine input", () =>
    Effect.gen(function* () {
      const failure = yield* runAssertionEngine({
        snapshot: {
          id: "not-a-valid-snapshot",
        },
      }).pipe(Effect.flip);

      expect(
        failure.failures.map((issue) => Schema.encodeSync(AssertionFailureSchema)(issue)),
      ).toEqual([
        {
          kind: "businessInvariantFailure",
          message: "Failed to decode assertion-engine input through shared contracts.",
          context: {
            snapshotId: "unknown-snapshot",
            field: "unknown-field",
            evidenceRefs: [],
          },
        },
      ]);
    }),
  );
});
