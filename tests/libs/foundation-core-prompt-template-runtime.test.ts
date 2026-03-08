import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Match, Schema } from "effect";
import { makeOptionalPromptModelProvider } from "../../libs/foundation/core/src/llm-provider-runtime.ts";
import {
  PromptTemplateRenderSchema,
  renderPromptTemplate,
  runPromptTemplate,
  runPromptTemplateWithProvider,
} from "../../libs/foundation/core/src/prompt-template-runtime.ts";
import { PromptModelProvider } from "../../libs/foundation/core/src/service-topology.ts";

function makeInput(body: string) {
  return {
    templateId: "template-e9-shadow-001",
    packId: "pack-example-com",
    generatedAt: "2026-03-09T06:05:00.000Z",
    kind: "scaffoldDriftDiagnosis" as const,
    artifacts: [
      {
        artifactId: "artifact-redacted-001",
        artifactKind: "responseMetadata" as const,
        sourceVisibility: "redacted" as const,
        mediaType: "application/json",
        body,
      },
    ],
  };
}

describe("foundation-core prompt template runtime", () => {
  it.effect(
    "renders prompt templates only from redacted evidence and routes them to shadow validation",
    () =>
      Effect.gen(function* () {
        const rendered = yield* renderPromptTemplate(
          makeInput('{"summary":"token=[REDACTED] selector moved to fallback"}'),
        );

        expect(Schema.decodeUnknownSync(PromptTemplateRenderSchema)(rendered)).toEqual(rendered);
        expect(rendered.route).toBe("shadowValidation");
        expect(rendered.request.route).toBe("shadowValidation");
        expect(rendered.prompt).toContain("Route: shadowValidation");
        expect(rendered.prompt).toContain("token=[REDACTED]");
        expect(rendered.prompt).not.toContain("Bearer live-secret");
      }),
  );

  it.effect("rejects unsanitized prompt-template evidence before invoking a provider", () =>
    Effect.gen(function* () {
      const error = yield* renderPromptTemplate(
        makeInput('{"summary":"Bearer live-secret https://user:secret@example.com/checkout"}'),
      ).pipe(Effect.flip);

      yield* Match.value(error).pipe(
        Match.tag("PolicyViolation", ({ message }) =>
          Effect.sync(() => {
            expect(message).toContain("only accept sanitized redacted artifacts");
          }),
        ),
        Match.exhaustive,
      );
    }),
  );

  it.effect("keeps runPromptTemplate disabled by default so no hot-path provider is required", () =>
    Effect.gen(function* () {
      const invocation = yield* runPromptTemplate(
        makeInput('{"summary":"token=[REDACTED] selector drift"}'),
      );

      expect(invocation.status).toBe("disabled");
      expect(invocation.reason).toContain("disabled by configuration");
    }),
  );

  it.effect(
    "invokes the optional provider through the shared service boundary with typed output",
    () =>
      Effect.gen(function* () {
        const invocation = yield* runPromptTemplateWithProvider(
          makeInput('{"summary":"token=[REDACTED] selector drift"}'),
        ).pipe(
          Effect.provideService(
            PromptModelProvider,
            makeOptionalPromptModelProvider({
              providerId: "provider-shadow-review",
              modelId: "model-shadow-review",
              invoke: async () => ({
                route: "shadowValidation",
                summary: "Use shadow validation to evaluate the fallback selector.",
                findings: [
                  { kind: "selectorDrift", summary: "Fallback selector candidate found." },
                ],
                candidateSelectorPaths: ["$.selectors.price.fallback[0]"],
              }),
            }),
          ),
        );

        expect(invocation.status).toBe("completed");
        expect(invocation.response?.route).toBe("shadowValidation");
        expect(invocation.response?.candidateSelectorPaths).toEqual([
          "$.selectors.price.fallback[0]",
        ]);
      }),
  );
});
