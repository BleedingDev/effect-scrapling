import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  buildProductIdentity,
  canonicalizeIdentityText,
  detectProductIdentitySignals,
  E9ProductIdentitySchema,
  extractVariantTokens,
  normalizeModelToken,
  tokenizeProductIdentity,
} from "../../src/e9-product-identity.ts";

describe("e9 product identity normalization", () => {
  it("canonicalizes titles with accent folding and normalized spacing", async () => {
    await expect(
      Effect.runPromise(canonicalizeIdentityText("  Bezdrátová   sluchátka   TESLA Sound EB20  ")),
    ).resolves.toBe("bezdratova sluchatka tesla sound eb20");
  });

  it("tokenizes product titles into stable canonical identity tokens", async () => {
    await expect(
      Effect.runPromise(tokenizeProductIdentity("TESLA Sound EB20 - Pearl Pink")),
    ).resolves.toEqual(["tesla", "sound", "eb20", "pearl", "pink"]);
    await expect(
      Effect.runPromise(tokenizeProductIdentity("TESLA Sound EB20-Pearl Pink")),
    ).resolves.toEqual(["tesla", "sound", "eb20", "pearl", "pink"]);
  });

  it("normalizes compact model tokens across punctuation variants", () => {
    expect(normalizeModelToken("TE-300")).toBe("te300");
    expect(normalizeModelToken("TE 300")).toBe("te300");
    expect(normalizeModelToken("TE300")).toBe("te300");
  });

  it("accepts raw model tokens on the main identity builder and normalizes them before anchoring", async () => {
    const identity = await Effect.runPromise(
      buildProductIdentity({
        title: "Tesla Smart Air Purifier TE300",
        modelTokens: ["TE-300", "TE 301"],
      }),
    );

    expect(identity.normalizedModelTokens).toEqual(["te300", "te301"]);
    expect(identity.anchoredModelTokens).toEqual(["te300"]);
    expect(identity.missingModelTokens).toEqual(["te301"]);
  });

  it("anchors punctuated model tokens from titles after canonical token merging", async () => {
    const identity = await Effect.runPromise(
      buildProductIdentity({
        title: "Tesla Smart Air Purifier TE-300",
        modelTokens: ["TE 300"],
      }),
    );

    expect(identity.canonicalTokens).toContain("te300");
    expect(identity.anchoredModelTokens).toEqual(["te300"]);
  });

  it("rejects invalid blank inputs consistently across exported helpers", async () => {
    await expect(Effect.runPromise(canonicalizeIdentityText("   "))).rejects.toThrow();
    await expect(Effect.runPromise(canonicalizeIdentityText("---"))).rejects.toThrow();
    await expect(Effect.runPromise(canonicalizeIdentityText("()"))).rejects.toThrow();
    await expect(
      Effect.runPromise(
        extractVariantTokens({
          title: "Tesla Smart Air Purifier TE300",
          modelTokens: ["   "],
        }),
      ),
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(
        buildProductIdentity({
          title: "Tesla Smart Air Purifier TE300",
          modelTokens: ["---"],
        }),
      ),
    ).rejects.toThrow();
  });

  it("anchors model tokens without confusing close model variants", async () => {
    const identity = await Effect.runPromise(
      buildProductIdentity({
        title: "Tesla Smart Air Purifier S300W",
        modelTokens: ["s300w", "s300b"],
        officialIsAccessory: false,
      }),
    );

    const decoded = Schema.decodeUnknownSync(E9ProductIdentitySchema)(identity);
    expect(decoded.anchoredModelTokens).toEqual(["s300w"]);
    expect(decoded.missingModelTokens).toEqual(["s300b"]);
    expect(decoded.officialIsAccessory).toBe(false);
  });

  it("extracts variant tokens from suffix and parenthetical segments", async () => {
    await expect(
      Effect.runPromise(
        extractVariantTokens({
          title: "TESLA Sound EB20 - Pearl Pink",
          modelTokens: ["eb20"],
        }),
      ),
    ).resolves.toEqual(["pearl", "pink"]);

    await expect(
      Effect.runPromise(
        extractVariantTokens({
          title: "Bezdrátová sluchátka TESLA Sound EB20 (Pearl Pink)",
          modelTokens: ["eb20"],
        }),
      ),
    ).resolves.toEqual(["pearl", "pink"]);

    await expect(
      Effect.runPromise(
        extractVariantTokens({
          title: "Tesla Smart Air Purifier S200B černá",
          modelTokens: ["s200b"],
        }),
      ),
    ).resolves.toEqual(["cerna"]);

    await expect(
      Effect.runPromise(
        extractVariantTokens({
          title: "TESLA Sound EB20 Pearl Pink (Limited Edition)",
          modelTokens: ["eb20"],
        }),
      ),
    ).resolves.toEqual(["pearl", "pink", "limited", "edition"]);

    const inferredIdentity = await Effect.runPromise(
      buildProductIdentity({
        title: "TESLA Sound (wireless) EB20 Pearl Pink",
      }),
    );

    expect(inferredIdentity.anchoredModelTokens).toEqual(["eb20"]);
    expect(inferredIdentity.variantTokens).toEqual(["pearl", "pink"]);
  });

  it("surfaces bundle signals while still anchoring the primary model token", async () => {
    const identity = await Effect.runPromise(
      buildProductIdentity({
        title: "TESLA Sound EB20 Bundle",
        modelTokens: ["eb20"],
      }),
    );

    expect(identity.anchoredModelTokens).toEqual(["eb20"]);
    expect(identity.signals.bundle).toEqual(["bundle"]);
    expect(identity.signals.accessory).toEqual([]);
  });

  it("surfaces replacement, accessory, and compatible signals on replacement phrasing", async () => {
    const identity = await Effect.runPromise(
      buildProductIdentity({
        title: "Replacement filter for Tesla Air Purifier S300W",
        modelTokens: ["s300w"],
      }),
    );

    expect(identity.anchoredModelTokens).toEqual(["s300w"]);
    expect(identity.signals.replacement).toEqual(["replacement"]);
    expect(identity.signals.accessory).toEqual(["filter"]);
    expect(identity.signals.compatible).toEqual(["for"]);
  });

  it("does not mark a normal product title as accessory-like just because it has a variant", async () => {
    const identity = await Effect.runPromise(
      buildProductIdentity({
        title: "Bezdrátová sluchátka TESLA Sound EB20 (Pearl Pink)",
        modelTokens: ["eb20"],
        officialIsAccessory: false,
      }),
    );

    expect(identity.anchoredModelTokens).toEqual(["eb20"]);
    expect(identity.signals.accessory).toEqual([]);
    expect(identity.signals.bundle).toEqual([]);
    expect(identity.signals.replacement).toEqual([]);
    expect(identity.variantTokens).toEqual(["pearl", "pink"]);
  });

  it("treats official accessory context as surfaced metadata instead of a classifier override", async () => {
    const identity = await Effect.runPromise(
      buildProductIdentity({
        title: "TESLA RoboStar iQ900 Ultra - sáček na nečistoty (5 ks)",
        modelTokens: ["iq900"],
        officialIsAccessory: true,
      }),
    );

    expect(identity.officialIsAccessory).toBe(true);
    expect(identity.anchoredModelTokens).toEqual(["iq900"]);
    expect(identity.signals.accessory).toEqual(["sacek"]);
    expect(identity.variantTokens).toEqual(["5ks"]);
  });

  it("keeps real dash and parenthetical accessory variants while suppressing undelimited descriptor noise", async () => {
    await expect(
      Effect.runPromise(
        extractVariantTokens({
          title: "Replacement filter for AP300 - White (2 ks)",
          modelTokens: ["ap300"],
        }),
      ),
    ).resolves.toEqual(["white", "2ks"]);
    await expect(
      Effect.runPromise(
        extractVariantTokens({
          title: "Replacement filter for AP300 White (2 ks)",
          modelTokens: ["ap300"],
        }),
      ),
    ).resolves.toEqual(["white", "2ks"]);
    await expect(
      Effect.runPromise(
        extractVariantTokens({
          title: "Replacement filter (Bílý) for Tesla AP300",
          modelTokens: ["ap300"],
        }),
      ),
    ).resolves.toEqual(["bily"]);
    await expect(
      Effect.runPromise(
        extractVariantTokens({
          title: "Náhradní filtr pro Tesla AP300 černá",
          modelTokens: ["ap300"],
        }),
      ),
    ).resolves.toEqual(["cerna"]);

    await expect(
      Effect.runPromise(
        extractVariantTokens({
          title: "TESLA RoboStar iQ900 Ultra sáček na nečistoty 5 ks",
          modelTokens: ["iq900"],
        }),
      ),
    ).resolves.toEqual(["5ks"]);
  });

  it("marks Czech compatibility phrasing even when pro is followed by descriptive words", async () => {
    await expect(
      Effect.runPromise(
        detectProductIdentitySignals("Náhradní filtr pro čističku vzduchu Tesla AP300"),
      ),
    ).resolves.toEqual({
      accessory: ["filtr"],
      bundle: [],
      compatible: ["pro"],
      replacement: ["nahradni"],
    });
  });

  it("ignores parenthetical descriptors that appear before the anchored model token", async () => {
    await expect(
      Effect.runPromise(
        extractVariantTokens({
          title: "TESLA Sound (wireless) EB20 Pearl Pink",
          modelTokens: ["eb20"],
        }),
      ),
    ).resolves.toEqual(["pearl", "pink"]);
  });

  it("does not merge signal words into count tokens before signal detection", async () => {
    await expect(
      Effect.runPromise(detectProductIdentitySignals("Replacement case 2 ks for Tesla AP300")),
    ).resolves.toEqual({
      accessory: ["case"],
      bundle: [],
      compatible: ["for"],
      replacement: ["replacement"],
    });

    const identity = await Effect.runPromise(
      buildProductIdentity({
        title: "TESLA Sound EB20 set 2 ks",
        modelTokens: ["eb20"],
      }),
    );

    expect(identity.signals.bundle).toEqual(["set"]);
    expect(identity.variantTokens).toEqual(["2ks"]);
  });

  it("exposes the smaller standalone signal helper for deterministic callers", async () => {
    await expect(
      Effect.runPromise(detectProductIdentitySignals("Replacement filter for Tesla AP300")),
    ).resolves.toEqual({
      accessory: ["filter"],
      bundle: [],
      compatible: ["for"],
      replacement: ["replacement"],
    });

    await expect(
      Effect.runPromise(detectProductIdentitySignals("Náhradní filtr pro Tesla AP300")),
    ).resolves.toEqual({
      accessory: ["filtr"],
      bundle: [],
      compatible: ["pro"],
      replacement: ["nahradni"],
    });

    await expect(
      Effect.runPromise(detectProductIdentitySignals("Replacement case Tesla AP300 Pro")),
    ).resolves.toEqual({
      accessory: ["case"],
      bundle: [],
      compatible: [],
      replacement: ["replacement"],
    });

    await expect(
      Effect.runPromise(detectProductIdentitySignals("Replacement remote for Tesla TV Pro 55")),
    ).resolves.toEqual({
      accessory: ["remote"],
      bundle: [],
      compatible: ["for"],
      replacement: ["replacement"],
    });
  });
});
