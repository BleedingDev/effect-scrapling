import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Option, Schema } from "effect";
import {
  makePackRegistry,
  resolvePackRegistryLookup,
} from "../../libs/foundation/core/src/pack-registry-runtime.ts";
import { SitePackSchema } from "../../libs/foundation/core/src/site-pack.ts";

const catalog = [
  Schema.decodeUnknownSync(SitePackSchema)({
    id: "pack-global-shadow",
    domainPattern: "*.example.com",
    state: "shadow",
    accessPolicyId: "policy-default",
    version: "2026.03.01",
  }),
  Schema.decodeUnknownSync(SitePackSchema)({
    id: "pack-global-active",
    domainPattern: "*.example.com",
    state: "active",
    accessPolicyId: "policy-default",
    version: "2026.03.02",
  }),
  Schema.decodeUnknownSync(SitePackSchema)({
    id: "pack-exact-active",
    domainPattern: "shop.example.com",
    state: "active",
    accessPolicyId: "policy-default",
    version: "2026.03.03",
  }),
  Schema.decodeUnknownSync(SitePackSchema)({
    id: "pack-tenant-shadow",
    tenantId: "tenant-main",
    domainPattern: "*.example.com",
    state: "shadow",
    accessPolicyId: "policy-default",
    version: "2026.03.04",
  }),
  Schema.decodeUnknownSync(SitePackSchema)({
    id: "pack-tenant-active",
    tenantId: "tenant-main",
    domainPattern: "*.example.com",
    state: "active",
    accessPolicyId: "policy-default",
    version: "2026.03.05",
  }),
] as const;

describe("foundation-core pack registry runtime", () => {
  it("prefers exact active matches by default and falls back deterministically", async () => {
    const registry = makePackRegistry(catalog);
    const resolved = await Effect.runPromise(registry.getByDomain("shop.example.com"));

    expect(
      Option.match(resolved, {
        onNone: () => "none",
        onSome: (pack) => pack.id,
      }),
    ).toBe("pack-exact-active");
  });

  it("prefers tenant-specific packs before global packs for the same lifecycle band", () => {
    const resolved = resolvePackRegistryLookup(catalog, {
      domain: "shop.example.com",
      tenantId: "tenant-main",
      states: ["active", "shadow"],
    });

    expect(
      Option.match(resolved, {
        onNone: () => "none",
        onSome: (pack) => pack.id,
      }),
    ).toBe("pack-tenant-active");
  });

  it("can resolve a shadow-only lookup deterministically", () => {
    const resolved = resolvePackRegistryLookup(catalog, {
      domain: "shop.example.com",
      tenantId: "tenant-main",
      states: ["shadow"],
    });

    expect(
      Option.match(resolved, {
        onNone: () => "none",
        onSome: (pack) => pack.id,
      }),
    ).toBe("pack-tenant-shadow");
  });

  it("does not treat a wildcard pack as a root-domain exact match", async () => {
    const registry = makePackRegistry(catalog);
    const resolved = await Effect.runPromise(registry.getByDomain("example.com"));

    expect(Option.isNone(resolved)).toBe(true);
  });

  it("resolves packs by identifier through the service surface", async () => {
    const registry = makePackRegistry(catalog);
    const resolved = await Effect.runPromise(registry.getById("pack-tenant-active"));

    expect(
      Option.match(resolved, {
        onNone: () => "none",
        onSome: (pack) => pack.id,
      }),
    ).toBe("pack-tenant-active");
  });

  it("prefers the newest pack version by numeric segment ordering instead of raw lexical ordering", () => {
    const resolved = resolvePackRegistryLookup(
      [
        Schema.decodeUnknownSync(SitePackSchema)({
          id: "pack-version-1-9-0",
          domainPattern: "*.example.com",
          state: "active",
          accessPolicyId: "policy-default",
          version: "1.9.0",
        }),
        Schema.decodeUnknownSync(SitePackSchema)({
          id: "pack-version-1-10-0",
          domainPattern: "*.example.com",
          state: "active",
          accessPolicyId: "policy-default",
          version: "1.10.0",
        }),
      ],
      {
        domain: "shop.example.com",
        states: ["active"],
      },
    );

    expect(
      Option.match(resolved, {
        onNone: () => "none",
        onSome: (pack) => pack.id,
      }),
    ).toBe("pack-version-1-10-0");
  });
});
