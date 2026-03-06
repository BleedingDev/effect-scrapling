import { describe, expect, it } from "@effect-native/bun-test";
import { apiEntry } from "../../apps/api/src/api-entry";

describe("api-app", () => {
  it("exposes the foundation workspace banner", () => {
    expect(apiEntry).toBe("workspace-project:api-app");
  });
});
