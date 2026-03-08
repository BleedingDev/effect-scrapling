import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  PromptModelInvocationSchema,
  PromptModelRequestSchema,
  makeDisabledPromptModelProvider,
  makeOptionalPromptModelProvider,
} from "../../libs/foundation/core/src/llm-provider-runtime.ts";

function makeRequest() {
  return Schema.decodeUnknownSync(PromptModelRequestSchema)({
    requestId: "prompt-request-001",
    templateId: "prompt-template-001",
    packId: "pack-example-com",
    generatedAt: "2026-03-09T06:00:00.000Z",
    route: "shadowValidation",
    modelPurpose: "scaffoldDriftDiagnosis",
    artifactIds: ["artifact-redacted-001"],
    prompt: "Diagnose scaffold drift from redacted evidence only.",
  });
}

describe("foundation-core llm provider runtime", () => {
  it.effect("keeps the provider disabled by default with a typed invocation envelope", () =>
    Effect.gen(function* () {
      const provider = makeDisabledPromptModelProvider({
        providerId: "provider-disabled",
        modelId: "model-disabled",
        now: () => new Date("2026-03-09T06:00:01.000Z"),
      });
      const invocation = yield* provider.invoke(makeRequest());

      expect(Schema.decodeUnknownSync(PromptModelInvocationSchema)(invocation)).toEqual(invocation);
      expect(invocation.status).toBe("disabled");
      expect(invocation.reason).toBe("Prompt model provider is disabled by configuration.");
      expect(invocation.response).toBeUndefined();
    }),
  );

  it.effect("decodes enabled provider responses through the shared schema", () =>
    Effect.gen(function* () {
      const provider = makeOptionalPromptModelProvider({
        providerId: "provider-llm",
        modelId: "model-shadow-validator",
        now: () => new Date("2026-03-09T06:00:02.000Z"),
        invoke: async () => ({
          route: "shadowValidation",
          summary: "Selector drift likely moved from primary CTA to fallback CTA.",
          findings: [{ kind: "selectorDrift", summary: "Primary selector no longer resolves." }],
          candidateSelectorPaths: ["$.selectors.buyButton.fallback[0]"],
        }),
      });
      const invocation = yield* provider.invoke(makeRequest());

      expect(invocation.status).toBe("completed");
      expect(invocation.response?.route).toBe("shadowValidation");
      expect(invocation.response?.candidateSelectorPaths).toEqual([
        "$.selectors.buyButton.fallback[0]",
      ]);
    }),
  );

  it.effect("rejects malformed provider responses through shared contracts", () =>
    Effect.gen(function* () {
      const provider = makeOptionalPromptModelProvider({
        providerId: "provider-llm",
        modelId: "model-shadow-validator",
        invoke: async () => ({
          route: "shadowValidation",
          summary: "",
          findings: [{ kind: "selectorDrift", summary: "Missing title." }],
          candidateSelectorPaths: [],
        }),
      });
      const failureMessage = yield* provider.invoke(makeRequest()).pipe(
        Effect.match({
          onFailure: ({ message }) => message,
          onSuccess: () => "unexpected-success",
        }),
      );

      expect(failureMessage).toContain("failed schema validation");
    }),
  );
});
