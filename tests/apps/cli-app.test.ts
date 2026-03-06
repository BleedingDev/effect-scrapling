import { describe, expect, it } from "@effect-native/bun-test";
import { cliEntry } from "../../apps/cli/src/cli-entry";

describe("cli-app", () => {
  it("exposes the foundation workspace banner", () => {
    expect(cliEntry).toBe("workspace-project:cli-app");
  });
});
