import { Effect, Schema } from "effect";
import {
  CompiledCrawlPlan,
  compileCrawlPlans,
} from "../libs/foundation/core/src/crawl-plan-runtime.ts";
import {
  type SimulationProfile,
  SimulationProfileSchema,
  createSimulationCompilerInput,
} from "../scripts/benchmarks/e5-workflow-simulation.ts";
import {
  CrashResumeSampleSchema,
  runCrashResumeSample,
} from "../scripts/benchmarks/e5-crash-resume-harness.ts";

const CAPABILITY_PROFILE = Schema.decodeUnknownSync(SimulationProfileSchema)({
  targetCount: 2,
  observationsPerTarget: 6,
  totalObservations: 12,
}) satisfies SimulationProfile;

export class E5CapabilitySliceEvidence extends Schema.Class<E5CapabilitySliceEvidence>(
  "E5CapabilitySliceEvidence",
)({
  profile: SimulationProfileSchema,
  compiledPlans: Schema.Array(CompiledCrawlPlan),
  crashResume: CrashResumeSampleSchema,
}) {}

export const E5CapabilitySliceEvidenceSchema = E5CapabilitySliceEvidence;

export function runE5CapabilitySlice() {
  return Effect.gen(function* () {
    const compiledPlans = yield* compileCrawlPlans(
      createSimulationCompilerInput(CAPABILITY_PROFILE),
    );
    const crashResume = yield* runCrashResumeSample(CAPABILITY_PROFILE, [1, 2]);

    return Schema.decodeUnknownSync(E5CapabilitySliceEvidenceSchema)({
      profile: CAPABILITY_PROFILE,
      compiledPlans,
      crashResume,
    });
  });
}

export function runE5CapabilitySliceEncoded() {
  return runE5CapabilitySlice().pipe(
    Effect.map((evidence) => Schema.encodeSync(E5CapabilitySliceEvidenceSchema)(evidence)),
  );
}

if (import.meta.main) {
  const encoded = await Effect.runPromise(runE5CapabilitySliceEncoded());
  process.stdout.write(`${JSON.stringify(encoded, null, 2)}\n`);
}
