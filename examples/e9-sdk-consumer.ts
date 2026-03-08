import { Effect, Schema } from "effect";
import {
  E9CapabilitySliceEvidenceSchema,
  E9LaunchReadinessArtifactSchema,
  E9ScraplingParityArtifactSchema,
  runE9CapabilitySlice,
  runE9LaunchReadiness,
} from "effect-scrapling/e9";

export const e9SdkConsumerPrerequisites = [
  "Bun >= 1.3.10",
  'Run from repository root with "bun run example:e9-sdk-consumer".',
  "Use only the public effect-scrapling/e9 package subpath for E9 launch-readiness and parity consumers.",
] as const;

export const e9SdkConsumerPitfalls = [
  "The Scrapling comparison is fixture-corpus postcapture parity, not a live transport benchmark.",
  "Launch readiness consumes sanitized benchmark artifacts and runbooks; do not bypass those artifacts with ad-hoc filesystem reads in downstream apps.",
  "Reference-pack governance remains the promotion gate; do not treat a passing parity artifact as permission to skip active-pack lifecycle controls.",
] as const;

export function runE9SdkConsumerExample() {
  return Effect.gen(function* () {
    const capabilitySlice = yield* runE9CapabilitySlice();
    const readiness = yield* Effect.promise(() => runE9LaunchReadiness());

    return {
      importPath: "effect-scrapling/e9" as const,
      prerequisites: e9SdkConsumerPrerequisites,
      pitfalls: e9SdkConsumerPitfalls,
      payload: {
        capabilitySlice: Schema.encodeSync(E9CapabilitySliceEvidenceSchema)(capabilitySlice),
        parity: Schema.encodeSync(E9ScraplingParityArtifactSchema)(capabilitySlice.scraplingParity),
        readiness: Schema.encodeSync(E9LaunchReadinessArtifactSchema)(readiness),
      },
    };
  });
}

if (import.meta.main) {
  const result = await Effect.runPromise(runE9SdkConsumerExample());
  console.log(JSON.stringify(result, null, 2));
}
