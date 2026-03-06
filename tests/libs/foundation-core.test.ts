import { describe, expect, it } from "@effect-native/bun-test";
import { buildWorkspaceBanner } from "../../libs/foundation/core/src/workspace-banner";

describe("foundation-core", () => {
  it("builds a deterministic workspace banner", () => {
    expect(buildWorkspaceBanner("demo")).toBe("workspace-project:demo");
  });
});
