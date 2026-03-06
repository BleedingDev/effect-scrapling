import { createHash } from "node:crypto";
import { Effect, Layer, Schema } from "effect";
import { ArtifactKindSchema, ArtifactVisibilitySchema } from "./budget-lease-artifact.js";
import { ArtifactMetadataRecordSchema, StorageLocatorSchema } from "./config-storage.js";
import { RunPlanSchema } from "./run-state.js";
import { HttpAccess } from "./service-topology.js";
import { IsoDateTimeSchema } from "./schema-primitives.js";
import { PolicyViolation, ProviderUnavailable } from "./tagged-errors.js";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

export class HttpCapturePayload extends Schema.Class<HttpCapturePayload>("HttpCapturePayload")({
  locator: StorageLocatorSchema,
  mediaType: NonEmptyStringSchema,
  body: Schema.String,
}) {}

export class HttpCaptureBundle extends Schema.Class<HttpCaptureBundle>("HttpCaptureBundle")({
  capturedAt: IsoDateTimeSchema,
  artifacts: Schema.Array(ArtifactMetadataRecordSchema),
  payloads: Schema.Array(HttpCapturePayload),
}) {}

export const HttpCapturePayloadSchema = HttpCapturePayload;
export const HttpCaptureBundleSchema = HttpCaptureBundle;

type HttpFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function serializeHeaders(headers: Headers) {
  return Array.from(headers.entries())
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName
        ? leftValue.localeCompare(rightValue)
        : leftName.localeCompare(rightName),
    )
    .map(([name, value]) => ({ name, value }));
}

function sizeBytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function buildCapturePayload(
  plan: Schema.Schema.Type<typeof RunPlanSchema>,
  keySuffix: string,
  mediaType: string,
  body: string,
) {
  const locator = Schema.decodeUnknownSync(StorageLocatorSchema)({
    namespace: `captures/${plan.targetId}`,
    key: `${plan.id}/${keySuffix}`,
  });

  return Schema.decodeUnknownSync(HttpCapturePayloadSchema)({
    locator,
    mediaType,
    body,
  });
}

function buildArtifactRecord(
  plan: Schema.Schema.Type<typeof RunPlanSchema>,
  storedAt: string,
  artifactId: string,
  kind: Schema.Schema.Type<typeof ArtifactKindSchema>,
  visibility: Schema.Schema.Type<typeof ArtifactVisibilitySchema>,
  payload: HttpCapturePayload,
) {
  return Schema.decodeUnknownSync(ArtifactMetadataRecordSchema)({
    id: artifactId,
    runId: plan.id,
    artifactId,
    kind,
    visibility,
    locator: payload.locator,
    sha256: sha256(payload.body),
    sizeBytes: sizeBytes(payload.body),
    mediaType: payload.mediaType,
    storedAt,
  });
}

export function captureHttpArtifacts(
  plan: unknown,
  fetchImpl: HttpFetch = fetch,
  now: () => Date = () => new Date(),
  perfNow: () => number = () => performance.now(),
) {
  return Effect.gen(function* () {
    const decodedPlan = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(RunPlanSchema)(plan),
      catch: () =>
        new PolicyViolation({
          message: "Failed to decode HTTP capture plan through shared contracts.",
        }),
    });
    const captureStep = decodedPlan.steps.find(({ stage }) => stage === "capture");
    if (captureStep === undefined) {
      return yield* Effect.fail(
        new PolicyViolation({
          message: "HTTP access requires a capture step in the run plan.",
        }),
      );
    }

    if (captureStep.requiresBrowser) {
      return yield* Effect.fail(
        new PolicyViolation({
          message: "HTTP access cannot execute a capture plan that requires browser resources.",
        }),
      );
    }

    const requestHeaders = {
      accept: "text/html,application/xhtml+xml",
    };
    const startedAt = perfNow();
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(decodedPlan.entryUrl, {
          method: "GET",
          headers: requestHeaders,
        }),
      catch: (cause) =>
        new ProviderUnavailable({
          message: readCauseMessage(cause, "HTTP access request failed."),
        }),
    });
    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new ProviderUnavailable({
          message: readCauseMessage(cause, "HTTP access response body could not be read."),
        }),
    });
    const durationMs = Math.max(0, perfNow() - startedAt);
    const storedAt = now().toISOString();
    const responseMediaType = response.headers.get("content-type") ?? "application/octet-stream";

    const requestPayload = buildCapturePayload(
      decodedPlan,
      "request-metadata.json",
      "application/json",
      `${JSON.stringify(
        {
          method: "GET",
          url: decodedPlan.entryUrl,
          headers: Object.entries(requestHeaders)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, value]) => ({ name, value })),
        },
        null,
        2,
      )}\n`,
    );
    const responsePayload = buildCapturePayload(
      decodedPlan,
      "response-metadata.json",
      "application/json",
      `${JSON.stringify(
        {
          status: response.status,
          ok: response.ok,
          redirected: response.redirected,
          url: response.url || decodedPlan.entryUrl,
          headers: serializeHeaders(response.headers),
        },
        null,
        2,
      )}\n`,
    );
    const htmlPayload = buildCapturePayload(decodedPlan, "body.html", responseMediaType, body);
    const timingsPayload = buildCapturePayload(
      decodedPlan,
      "timings.json",
      "application/json",
      `${JSON.stringify({ durationMs }, null, 2)}\n`,
    );
    const payloads = [requestPayload, responsePayload, htmlPayload, timingsPayload];

    return Schema.decodeUnknownSync(HttpCaptureBundleSchema)({
      capturedAt: storedAt,
      artifacts: [
        buildArtifactRecord(
          decodedPlan,
          storedAt,
          `${decodedPlan.id}-request-metadata`,
          "requestMetadata",
          "redacted",
          requestPayload,
        ),
        buildArtifactRecord(
          decodedPlan,
          storedAt,
          `${decodedPlan.id}-response-metadata`,
          "responseMetadata",
          "redacted",
          responsePayload,
        ),
        buildArtifactRecord(
          decodedPlan,
          storedAt,
          `${decodedPlan.id}-html`,
          "html",
          "raw",
          htmlPayload,
        ),
        buildArtifactRecord(
          decodedPlan,
          storedAt,
          `${decodedPlan.id}-timings`,
          "timings",
          "redacted",
          timingsPayload,
        ),
      ],
      payloads,
    });
  });
}

export function makeHttpAccess(
  fetchImpl: HttpFetch = fetch,
  now: () => Date = () => new Date(),
  perfNow: () => number = () => performance.now(),
) {
  const capture = Effect.fn("HttpAccessLive.capture")(function* (
    plan: Schema.Schema.Type<typeof RunPlanSchema>,
  ) {
    const bundle = yield* captureHttpArtifacts(plan, fetchImpl, now, perfNow);
    return bundle.artifacts;
  });

  return HttpAccess.of({ capture });
}

export function HttpAccessLive(
  fetchImpl: HttpFetch = fetch,
  now: () => Date = () => new Date(),
  perfNow: () => number = () => performance.now(),
) {
  return Layer.succeed(HttpAccess)(makeHttpAccess(fetchImpl, now, perfNow));
}
