import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  E9ReferencePackCatalogSchema,
  E9ReferencePackSchema,
  alzaTeslaReferencePack,
  datartTeslaReferencePack,
  e9TeslaReferencePacks,
  tsBohemiaTeslaReferencePack,
} from "effect-scrapling/e9";

describe("E9 reference packs", () => {
  it("exports the public Tesla reference packs through the E9 package subpath", () => {
    const packs = Schema.decodeUnknownSync(E9ReferencePackCatalogSchema)(e9TeslaReferencePacks);

    expect(packs.map(({ domain }) => domain)).toEqual(["alza", "datart", "tsbohemia"]);
    expect(packs.map(({ definition }) => definition.pack.domainPattern)).toEqual([
      "*.alza.cz",
      "*.datart.cz",
      "*.tsbohemia.cz",
    ]);
    expect(packs.map(({ recipe }) => recipe.packId)).toEqual(
      packs.map(({ definition }) => definition.pack.id),
    );
  });

  it("keeps each exported reference pack aligned on required pack fields and recipes", () => {
    const alza = Schema.decodeUnknownSync(E9ReferencePackSchema)(alzaTeslaReferencePack);
    const datart = Schema.decodeUnknownSync(E9ReferencePackSchema)(datartTeslaReferencePack);
    const tsBohemia = Schema.decodeUnknownSync(E9ReferencePackSchema)(tsBohemiaTeslaReferencePack);

    for (const pack of [alza, datart, tsBohemia]) {
      expect(pack.definition.assertions.requiredFields.map(({ field }) => field)).toEqual([
        "title",
        "price",
        "availability",
        "productIdentifier",
      ]);
      expect(pack.recipe.fields.map(({ field }) => field)).toEqual([
        "title",
        "price",
        "availability",
        "productIdentifier",
      ]);
      expect(pack.definition.policy.mode).toBe("http");
      expect(pack.definition.policy.render).toBe("never");
    }
  });
});
