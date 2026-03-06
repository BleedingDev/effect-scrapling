import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import { TargetKindSchema, TargetProfileSchema } from "../../libs/foundation/core/src";

const TARGET_KINDS = [
  "productPage",
  "productListing",
  "marketingPost",
  "blogPost",
  "pressRelease",
  "socialPost",
  "searchResult",
] as const;

function makeTargetProfile(kind: (typeof TARGET_KINDS)[number], suffix: string) {
  return {
    id: `target-${suffix}`,
    tenantId: "tenant-main",
    domain: "example.com",
    kind,
    canonicalKey: `catalog/${suffix}`,
    seedUrls: [`https://example.com/${suffix}`],
    accessPolicyId: "policy-default",
    packId: "pack-example-com",
    priority: 10,
  };
}

describe("E1 target profile schema verification", () => {
  it("roundtrips every supported target kind through the public foundation-core contract", () => {
    for (const [index, kind] of TARGET_KINDS.entries()) {
      const decoded = Schema.decodeUnknownSync(TargetProfileSchema)(
        makeTargetProfile(kind, `${index + 1}`),
      );

      expect(Schema.encodeSync(TargetProfileSchema)(decoded)).toEqual(
        makeTargetProfile(kind, `${index + 1}`),
      );
      expect(Schema.decodeUnknownSync(TargetKindSchema)(kind)).toBe(kind);
    }
  });

  it("rejects invalid target identity inputs deterministically", () => {
    const invalidPayloads = [
      {
        ...makeTargetProfile("productPage", "invalid-id"),
        id: "target invalid",
      },
      {
        ...makeTargetProfile("productPage", "invalid-tenant"),
        tenantId: "tenant main",
      },
      {
        ...makeTargetProfile("productPage", "invalid-domain"),
        domain: "HTTPS://Example.com/catalog",
      },
      {
        ...makeTargetProfile("productPage", "invalid-key"),
        canonicalKey: "catalog invalid key",
      },
      {
        ...makeTargetProfile("productPage", "invalid-seed-fragment"),
        seedUrls: ["https://example.com/path#fragment"],
      },
      {
        ...makeTargetProfile("productPage", "invalid-seed-scheme"),
        seedUrls: ["ftp://example.com/path"],
      },
      {
        ...makeTargetProfile("productPage", "invalid-seed-credentials"),
        seedUrls: ["https://user:pass@example.com/path"],
      },
      {
        ...makeTargetProfile("productPage", "duplicate-seeds"),
        seedUrls: ["https://example.com/path", "https://example.com/path"],
      },
      {
        ...makeTargetProfile("productPage", "empty-seeds"),
        seedUrls: [],
      },
      {
        ...makeTargetProfile("productPage", "priority-low"),
        priority: -1,
      },
      {
        ...makeTargetProfile("productPage", "priority-high"),
        priority: 1001,
      },
    ] as const;

    for (const payload of invalidPayloads) {
      expect(() => Schema.decodeUnknownSync(TargetProfileSchema)(payload)).toThrow();
    }

    expect(() => Schema.decodeUnknownSync(TargetKindSchema)("inventoryFeed")).toThrow();
  });
});
