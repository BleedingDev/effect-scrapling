import { describe, expect, it } from "@effect-native/bun-test";
import { projectHealthSummary } from "../../tools/ci/src/project-health";

describe("ci-tooling", () => {
  it("builds a deterministic workspace banner", () => {
    expect(projectHealthSummary()).toBe("workspace-project:ci-tooling");
  });
});
