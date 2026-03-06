import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  PackLifecycleTransitionSchema,
  PackStateSchema,
  SitePackSchema,
} from "../../libs/foundation/core/src";

type PackState = Schema.Schema.Type<typeof PackStateSchema>;

function makeSitePack(state: PackState) {
  return {
    id: "pack-example-com",
    domainPattern: "*.example.com",
    state,
    accessPolicyId: "policy-default",
    version: "2026.03.06",
  };
}

describe("E1 site pack state verification", () => {
  it("roundtrips each supported pack state through the public foundation-core contract", () => {
    const states = ["draft", "shadow", "active", "guarded", "quarantined", "retired"] as const;

    for (const state of states) {
      const decoded = Schema.decodeUnknownSync(SitePackSchema)(makeSitePack(state));

      expect(Schema.encodeSync(SitePackSchema)(decoded)).toEqual(makeSitePack(state));
      expect(Schema.decodeUnknownSync(PackStateSchema)(state)).toBe(state);
    }
  });

  it("accepts only allowed lifecycle transitions and rejects invalid jumps", () => {
    const allowedTransitions = [
      { from: "draft", to: "shadow" },
      { from: "shadow", to: "active" },
      { from: "active", to: "shadow" },
      { from: "active", to: "guarded" },
      { from: "active", to: "quarantined" },
      { from: "guarded", to: "shadow" },
      { from: "guarded", to: "active" },
      { from: "guarded", to: "quarantined" },
      { from: "quarantined", to: "shadow" },
      { from: "quarantined", to: "active" },
      { from: "draft", to: "retired" },
      { from: "shadow", to: "retired" },
      { from: "active", to: "retired" },
      { from: "guarded", to: "retired" },
      { from: "quarantined", to: "retired" },
    ] as const;

    for (const transition of allowedTransitions) {
      expect(Schema.decodeUnknownSync(PackLifecycleTransitionSchema)(transition)).toEqual(
        transition,
      );
    }

    const invalidTransitions = [
      { from: "draft", to: "active" },
      { from: "shadow", to: "guarded" },
      { from: "quarantined", to: "draft" },
      { from: "retired", to: "draft" },
    ] as const;

    for (const transition of invalidTransitions) {
      expect(() => Schema.decodeUnknownSync(PackLifecycleTransitionSchema)(transition)).toThrow();
    }
  });
});
