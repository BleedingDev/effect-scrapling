import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  AccessModeSchema,
  AccessPolicySchema,
  RenderingPolicySchema,
} from "../../libs/foundation/core/src";

const SUPPORTED_MODE_RENDER_MATRIX = [
  { mode: "http", render: "never" },
  { mode: "browser", render: "onDemand" },
  { mode: "browser", render: "always" },
  { mode: "hybrid", render: "onDemand" },
  { mode: "hybrid", render: "always" },
  { mode: "managed", render: "onDemand" },
  { mode: "managed", render: "always" },
] as const;

function makeAccessPolicy(
  mode: (typeof SUPPORTED_MODE_RENDER_MATRIX)[number]["mode"],
  render: (typeof SUPPORTED_MODE_RENDER_MATRIX)[number]["render"],
) {
  return {
    id: `policy-${mode}-${render}`,
    mode,
    perDomainConcurrency: 8,
    globalConcurrency: 64,
    timeoutMs: 30_000,
    maxRetries: 3,
    render,
  };
}

describe("E1 access policy schema verification", () => {
  it("roundtrips the supported access mode and render matrix", () => {
    for (const { mode, render } of SUPPORTED_MODE_RENDER_MATRIX) {
      const decoded = Schema.decodeUnknownSync(AccessPolicySchema)(makeAccessPolicy(mode, render));

      expect(Schema.encodeSync(AccessPolicySchema)(decoded)).toEqual(
        makeAccessPolicy(mode, render),
      );
      expect(Schema.decodeUnknownSync(AccessModeSchema)(mode)).toBe(mode);
      expect(Schema.decodeUnknownSync(RenderingPolicySchema)(render)).toBe(render);
    }
  });

  it("rejects unsupported combinations and bounded numeric violations deterministically", () => {
    const invalidPayloads = [
      makeAccessPolicy("http", "always"),
      makeAccessPolicy("http", "onDemand"),
      makeAccessPolicy("browser", "never"),
      makeAccessPolicy("hybrid", "never"),
      makeAccessPolicy("managed", "never"),
      {
        ...makeAccessPolicy("browser", "always"),
        perDomainConcurrency: 0,
      },
      {
        ...makeAccessPolicy("browser", "always"),
        globalConcurrency: 4,
      },
      {
        ...makeAccessPolicy("browser", "always"),
        timeoutMs: 99,
      },
      {
        ...makeAccessPolicy("browser", "always"),
        timeoutMs: 600_001,
      },
      {
        ...makeAccessPolicy("browser", "always"),
        maxRetries: 11,
      },
    ] as const;

    for (const payload of invalidPayloads) {
      expect(() => Schema.decodeUnknownSync(AccessPolicySchema)(payload)).toThrow();
    }
  });
});
