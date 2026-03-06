import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  NormalizedPriceSchema,
  normalizePrice,
} from "../../libs/foundation/core/src/domain-normalizers.ts";
import { SnapshotDiffSchema } from "../../libs/foundation/core/src/diff-verdict.ts";
import {
  CanonicalSnapshotSchema,
  canonicalizeSnapshot,
  compareSnapshots,
  makeSnapshotDiffEngine,
} from "../../libs/foundation/core/src/snapshot-diff-engine.ts";
import { SnapshotSchema } from "../../libs/foundation/core/src/observation-snapshot.ts";

describe("foundation-core snapshot diff engine", () => {
  it.effect("canonicalizes snapshots deterministically by strongest field evidence", () =>
    Effect.gen(function* () {
      const snapshot = Schema.decodeUnknownSync(SnapshotSchema)({
        id: "snapshot-canonical-001",
        targetId: "target-product-001",
        observations: [
          {
            field: "title",
            normalizedValue: "Zeta Jacket",
            confidence: 0.9,
            evidenceRefs: ["artifact-title-2", "artifact-title-1"],
          },
          {
            field: "title",
            normalizedValue: "Alpha Jacket",
            confidence: 0.9,
            evidenceRefs: ["artifact-title-3"],
          },
          {
            field: "availability",
            normalizedValue: "outOfStock",
            confidence: 0.41,
            evidenceRefs: ["artifact-availability-2"],
          },
          {
            field: "availability",
            normalizedValue: "inStock",
            confidence: 0.96,
            evidenceRefs: ["artifact-availability-1"],
          },
        ],
        qualityScore: 0.88,
        createdAt: "2026-03-06T10:00:00.000Z",
      });

      const canonical = yield* canonicalizeSnapshot(snapshot);

      expect(Schema.encodeSync(CanonicalSnapshotSchema)(canonical)).toEqual({
        snapshotId: "snapshot-canonical-001",
        targetId: "target-product-001",
        qualityScore: 0.88,
        confidenceScore: 0.93,
        fields: [
          {
            field: "availability",
            observation: {
              field: "availability",
              normalizedValue: "inStock",
              confidence: 0.96,
              evidenceRefs: ["artifact-availability-1"],
            },
            valueFingerprint: '"inStock"',
          },
          {
            field: "title",
            observation: {
              field: "title",
              normalizedValue: "Alpha Jacket",
              confidence: 0.9,
              evidenceRefs: ["artifact-title-3"],
            },
            valueFingerprint: '"Alpha Jacket"',
          },
        ],
      });
    }),
  );

  it.effect("classifies add remove and change scenarios on canonical snapshots", () =>
    Effect.gen(function* () {
      const baselinePrice = yield* normalizePrice("USD 19.99");
      const candidatePrice = yield* normalizePrice("USD 24.99");
      const baseline = Schema.decodeUnknownSync(SnapshotSchema)({
        id: "snapshot-baseline-001",
        targetId: "target-product-001",
        observations: [
          {
            field: "price",
            normalizedValue: Schema.encodeSync(NormalizedPriceSchema)(baselinePrice),
            confidence: 0.9,
            evidenceRefs: ["artifact-price-baseline"],
          },
          {
            field: "availability",
            normalizedValue: "inStock",
            confidence: 0.8,
            evidenceRefs: ["artifact-availability-baseline"],
          },
          {
            field: "title",
            normalizedValue: "Example Product",
            confidence: 0.7,
            evidenceRefs: ["artifact-title-baseline"],
          },
        ],
        qualityScore: 0.84,
        createdAt: "2026-03-06T10:00:00.000Z",
      });
      const candidate = Schema.decodeUnknownSync(SnapshotSchema)({
        id: "snapshot-candidate-001",
        targetId: "target-product-001",
        observations: [
          {
            field: "price",
            normalizedValue: Schema.encodeSync(NormalizedPriceSchema)(candidatePrice),
            confidence: 0.6,
            evidenceRefs: ["artifact-price-candidate"],
          },
          {
            field: "title",
            normalizedValue: "Example Product",
            confidence: 0.9,
            evidenceRefs: ["artifact-title-candidate"],
          },
          {
            field: "rating",
            normalizedValue: "4.8",
            confidence: 0.5,
            evidenceRefs: ["artifact-rating-candidate"],
          },
        ],
        qualityScore: 0.79,
        createdAt: "2026-03-06T10:05:00.000Z",
      });

      const diff = yield* compareSnapshots({
        id: "diff-target-product-001",
        baseline,
        candidate,
        createdAt: "2026-03-06T10:06:00.000Z",
        latencyDeltaMs: 12,
        memoryDelta: -4,
      });

      expect(Schema.encodeSync(SnapshotDiffSchema)(diff)).toEqual({
        id: "diff-target-product-001",
        baselineSnapshotId: "snapshot-baseline-001",
        candidateSnapshotId: "snapshot-candidate-001",
        metrics: {
          fieldRecallDelta: -0.708333,
          falsePositiveDelta: -0.25,
          driftDelta: -0.465909,
          latencyDeltaMs: 12,
          memoryDelta: -4,
        },
        changes: [
          {
            changeType: "remove",
            field: "availability",
            baseline: {
              field: "availability",
              normalizedValue: "inStock",
              confidence: 0.8,
              evidenceRefs: ["artifact-availability-baseline"],
            },
            confidenceDelta: -0.8,
          },
          {
            changeType: "change",
            field: "price",
            baseline: {
              field: "price",
              normalizedValue: Schema.encodeSync(NormalizedPriceSchema)(baselinePrice),
              confidence: 0.9,
              evidenceRefs: ["artifact-price-baseline"],
            },
            candidate: {
              field: "price",
              normalizedValue: Schema.encodeSync(NormalizedPriceSchema)(candidatePrice),
              confidence: 0.6,
              evidenceRefs: ["artifact-price-candidate"],
            },
            confidenceDelta: -0.3,
          },
          {
            changeType: "add",
            field: "rating",
            candidate: {
              field: "rating",
              normalizedValue: "4.8",
              confidence: 0.5,
              evidenceRefs: ["artifact-rating-candidate"],
            },
            confidenceDelta: 0.5,
          },
        ],
        canonicalMetrics: {
          baselineFieldCount: 3,
          candidateFieldCount: 3,
          unchangedFieldCount: 1,
          addedFieldCount: 1,
          removedFieldCount: 1,
          changedFieldCount: 1,
          baselineConfidenceScore: 0.8,
          candidateConfidenceScore: 0.666667,
          confidenceDelta: -0.133333,
        },
        createdAt: "2026-03-06T10:06:00.000Z",
      });
    }),
  );

  it.effect("fails when the engine is asked to compare snapshots from different targets", () =>
    Effect.gen(function* () {
      const baseline = Schema.decodeUnknownSync(SnapshotSchema)({
        id: "snapshot-baseline-002",
        targetId: "target-product-001",
        observations: [],
        qualityScore: 0.9,
        createdAt: "2026-03-06T10:10:00.000Z",
      });
      const candidate = Schema.decodeUnknownSync(SnapshotSchema)({
        id: "snapshot-candidate-002",
        targetId: "target-product-002",
        observations: [],
        qualityScore: 0.91,
        createdAt: "2026-03-06T10:11:00.000Z",
      });

      const message = yield* compareSnapshots({
        id: "diff-target-mismatch-001",
        baseline,
        candidate,
        createdAt: "2026-03-06T10:12:00.000Z",
      }).pipe(
        Effect.match({
          onFailure: ({ message }) => message,
          onSuccess: () => "unexpected-success",
        }),
      );

      expect(message).toBe(
        "Snapshot diff requires baseline and candidate snapshots for the same target.",
      );
    }),
  );

  it.effect(
    "provides a DiffEngine-compatible implementation with deterministic ids and timestamps",
    () =>
      Effect.gen(function* () {
        const baseline = Schema.decodeUnknownSync(SnapshotSchema)({
          id: "snapshot-baseline-003",
          targetId: "target-product-001",
          observations: [
            {
              field: "title",
              normalizedValue: "Example Product",
              confidence: 0.8,
              evidenceRefs: ["artifact-title-baseline-003"],
            },
          ],
          qualityScore: 0.8,
          createdAt: "2026-03-06T10:13:00.000Z",
        });
        const candidate = Schema.decodeUnknownSync(SnapshotSchema)({
          id: "snapshot-candidate-003",
          targetId: "target-product-001",
          observations: [
            {
              field: "title",
              normalizedValue: "Example Product",
              confidence: 0.85,
              evidenceRefs: ["artifact-title-candidate-003"],
            },
          ],
          qualityScore: 0.85,
          createdAt: "2026-03-06T10:14:00.000Z",
        });
        const engine = makeSnapshotDiffEngine(
          () => new Date("2026-03-06T10:15:00.000Z"),
          () => "diff-live-001",
        );

        const diff = yield* engine.compare(baseline, candidate);

        expect(diff.id).toBe("diff-live-001");
        expect(diff.createdAt).toBe("2026-03-06T10:15:00.000Z");
        expect(diff.changes).toEqual([]);
        expect(diff.canonicalMetrics?.confidenceDelta).toBe(0.05);
      }),
  );
});
