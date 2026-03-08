import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { synthesizePackReflection } from "../../libs/foundation/core/src/reflector-runtime.ts";
import { SitePackDslSchema } from "../../libs/foundation/core/src/site-pack.ts";

const packDefinition = Schema.decodeUnknownSync(SitePackDslSchema)({
  pack: {
    id: "pack-shop-example-com",
    domainPattern: "*.example.com",
    state: "shadow",
    accessPolicyId: "policy-default",
    version: "2026.03.08",
  },
  selectors: [
    {
      field: "title",
      candidates: [
        {
          path: "title/primary",
          selector: "h1",
        },
      ],
      fallbackPolicy: {
        maxFallbackCount: 0,
        fallbackConfidenceImpact: 0,
        maxConfidenceImpact: 0,
      },
    },
    {
      field: "price",
      candidates: [
        {
          path: "price/primary",
          selector: "[data-testid='price']",
        },
        {
          path: "price/fallback",
          selector: ".price-box",
        },
      ],
      fallbackPolicy: {
        maxFallbackCount: 1,
        fallbackConfidenceImpact: 0.15,
        maxConfidenceImpact: 0.45,
      },
    },
  ],
  assertions: {
    requiredFields: [{ field: "title" }, { field: "price" }],
    businessInvariants: [],
  },
  policy: {
    targetKinds: ["productPage"],
    mode: "http",
    render: "never",
  },
  metadata: {
    owners: ["team-catalog"],
    labels: ["retail"],
  },
});

