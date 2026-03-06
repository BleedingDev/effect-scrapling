import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Option, Schema } from "effect";
import { ArtifactMetadataRecordSchema } from "../../libs/foundation/core/src/config-storage.ts";
import {
  makeInMemoryCaptureBundleStore,
  StoredCaptureBundleSchema,
} from "../../libs/foundation/core/src/capture-store-runtime.ts";
import {
  HttpCaptureBundleSchema,
  HttpCapturePayloadSchema,
} from "../../libs/foundation/core/src/http-access-runtime.ts";

function makeBundle(runId: string, htmlBody = "<html><body>ok</body></html>") {
  const responsePayload = Schema.decodeUnknownSync(HttpCapturePayloadSchema)({
    locator: {
      namespace: "captures/target-product-001",
      key: "plan-001/response-metadata.json",
    },
    mediaType: "application/json",
    body: '{"status":200}\n',
  });
  const htmlPayload = Schema.decodeUnknownSync(HttpCapturePayloadSchema)({
    locator: {
      namespace: "captures/target-product-001",
      key: "plan-001/body.html",
    },
    mediaType: "text/html; charset=utf-8",
    body: htmlBody,
  });
  const responseArtifact = Schema.decodeUnknownSync(ArtifactMetadataRecordSchema)({
    id: "plan-001-response-metadata",
    runId,
    artifactId: "plan-001-response-metadata",
    kind: "responseMetadata",
    visibility: "redacted",
    locator: responsePayload.locator,
    sha256: "1111111111111111111111111111111111111111111111111111111111111111",
    sizeBytes: responsePayload.body.length,
    mediaType: responsePayload.mediaType,
    storedAt: "2026-03-06T10:30:00.000Z",
  });
  const htmlArtifact = Schema.decodeUnknownSync(ArtifactMetadataRecordSchema)({
    id: "plan-001-html",
    runId,
    artifactId: "plan-001-html",
    kind: "html",
    visibility: "raw",
    locator: htmlPayload.locator,
    sha256: "2222222222222222222222222222222222222222222222222222222222222222",
    sizeBytes: htmlPayload.body.length,
    mediaType: htmlPayload.mediaType,
    storedAt: "2026-03-06T10:30:00.000Z",
  });

  return Schema.decodeUnknownSync(HttpCaptureBundleSchema)({
    capturedAt: "2026-03-06T10:30:00.000Z",
    artifacts: [htmlArtifact, responseArtifact],
    payloads: [responsePayload, htmlPayload],
  });
}

describe("foundation-core capture store runtime", () => {
  it.effect("persists and reloads capture bundles with deterministic locator ordering", () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryCaptureBundleStore();
      const stored = yield* store.persistBundle("run-001", makeBundle("run-001"));
      const reloaded = yield* store.readBundle("run-001");

      expect(stored.bundle.artifacts.map(({ locator }) => locator.key)).toEqual([
        "plan-001/body.html",
        "plan-001/response-metadata.json",
      ]);

      yield* Option.match(reloaded, {
        onNone: () =>
          Effect.die(new Error("Expected persisted capture bundle to be readable by run id.")),
        onSome: (bundle) =>
          Effect.sync(() => {
            expect(Schema.encodeSync(StoredCaptureBundleSchema)(bundle)).toEqual(
              Schema.encodeSync(StoredCaptureBundleSchema)(stored),
            );
          }),
      });
    }),
  );

  it.effect("keeps payload partitions isolated across runs even when locator keys collide", () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryCaptureBundleStore();
      yield* store.persistBundle(
        "run-001",
        makeBundle("run-001", "<html><body>first</body></html>"),
      );
      yield* store.persistBundle(
        "run-002",
        makeBundle("run-002", "<html><body>second</body></html>"),
      );

      const firstReloaded = yield* store.readBundle("run-001").pipe(
        Effect.flatMap((option) =>
          Option.match(option, {
            onNone: () => Effect.die(new Error("Expected run-001 bundle to exist.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      const secondReloaded = yield* store.readBundle("run-002").pipe(
        Effect.flatMap((option) =>
          Option.match(option, {
            onNone: () => Effect.die(new Error("Expected run-002 bundle to exist.")),
            onSome: Effect.succeed,
          }),
        ),
      );

      expect(firstReloaded.bundle.payloads[0]?.body).toContain("first");
      expect(secondReloaded.bundle.payloads[0]?.body).toContain("second");
    }),
  );

  it.effect("returns none for unknown run ids and rejects inconsistent bundles", () =>
    Effect.gen(function* () {
      const store = yield* makeInMemoryCaptureBundleStore();
      const missing = yield* store.readBundle("run-missing");

      expect(Option.isNone(missing)).toBe(true);

      const inconsistentMessage = yield* store
        .persistBundle("run-001", {
          ...Schema.encodeSync(HttpCaptureBundleSchema)(makeBundle("run-001")),
          payloads: [],
        })
        .pipe(
          Effect.match({
            onFailure: ({ message }) => message,
            onSuccess: () => "unexpected-success",
          }),
        );

      expect(inconsistentMessage).toContain("one-to-one mapping");
    }),
  );
});
