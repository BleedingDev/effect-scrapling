import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  buildObservationSnapshot,
  SnapshotAssemblyResultSchema,
} from "../../libs/foundation/core/src/snapshot-builder.ts";

const SNAPSHOT_INPUT = {
  id: "snapshot-product-001",
  targetId: "target-product-001",
  createdAt: "2026-03-06T10:15:00.000Z",
  observations: [
    {
      field: "title",
      normalizedValue: "example product",
      confidence: 0.95,
      evidenceRefs: ["artifact-title-dom"],
    },
    {
      field: "availability",
      normalizedValue: "outOfStock",
      confidence: 0.51,
      evidenceRefs: ["artifact-availability-fallback"],
    },
    {
      field: "price",
      normalizedValue: {
        currency: "USD",
        amount: 19.99,
      },
      confidence: 0.87,
      evidenceRefs: ["artifact-price-json", "artifact-price-dom"],
    },
    {
      field: "availability",
      normalizedValue: "inStock",
      confidence: 0.72,
      evidenceRefs: ["artifact-availability-json", "artifact-availability-dom"],
    },
    {
      field: "price",
      normalizedValue: {
        amount: 19.99,
        currency: "USD",
      },
      confidence: 0.91,
      evidenceRefs: ["artifact-price-dom"],
    },
  ],
};

const SNAPSHOT_INPUT_PERMUTED = {
  id: "snapshot-product-001",
  targetId: "target-product-001",
  createdAt: "2026-03-06T10:15:00.000Z",
  observations: [
    {
      field: "price",
      normalizedValue: {
        amount: 19.99,
        currency: "USD",
      },
      confidence: 0.91,
      evidenceRefs: ["artifact-price-dom"],
    },
    {
      field: "availability",
      normalizedValue: "inStock",
      confidence: 0.72,
      evidenceRefs: ["artifact-availability-dom", "artifact-availability-json"],
    },
    {
      field: "title",
      normalizedValue: "example product",
      confidence: 0.95,
      evidenceRefs: ["artifact-title-dom"],
    },
    {
      field: "price",
      normalizedValue: {
        currency: "USD",
        amount: 19.99,
      },
      confidence: 0.87,
      evidenceRefs: ["artifact-price-dom", "artifact-price-json"],
    },
    {
      field: "availability",
      normalizedValue: "outOfStock",
      confidence: 0.51,
      evidenceRefs: ["artifact-availability-fallback"],
    },
  ],
};

describe("foundation-core snapshot builder", () => {
  it.effect("assembles identical snapshots for equivalent observation sets", () =>
    Effect.gen(function* () {
      const first = yield* buildObservationSnapshot(SNAPSHOT_INPUT);
      const second = yield* buildObservationSnapshot(SNAPSHOT_INPUT_PERMUTED);

      expect(Schema.encodeSync(SnapshotAssemblyResultSchema)(first)).toEqual(
        Schema.encodeSync(SnapshotAssemblyResultSchema)(second),
      );
    }),
  );

  it.effect("computes auditable quality score inputs from deterministic observations", () =>
    Effect.gen(function* () {
      const result = yield* buildObservationSnapshot(SNAPSHOT_INPUT);

      expect(Schema.encodeSync(SnapshotAssemblyResultSchema)(result)).toEqual({
        snapshot: {
          id: "snapshot-product-001",
          targetId: "target-product-001",
          observations: [
            {
              field: "availability",
              normalizedValue: "inStock",
              confidence: 0.72,
              evidenceRefs: ["artifact-availability-dom", "artifact-availability-json"],
            },
            {
              field: "availability",
              normalizedValue: "outOfStock",
              confidence: 0.51,
              evidenceRefs: ["artifact-availability-fallback"],
            },
            {
              field: "price",
              normalizedValue: {
                amount: 19.99,
                currency: "USD",
              },
              confidence: 0.91,
              evidenceRefs: ["artifact-price-dom", "artifact-price-json"],
            },
            {
              field: "title",
              normalizedValue: "example product",
              confidence: 0.95,
              evidenceRefs: ["artifact-title-dom"],
            },
          ],
          qualityScore: 0.754875,
          createdAt: "2026-03-06T10:15:00.000Z",
        },
        qualityScoreInputs: {
          sourceObservationCount: 5,
          assembledObservationCount: 4,
          duplicateObservationCount: 1,
          uniqueFieldCount: 3,
          conflictingFieldCount: 1,
          uniqueEvidenceRefCount: 6,
          multiEvidenceObservationCount: 2,
          averageEvidenceRefsPerObservation: 1.5,
          averageConfidence: 0.7725,
          minimumConfidence: 0.51,
          evidenceStrengthScore: 0.75,
          conflictFreeScore: 0.666667,
          uniquenessScore: 0.8,
        },
        qualityScoreBreakdown: {
          confidenceContribution: 0.424875,
          evidenceStrengthContribution: 0.15,
          conflictFreeContribution: 0.1,
          uniquenessContribution: 0.08,
        },
      });
    }),
  );

  it.effect("fails with a structured error when no observations are provided", () =>
    Effect.gen(function* () {
      const failureMessage = yield* buildObservationSnapshot({
        id: "snapshot-product-empty",
        targetId: "target-product-empty",
        createdAt: "2026-03-06T10:20:00.000Z",
        observations: [],
      }).pipe(
        Effect.match({
          onFailure: ({ message }) => message,
          onSuccess: () => "unexpected-success",
        }),
      );

      expect(failureMessage).toContain("at least one observation");
      expect(failureMessage).not.toBe("unexpected-success");
    }),
  );
});
