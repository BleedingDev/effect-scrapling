import { Effect, Schema } from "effect";
import {
  PackPromotionDecisionSchema,
  RunExecutionConfigSchema,
  StorageLocatorSchema,
  TargetProfileSchema,
  resolveRunExecutionConfig,
} from "@effect-scrapling/foundation-core";

export const foundationCoreConsumerPrerequisites = [
  "Bun >= 1.3.10",
  "Use the public @effect-scrapling/foundation-core package only.",
  'Run from repository root with "bun run example:e1-foundation-core-consumer".',
] as const;

export const foundationCoreConsumerPitfalls = [
  "Decode public payloads through the shared schemas instead of retyping DTOs by hand.",
  "Treat StorageLocator values as logical namespace/key transport, not filesystem paths.",
  "Handle schema rejections explicitly when user input can affect config or locator payloads.",
] as const;

export function runFoundationCoreConsumerExample() {
  return Effect.gen(function* () {
    const targetProfile = Schema.decodeUnknownSync(TargetProfileSchema)({
      id: "target-product-001",
      tenantId: "tenant-main",
      domain: "example.com",
      kind: "productPage",
      canonicalKey: "catalog/product-001",
      seedUrls: ["https://example.com/products/001"],
      accessPolicyId: "policy-default",
      packId: "pack-example-com",
      priority: 10,
    });

    const runConfig = resolveRunExecutionConfig({
      defaults: {
        targetId: targetProfile.id,
        targetDomain: targetProfile.domain,
        packId: "pack-example-com",
        accessPolicyId: "policy-default",
        entryUrl: "https://example.com/catalog",
        mode: "http",
        render: "never",
        perDomainConcurrency: 2,
        globalConcurrency: 8,
        timeoutMs: 10_000,
        maxRetries: 1,
        checkpointInterval: 10,
        artifactNamespace: "artifacts/default",
        checkpointNamespace: "checkpoints/default",
      },
      targetProfile: {
        entryUrl: "https://example.com/products/001",
      },
      run: {
        mode: "browser",
        render: "always",
        artifactNamespace: "artifacts/example-com",
      },
    });

    const promotionDecision = Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
      id: "decision-pack-example-com-001",
      packId: "pack-example-com",
      fromState: "draft",
      toState: "shadow",
      triggerVerdictId: "verdict-pack-example-com-001",
      action: "promote-shadow",
      createdAt: "2026-03-06T12:00:00.000Z",
    });

    const expectedError = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(StorageLocatorSchema)({
          namespace: "../secrets",
          key: "run-001/html-001",
        }),
      catch: () => ({
        tag: "SchemaBoundaryError" as const,
        message:
          "StorageLocator rejected a traversal-like namespace before the payload reached any backend.",
      }),
    }).pipe(
      Effect.matchEffect({
        onFailure: Effect.succeed,
        onSuccess: () =>
          Effect.die(
            new Error(
              "Expected StorageLocator schema decode to reject the traversal-like namespace",
            ),
          ),
      }),
    );

    return {
      importPath: "@effect-scrapling/foundation-core",
      prerequisites: foundationCoreConsumerPrerequisites,
      pitfalls: foundationCoreConsumerPitfalls,
      payload: {
        targetProfile: Schema.encodeSync(TargetProfileSchema)(targetProfile),
        runConfig: Schema.encodeSync(RunExecutionConfigSchema)(runConfig),
        promotionDecision: Schema.encodeSync(PackPromotionDecisionSchema)(promotionDecision),
        expectedError,
      },
    };
  });
}

if (import.meta.main) {
  const payload = await Effect.runPromise(runFoundationCoreConsumerExample());
  console.log(JSON.stringify(payload, null, 2));
}
