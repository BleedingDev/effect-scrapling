import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  CoreErrorEnvelopeSchema,
  RunExecutionConfigSchema,
  StorageLocatorSchema,
  TargetProfileSchema,
  WorkflowInspectionSnapshotSchema,
} from "../../libs/foundation/core/src";
import { runE1CapabilitySlice } from "../../examples/e1-capability-slice.ts";

describe("E1 security review verification", () => {
  it("rejects traversal-like keys and unsafe public-boundary URLs", () => {
    const invalidTargetProfile = {
      id: "target-product-001",
      tenantId: "tenant-main",
      domain: "example.com",
      kind: "productPage",
      canonicalKey: "catalog/../secrets",
      seedUrls: ["https://example.com/products/001"],
      accessPolicyId: "policy-default",
      packId: "pack-example-com",
      priority: 10,
    };

    const invalidLocators = [
      {
        namespace: "../secrets",
        key: "run-001/html-001",
      },
      {
        namespace: "/absolute",
        key: "run-001/html-001",
      },
      {
        namespace: "artifacts//example-com",
        key: "run-001/html-001",
      },
      {
        namespace: "artifacts/example-com",
        key: "../html-001",
      },
    ] as const;

    const invalidRunConfig = {
      targetId: "target-product-001",
      targetDomain: "example.com",
      packId: "pack-example-com",
      accessPolicyId: "policy-default",
      entryUrl: "https://user:password@example.com/products/001",
      mode: "browser",
      render: "always",
      perDomainConcurrency: 4,
      globalConcurrency: 8,
      timeoutMs: 30_000,
      maxRetries: 1,
      checkpointInterval: 10,
      artifactNamespace: "artifacts/example-com",
      checkpointNamespace: "checkpoints/example-com",
    };

    expect(() => Schema.decodeUnknownSync(TargetProfileSchema)(invalidTargetProfile)).toThrow();

    for (const locator of invalidLocators) {
      expect(() => Schema.decodeUnknownSync(StorageLocatorSchema)(locator)).toThrow();
    }

    expect(() => Schema.decodeUnknownSync(RunExecutionConfigSchema)(invalidRunConfig)).toThrow();
  });

  it.effect(
    "emits sanitized E1 capability evidence with logical locators and minimal error transport",
    () =>
      Effect.gen(function* () {
        const result = yield* runE1CapabilitySlice();
        const errorEnvelope = Schema.decodeUnknownSync(CoreErrorEnvelopeSchema)(
          result.errorEnvelope,
        );
        const inspection = Schema.decodeUnknownSync(WorkflowInspectionSnapshotSchema)(
          result.inspection,
        );

        expect(result.resolvedConfig.artifactNamespace).not.toContain("..");
        expect(result.resolvedConfig.checkpointNamespace).not.toContain("..");
        expect(result.exportedLocator.namespace.startsWith("/")).toBe(false);
        expect(result.exportedLocator.namespace).not.toContain("..");
        expect(result.exportedLocator.key).not.toContain("..");
        expect(errorEnvelope.code).toBe("policy_violation");
        expect(Object.keys(errorEnvelope).sort()).toEqual(["code", "message", "retryable"]);
        expect(inspection.error).toBeUndefined();
      }),
  );
});