describe("foundation-core reflector runtime", () => {
  it.effect("clusters recurring failure signals into one pack-level recommendation", () =>
    Effect.gen(function* () {
      const recommendation = yield* synthesizePackReflection({
        pack: packDefinition,
        createdAt: "2026-03-08T12:00:00.000Z",
        signals: [
          {
            kind: "failure",
            failure: {
              kind: "missingRequiredField",
              message: "Price is missing.",
              context: {
                snapshotId: "snapshot-001",
                field: "price",
                evidenceRefs: ["artifact-price-001"],
              },
            },
            selectorCandidate: {
              path: "price/relocated",
              selector: "[data-price]",
            },
            evidenceRefs: ["artifact-price-001", "artifact-price-002"],
            observedAt: "2026-03-08T11:00:00.000Z",
          },
          {
            kind: "failure",
            failure: {
              kind: "missingRequiredField",
              message: "Price is still missing.",
              context: {
                snapshotId: "snapshot-002",
                field: "price",
                evidenceRefs: ["artifact-price-003"],
              },
            },
            selectorCandidate: {
              path: "price/relocated",
              selector: "[data-price]",
            },
            evidenceRefs: ["artifact-price-003"],
            observedAt: "2026-03-08T11:05:00.000Z",
          },
          {
            kind: "failure",
            failure: {
              kind: "missingRequiredField",
              message: "Price remains missing.",
              context: {
                snapshotId: "snapshot-003",
                field: "price",
                evidenceRefs: ["artifact-price-004"],
              },
            },
            selectorCandidate: {
              path: "price/relocated",
              selector: "[data-price]",
            },
            evidenceRefs: ["artifact-price-004"],
            observedAt: "2026-03-08T11:10:00.000Z",
          },
        ],
      });

      expect(recommendation.packId).toBe(packDefinition.pack.id);
      expect(recommendation.clusters).toHaveLength(1);
      expect(recommendation.clusters[0]).toMatchObject({
        field: "price",
        kind: "missingRequiredFieldPattern",
        occurrenceCount: 3,
      });
      expect(recommendation.proposal.operations).toEqual([
        expect.objectContaining({
          action: "appendSelectorCandidate",
          field: "price",
          selectorCandidate: expect.objectContaining({
            path: "price/relocated",
          }),
        }),
      ]);
    }),
  );

  it.effect("synthesizes one pack-level proposal from multiple recurring clusters", () =>
    Effect.gen(function* () {
      const recommendation = yield* synthesizePackReflection({
        pack: packDefinition,
        createdAt: "2026-03-08T12:00:00.000Z",
        signals: [
          {
            kind: "regression",
            field: "price",
            currentPrimarySelectorPath: "price/primary",
            selectorCandidate: {
              path: "price/fallback",
              selector: ".price-box",
            },
            evidenceRefs: ["artifact-regression-001"],
            observedAt: "2026-03-08T11:00:00.000Z",
          },
          {
            kind: "regression",
            field: "price",
            currentPrimarySelectorPath: "price/primary",
            selectorCandidate: {
              path: "price/fallback",
              selector: ".price-box",
            },
            evidenceRefs: ["artifact-regression-002"],
            observedAt: "2026-03-08T11:05:00.000Z",
          },
          {
            kind: "fixture",
            fixtureId: "fixture-title-001",
            field: "title",
            selectorCandidate: {
              path: "title/secondary",
              selector: "[data-title]",
            },
            evidenceRefs: ["artifact-title-001"],
            observedAt: "2026-03-08T11:00:00.000Z",
          },
          {
            kind: "fixture",
            fixtureId: "fixture-title-002",
            field: "title",
            selectorCandidate: {
              path: "title/secondary",
              selector: "[data-title]",
            },
            evidenceRefs: ["artifact-title-002"],
            observedAt: "2026-03-08T11:05:00.000Z",
          },
        ],
      });

      expect(recommendation.clusters.map(({ field, kind }) => ({ field, kind }))).toEqual([
        { field: "price", kind: "selectorRegressionPattern" },
        { field: "title", kind: "fixtureConsensusPattern" },
      ]);
      expect(recommendation.proposal.operations).toHaveLength(2);
    }),
  );

  it.effect("rejects non-recurring noise below the clustering threshold", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        synthesizePackReflection({
          pack: packDefinition,
          createdAt: "2026-03-08T12:00:00.000Z",
          signals: [
            {
              kind: "failure",
              failure: {
                kind: "missingRequiredField",
                message: "Price is missing.",
                context: {
                  snapshotId: "snapshot-001",
                  field: "price",
                  evidenceRefs: ["artifact-price-001"],
                },
              },
              selectorCandidate: {
                path: "price/relocated",
                selector: "[data-price]",
              },
              evidenceRefs: ["artifact-price-001"],
              observedAt: "2026-03-08T11:00:00.000Z",
            },
          ],
        }),
      );

      expect(error.message).toContain("no recurring pack-level patterns");
    }),
  );

  it.effect("rejects recurring clusters that still produce no actionable pack delta", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        synthesizePackReflection({
          pack: packDefinition,
          createdAt: "2026-03-08T12:00:00.000Z",
          signals: [
            {
              kind: "regression",
              field: "price",
              currentPrimarySelectorPath: "price/primary",
              selectorCandidate: {
                path: "price/primary",
                selector: "[data-testid='price']",
              },
              evidenceRefs: ["artifact-regression-001"],
              observedAt: "2026-03-08T11:00:00.000Z",
            },
            {
              kind: "regression",
              field: "price",
              currentPrimarySelectorPath: "price/primary",
              selectorCandidate: {
                path: "price/primary",
                selector: "[data-testid='price']",
              },
              evidenceRefs: ["artifact-regression-002"],
              observedAt: "2026-03-08T11:05:00.000Z",
            },
          ],
        }),
      );

      expect(error.message).toContain("no actionable selector candidate delta");
    }),
  );

  it.effect("keeps distinct selector-path spellings as distinct cluster identifiers", () =>
    Effect.gen(function* () {
      const recommendation = yield* synthesizePackReflection({
        pack: packDefinition,
        createdAt: "2026-03-08T12:00:00.000Z",
        signals: [
          {
            kind: "fixture",
            fixtureId: "fixture-title-001",
            field: "title",
            selectorCandidate: {
              path: "title/secondary",
              selector: "[data-title]",
            },
            evidenceRefs: ["artifact-title-001"],
            observedAt: "2026-03-08T11:00:00.000Z",
          },
          {
            kind: "fixture",
            fixtureId: "fixture-title-002",
            field: "title",
            selectorCandidate: {
              path: "title/secondary",
              selector: "[data-title]",
            },
            evidenceRefs: ["artifact-title-002"],
            observedAt: "2026-03-08T11:05:00.000Z",
          },
          {
            kind: "fixture",
            fixtureId: "fixture-title-alt-001",
            field: "title",
            selectorCandidate: {
              path: "title-secondary",
              selector: "[data-title-alt]",
            },
            evidenceRefs: ["artifact-title-003"],
            observedAt: "2026-03-08T11:10:00.000Z",
          },
          {
            kind: "fixture",
            fixtureId: "fixture-title-alt-002",
            field: "title",
            selectorCandidate: {
              path: "title-secondary",
              selector: "[data-title-alt]",
            },
            evidenceRefs: ["artifact-title-004"],
            observedAt: "2026-03-08T11:15:00.000Z",
          },
        ],
      });

      expect(recommendation.clusters).toHaveLength(2);
      expect(new Set(recommendation.clusters.map(({ id }) => id)).size).toBe(2);
    }),
  );
});
