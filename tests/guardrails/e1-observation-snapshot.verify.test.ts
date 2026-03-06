import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import { ObservationSchema, SnapshotSchema } from "../../libs/foundation/core/src";

function makeObservation() {
  return {
    field: "headline",
    normalizedValue: "Example headline",
    confidence: 0.92,
    evidenceRefs: ["artifact-html-001"],
  };
}

function makeSnapshot() {
  return {
    id: "snapshot-001",
    targetId: "target-product-001",
    observations: [makeObservation()],
    qualityScore: 0.88,
    createdAt: "2026-03-06T00:00:00.000Z",
  };
}

describe("E1 observation and snapshot verification", () => {
  it("roundtrips snapshot payloads through the public foundation-core contract", () => {
    const decoded = Schema.decodeUnknownSync(SnapshotSchema)(makeSnapshot());

    expect(Schema.encodeSync(SnapshotSchema)(decoded)).toEqual(makeSnapshot());
  });

  it("rejects observations without evidence and out-of-range scores", () => {
    expect(
      Schema.decodeUnknownSync(ObservationSchema)({
        field: "price",
        normalizedValue: {
          amount: 19.99,
          currency: "USD",
        },
        confidence: 0.9,
        evidenceRefs: ["artifact-price-001"],
      }),
    ).toEqual({
      field: "price",
      normalizedValue: {
        amount: 19.99,
        currency: "USD",
      },
      confidence: 0.9,
      evidenceRefs: ["artifact-price-001"],
    });

    expect(() =>
      Schema.decodeUnknownSync(ObservationSchema)({
        ...makeObservation(),
        evidenceRefs: [],
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(ObservationSchema)({
        ...makeObservation(),
        confidence: 1.1,
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(ObservationSchema)({
        field: "price",
        normalizedValue: {
          amount: 19.99,
        },
        confidence: 0.9,
        evidenceRefs: ["artifact-price-001"],
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(SnapshotSchema)({
        ...makeSnapshot(),
        qualityScore: -0.01,
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(SnapshotSchema)({
        ...makeSnapshot(),
        createdAt: "March 6 2026",
      }),
    ).toThrow();
  });
});
