import { Effect, Schema } from "effect";
import {
  E9ReferencePackValidationArtifactSchema,
  createDefaultE9ReferencePackValidationInput,
  runE9ReferencePackValidation,
} from "./e9-reference-pack-validation.ts";
import { E9ScraplingParityArtifactSchema, runE9ScraplingParity } from "./e9-scrapling-parity.ts";
import {
  E9HighFrictionCanaryArtifactSchema,
  runE9HighFrictionCanary,
} from "./e9-high-friction-canary.ts";
import { E9LaunchReadinessArtifactSchema, runE9LaunchReadiness } from "./e9-launch-readiness.ts";

const E9CapabilityPathSchema = Schema.Struct({
  validationId: Schema.String,
  comparisonId: Schema.String,
  canarySuiteId: Schema.String,
  readinessId: Schema.String,
  referencePackStatus: Schema.Literal("pass"),
  parityStatus: Schema.Literals(["pass", "fail"] as const),
  canaryStatus: Schema.Literals(["pass", "fail"] as const),
  readinessStatus: Schema.Literals(["pass", "fail"] as const),
});

export class E9CapabilitySliceEvidence extends Schema.Class<E9CapabilitySliceEvidence>(
  "E9CapabilitySliceEvidence",
)({
  evidencePath: E9CapabilityPathSchema,
  referencePackValidation: E9ReferencePackValidationArtifactSchema,
  scraplingParity: E9ScraplingParityArtifactSchema,
  highFrictionCanary: E9HighFrictionCanaryArtifactSchema,
  launchReadiness: E9LaunchReadinessArtifactSchema,
}) {}

export const E9CapabilitySliceEvidenceSchema = E9CapabilitySliceEvidence;

export function runE9CapabilitySlice() {
  return Effect.gen(function* () {
    const validationInput = yield* Effect.promise(() =>
      createDefaultE9ReferencePackValidationInput(),
    );
    const referencePackValidation = yield* runE9ReferencePackValidation(validationInput);
    const scraplingParity = yield* Effect.promise(() => runE9ScraplingParity());
    const highFrictionCanary = yield* Effect.promise(() => runE9HighFrictionCanary());
    const launchReadiness = yield* Effect.promise(() =>
      runE9LaunchReadiness({
        readJson: async (path) => {
          if (path.endsWith("e9-reference-pack-validation-artifact.json")) {
            return Schema.encodeSync(E9ReferencePackValidationArtifactSchema)(
              referencePackValidation,
            );
          }

          if (path.endsWith("e9-scrapling-parity-artifact.json")) {
            return Schema.encodeSync(E9ScraplingParityArtifactSchema)(scraplingParity);
          }

          if (path.endsWith("e9-high-friction-canary-artifact.json")) {
            return Schema.encodeSync(E9HighFrictionCanaryArtifactSchema)(highFrictionCanary);
          }

          throw new Error(`Unsupported E9 capability-slice artifact path: ${path}`);
        },
      }),
    );

    return new E9CapabilitySliceEvidence({
      evidencePath: {
        validationId: referencePackValidation.validationId,
        comparisonId: scraplingParity.comparisonId,
        canarySuiteId: highFrictionCanary.suiteId,
        readinessId: launchReadiness.readinessId,
        referencePackStatus: referencePackValidation.status,
        parityStatus: scraplingParity.status,
        canaryStatus: highFrictionCanary.status,
        readinessStatus: launchReadiness.status,
      },
      referencePackValidation,
      scraplingParity,
      highFrictionCanary,
      launchReadiness,
    });
  });
}

export function runE9CapabilitySliceEncoded() {
  return Effect.gen(function* () {
    const evidence = yield* runE9CapabilitySlice();
    return Schema.encodeSync(E9CapabilitySliceEvidenceSchema)(evidence);
  });
}
