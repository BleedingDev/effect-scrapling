import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  AccessPolicySchema,
  buildWorkspaceBanner,
  TargetProfileSchema,
} from "../../libs/foundation/core/src";

describe("foundation-core", () => {
  it("builds a deterministic workspace banner", () => {
    expect(buildWorkspaceBanner("demo")).toBe("workspace-project:demo");
  });

  it("roundtrips target profiles through canonical Effect Schema contracts", () => {
    const decoded = Schema.decodeUnknownSync(TargetProfileSchema)({
      id: "target-product-001",
      tenantId: "tenant-main",
      domain: "example.com",
      kind: "productPage",
      canonicalKey: "catalog/product-001",
      seedUrls: ["https://example.com/products/001"],
      accessPolicyId: "policy-default",
      packId: "pack-example-com",
      priority: 10,
    });

    expect(Schema.encodeSync(TargetProfileSchema)(decoded)).toEqual({
      id: "target-product-001",
      tenantId: "tenant-main",
      domain: "example.com",
      kind: "productPage",
      canonicalKey: "catalog/product-001",
      seedUrls: ["https://example.com/products/001"],
      accessPolicyId: "policy-default",
      packId: "pack-example-com",
      priority: 10,
    });
  });

  it("rejects target profiles with non-canonical identity fields", () => {
    expect(() =>
      Schema.decodeUnknownSync(TargetProfileSchema)({
        id: "target-product-001",
        tenantId: "tenant-main",
        domain: "HTTPS://Example.com/catalog",
        kind: "productPage",
        canonicalKey: "catalog product 001",
        seedUrls: ["https://example.com/products/001#fragment"],
        accessPolicyId: "policy-default",
        packId: "pack-example-com",
        priority: 10,
      }),
    ).toThrow();
  });

  it("accepts target profile boundary priorities and rejects empty seed URL sets", () => {
    expect(
      Schema.encodeSync(TargetProfileSchema)(
        Schema.decodeUnknownSync(TargetProfileSchema)({
          id: "target-product-low",
          tenantId: "tenant-main",
          domain: "example.com",
          kind: "productListing",
          canonicalKey: "catalog/low-priority",
          seedUrls: ["https://example.com/catalog"],
          accessPolicyId: "policy-default",
          packId: "pack-example-com",
          priority: 0,
        }),
      ).priority,
    ).toBe(0);

    expect(
      Schema.encodeSync(TargetProfileSchema)(
        Schema.decodeUnknownSync(TargetProfileSchema)({
          id: "target-product-high",
          tenantId: "tenant-main",
          domain: "example.com",
          kind: "searchResult",
          canonicalKey: "catalog/high-priority",
          seedUrls: ["https://example.com/search?q=widgets"],
          accessPolicyId: "policy-default",
          packId: "pack-example-com",
          priority: 1000,
        }),
      ).priority,
    ).toBe(1000);

    expect(() =>
      Schema.decodeUnknownSync(TargetProfileSchema)({
        id: "target-product-empty-seeds",
        tenantId: "tenant-main",
        domain: "example.com",
        kind: "productPage",
        canonicalKey: "catalog/empty-seeds",
        seedUrls: [],
        accessPolicyId: "policy-default",
        packId: "pack-example-com",
        priority: 10,
      }),
    ).toThrow();
  });

  it("validates access policy mode/render combinations and bounded numeric fields", () => {
    const decoded = Schema.decodeUnknownSync(AccessPolicySchema)({
      id: "policy-browser-fallback",
      mode: "browser",
      perDomainConcurrency: 8,
      globalConcurrency: 64,
      timeoutMs: 30_000,
      maxRetries: 3,
      render: "always",
    });

    expect(Schema.encodeSync(AccessPolicySchema)(decoded)).toEqual({
      id: "policy-browser-fallback",
      mode: "browser",
      perDomainConcurrency: 8,
      globalConcurrency: 64,
      timeoutMs: 30_000,
      maxRetries: 3,
      render: "always",
    });

    expect(() =>
      Schema.decodeUnknownSync(AccessPolicySchema)({
        id: "policy-http-invalid-render",
        mode: "http",
        perDomainConcurrency: 8,
        globalConcurrency: 64,
        timeoutMs: 30_000,
        maxRetries: 3,
        render: "always",
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(AccessPolicySchema)({
        id: "policy-invalid-budget",
        mode: "hybrid",
        perDomainConcurrency: 32,
        globalConcurrency: 16,
        timeoutMs: 700_000,
        maxRetries: 11,
        render: "onDemand",
      }),
    ).toThrow();
  });

  it("accepts access policy numeric boundaries", () => {
    expect(
      Schema.encodeSync(AccessPolicySchema)(
        Schema.decodeUnknownSync(AccessPolicySchema)({
          id: "policy-http-minimum",
          mode: "http",
          perDomainConcurrency: 1,
          globalConcurrency: 1,
          timeoutMs: 100,
          maxRetries: 0,
          render: "never",
        }),
      ),
    ).toEqual({
      id: "policy-http-minimum",
      mode: "http",
      perDomainConcurrency: 1,
      globalConcurrency: 1,
      timeoutMs: 100,
      maxRetries: 0,
      render: "never",
    });

    expect(
      Schema.encodeSync(AccessPolicySchema)(
        Schema.decodeUnknownSync(AccessPolicySchema)({
          id: "policy-managed-maximum",
          mode: "managed",
          perDomainConcurrency: 128,
          globalConcurrency: 4096,
          timeoutMs: 600_000,
          maxRetries: 10,
          render: "always",
        }),
      ),
    ).toEqual({
      id: "policy-managed-maximum",
      mode: "managed",
      perDomainConcurrency: 128,
      globalConcurrency: 4096,
      timeoutMs: 600_000,
      maxRetries: 10,
      render: "always",
    });
  });
});
