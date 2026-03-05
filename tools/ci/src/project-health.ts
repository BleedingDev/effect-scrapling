import { buildWorkspaceBanner } from "@effect-scrapling/foundation-core";

export function projectHealthSummary(): string {
  return buildWorkspaceBanner("ci-tooling");
}
