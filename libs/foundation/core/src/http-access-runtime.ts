import { createHash } from "node:crypto";
import { Effect, Layer, Predicate, Schema } from "effect";
import {
  AccessRetryDecisionSchema,
  deriveAccessRetryPolicy,
  executeWithAccessRetry,
  isRetryableAccessFailure,
} from "./access-retry-runtime.ts";
import { tryAbortableAccess, withAccessTimeout } from "./access-timeout-runtime.ts";
import { ArtifactKindSchema, ArtifactVisibilitySchema } from "./budget-lease-artifact.ts";
import { ArtifactMetadataRecordSchema, StorageLocatorSchema } from "./config-storage.ts";
import { RunPlanSchema } from "./run-state.ts";
import { HttpAccess } from "./service-topology.ts";
import { IsoDateTimeSchema } from "./schema-primitives.ts";
import { PolicyViolation, ProviderUnavailable, TimeoutError } from "./tagged-errors.ts";

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

const defaultRequestHeaders = {
  accept: "text/html,application/xhtml+xml",
} as const;

const redactedHeaderValue = "[REDACTED]";

const explicitlySensitiveHeaderNames = new Set(["cookie2", "set-cookie2"]);

const sensitiveHeaderNamePattern =
  /(?:^|[-])(authorization|cookie|token|secret|session|api[-]?key)(?:$|[-])/;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function hasFailureMessage(cause: unknown): cause is { readonly message: string } {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }

  return Predicate.hasProperty(cause, "message") && typeof cause.message === "string";
}

function toHttpAccessFailure(
  cause: unknown,
  fallback: string,
): PolicyViolation | ProviderUnavailable | TimeoutError {
  if (Predicate.isTagged("ProviderUnavailable")(cause) && hasFailureMessage(cause)) {
    return new ProviderUnavailable({
      message: cause.message,
    });
  }

  if (Predicate.isTagged("TimeoutError")(cause) && hasFailureMessage(cause)) {
    return new TimeoutError({
      message: cause.message,
    });
  }

  if (Predicate.isTagged("PolicyViolation")(cause) && hasFailureMessage(cause)) {
    return new PolicyViolation({
      message: cause.message,
    });
  }

  return new ProviderUnavailable({
    message: readCauseMessage(cause, fallback),
  });
}

function shouldSanitizeHeader(name: string) {
  return explicitlySensitiveHeaderNames.has(name) || sensitiveHeaderNamePattern.test(name);
}

export function sanitizeHttpHeaders(headers: Iterable<readonly [string, string]>) {
  return Array.from(headers)
    .map(([name, value]) => {
      const normalizedName = name.toLowerCase();

      return {
        name: normalizedName,
        value: shouldSanitizeHeader(normalizedName) ? redactedHeaderValue : value,
      };
    })
    .sort((left, right) =>
      left.name === right.name
        ? left.value.localeCompare(right.value)
        : left.name.localeCompare(right.name),
    );
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
  onRetryDecision: (
    decision: Schema.Schema.Type<typeof AccessRetryDecisionSchema>,
  ) => Effect.Effect<void, never, never> = (decision) =>
    Effect.log(
      `Retrying access operation attempt ${decision.attempt} -> ${decision.nextAttempt} after ${decision.delayMs}ms: ${decision.reason}`,
    ),
  requestHeaders: Readonly<Record<string, string>> = defaultRequestHeaders,
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

    const startedAt = perfNow();
    const retryPolicy = yield* deriveAccessRetryPolicy(decodedPlan);
    const capture = yield* executeWithAccessRetry({
      policy: retryPolicy,
      effect: () =>
        Effect.gen(function* () {
          const response = yield* tryAbortableAccess({
            policy: {
              timeoutMs: decodedPlan.timeoutMs,
              timeoutMessage: `HTTP access timed out for ${decodedPlan.entryUrl}.`,
            },
            try: (signal) =>
              fetchImpl(decodedPlan.entryUrl, {
                method: "GET",
                headers: requestHeaders,
                signal,
              }),
            catch: (cause) => toHttpAccessFailure(cause, "HTTP access request failed."),
          });
          const body = yield* withAccessTimeout(
            Effect.tryPromise({
              try: () => response.text(),
              catch: (cause) =>
                toHttpAccessFailure(cause, "HTTP access response body could not be read."),
            }),
            {
              timeoutMs: decodedPlan.timeoutMs,
              timeoutMessage: `HTTP access body read timed out for ${decodedPlan.entryUrl}.`,
            },
          );

          return { body, response };
        }),
      shouldRetry: isRetryableAccessFailure,
      onDecision: onRetryDecision,
    }).pipe(Effect.map(({ value }) => value));
    const { body, response } = capture;
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
          headers: sanitizeHttpHeaders(Object.entries(requestHeaders)),
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
          headers: sanitizeHttpHeaders(response.headers.entries()),
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
