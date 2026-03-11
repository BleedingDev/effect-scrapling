const VOLATILE_NUMBER_KEYS = new Set([
  "durationMs",
  "responseHeadersDurationMs",
  "bodyReadDurationMs",
  "routeRegistrationDurationMs",
  "gotoDurationMs",
  "loadStateDurationMs",
  "domReadDurationMs",
  "headerReadDurationMs",
]);

const VOLATILE_STRING_KEYS = new Set(["egressLeaseId", "identityLeaseId"]);

export function stripVolatileAccessTelemetry<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripVolatileAccessTelemetry(entry)) as T;
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const normalizedEntries = Object.entries(value).map(([key, entry]) => {
    if (VOLATILE_NUMBER_KEYS.has(key)) {
      return [key, 0];
    }

    if (VOLATILE_STRING_KEYS.has(key)) {
      return [key, "<volatile>"];
    }

    return [key, stripVolatileAccessTelemetry(entry)];
  });

  return Object.fromEntries(normalizedEntries) as T;
}
