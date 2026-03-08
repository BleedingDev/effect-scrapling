import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Exit, Schema } from "effect";
import { generatePackCandidate } from "../../libs/foundation/core/src/pack-candidate-generator.ts";
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
    requiredFields: [
      {
        field: "title",
      },
      {
        field: "price",
      },
    ],
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

describe("foundation-core pack candidate generator", () => {
  it.effect(
    "appends new selector candidates from failure evidence with preserved evidence refs",
    () =>
      Effect.gen(function* () {
        const proposal = yield* generatePackCandidate({
          pack: packDefinition,
          createdAt: "2026-03-08T12:00:00.000Z",
          signals: [
            {
              kind: "failure",
              failure: {
                kind: "missingRequiredField",
                message: "Price is missing from the snapshot.",
                context: {
                  snapshotId: "snapshot-001",
                  field: "price",
                  evidenceRefs: ["artifact-price-miss"],
                },
              },
              selectorCandidate: {
                path: "price/relocated",
                selector: "[data-price]",
              },
              evidenceRefs: ["artifact-price-miss", "artifact-price-html"],
              observedAt: "2026-03-08T11:45:00.000Z",
            },
          ],
        });

        expect(proposal.sourcePackId).toBe(packDefinition.pack.id);
        expect(proposal.targetPackState).toBe("draft");
        expect(proposal.operations).toEqual([
          expect.objectContaining({
            action: "appendSelectorCandidate",
            field: "price",
            evidenceRefs: ["artifact-price-html", "artifact-price-miss"],
          }),
        ]);
        expect(proposal.evidenceRefs).toEqual(["artifact-price-html", "artifact-price-miss"]);
      }),
  );

  it.effect("promotes existing secondary selector candidates instead of appending duplicates", () =>
    Effect.gen(function* () {
      const proposal = yield* generatePackCandidate({
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
            evidenceRefs: ["artifact-price-regression"],
            observedAt: "2026-03-08T11:00:00.000Z",
          },
        ],
      });

      expect(proposal.operations).toEqual([
        expect.objectContaining({
          action: "promoteSelectorCandidate",
          field: "price",
          selectorCandidate: expect.objectContaining({
            path: "price/fallback",
          }),
        }),
      ]);
    }),
  );

  it.effect(
    "keeps active packs immutable by emitting draft proposals instead of mutating the source pack",
    () =>
      Effect.gen(function* () {
        const activePackDefinition = Schema.decodeUnknownSync(SitePackDslSchema)({
          ...Schema.encodeSync(SitePackDslSchema)(packDefinition),
          pack: {
            ...Schema.encodeSync(SitePackDslSchema)(packDefinition).pack,
            state: "active",
          },
        });

        const proposal = yield* generatePackCandidate({
          pack: activePackDefinition,
          createdAt: "2026-03-08T12:00:00.000Z",
          signals: [
            {
              kind: "fixture",
              fixtureId: "fixture-price-001",
              field: "price",
              selectorCandidate: {
                path: "price/fixture",
                selector: "[itemprop='price']",
              },
              evidenceRefs: ["artifact-price-fixture"],
              observedAt: "2026-03-08T11:30:00.000Z",
            },
          ],
        });

        expect(proposal.sourcePackState).toBe("active");
        expect(proposal.targetPackState).toBe("draft");
        expect(activePackDefinition.pack.state).toBe("active");
      }),
  );

  it.effect(
    "deduplicates repeated signals into one operation and merges evidence refs and fixture ids",
    () =>
      Effect.gen(function* () {
        const proposal = yield* generatePackCandidate({
          pack: packDefinition,
          createdAt: "2026-03-08T12:00:00.000Z",
          signals: [
            {
              kind: "fixture",
              fixtureId: "fixture-price-001",
              field: "price",
              selectorCandidate: {
                path: "price/fixture",
                selector: "[itemprop='price']",
              },
              evidenceRefs: ["artifact-price-a"],
              observedAt: "2026-03-08T11:30:00.000Z",
            },
            {
              kind: "fixture",
              fixtureId: "fixture-price-002",
              field: "price",
              selectorCandidate: {
                path: "price/fixture",
                selector: "[itemprop='price']",
              },
              evidenceRefs: ["artifact-price-b"],
              observedAt: "2026-03-08T11:35:00.000Z",
            },
          ],
        });

        expect(proposal.operations).toHaveLength(1);
        expect(proposal.operations[0]).toMatchObject({
          action: "appendSelectorCandidate",
          fixtureIds: ["fixture-price-001", "fixture-price-002"],
          evidenceRefs: ["artifact-price-a", "artifact-price-b"],
          sourceKinds: ["fixture"],
        });
      }),
  );

  it.effect("rejects signals that target undeclared pack fields", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        generatePackCandidate({
          pack: packDefinition,
          createdAt: "2026-03-08T12:00:00.000Z",
          signals: [
            {
              kind: "fixture",
              fixtureId: "fixture-availability-001",
              field: "availability",
              selectorCandidate: {
                path: "availability/primary",
                selector: ".availability",
              },
              evidenceRefs: ["artifact-availability-a"],
              observedAt: "2026-03-08T11:30:00.000Z",
            },
          ],
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
