import { Effect, Option, Ref, Schema } from "effect";
import { enforceCaptureArtifactBoundary } from "./capture-artifact-storage.ts";
import { ArtifactMetadataRecordSchema, StorageLocatorSchema } from "./config-storage.ts";
import { HttpCaptureBundleSchema, HttpCapturePayloadSchema } from "./http-access-runtime.ts";
import { CanonicalIdentifierSchema } from "./schema-primitives.ts";
import { PolicyViolation } from "./tagged-errors.ts";

const CapturePayloadKeySchema = Schema.Trim.check(Schema.isNonEmpty());

export class StoredCaptureBundle extends Schema.Class<StoredCaptureBundle>("StoredCaptureBundle")({
  runId: CanonicalIdentifierSchema,
  bundle: HttpCaptureBundleSchema,
}) {}

export const StoredCaptureBundleSchema = StoredCaptureBundle;

function decodeRunId(runId: unknown) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(CanonicalIdentifierSchema)(runId),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode capture-store run id through shared contracts.",
      }),
  });
}

function decodeBundle(bundle: unknown) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(HttpCaptureBundleSchema)(bundle),
    catch: () =>
      new PolicyViolation({
        message: "Failed to decode capture-store bundle through shared contracts.",
      }),
  });
}

function payloadStorageKey(locator: unknown) {
  const decodedLocator = Schema.decodeUnknownSync(StorageLocatorSchema)(locator);
  return Schema.decodeUnknownSync(CapturePayloadKeySchema)(
    `${decodedLocator.namespace}/${decodedLocator.key}`,
  );
}

function sortArtifacts(
  artifacts: ReadonlyArray<Schema.Schema.Type<typeof ArtifactMetadataRecordSchema>>,
) {
  return [...artifacts].sort((left, right) =>
    payloadStorageKey(left.locator).localeCompare(payloadStorageKey(right.locator)),
  );
}

function sortPayloads(
  payloads: ReadonlyArray<Schema.Schema.Type<typeof HttpCapturePayloadSchema>>,
) {
  return [...payloads].sort((left, right) =>
    payloadStorageKey(left.locator).localeCompare(payloadStorageKey(right.locator)),
  );
}

function validateBundleConsistency(bundle: Schema.Schema.Type<typeof HttpCaptureBundleSchema>) {
  for (const artifact of bundle.artifacts) {
    try {
      enforceCaptureArtifactBoundary(artifact);
    } catch {
      return Effect.fail(
        new PolicyViolation({
          message:
            "Capture-store bundles must keep raw and redacted artifacts in separate storage namespaces.",
        }),
      );
    }
  }

  const artifactKeys = sortArtifacts(bundle.artifacts).map(({ locator }) =>
    payloadStorageKey(locator),
  );
  const payloadKeys = sortPayloads(bundle.payloads).map(({ locator }) =>
    payloadStorageKey(locator),
  );

  if (
    artifactKeys.length !== payloadKeys.length ||
    artifactKeys.some((artifactKey, index) => artifactKey !== payloadKeys[index])
  ) {
    return Effect.fail(
      new PolicyViolation({
        message:
          "Capture-store bundles must contain a one-to-one mapping between artifact records and payload locators.",
      }),
    );
  }

  return Effect.void;
}

export function makeInMemoryCaptureBundleStore() {
  return Effect.gen(function* () {
    const artifactsByRun = yield* Ref.make(
      new Map<string, ReadonlyArray<Schema.Schema.Type<typeof ArtifactMetadataRecordSchema>>>(),
    );
    const capturedAtByRun = yield* Ref.make(new Map<string, string>());
    const payloadsByRun = yield* Ref.make(
      new Map<string, Map<string, Schema.Schema.Type<typeof HttpCapturePayloadSchema>>>(),
    );

    const persistBundle = Effect.fn("InMemoryCaptureBundleStore.persistBundle")(function* (
      runId: unknown,
      bundle: unknown,
    ) {
      const decodedRunId = yield* decodeRunId(runId);
      const decodedBundle = yield* decodeBundle(bundle);
      yield* validateBundleConsistency(decodedBundle);

      const sortedArtifacts = sortArtifacts(decodedBundle.artifacts);
      const sortedPayloads = sortPayloads(decodedBundle.payloads);

      yield* Ref.update(payloadsByRun, (current) => {
        const next = new Map(current);
        next.set(
          decodedRunId,
          new Map(
            sortedPayloads.map((payload) => [payloadStorageKey(payload.locator), payload] as const),
          ),
        );
        return next;
      });
      yield* Ref.update(artifactsByRun, (current) => {
        const next = new Map(current);
        next.set(decodedRunId, sortedArtifacts);
        return next;
      });
      yield* Ref.update(capturedAtByRun, (current) => {
        const next = new Map(current);
        next.set(decodedRunId, decodedBundle.capturedAt);
        return next;
      });

      return Schema.decodeUnknownSync(StoredCaptureBundleSchema)({
        runId: decodedRunId,
        bundle: {
          capturedAt: decodedBundle.capturedAt,
          artifacts: sortedArtifacts,
          payloads: sortedPayloads,
        },
      });
    });

    const readBundle = Effect.fn("InMemoryCaptureBundleStore.readBundle")(function* (
      runId: unknown,
    ) {
      const decodedRunId = yield* decodeRunId(runId);
      const artifacts = (yield* Ref.get(artifactsByRun)).get(decodedRunId);
      const capturedAt = (yield* Ref.get(capturedAtByRun)).get(decodedRunId);

      if (artifacts === undefined || capturedAt === undefined) {
        return Option.none<StoredCaptureBundle>();
      }

      const payloads = yield* Ref.get(payloadsByRun).pipe(
        Effect.flatMap((current) =>
          Effect.sync(() => current.get(decodedRunId)).pipe(
            Effect.flatMap((payloadsForRun) =>
              payloadsForRun === undefined
                ? Effect.fail(
                    new PolicyViolation({
                      message:
                        "Capture-store payload state is corrupted because the run payload partition is missing.",
                    }),
                  )
                : Effect.succeed(payloadsForRun),
            ),
          ),
        ),
        Effect.flatMap((payloadsForRun) =>
          Effect.forEach(artifacts, ({ locator }) =>
            Effect.sync(() => payloadsForRun.get(payloadStorageKey(locator))).pipe(
              Effect.flatMap((payload) =>
                payload === undefined
                  ? Effect.fail(
                      new PolicyViolation({
                        message:
                          "Capture-store payload state is corrupted because an artifact payload is missing.",
                      }),
                    )
                  : Effect.succeed(payload),
              ),
            ),
          ),
        ),
      );

      return Option.some(
        Schema.decodeUnknownSync(StoredCaptureBundleSchema)({
          runId: decodedRunId,
          bundle: {
            capturedAt,
            artifacts,
            payloads: sortPayloads(payloads),
          },
        }),
      );
    });

    return {
      persistBundle,
      readBundle,
    };
  });
}
